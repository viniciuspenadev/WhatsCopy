'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import {
  Sparkles,
  Loader2,
  Link2,
  Tag,
  Send,
  Save,
  Wand2,
  RefreshCw,
} from 'lucide-react'
import { PersonaCards } from '@/components/offers/persona-cards'
import { WhatsappPreview } from '@/components/blasts/whatsapp-preview'
import {
  CreateCampaignDialog,
  type CampaignPrefill,
} from '@/components/blasts/create-campaign-dialog'
import type { OfferPersonaKey } from '@/lib/offers/personas'

interface OfferRow {
  id: string
  source_url: string
  marketplace: string
  title: string | null
  image_url: string | null
  price_from_cents: number | null
  price_to_cents: number | null
  generated_copy: string | null
  edited_copy: string | null
  persona: string
}

export default function OffersPage() {
  const [url, setUrl] = useState('')
  const [persona, setPersona] = useState<OfferPersonaKey>('padrao')
  const [coupon, setCoupon] = useState('')
  const [affiliateUrl, setAffiliateUrl] = useState('')

  const [generating, setGenerating] = useState(false)
  const [offer, setOffer] = useState<OfferRow | null>(null)
  const [copy, setCopy] = useState('')
  const [saving, setSaving] = useState(false)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [prefill, setPrefill] = useState<CampaignPrefill | undefined>()

  const generate = async () => {
    if (!/^https?:\/\//i.test(url.trim())) {
      toast.error('Cole uma URL de produto válida (com https://).')
      return
    }
    setGenerating(true)
    try {
      const res = await fetch('/api/offers/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: url.trim(),
          persona,
          coupon: coupon.trim() || undefined,
          affiliate_url: affiliateUrl.trim() || undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error ?? 'Não foi possível gerar a oferta.')
        return
      }
      const o = data.offer as OfferRow
      setOffer(o)
      setCopy(o.edited_copy || o.generated_copy || '')
      toast.success('Oferta gerada!')
    } catch {
      toast.error('Erro de rede ao gerar a oferta.')
    } finally {
      setGenerating(false)
    }
  }

  const save = async () => {
    if (!offer) return
    setSaving(true)
    try {
      const res = await fetch(`/api/offers/${offer.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ edited_copy: copy }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        toast.error(data.error ?? 'Falha ao salvar.')
        return
      }
      toast.success('Oferta salva.')
    } catch {
      toast.error('Erro de rede ao salvar.')
    } finally {
      setSaving(false)
    }
  }

  const blast = () => {
    if (!offer) return
    const pre: CampaignPrefill = {
      message: copy,
      media: offer.image_url
        ? { url: offer.image_url, kind: 'image', name: offer.title ?? 'oferta' }
        : null,
    }
    setPrefill(pre)
    setDialogOpen(true)
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-2.5">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Sparkles className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-foreground">Gerador de ofertas</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Cole o link do produto, escolha a persona e a IA escreve o anúncio pronto para disparar.
          </p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
        {/* ---- Form ---- */}
        <div className="space-y-5">
          {/* URL */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Link do produto</label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Link2 className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://… (Mercado Livre, Shopee, Amazon)"
                  className="w-full rounded-lg border border-border bg-card py-2.5 pl-9 pr-3 text-sm text-foreground placeholder-muted-foreground focus:border-primary/50 focus:outline-none"
                />
              </div>
              <button
                onClick={generate}
                disabled={generating}
                className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
              >
                {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
                {offer ? 'Gerar de novo' : 'Gerar oferta'}
              </button>
            </div>
          </div>

          {/* Persona */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Persona</label>
            <PersonaCards value={persona} onChange={setPersona} disabled={generating} />
          </div>

          {/* Coupon + affiliate link */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Cupom (opcional)</label>
              <div className="relative">
                <Tag className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={coupon}
                  onChange={(e) => setCoupon(e.target.value)}
                  placeholder="PROMO10"
                  className="w-full rounded-lg border border-border bg-card py-2 pl-9 pr-3 text-sm text-foreground placeholder-muted-foreground focus:border-primary/50 focus:outline-none"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Link de afiliado (opcional)</label>
              <div className="relative">
                <Link2 className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={affiliateUrl}
                  onChange={(e) => setAffiliateUrl(e.target.value)}
                  placeholder="https://seu.link/afiliado"
                  className="w-full rounded-lg border border-border bg-card py-2 pl-9 pr-3 text-sm text-foreground placeholder-muted-foreground focus:border-primary/50 focus:outline-none"
                />
              </div>
            </div>
          </div>

          {/* Editor (after generation) */}
          {offer && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-foreground">Texto da oferta</label>
                <span className="text-[11px] text-muted-foreground">Edite à vontade — o preview atualiza ao lado.</span>
              </div>
              <textarea
                value={copy}
                onChange={(e) => setCopy(e.target.value)}
                rows={10}
                className="w-full resize-y rounded-lg border border-border bg-card p-3 text-sm text-foreground placeholder-muted-foreground focus:border-primary/50 focus:outline-none"
              />
            </div>
          )}
        </div>

        {/* ---- Preview ---- */}
        <div className="space-y-3 lg:sticky lg:top-4 lg:self-start">
          <p className="text-sm font-medium text-foreground">Pré-visualização</p>
          {generating && !offer ? (
            <div className="flex h-56 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-card text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
              <span className="text-sm">Lendo o produto e escrevendo a oferta…</span>
            </div>
          ) : offer ? (
            <>
              <WhatsappPreview text={copy} mediaUrl={offer.image_url} mediaKind="image" />
              <div className="flex gap-2">
                <button
                  onClick={save}
                  disabled={saving}
                  className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg border border-border px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-60"
                >
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  Salvar oferta
                </button>
                <button
                  onClick={blast}
                  className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                >
                  <Send className="h-4 w-4" /> Disparar agora
                </button>
              </div>
              {offer.image_url == null && (
                <p className="flex items-center gap-1.5 text-[11px] text-amber-500">
                  <RefreshCw className="h-3 w-3" /> Não consegui capturar a imagem — o disparo irá só com texto.
                </p>
              )}
            </>
          ) : (
            <div className="flex h-56 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-card px-6 text-center text-muted-foreground">
              <Sparkles className="h-6 w-6 text-muted-foreground" />
              <span className="text-sm">Cole um link e clique em “Gerar oferta” para ver a mensagem aqui.</span>
            </div>
          )}
        </div>
      </div>

      <CreateCampaignDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={() => toast.success('Campanha criada a partir da oferta!')}
        prefill={prefill}
      />
    </div>
  )
}
