"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import type { Conversation } from "@/types";
import {
  Radar,
  Users,
  TrendingUp,
  TrendingDown,
  Plus,
  Loader2,
  Search,
  ChevronRight,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

interface GroupRow extends Conversation {
  joins7d: number;
  leaves7d: number;
}

/** 0 / cap progress bar — greens up low, ambers mid, reds near the cap. */
function MemberBar({
  count,
  cap,
}: {
  count: number | null | undefined;
  cap: number | null | undefined;
}) {
  const c = count ?? 0;
  const max = cap || 1024;
  const pct = Math.min(100, Math.round((c / max) * 100));
  const color =
    pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-500" : "bg-primary";
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">Membros</span>
        <span className="font-medium text-foreground">
          {c} / {max}
          {pct >= 90 && (
            <span className="ml-1 text-red-400">⚠ quase cheio</span>
          )}
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-2 rounded-full transition-all", color)}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export default function MonitoringPage() {
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    const supabase = createClient();
    const { data: convs, error } = await supabase
      .from("conversations")
      .select(
        "id, group_name, group_picture, member_count, member_cap, group_members, monitored, is_group, last_message_at",
      )
      .eq("is_group", true)
      .eq("monitored", true);

    if (error) {
      console.error("Failed to load monitored groups:", error.message);
      setLoading(false);
      return;
    }

    const list = (convs as Conversation[]) ?? [];
    const ids = list.map((c) => c.id);

    // One query for all recent events, aggregated client-side per group.
    const joins = new Map<string, number>();
    const leaves = new Map<string, number>();
    if (ids.length > 0) {
      const since = new Date(Date.now() - SEVEN_DAYS_MS).toISOString();
      const { data: events } = await supabase
        .from("messages")
        .select("conversation_id, payload, created_at")
        .in("conversation_id", ids)
        .eq("content_type", "system")
        .gte("created_at", since);
      for (const e of (events as { conversation_id: string; payload: { action?: string } | null }[]) ?? []) {
        const action = e.payload?.action;
        if (action === "add") joins.set(e.conversation_id, (joins.get(e.conversation_id) ?? 0) + 1);
        else if (action === "remove") leaves.set(e.conversation_id, (leaves.get(e.conversation_id) ?? 0) + 1);
      }
    }

    const rows: GroupRow[] = list
      .map((c) => ({
        ...c,
        joins7d: joins.get(c.id) ?? 0,
        leaves7d: leaves.get(c.id) ?? 0,
      }))
      .sort((a, b) => (b.member_count ?? 0) - (a.member_count ?? 0));

    setGroups(rows);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleSyncGroups = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      const res = await fetch("/api/whatsapp/groups/sync", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error || "Falha ao sincronizar grupos");
        return;
      }
      toast.success(`${data.total ?? 0} grupo(s) na conexão`);
      await load();
    } finally {
      setSyncing(false);
    }
  }, [syncing, load]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-xl bg-primary-soft text-primary">
            <Radar className="size-5" />
          </span>
          <div>
            <h1 className="text-2xl font-semibold text-foreground">
              Monitoramento de grupos
            </h1>
            <p className="text-sm text-muted-foreground">
              {groups.length} grupo{groups.length === 1 ? "" : "s"} monitorado
              {groups.length === 1 ? "" : "s"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={handleSyncGroups}
            disabled={syncing}
          >
            {syncing ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            Sincronizar grupos
          </Button>
          <Button onClick={() => setAddOpen(true)}>
            <Plus className="size-4" />
            Adicionar grupo
          </Button>
        </div>
      </div>

      {/* List */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : groups.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border py-16 text-center">
          <Radar className="mx-auto size-8 text-muted-foreground" />
          <p className="mt-3 text-sm font-medium text-foreground">
            Nenhum grupo monitorado ainda
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Clique em “Adicionar grupo” para começar a acompanhar entradas e
            saídas.
          </p>
        </div>
      ) : (
        <div className="grid gap-3">
          {groups.map((g) => {
            const net = g.joins7d - g.leaves7d;
            return (
              <Link
                key={g.id}
                href={`/monitoring/${g.id}`}
                className="group flex items-center gap-4 rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary-soft-2 hover:bg-card-2"
              >
                <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted">
                  {g.group_picture ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={g.group_picture}
                      alt={g.group_name ?? "Grupo"}
                      className="size-12 rounded-full object-cover"
                    />
                  ) : (
                    <Users className="size-5 text-muted-foreground" />
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-semibold text-foreground">
                      {g.group_name || "Grupo"}
                    </span>
                    <span
                      className={cn(
                        "inline-flex shrink-0 items-center gap-1 text-xs font-medium",
                        net > 0
                          ? "text-emerald-400"
                          : net < 0
                            ? "text-red-400"
                            : "text-muted-foreground",
                      )}
                    >
                      {net > 0 ? (
                        <TrendingUp className="size-3.5" />
                      ) : net < 0 ? (
                        <TrendingDown className="size-3.5" />
                      ) : null}
                      {net > 0 ? `+${net}` : net} (7d)
                    </span>
                  </div>
                  <div className="mt-2">
                    <MemberBar count={g.member_count} cap={g.member_cap} />
                  </div>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    {g.joins7d} entrada{g.joins7d === 1 ? "" : "s"} ·{" "}
                    {g.leaves7d} saída{g.leaves7d === 1 ? "" : "s"} (7 dias)
                  </p>
                </div>

                <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
              </Link>
            );
          })}
        </div>
      )}

      <AddGroupDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onChanged={load}
      />
    </div>
  );
}

/** Picker of synced groups not yet on the watchlist. */
function AddGroupDialog({
  open,
  onOpenChange,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onChanged: () => void;
}) {
  const [candidates, setCandidates] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadCandidates = useCallback(async () => {
    setLoading(true);
    const supabase = createClient();
    const { data } = await supabase
      .from("conversations")
      .select("id, group_name, group_picture, member_count, member_cap")
      .eq("is_group", true)
      .eq("monitored", false)
      .order("group_name", { ascending: true });
    setCandidates((data as Conversation[]) ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (open) loadCandidates();
  }, [open, loadCandidates]);

  const filtered = useMemo(() => {
    if (!search.trim()) return candidates;
    const q = search.toLowerCase();
    return candidates.filter((c) => (c.group_name ?? "").toLowerCase().includes(q));
  }, [candidates, search]);

  const monitor = useCallback(
    async (id: string) => {
      setBusyId(id);
      const supabase = createClient();
      const { error } = await supabase
        .from("conversations")
        .update({ monitored: true })
        .eq("id", id);
      setBusyId(null);
      if (error) {
        toast.error("Não foi possível adicionar");
        return;
      }
      setCandidates((prev) => prev.filter((c) => c.id !== id));
      onChanged();
      toast.success("Grupo adicionado ao monitoramento");
    },
    [onChanged],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Adicionar grupo ao monitoramento</DialogTitle>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar grupo…"
            className="pl-9"
          />
        </div>

        <ScrollArea className="max-h-80">
          {loading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : filtered.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              Nenhum grupo disponível. Use “Sincronizar grupos”.
            </p>
          ) : (
            <div className="flex flex-col gap-1 pr-2">
              {filtered.map((c) => (
                <div
                  key={c.id}
                  className="flex items-center gap-3 rounded-lg p-2 hover:bg-muted/50"
                >
                  <div className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted">
                    {c.group_picture ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={c.group_picture}
                        alt={c.group_name ?? "Grupo"}
                        className="size-9 rounded-full object-cover"
                      />
                    ) : (
                      <Users className="size-4 text-muted-foreground" />
                    )}
                  </div>
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                    {c.group_name || "Grupo"}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busyId === c.id}
                    onClick={() => monitor(c.id)}
                  >
                    {busyId === c.id ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      "Monitorar"
                    )}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
