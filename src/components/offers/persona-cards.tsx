'use client'

import { Baby, Dumbbell, Gem, PawPrint, Sparkles, User } from 'lucide-react'
import { OFFER_PERSONAS, type OfferPersonaKey } from '@/lib/offers/personas'

const PERSONA_ICON: Record<OfferPersonaKey, typeof Sparkles> = {
  padrao: Sparkles,
  maes: Baby,
  pet: PawPrint,
  beleza: Gem,
  homens: User,
  fitness: Dumbbell,
}

interface Props {
  value: OfferPersonaKey
  onChange: (persona: OfferPersonaKey) => void
  disabled?: boolean
}

/** Single-select persona grid. Picks the tone the AI copy is written in. */
export function PersonaCards({ value, onChange, disabled }: Props) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {OFFER_PERSONAS.map((p) => {
        const Icon = PERSONA_ICON[p.key]
        const active = value === p.key
        return (
          <button
            key={p.key}
            type="button"
            disabled={disabled}
            onClick={() => onChange(p.key)}
            className={`flex flex-col items-start gap-1 rounded-xl border p-3 text-left transition-colors disabled:opacity-60 ${
              active
                ? 'border-primary bg-primary/10'
                : 'border-border bg-card hover:border-primary/40 hover:bg-muted/50'
            }`}
          >
            <span
              className={`flex h-8 w-8 items-center justify-center rounded-lg ${
                active ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground'
              }`}
            >
              <Icon className="h-4 w-4" />
            </span>
            <span className={`text-sm font-medium ${active ? 'text-primary' : 'text-foreground'}`}>
              {p.label}
            </span>
            <span className="text-[11px] leading-tight text-muted-foreground">{p.description}</span>
          </button>
        )
      })}
    </div>
  )
}
