'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Megaphone, Plus, Loader2, List, CalendarDays } from 'lucide-react'
import { format } from 'date-fns'
import { CreateCampaignDialog, type CampaignPrefill } from '@/components/blasts/create-campaign-dialog'
import { BlastCalendar } from '@/components/blasts/blast-calendar'
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

const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  draft: { label: 'Rascunho', cls: 'bg-muted text-muted-foreground' },
  scheduled: { label: 'Agendada', cls: 'bg-amber-500/15 text-amber-500' },
  sending: { label: 'Enviando', cls: 'bg-primary/15 text-primary' },
  paused: { label: 'Pausada', cls: 'bg-amber-500/15 text-amber-500' },
  sent: { label: 'Concluída', cls: 'bg-green-500/15 text-green-500' },
  failed: { label: 'Falhou', cls: 'bg-red-500/15 text-red-500' },
  canceled: { label: 'Cancelada', cls: 'bg-muted text-muted-foreground' },
}

export default function BlastsPage() {
  const [blasts, setBlasts] = useState<BlastRow[]>([])
  const [loading, setLoading] = useState(true)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [prefillDate, setPrefillDate] = useState<string | undefined>(undefined)
  const [prefill, setPrefill] = useState<CampaignPrefill | undefined>(undefined)

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
    // Keep the list fresh while campaigns run.
    const supabase = createClient()
    const channel = supabase
      .channel('blasts-list')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'group_blasts' }, () => void loadBlasts())
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [loadBlasts])

  const openCreate = (date?: string, pre?: CampaignPrefill) => {
    setPrefillDate(date)
    setPrefill(pre)
    setDialogOpen(true)
  }

  const openDetail = (id: string) => {
    setDetailId(id)
    setDetailOpen(true)
  }

  return (
    <div className="mx-auto max-w-4xl space-y-5 py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Megaphone className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold text-foreground">Disparos em grupos</h1>
            <p className="text-sm text-muted-foreground">Campanhas para vários grupos, com agenda e anti-ban.</p>
          </div>
        </div>
        <button
          onClick={() => openCreate()}
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <Plus className="h-4 w-4" /> Criar campanha
        </button>
      </div>

      <Tabs defaultValue="list">
        <TabsList>
          <TabsTrigger value="list">
            <List className="mr-1.5 h-4 w-4" /> Lista
          </TabsTrigger>
          <TabsTrigger value="calendar">
            <CalendarDays className="mr-1.5 h-4 w-4" /> Calendário
          </TabsTrigger>
        </TabsList>

        {/* Lista */}
        <TabsContent value="list" className="mt-4 space-y-2">
          {loading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : blasts.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border p-10 text-center">
              <p className="text-sm text-muted-foreground">Nenhuma campanha ainda.</p>
              <button onClick={() => openCreate()} className="mt-3 text-sm font-medium text-primary hover:underline">
                Criar a primeira
              </button>
            </div>
          ) : (
            blasts.map((b) => {
              const s = STATUS_LABEL[b.status] ?? STATUS_LABEL.draft
              return (
                <button
                  key={b.id}
                  onClick={() => openDetail(b.id)}
                  className="flex w-full items-center justify-between gap-3 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:border-primary/40"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm text-foreground">{b.message_text || b.name || '(sem texto)'}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {b.sent_count}/{b.total_count} enviados
                      {b.failed_count > 0 && ` · ${b.failed_count} falhas`}
                      {b.mention_all && ' · @todos'}
                      {b.scheduled_at && b.status === 'scheduled' && ` · ${format(new Date(b.scheduled_at), "dd/MM HH:mm")}`}
                    </p>
                  </div>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${s.cls}`}>{s.label}</span>
                </button>
              )
            })
          )}
        </TabsContent>

        {/* Calendário */}
        <TabsContent value="calendar" className="mt-4">
          <BlastCalendar
            blasts={blasts}
            onDayClick={(dt) => openCreate(dt)}
            onBlastClick={(id) => openDetail(id)}
          />
        </TabsContent>
      </Tabs>

      <CreateCampaignDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={loadBlasts}
        prefillDate={prefillDate}
        prefill={prefill}
      />

      <BlastDetailSheet
        blastId={detailId}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        onChanged={loadBlasts}
        onDuplicate={(pre) => openCreate(undefined, pre)}
      />
    </div>
  )
}
