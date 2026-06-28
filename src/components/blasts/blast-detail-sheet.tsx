'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import {
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  Pause,
  Play,
  Ban,
  RotateCcw,
  Copy,
} from 'lucide-react'
import { toast } from 'sonner'
import type { CampaignPrefill } from './create-campaign-dialog'

interface Blast {
  id: string
  name: string | null
  status: string
  message_text: string | null
  media_url: string | null
  media_kind: 'image' | 'video' | 'audio' | 'document' | null
  mention_all: boolean
  total_count: number
  sent_count: number
  failed_count: number
  scheduled_at: string | null
}

interface Target {
  id: string
  group_jid: string
  conversation_id: string | null
  status: string
  error: string | null
  sent_at: string | null
  conversation: { group_name: string | null } | { group_name: string | null }[] | null
}

const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  draft: { label: 'Rascunho', cls: 'bg-muted text-muted-foreground' },
  scheduled: { label: 'Agendada', cls: 'bg-amber-500/15 text-amber-500' },
  sending: { label: 'Enviando', cls: 'bg-primary/15 text-primary' },
  paused: { label: 'Pausada', cls: 'bg-amber-500/15 text-amber-500' },
  sent: { label: 'Concluída', cls: 'bg-green-500/15 text-green-500' },
  failed: { label: 'Falhou', cls: 'bg-red-500/15 text-red-500' },
  canceled: { label: 'Cancelada', cls: 'bg-muted text-muted-foreground' },
}

function groupName(t: Target): string {
  const c = Array.isArray(t.conversation) ? t.conversation[0] : t.conversation
  return c?.group_name || 'Grupo'
}

interface Props {
  blastId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onChanged: () => void
  onDuplicate: (prefill: CampaignPrefill) => void
}

export function BlastDetailSheet({ blastId, open, onOpenChange, onChanged, onDuplicate }: Props) {
  const [blast, setBlast] = useState<Blast | null>(null)
  const [targets, setTargets] = useState<Target[]>([])
  const [loading, setLoading] = useState(false)
  const [acting, setActing] = useState(false)

  const load = useCallback(async () => {
    if (!blastId) return
    const res = await fetch(`/api/blasts/${blastId}`)
    const data = await res.json()
    if (res.ok) {
      setBlast(data.blast)
      setTargets(data.targets ?? [])
    }
  }, [blastId])

  useEffect(() => {
    if (!open || !blastId) return
    setLoading(true)
    load().finally(() => setLoading(false))

    // Live updates while the campaign runs.
    const supabase = createClient()
    const channel = supabase
      .channel(`blast:${blastId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'group_blasts', filter: `id=eq.${blastId}` }, () => void load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'group_blast_targets', filter: `blast_id=eq.${blastId}` }, () => void load())
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [open, blastId, load])

  const act = async (action: string) => {
    if (!blastId) return
    setActing(true)
    try {
      const res = await fetch(`/api/blasts/${blastId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Falha na ação')
      }
      await load()
      onChanged()
      toast.success('Feito!')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro')
    } finally {
      setActing(false)
    }
  }

  const duplicate = () => {
    if (!blast) return
    onDuplicate({
      message: blast.message_text ?? '',
      mentionAll: blast.mention_all,
      groupIds: targets.map((t) => t.conversation_id).filter((x): x is string => Boolean(x)),
      media: blast.media_url && blast.media_kind ? { url: blast.media_url, kind: blast.media_kind, name: 'mídia' } : null,
    })
    onOpenChange(false)
  }

  const pending = targets.filter((t) => t.status === 'pending').length
  const s = blast ? STATUS_LABEL[blast.status] ?? STATUS_LABEL.draft : null

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            Campanha
            {s && <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${s.cls}`}>{s.label}</span>}
          </SheetTitle>
          <SheetDescription className="line-clamp-2">
            {blast?.message_text || '(sem texto)'}
          </SheetDescription>
        </SheetHeader>

        {loading && !blast ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : blast ? (
          <div className="space-y-4 px-4 pb-6">
            {/* Stats */}
            <div className="grid grid-cols-3 gap-2">
              <Stat label="Enviados" value={blast.sent_count} icon={<CheckCircle2 className="h-4 w-4 text-green-500" />} />
              <Stat label="Falhas" value={blast.failed_count} icon={<XCircle className="h-4 w-4 text-red-500" />} />
              <Stat label="Pendentes" value={pending} icon={<Clock className="h-4 w-4 text-muted-foreground" />} />
            </div>

            {/* Ações */}
            <div className="flex flex-wrap gap-2">
              {blast.status === 'sending' && (
                <ActionBtn onClick={() => act('pause')} disabled={acting} icon={<Pause className="h-4 w-4" />}>Pausar</ActionBtn>
              )}
              {blast.status === 'paused' && (
                <ActionBtn onClick={() => act('resume')} disabled={acting} icon={<Play className="h-4 w-4" />}>Retomar</ActionBtn>
              )}
              {['scheduled', 'sending', 'paused'].includes(blast.status) && (
                <ActionBtn onClick={() => act('cancel')} disabled={acting} icon={<Ban className="h-4 w-4" />}>Cancelar</ActionBtn>
              )}
              {blast.failed_count > 0 && ['sent', 'failed'].includes(blast.status) && (
                <ActionBtn onClick={() => act('retry')} disabled={acting} icon={<RotateCcw className="h-4 w-4" />}>Reenviar falhas</ActionBtn>
              )}
              <ActionBtn onClick={duplicate} disabled={acting} icon={<Copy className="h-4 w-4" />}>Duplicar</ActionBtn>
            </div>

            {/* Tabela por grupo */}
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Grupo</th>
                    <th className="px-3 py-2 text-right font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {targets.map((t) => {
                    const ts = STATUS_LABEL[t.status] ?? STATUS_LABEL.draft
                    return (
                      <tr key={t.id} className="border-t border-border">
                        <td className="px-3 py-2">
                          <span className="text-foreground">{groupName(t)}</span>
                          {t.error && <span className="block truncate text-[11px] text-red-500" title={t.error}>{t.error}</span>}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${ts.cls}`}>{ts.label}</span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

function Stat({ label, value, icon }: { label: string; value: number; icon: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3 text-center">
      <div className="flex justify-center">{icon}</div>
      <p className="mt-1 text-xl font-bold text-foreground">{value}</p>
      <p className="text-[11px] text-muted-foreground">{label}</p>
    </div>
  )
}

function ActionBtn({
  onClick,
  disabled,
  icon,
  children,
}: {
  onClick: () => void
  disabled?: boolean
  icon: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm text-foreground hover:bg-muted disabled:opacity-60"
    >
      {icon}
      {children}
    </button>
  )
}
