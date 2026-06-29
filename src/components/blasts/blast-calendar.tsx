'use client'

import { useMemo, useState } from 'react'
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  startOfMonth,
  startOfWeek,
  subMonths,
} from 'date-fns'
import { ptBR } from 'date-fns/locale'
import { ChevronLeft, ChevronRight } from 'lucide-react'

interface CalBlast {
  id: string
  message_text: string | null
  status: string
  scheduled_at: string | null
}

const STATUS_DOT: Record<string, string> = {
  scheduled: 'bg-amber-500',
  sending: 'bg-primary',
  paused: 'bg-amber-500',
  sent: 'bg-green-500',
  failed: 'bg-red-500',
  canceled: 'bg-muted-foreground',
}

const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']

interface Props {
  blasts: CalBlast[]
  /** Receives a datetime-local string (yyyy-MM-ddTHH:mm) for the clicked day. */
  onDayClick: (datetimeLocal: string) => void
  onBlastClick: (id: string) => void
}

export function BlastCalendar({ blasts, onDayClick, onBlastClick }: Props) {
  const [cursor, setCursor] = useState(() => new Date())

  const days = useMemo(() => {
    const start = startOfWeek(startOfMonth(cursor), { weekStartsOn: 0 })
    const end = endOfWeek(endOfMonth(cursor), { weekStartsOn: 0 })
    return eachDayOfInterval({ start, end })
  }, [cursor])

  const byDay = useMemo(() => {
    const map = new Map<string, CalBlast[]>()
    for (const b of blasts) {
      if (!b.scheduled_at) continue
      const key = format(new Date(b.scheduled_at), 'yyyy-MM-dd')
      const arr = map.get(key) ?? []
      arr.push(b)
      map.set(key, arr)
    }
    return map
  }, [blasts])

  return (
    <div className="rounded-xl border border-border bg-card p-3">
      {/* Header */}
      <div className="mb-2 flex items-center justify-between">
        <button onClick={() => setCursor((c) => subMonths(c, 1))} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted">
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="text-sm font-semibold capitalize text-foreground">
          {format(cursor, 'MMMM yyyy', { locale: ptBR })}
        </span>
        <button onClick={() => setCursor((c) => addMonths(c, 1))} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted">
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      {/* Weekday row */}
      <div className="grid grid-cols-7 text-center text-[11px] font-medium text-muted-foreground">
        {WEEKDAYS.map((w) => (
          <div key={w} className="py-1">
            {w}
          </div>
        ))}
      </div>

      {/* Days */}
      <div className="grid grid-cols-7 gap-1">
        {days.map((day) => {
          const key = format(day, 'yyyy-MM-dd')
          const dayBlasts = byDay.get(key) ?? []
          const inMonth = isSameMonth(day, cursor)
          const today = isSameDay(day, new Date())
          return (
            <button
              key={key}
              onClick={() => onDayClick(`${key}T09:00`)}
              className={`flex min-h-[5.5rem] flex-col rounded-md border p-1 text-left transition-colors hover:border-primary/50 sm:min-h-[7rem] ${
                inMonth ? 'border-border bg-background' : 'border-transparent bg-muted/30'
              }`}
            >
              <span className={`text-[11px] ${today ? 'font-bold text-primary' : inMonth ? 'text-foreground' : 'text-muted-foreground'}`}>
                {format(day, 'd')}
              </span>
              <div className="mt-0.5 space-y-0.5 overflow-hidden">
                {dayBlasts.slice(0, 3).map((b) => (
                  <span
                    key={b.id}
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation()
                      onBlastClick(b.id)
                    }}
                    className="flex items-center gap-1 truncate rounded bg-muted px-1 py-0.5 text-[10px] text-foreground hover:bg-muted/70"
                  >
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[b.status] ?? 'bg-muted-foreground'}`} />
                    <span className="truncate">{b.message_text || 'Campanha'}</span>
                  </span>
                ))}
                {dayBlasts.length > 3 && (
                  <span className="px-1 text-[10px] text-muted-foreground">+{dayBlasts.length - 3}</span>
                )}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
