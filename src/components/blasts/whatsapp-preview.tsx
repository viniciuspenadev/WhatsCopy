'use client'

import { CheckCheck } from 'lucide-react'

interface WhatsappPreviewProps {
  text: string
  mediaUrl?: string | null
  mediaKind?: 'image' | 'video' | 'audio' | 'document' | null
  mentionAll?: boolean
  className?: string
}

/** Highlight @todos mentions and URLs the way WhatsApp tints them. */
function renderRich(text: string) {
  const parts = text.split(/(@todos|https?:\/\/[^\s]+)/gi)
  return parts.map((p, i) => {
    if (/^@todos$/i.test(p)) {
      return (
        <span key={i} className="font-medium text-sky-300">
          {p}
        </span>
      )
    }
    if (/^https?:\/\//i.test(p)) {
      return (
        <span key={i} className="text-sky-300 underline">
          {p}
        </span>
      )
    }
    return <span key={i}>{p}</span>
  })
}

/**
 * Faithful WhatsApp outgoing-bubble preview over the chat doodle. Used by the
 * campaign composer (and reused by the offer generator) so users see exactly
 * how the message lands before sending.
 */
export function WhatsappPreview({
  text,
  mediaUrl,
  mediaKind,
  mentionAll,
  className,
}: WhatsappPreviewProps) {
  const display = mentionAll && !/@todos/i.test(text) ? `@todos\n${text}`.trim() : text
  const time = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })

  return (
    <div className={`overflow-hidden rounded-xl border border-border ${className ?? ''}`}>
      <div className="flex min-h-[14rem] flex-col justify-end bg-[#0b141a] bg-[url('/inbox-doodle.svg')] bg-repeat p-3">
        <div className="ml-auto max-w-[85%] rounded-lg rounded-tr-sm bg-[#005c4b] p-1 text-white shadow">
          {mediaUrl && mediaKind === 'image' && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={mediaUrl} alt="" className="mb-1 max-h-48 w-full rounded-md object-cover" />
          )}
          {mediaUrl && mediaKind === 'video' && (
            <video src={mediaUrl} className="mb-1 max-h-48 w-full rounded-md object-cover" />
          )}
          {mediaUrl && (mediaKind === 'document' || mediaKind === 'audio') && (
            <div className="mb-1 rounded-md bg-white/10 px-2 py-3 text-xs text-white/80">
              📎 {mediaKind === 'audio' ? 'Áudio' : 'Documento'}
            </div>
          )}
          {display.trim().length > 0 && (
            <p className="whitespace-pre-wrap break-words px-1.5 pt-0.5 text-sm leading-snug">
              {renderRich(display)}
            </p>
          )}
          <div className="flex items-center justify-end gap-1 px-1.5 pb-0.5 pt-1 text-[10px] text-white/60">
            {time}
            <CheckCheck className="h-3 w-3 text-sky-400" />
          </div>
        </div>
      </div>
    </div>
  )
}
