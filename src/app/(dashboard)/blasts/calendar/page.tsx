'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { CalendarDays, Plus, List, Loader2 } from 'lucide-react'
import { BlastCalendar } from '@/components/blasts/blast-calendar'
import { CreateCampaignDialog, type CampaignPrefill } from '@/components/blasts/create-campaign-dialog'
import { BlastDetailSheet } from '@/components/blasts/blast-detail-sheet'

interface BlastRow {
  id: string
  message_text: string | null
  status: string
  scheduled_at: string | null
}

export default function BlastsCalendarPage() {
  const [blasts, setBlasts] = useState<BlastRow[]>([])
  const [loading, setLoading] = useState(true)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [prefillDate, setPrefillDate] = useState<string | undefined>()
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
      .channel('blasts-calendar')
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

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <CalendarDays className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-foreground">Agenda de disparos</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Veja os agendamentos e crie uma campanha clicando no dia.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/blasts"
            className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-muted"
          >
            <List className="h-4 w-4" /> Lista
          </Link>
          <button
            onClick={() => openCreate()}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" /> Criar campanha
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex h-64 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : (
        <BlastCalendar
          blasts={blasts}
          onDayClick={(dt) => openCreate(dt)}
          onBlastClick={(id) => {
            setDetailId(id)
            setDetailOpen(true)
          }}
        />
      )}

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
