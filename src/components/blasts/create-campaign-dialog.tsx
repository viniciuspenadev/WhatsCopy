'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import {
  Loader2,
  Send,
  Paperclip,
  X,
  Users,
  Search,
  RefreshCw,
  AlertTriangle,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  uploadAccountMedia,
  deleteAccountMedia,
  MEDIA_MAX_BYTES_BY_KIND,
} from '@/lib/storage/upload-media'
import { WhatsappPreview } from './whatsapp-preview'

const CHAT_MEDIA_BUCKET = 'chat-media'
type MediaKind = 'image' | 'video' | 'audio' | 'document'

function detectKind(type: string): MediaKind {
  if (type.startsWith('image/')) return 'image'
  if (type.startsWith('video/')) return 'video'
  if (type.startsWith('audio/')) return 'audio'
  return 'document'
}

interface GroupRow {
  id: string
  group_name: string | null
}

export interface CampaignPrefill {
  message?: string
  mentionAll?: boolean
  groupIds?: string[]
  media?: { url: string; kind: MediaKind; name: string } | null
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: () => void
  /** datetime-local value (yyyy-MM-ddTHH:mm) when opened from a calendar day. */
  prefillDate?: string
  /** Prefill from a duplicated campaign. */
  prefill?: CampaignPrefill
}

export function CreateCampaignDialog({ open, onOpenChange, onCreated, prefillDate, prefill }: Props) {
  const [groups, setGroups] = useState<GroupRow[]>([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)

  const [message, setMessage] = useState('')
  const [mentionAll, setMentionAll] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [mode, setMode] = useState<'now' | 'schedule'>('now')
  const [scheduledAt, setScheduledAt] = useState('')
  const [media, setMedia] = useState<{ url: string; kind: MediaKind; path?: string; name: string } | null>(null)
  const [uploading, setUploading] = useState(false)
  const [creating, setCreating] = useState(false)

  const loadGroups = useCallback(async () => {
    const supabase = createClient()
    const { data } = await supabase
      .from('conversations')
      .select('id, group_name')
      .eq('is_group', true)
      .order('group_name', { ascending: true })
    setGroups((data as GroupRow[]) ?? [])
  }, [])

  const syncGroups = useCallback(async () => {
    setSyncing(true)
    try {
      const res = await fetch('/api/whatsapp/groups/sync', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Falha ao sincronizar')
      await loadGroups()
      if (data.synced > 0) toast.success(`${data.synced} grupo(s) sincronizado(s).`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao sincronizar grupos')
    } finally {
      setSyncing(false)
    }
  }, [loadGroups])

  // Reset + prefill whenever the dialog opens.
  useEffect(() => {
    if (!open) return
    setMessage(prefill?.message ?? '')
    setMentionAll(prefill?.mentionAll ?? false)
    setSelected(new Set(prefill?.groupIds ?? []))
    setMedia(prefill?.media ?? null)
    setSearch('')
    if (prefillDate) {
      setMode('schedule')
      setScheduledAt(prefillDate)
    } else {
      setMode('now')
      setScheduledAt('')
    }
    setLoading(true)
    ;(async () => {
      await loadGroups()
      setLoading(false)
      void syncGroups()
    })()
  }, [open, prefill, prefillDate, loadGroups, syncGroups])

  const filteredGroups = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return groups
    return groups.filter((g) => (g.group_name ?? '').toLowerCase().includes(q))
  }, [groups, search])

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const kind = detectKind(file.type)
    if (file.size > MEDIA_MAX_BYTES_BY_KIND[kind]) {
      return toast.error(`Arquivo muito grande (máx ${Math.round(MEDIA_MAX_BYTES_BY_KIND[kind] / 1024 / 1024)}MB).`)
    }
    setUploading(true)
    try {
      const { publicUrl, path } = await uploadAccountMedia(CHAT_MEDIA_BUCKET, file)
      setMedia({ url: publicUrl, kind, path, name: file.name })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha no upload')
    } finally {
      setUploading(false)
    }
  }

  const removeMedia = () => {
    if (media?.path) void deleteAccountMedia(CHAT_MEDIA_BUCKET, media.path).catch(() => {})
    setMedia(null)
  }

  const submit = async () => {
    if (selected.size === 0) return toast.error('Selecione ao menos um grupo.')
    if (!message.trim() && !media) return toast.error('Escreva a mensagem ou anexe uma mídia.')
    if (mode === 'schedule' && !scheduledAt) return toast.error('Defina a data/hora.')
    setCreating(true)
    try {
      const res = await fetch('/api/blasts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message_text: message,
          media_url: media?.url,
          media_kind: media?.kind,
          mention_all: mentionAll,
          conversation_ids: Array.from(selected),
          send_now: mode === 'now',
          scheduled_at: mode === 'schedule' ? new Date(scheduledAt).toISOString() : undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Falha ao criar campanha')
      toast.success(mode === 'now' ? 'Disparo iniciado!' : 'Campanha agendada!')
      onCreated()
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro')
    } finally {
      setCreating(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl lg:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Criar campanha</DialogTitle>
          <DialogDescription>
            Monte a mensagem, escolha os grupos e veja o preview antes de disparar.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-5 sm:grid-cols-[1.4fr_1fr]">
          {/* ---- Coluna de inputs ---- */}
          <div className="space-y-4">
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={4}
              placeholder="Escreva a oferta…"
              className="w-full resize-y rounded-lg border border-border bg-muted p-3 text-sm text-foreground placeholder-muted-foreground focus:border-primary/50 focus:outline-none"
            />

            {/* Mídia */}
            {media ? (
              <div className="flex items-center gap-3 rounded-lg border border-border bg-background p-2">
                {media.kind === 'image' ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={media.url} alt="" className="h-12 w-12 rounded object-cover" />
                ) : (
                  <div className="flex h-12 w-12 items-center justify-center rounded bg-muted">
                    <Paperclip className="h-5 w-5 text-muted-foreground" />
                  </div>
                )}
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">{media.name}</span>
                <button onClick={removeMedia} aria-label="Remover" className="rounded-md p-1 text-muted-foreground hover:bg-muted">
                  <X className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <label className="inline-flex w-fit cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-foreground hover:bg-muted">
                {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
                {uploading ? 'Enviando…' : 'Anexar imagem/vídeo'}
                <input type="file" accept="image/*,video/*,application/pdf" className="hidden" onChange={onPickFile} disabled={uploading} />
              </label>
            )}

            {/* @todos */}
            <div className="flex items-start justify-between gap-3 rounded-lg border border-border bg-background p-3">
              <div>
                <p className="text-sm font-medium text-foreground">Mencionar todos (@todos)</p>
                <p className="mt-0.5 flex items-center gap-1 text-xs text-amber-500">
                  <AlertTriangle className="h-3 w-3" /> Aumenta o risco de ban. Use com moderação.
                </p>
              </div>
              <Switch checked={mentionAll} onCheckedChange={setMentionAll} />
            </div>

            {/* Grupos */}
            <div className="rounded-lg border border-border">
              <div className="flex items-center justify-between gap-2 border-b border-border p-2">
                <div className="relative flex-1">
                  <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Buscar grupo…"
                    className="w-full rounded-md bg-muted py-1.5 pl-8 pr-2 text-sm text-foreground placeholder-muted-foreground focus:outline-none"
                  />
                </div>
                <button onClick={() => void syncGroups()} disabled={syncing} title="Sincronizar" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-60">
                  <RefreshCw className={`h-3.5 w-3.5 ${syncing ? 'animate-spin' : ''}`} />
                </button>
                <button onClick={() => setSelected(new Set(filteredGroups.map((g) => g.id)))} className="text-xs text-primary hover:underline">
                  Todos
                </button>
                <button onClick={() => setSelected(new Set())} className="text-xs text-muted-foreground hover:underline">
                  Limpar
                </button>
              </div>
              <div className="max-h-40 overflow-y-auto p-1">
                {loading ? (
                  <div className="flex justify-center py-6">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                ) : filteredGroups.length === 0 ? (
                  <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                    Nenhum grupo. Toque em sincronizar.
                  </p>
                ) : (
                  filteredGroups.map((g) => (
                    <label key={g.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/60">
                      <input type="checkbox" checked={selected.has(g.id)} onChange={() => toggle(g.id)} />
                      <Users className="h-4 w-4 text-muted-foreground" />
                      <span className="truncate text-foreground">{g.group_name || 'Grupo'}</span>
                    </label>
                  ))
                )}
              </div>
            </div>

            {/* Agendamento */}
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-1.5 text-sm text-foreground">
                <input type="radio" checked={mode === 'now'} onChange={() => setMode('now')} /> Enviar agora
              </label>
              <label className="flex items-center gap-1.5 text-sm text-foreground">
                <input type="radio" checked={mode === 'schedule'} onChange={() => setMode('schedule')} /> Agendar
              </label>
              {mode === 'schedule' && (
                <input
                  type="datetime-local"
                  value={scheduledAt}
                  onChange={(e) => setScheduledAt(e.target.value)}
                  className="rounded-md border border-border bg-muted px-2 py-1 text-sm text-foreground"
                />
              )}
            </div>
          </div>

          {/* ---- Coluna de preview ---- */}
          <div className="space-y-2 sm:sticky sm:top-0 sm:self-start">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Preview</p>
            <WhatsappPreview
              text={message}
              mediaUrl={media?.url}
              mediaKind={media?.kind}
              mentionAll={mentionAll}
            />
            <p className="text-xs text-muted-foreground">{selected.size} grupo(s) selecionado(s)</p>
          </div>
        </div>

        <div className="mt-2 flex justify-end gap-2">
          <button onClick={() => onOpenChange(false)} className="rounded-lg border border-border px-4 py-2 text-sm text-foreground hover:bg-muted">
            Cancelar
          </button>
          <button
            onClick={submit}
            disabled={creating}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
          >
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {mode === 'now' ? 'Disparar' : 'Agendar'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
