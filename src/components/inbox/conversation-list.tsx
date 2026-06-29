"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import type { Conversation, ConversationStatus } from "@/types";
import { Search, ChevronDown, Users, Images, Loader2, Pin } from "lucide-react";
import { format, isToday, isYesterday } from "date-fns";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";

// Joined tags shape (contacts → contact_tags → tags), pulled in CONV_SELECT.
interface JoinedTag {
  tag: { id: string; name: string; color: string | null } | null;
}

// One query string, reused by the initial fetch and the post-action refetch
// so the list always carries the same joined data (contact + its tags).
const CONV_SELECT =
  "*, contact:contacts(*, contact_tags(tag:tags(id, name, color)))";

// WhatsApp-style compact timestamp for the list: clock time today,
// "Yesterday", otherwise a short date. Kept terse so it never wraps
// next to the conversation name.
function formatListTime(dateStr?: string | null): string {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (isToday(d)) return format(d, "HH:mm");
  if (isYesterday(d)) return "Yesterday";
  return format(d, "dd/MM/yy");
}

type InboxFilter =
  | ConversationStatus
  | "all"
  | "unread"
  | "assigned"
  | "groups"
  | "dm";

const FILTER_OPTIONS: { label: string; value: InboxFilter }[] = [
  { label: "Todas", value: "all" },
  { label: "Não lidas", value: "unread" },
  { label: "Atribuídas a mim", value: "assigned" },
  { label: "Grupos", value: "groups" },
  { label: "Individuais", value: "dm" },
  { label: "Abertas", value: "open" },
  { label: "Pendentes", value: "pending" },
  { label: "Fechadas", value: "closed" },
];

function tagsOf(conversation: Conversation): { id: string; name: string; color: string | null }[] {
  const ct = (conversation.contact as { contact_tags?: JoinedTag[] } | undefined)?.contact_tags;
  if (!Array.isArray(ct)) return [];
  return ct.map((r) => r.tag).filter((t): t is NonNullable<JoinedTag["tag"]> => !!t);
}

export function ConversationList({
  activeConversationId,
  onSelect,
  conversations,
  onConversationsLoaded,
  resyncToken = 0,
}: ConversationListProps) {
  const { user } = useAuth();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [loading, setLoading] = useState(true);
  const [syncingPhotos, setSyncingPhotos] = useState(false);

  // Keep the latest callback in a ref so the fetch effect below can
  // have a stable, empty-dep identity (see the long note that used to live
  // here: depending on the callback caused redundant refetches that wiped
  // the active thread's messages).
  const onConversationsLoadedRef = useRef(onConversationsLoaded);
  useEffect(() => {
    onConversationsLoadedRef.current = onConversationsLoaded;
  });

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from("conversations")
        .select(CONV_SELECT)
        .order("last_message_at", { ascending: false });

      if (cancelled) return;

      if (error) {
        console.error("Failed to fetch conversations:", {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        setLoading(false);
        return;
      }

      onConversationsLoadedRef.current(data ?? []);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [resyncToken]);

  // Re-pull the list without toggling the skeleton — used after a photo sync
  // or a pin toggle so the change surfaces immediately.
  const refetchConversations = useCallback(async () => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("conversations")
      .select(CONV_SELECT)
      .order("last_message_at", { ascending: false });
    if (error) {
      console.error("Failed to refetch conversations:", error.message);
      return;
    }
    onConversationsLoadedRef.current(data ?? []);
  }, []);

  const handleSyncPhotos = useCallback(async () => {
    if (syncingPhotos) return;
    setSyncingPhotos(true);
    let totalPhotos = 0;
    try {
      for (let i = 0; i < 20; i++) {
        const res = await fetch("/api/whatsapp/contacts/sync-avatars", {
          method: "POST",
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(data?.error || "Falha ao sincronizar fotos");
          return;
        }
        totalPhotos += data.withPhoto ?? 0;
        if (!data.processed || !data.remaining) break;
      }
      await refetchConversations();
      toast.success(
        totalPhotos > 0
          ? `${totalPhotos} foto(s) de perfil sincronizada(s)`
          : "Nenhuma foto nova encontrada",
      );
    } finally {
      setSyncingPhotos(false);
    }
  }, [syncingPhotos, refetchConversations]);

  // Pin / unpin sticks a conversation to the top. Persist then refetch so the
  // ordering + icon reflect the new state.
  const handleTogglePin = useCallback(
    async (conv: Conversation) => {
      const supabase = createClient();
      const { error } = await supabase
        .from("conversations")
        .update({ pinned: !conv.pinned })
        .eq("id", conv.id);
      if (error) {
        toast.error("Não foi possível fixar");
        return;
      }
      await refetchConversations();
    },
    [refetchConversations],
  );

  const filtered = useMemo(() => {
    let result = conversations;

    if (filter === "unread") {
      result = result.filter((c) => c.unread_count > 0);
    } else if (filter === "assigned") {
      result = result.filter((c) => c.assigned_agent_id && c.assigned_agent_id === user?.id);
    } else if (filter === "groups") {
      result = result.filter((c) => c.is_group === true);
    } else if (filter === "dm") {
      result = result.filter((c) => c.is_group !== true);
    } else if (filter !== "all") {
      result = result.filter((c) => c.status === filter);
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((c) => {
        const name = c.contact?.name?.toLowerCase() ?? "";
        const phone = c.contact?.phone?.toLowerCase() ?? "";
        const groupName = c.group_name?.toLowerCase() ?? "";
        const lastMsg = c.last_message_text?.toLowerCase() ?? "";
        return (
          name.includes(q) ||
          phone.includes(q) ||
          groupName.includes(q) ||
          lastMsg.includes(q)
        );
      });
    }

    // Pinned first, then most-recent-first. The realtime handlers patch
    // last_message_at in place without reordering, so this sort is the single
    // source of truth for list order. Null timestamps sink to the bottom.
    return [...result].sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      const ta = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
      const tb = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
      return tb - ta;
    });
  }, [conversations, filter, search, user?.id]);

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearch(e.target.value);
    },
    [],
  );

  const handleSelect = useCallback(
    (conv: Conversation) => {
      onSelect(conv);
    },
    [onSelect],
  );

  // Keyboard navigation: j / ↓ next, k / ↑ previous, Enter opens. Ignored
  // while typing in an input/textarea so search isn't hijacked.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      const typing =
        el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (typing) return;
      if (!["j", "k", "ArrowDown", "ArrowUp"].includes(e.key)) return;
      if (filtered.length === 0) return;
      e.preventDefault();
      const idx = filtered.findIndex((c) => c.id === activeConversationId);
      const next = e.key === "j" || e.key === "ArrowDown";
      let target: number;
      if (idx === -1) target = 0;
      else target = next ? Math.min(filtered.length - 1, idx + 1) : Math.max(0, idx - 1);
      onSelect(filtered[target]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [filtered, activeConversationId, onSelect]);

  const activeFilter = FILTER_OPTIONS.find((o) => o.value === filter);

  return (
    <div className="flex h-full w-full flex-col border-r border-border bg-card lg:w-80">
      {/* Search + Filter */}
      <div className="space-y-2 border-b border-border p-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={handleSearchChange}
            placeholder="Buscar conversas..."
            className="border-border bg-muted pl-9 text-sm text-foreground placeholder-muted-foreground focus:border-primary/50"
          />
        </div>

        <div className="flex items-center justify-between gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger className="inline-flex items-center justify-center h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground rounded-md hover:bg-muted">
              {activeFilter?.label ?? "Todas"}
              <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="border-border bg-popover">
              {FILTER_OPTIONS.map((opt) => (
                <DropdownMenuItem
                  key={opt.value}
                  onClick={() => setFilter(opt.value)}
                  className={cn(
                    "text-sm",
                    filter === opt.value ? "text-primary" : "text-popover-foreground",
                  )}
                >
                  {opt.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Manual profile-photo backfill (inbound also syncs over time). */}
          <button
            type="button"
            onClick={handleSyncPhotos}
            disabled={syncingPhotos}
            title="Sincronizar fotos de perfil"
            aria-label="Sincronizar fotos de perfil"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-60"
          >
            {syncingPhotos ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Images className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>

      {/* Conversation Items. `min-h-0` keeps the ScrollArea bounded (issue #229). */}
      <ScrollArea className="min-h-0 flex-1">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-sm text-muted-foreground">Nenhuma conversa encontrada</p>
          </div>
        ) : (
          <div className="flex flex-col">
            {filtered.map((conv) => (
              <ConversationItem
                key={conv.id}
                conversation={conv}
                isActive={conv.id === activeConversationId}
                onSelect={handleSelect}
                onTogglePin={handleTogglePin}
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

interface ConversationListProps {
  activeConversationId: string | null;
  onSelect: (conversation: Conversation) => void;
  conversations: Conversation[];
  onConversationsLoaded: (conversations: Conversation[]) => void;
  /** Bump to force a refetch (realtime reconnect / tab focus). */
  resyncToken?: number;
}

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
  onSelect: (conversation: Conversation) => void;
  onTogglePin: (conversation: Conversation) => void;
}

function ConversationItem({
  conversation,
  isActive,
  onSelect,
  onTogglePin,
}: ConversationItemProps) {
  const contact = conversation.contact;
  const isGroup = conversation.is_group === true;
  const displayName = isGroup
    ? conversation.group_name || "Grupo"
    : contact?.name || contact?.phone || "Desconhecido";
  const avatarUrl = isGroup ? conversation.group_picture : contact?.avatar_url;
  const initials = displayName.charAt(0).toUpperCase();
  const timeAgo = formatListTime(conversation.last_message_at);
  const tags = tagsOf(conversation);

  const handleClick = useCallback(() => {
    onSelect(conversation);
  }, [onSelect, conversation]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onSelect(conversation);
      }
    },
    [onSelect, conversation],
  );

  const handlePinClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onTogglePin(conversation);
    },
    [onTogglePin, conversation],
  );

  return (
    // A div (not <button>) so the pin toggle can be a nested interactive
    // element — nesting buttons is invalid HTML.
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={cn(
        "group relative flex w-full cursor-pointer items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-muted/50",
        isActive && "border-l-2 border-primary bg-muted/70",
        conversation.pinned && !isActive && "bg-muted/30",
      )}
    >
      {/* Avatar */}
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium text-foreground">
        {avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={avatarUrl}
            alt={displayName}
            className="h-10 w-10 rounded-full object-cover"
          />
        ) : isGroup ? (
          <Users className="h-5 w-5 text-muted-foreground" />
        ) : (
          initials
        )}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1 truncate text-sm font-medium text-foreground">
            {conversation.pinned && (
              <Pin className="size-3 shrink-0 rotate-45 fill-current text-muted-foreground" />
            )}
            <span className="truncate">{displayName}</span>
          </span>
          <span className="shrink-0 text-[10px] text-muted-foreground">{timeAgo}</span>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p className="truncate text-xs text-muted-foreground">
            {conversation.last_message_text || "Sem mensagens ainda"}
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            {conversation.unread_count > 0 && (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                {conversation.unread_count}
              </span>
            )}
            {/* Only flag conversations that need attention (pending). An
                always-on dot for every "open" chat read as a persistent
                "unseen" marker, which was just noise. */}
            {conversation.status === "pending" && (
              <span
                className="h-2 w-2 rounded-full bg-amber-500"
                title="Pendente"
              />
            )}
          </div>
        </div>

        {/* Tag chips */}
        {tags.length > 0 && (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {tags.slice(0, 3).map((t) => (
              <span
                key={t.id}
                className="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-medium"
                style={{
                  borderColor: (t.color ?? "#64748b") + "66",
                  color: t.color ?? "#94a3b8",
                  backgroundColor: (t.color ?? "#64748b") + "1a",
                }}
              >
                {t.name}
              </span>
            ))}
            {tags.length > 3 && (
              <span className="text-[9px] text-muted-foreground">+{tags.length - 3}</span>
            )}
          </div>
        )}
      </div>

      {/* Pin toggle — appears on hover (or always when pinned). */}
      <button
        type="button"
        onClick={handlePinClick}
        aria-label={conversation.pinned ? "Desafixar" : "Fixar"}
        title={conversation.pinned ? "Desafixar" : "Fixar no topo"}
        className={cn(
          "absolute right-2 top-2 flex size-6 items-center justify-center rounded-md bg-card/80 text-muted-foreground opacity-0 backdrop-blur-sm transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100",
        )}
      >
        <Pin className={cn("size-3.5", conversation.pinned && "rotate-45 fill-current")} />
      </button>
    </div>
  );
}
