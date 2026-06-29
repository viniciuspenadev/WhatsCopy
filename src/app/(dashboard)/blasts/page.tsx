'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Megaphone, Plus, Loader2, CalendarDays, Search, AtSign } from 'lucide-react'
import { format } from 'date-fns'
import { CreateCampaignDialog, type CampaignPrefill } from '@/components/blasts/create-campaign-dialog'
import { BlastDetailSheet } from '@/components/blasts/blast-detail-sheet'

interface BlastRow {
  id: string
  name: string | null
  status: string
  message_text: string | null
  mention_all: boolean
  total_count: number
  sent_count: number
  failed_count: number
  scheduled_at: string | null
  created_at: string
}

const STATUS_LABEL: Record<string, { label: string; cls: string; pulse?: boolean }> = {
  draft: { label: 'Rascunho', cls: 'border-border bg-muted text-muted-foreground' },
  scheduled: { label: 'Agendada', cls: 'border-amber-500/30 bg-amber-500/10 text-amber-500' },
  sending: { label: 'Enviando', cls: 'border-primary/30 bg-primary/10 text-primary', pulse: true },
  paused: { label: 'Pausada', cls: 'border-amber-500/30 bg-amber-500/10 text-amber-500' },
  sent: { label: 'Concluída', cls: 'border-green-500/30 bg-green-500/10 text-green-500' },
  failed: { label: 'Falhou', cls: 'border-red-500/30 bg-red-500/10 text-red-500' },
  canceled: { label: 'Cancelada', cls: 'border-border bg-muted text-muted-foreground' },
}

const FILTERS: { label: string; value: string }[] = [
  { label: 'Todas', value: 'all' },
  { label: 'Agendadas', value: 'scheduled' },
  { label: 'Enviando', value: 'sending' },
  { label: 'Pausadas', value: 'paused' },
  { label: 'Concluídas', value: 'sent' },
  { label: 'Falhas', value: 'failed' },
]

export default function BlastsListPage() {
  const [blasts, setBlasts] = useState<BlastRow[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')

  const [dialogOpen, setDialogOpen] = useState(false)
  const [prefill, setPrefill] = useState<CampaignPrefill | undefined>()
  const [detailId, setDetailId] = useState<string | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)

  const loadBlasts = useCallback(async () => {
    try {
      const res = await fetch('/api/blasts')
      const data = await res.json()
      if (res.ok) setBlasts(data.blasts ?? [])
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    loadBlasts().finally(() => setLoading(false))
    const supabase = createClient()
    const channel = supabase
      .channel('blasts-list')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'group_blasts' }, () => void loadBlasts())
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [loadBlasts])

  const stats = useMemo(
    () => ({
      total: blasts.length,
      scheduled: blasts.filter((b) => b.status === 'scheduled').length,
      sending: blasts.filter((b) => b.status === 'sending' || b.status === 'paused').length,
      sent: blasts.filter((b) => b.status === 'sent').length,
      failed: blasts.reduce((n, b) => n + (b.failed_count || 0), 0),
    }),
    [blasts],
  )

  const filtered = useMemo(() => {
    let rows = blasts
    if (filter !== 'all') rows = rows.filter((b) => b.status === filter)
    const q = search.trim().toLowerCase()
    if (q) rows = rows.filter((b) => (b.message_text ?? b.name ?? '').toLowerCase().includes(q))
    return rows
  }, [blasts, filter, search])

  const openDetail = (id: string) => {
    setDetailId(id)
    setDetailOpen(true)
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Megaphone className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-foreground">Disparos em grupos</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Campanhas para vários grupos, com agenda, fila e anti-ban.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/blasts/calendar"
            className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-muted"
          >
            <CalendarDays className="h-4 w-4" /> Agenda
          </Link>
          <button
            onClick={() => {
              setPrefill(undefined)
              setDialogOpen(true)
            }}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" /> Criar campanha
          </button>
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
        <StatCard label="Campanhas" value={stats.total} />
        <StatCard label="Agendadas" value={stats.scheduled} accent="text-amber-500" />
        <StatCard label="Em andamento" value={stats.sending} accent="text-primary" />
        <StatCard label="Concluídas" value={stats.sent} accent="text-green-500" />
        <StatCard label="Falhas" value={stats.failed} accent="text-red-500" className="col-span-2 sm:col-span-1" />
      </div>

      {/* Filter bar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                filter === f.value
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:bg-muted'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="relative sm:w-64">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar campanha…"
            className="w-full rounded-lg border border-border bg-card py-2 pl-9 pr-3 text-sm text-foreground placeholder-muted-foreground focus:border-primary/50 focus:outline-none"
          />
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex h-64 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex h-64 flex-col items-center justify-center rounded-xl border border-border bg-card">
          <Megaphone className="mb-3 h-10 w-10 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">
            {blasts.length === 0 ? 'Nenhuma campanha ainda' : 'Nenhuma campanha neste filtro'}
          </p>
          <button
            onClick={() => {
              setPrefill(undefined)
              setDialogOpen(true)
            }}
            className="mt-4 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" /> Criar campanha
          </button>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="border-border hover:bg-transparent">
                <TableHead className="text-muted-foreground">Campanha</TableHead>
                <TableHead className="hidden text-right text-muted-foreground sm:table-cell">Grupos</TableHead>
                <TableHead className="hidden text-muted-foreground md:table-cell">Progresso</TableHead>
                <TableHead className="text-muted-foreground">Status</TableHead>
                <TableHead className="hidden text-muted-foreground lg:table-cell">Quando</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((b) => {
                const s = STATUS_LABEL[b.status] ?? STATUS_LABEL.draft
                const when = b.status === 'scheduled' && b.scheduled_at ? new Date(b.scheduled_at) : new Date(b.created_at)
                return (
                  <TableRow
                    key={b.id}
                    onClick={() => openDetail(b.id)}
                    className="cursor-pointer border-border hover:bg-muted/50"
                  >
                    <TableCell className="max-w-[24rem]">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium text-foreground">
                          {b.message_text || b.name || '(sem texto)'}
                        </span>
                        {b.mention_all && (
                          <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-medium text-sky-500">
                            <AtSign className="h-2.5 w-2.5" />todos
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="hidden text-right tabular-nums text-muted-foreground sm:table-cell">
                      {b.total_count}
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <ProgressCell sent={b.sent_count} failed={b.failed_count} total={b.total_count} />
                    </TableCell>
                    <TableCell>
                      <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${s.cls}`}>
                        {s.pulse && (
                          <span className="relative flex h-1.5 w-1.5">
                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
                          </span>
                        )}
                        {s.label}
                      </span>
                    </TableCell>
                    <TableCell className="hidden whitespace-nowrap text-sm text-muted-foreground lg:table-cell">
                      {format(when, 'dd/MM/yy HH:mm')}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <CreateCampaignDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={loadBlasts}
        prefill={prefill}
      />
      <BlastDetailSheet
        blastId={detailId}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        onChanged={loadBlasts}
        onDuplicate={(pre) => {
          setPrefill(pre)
          setDialogOpen(true)
        }}
      />
    </div>
  )
}

function StatCard({
  label,
  value,
  accent,
  className,
}: {
  label: string
  value: number
  accent?: string
  className?: string
}) {
  return (
    <div className={`rounded-xl border border-border bg-card p-4 ${className ?? ''}`}>
      <p className={`text-2xl font-bold ${accent ?? 'text-foreground'}`}>{value.toLocaleString('pt-BR')}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{label}</p>
    </div>
  )
}

function ProgressCell({ sent, failed, total }: { sent: number; failed: number; total: number }) {
  const done = total > 0 ? Math.round(((sent + failed) / total) * 100) : 0
  return (
    <div className="flex items-center gap-2">
      <span className="w-14 text-right text-xs tabular-nums text-muted-foreground">
        {sent}/{total}
      </span>
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
        <div className="h-1.5 rounded-full bg-primary" style={{ width: `${done}%` }} />
      </div>
    </div>
  )
}
