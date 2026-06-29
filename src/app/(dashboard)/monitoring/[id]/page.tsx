"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import type { Conversation, GroupParticipant } from "@/types";
import {
  ArrowLeft,
  Users,
  Loader2,
  Search,
  Shield,
  LogIn,
  LogOut,
  Crown,
  Activity,
  RefreshCw,
} from "lucide-react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { format, formatDistanceToNow } from "date-fns";
import { toast } from "sonner";

interface SystemEvent {
  id: string;
  created_at: string;
  content_text: string | null;
  payload: { action?: string; actorJid?: string | null; targetJid?: string | null } | null;
}

const DAYS = 30;

function jidPhone(jid: string): string {
  return jid.split("@")[0].split(":")[0].replace(/\D/g, "");
}

export default function GroupMonitoringDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;

  const [conv, setConv] = useState<Conversation | null>(null);
  const [events, setEvents] = useState<SystemEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [memberSearch, setMemberSearch] = useState("");
  const [removing, setRemoving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const supabase = createClient();
    const [{ data: c }, { data: evs }] = await Promise.all([
      supabase
        .from("conversations")
        .select(
          "id, group_name, group_picture, member_count, member_cap, group_members, monitored, is_group",
        )
        .eq("id", id)
        .maybeSingle(),
      supabase
        .from("messages")
        .select("id, created_at, content_text, payload")
        .eq("conversation_id", id)
        .eq("content_type", "system")
        .order("created_at", { ascending: false })
        .limit(500),
    ]);
    setConv((c as Conversation) ?? null);
    setEvents((evs as SystemEvent[]) ?? []);
    setLoading(false);
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const members = useMemo(() => {
    const raw = conv?.group_members;
    if (!Array.isArray(raw)) return [] as GroupParticipant[];
    return raw as GroupParticipant[];
  }, [conv]);

  const adminCount = useMemo(
    () => members.filter((m) => m.admin === "admin" || m.admin === "superadmin").length,
    [members],
  );

  const { joins7d, leaves7d } = useMemo(() => {
    const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
    let j = 0;
    let l = 0;
    for (const e of events) {
      if (new Date(e.created_at).getTime() < since) continue;
      if (e.payload?.action === "add") j++;
      else if (e.payload?.action === "remove") l++;
    }
    return { joins7d: j, leaves7d: l };
  }, [events]);

  // Daily entradas/saídas for the last DAYS days.
  const chartData = useMemo(() => {
    const buckets = new Map<string, { date: string; entradas: number; saidas: number }>();
    for (let i = DAYS - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const key = format(d, "yyyy-MM-dd");
      buckets.set(key, { date: format(d, "dd/MM"), entradas: 0, saidas: 0 });
    }
    for (const e of events) {
      const key = format(new Date(e.created_at), "yyyy-MM-dd");
      const b = buckets.get(key);
      if (!b) continue;
      if (e.payload?.action === "add") b.entradas++;
      else if (e.payload?.action === "remove") b.saidas++;
    }
    return [...buckets.values()];
  }, [events]);

  const filteredMembers = useMemo(() => {
    if (!memberSearch.trim()) return members;
    const q = memberSearch.toLowerCase();
    return members.filter((m) => jidPhone(m.id).includes(q.replace(/\D/g, "")));
  }, [members, memberSearch]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch("/api/whatsapp/groups/refresh-members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error || "Falha ao atualizar");
        return;
      }
      await load();
      toast.success(`${data.member_count ?? "?"} membros agora`);
    } finally {
      setRefreshing(false);
    }
  }, [id, load]);

  const handleRemove = useCallback(async () => {
    setRemoving(true);
    const supabase = createClient();
    const { error } = await supabase
      .from("conversations")
      .update({ monitored: false })
      .eq("id", id);
    if (error) {
      setRemoving(false);
      toast.error("Não foi possível remover");
      return;
    }
    toast.success("Removido do monitoramento");
    router.push("/monitoring");
  }, [id, router]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!conv) {
    return (
      <div className="py-20 text-center text-sm text-muted-foreground">
        Grupo não encontrado.
      </div>
    );
  }

  const memberCount = conv.member_count ?? members.length;
  const cap = conv.member_cap || 1024;
  const pct = Math.min(100, Math.round((memberCount / cap) * 100));
  const net = joins7d - leaves7d;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            onClick={() => router.push("/monitoring")}
            aria-label="Voltar"
            className="flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ArrowLeft className="size-5" />
          </button>
          <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted">
            {conv.group_picture ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={conv.group_picture}
                alt={conv.group_name ?? "Grupo"}
                className="size-12 rounded-full object-cover"
              />
            ) : (
              <Users className="size-5 text-muted-foreground" />
            )}
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold text-foreground">
              {conv.group_name || "Grupo"}
            </h1>
            <p className="text-sm text-muted-foreground">
              {memberCount} / {cap} membros
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={handleRefresh} disabled={refreshing}>
            {refreshing ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            Atualizar
          </Button>
          <Button variant="outline" onClick={handleRemove} disabled={removing}>
            {removing ? <Loader2 className="size-4 animate-spin" /> : null}
            Remover
          </Button>
        </div>
      </div>

      {/* Member bar */}
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="mb-2 flex items-center justify-between text-sm">
          <span className="font-medium text-foreground">Ocupação do grupo</span>
          <span className="text-muted-foreground">
            {memberCount} / {cap} ({pct}%)
          </span>
        </div>
        <div className="h-3 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-3 rounded-full transition-all",
              pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-500" : "bg-primary",
            )}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard icon={Users} label="Membros" value={memberCount} />
        <StatCard icon={Shield} label="Admins" value={adminCount} />
        <StatCard
          icon={LogIn}
          label="Entradas (7d)"
          value={joins7d}
          tone="up"
        />
        <StatCard
          icon={LogOut}
          label="Saídas (7d)"
          value={leaves7d}
          tone="down"
        />
      </div>

      {/* Growth chart */}
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Activity className="size-4 text-primary" />
            Crescimento ({DAYS} dias)
          </h2>
          <span
            className={cn(
              "text-xs font-medium",
              net > 0 ? "text-emerald-400" : net < 0 ? "text-red-400" : "text-muted-foreground",
            )}
          >
            Líquido 7d: {net > 0 ? `+${net}` : net}
          </span>
        </div>
        <div className="h-56 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="gJoin" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#10b981" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gLeave" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#ef4444" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                interval="preserveStartEnd"
                minTickGap={24}
              />
              <YAxis
                allowDecimals={false}
                tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                width={28}
              />
              <Tooltip
                contentStyle={{
                  background: "var(--popover)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  fontSize: 12,
                }}
              />
              <Area
                type="monotone"
                dataKey="entradas"
                stroke="#10b981"
                fill="url(#gJoin)"
                strokeWidth={2}
              />
              <Area
                type="monotone"
                dataKey="saidas"
                stroke="#ef4444"
                fill="url(#gLeave)"
                strokeWidth={2}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {/* Member list */}
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">
              Membros ({members.length})
            </h2>
          </div>
          <div className="relative mb-2">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={memberSearch}
              onChange={(e) => setMemberSearch(e.target.value)}
              placeholder="Buscar por número…"
              className="pl-9"
            />
          </div>
          <ScrollArea className="max-h-72">
            {filteredMembers.length === 0 ? (
              <p className="py-8 text-center text-xs text-muted-foreground">
                Sem membros sincronizados.
              </p>
            ) : (
              <div className="flex flex-col gap-1 pr-2">
                {filteredMembers.map((m) => {
                  const isAdmin = m.admin === "admin" || m.admin === "superadmin";
                  return (
                    <div
                      key={m.id}
                      className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-muted/40"
                    >
                      <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] text-muted-foreground">
                        <Users className="size-3.5" />
                      </div>
                      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                        +{jidPhone(m.id)}
                      </span>
                      {isAdmin && (
                        <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
                          <Crown className="size-3" />
                          {m.admin === "superadmin" ? "Dono" : "Admin"}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </ScrollArea>
        </div>

        {/* Event timeline */}
        <div className="rounded-xl border border-border bg-card p-4">
          <h2 className="mb-3 text-sm font-semibold text-foreground">
            Linha do tempo de eventos
          </h2>
          <ScrollArea className="max-h-72">
            {events.length === 0 ? (
              <p className="py-8 text-center text-xs text-muted-foreground">
                Nenhum evento registrado ainda. Entradas e saídas aparecerão
                aqui a partir de agora.
              </p>
            ) : (
              <div className="flex flex-col gap-2 pr-2">
                {events.map((e) => (
                  <div key={e.id} className="flex items-start gap-2 text-sm">
                    <span
                      className={cn(
                        "mt-1.5 size-1.5 shrink-0 rounded-full",
                        e.payload?.action === "add"
                          ? "bg-emerald-400"
                          : e.payload?.action === "remove"
                            ? "bg-red-400"
                            : "bg-muted-foreground",
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-foreground">{e.content_text}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {formatDistanceToNow(new Date(e.created_at), {
                          addSuffix: true,
                        })}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
        </div>
      </div>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof Users;
  label: string;
  value: number;
  tone?: "up" | "down";
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon
          className={cn(
            "size-4",
            tone === "up" ? "text-emerald-400" : tone === "down" ? "text-red-400" : "text-primary",
          )}
        />
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold text-foreground">{value}</div>
    </div>
  );
}
