import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { scrapeProduct } from '@/lib/offers/scrape'
import { isOfferPersona } from '@/lib/offers/personas'
import {
  loadPlatformAISettings,
  getCopyProvider,
  composeOfferCopy,
} from '@/lib/offers/ai-copy'
import { uploadAccountMediaFromUrl } from '@/lib/storage/upload-media-server'

const CHAT_MEDIA_BUCKET = 'chat-media'

/**
 * POST /api/offers/generate
 * Body: { url, persona, coupon?, affiliate_url? }
 *
 * Scrape product → re-host image → AI copy by persona → persist offer.
 */
export async function POST(request: Request) {
  const { supabase, accountId, userId } = await resolveAccount()
  if (!accountId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => ({}))
  const { url, persona, coupon, affiliate_url } = body as {
    url?: string
    persona?: string
    coupon?: string
    affiliate_url?: string
  }

  if (!url || !/^https?:\/\//i.test(url)) {
    return NextResponse.json({ error: 'Informe uma URL de produto válida.' }, { status: 400 })
  }
  if (!isOfferPersona(persona)) {
    return NextResponse.json({ error: 'Persona inválida.' }, { status: 400 })
  }

  // 1. Scrape the marketplace page (best-effort).
  const scraped = await scrapeProduct(url)

  // 2. Re-host the product image in our bucket (CDN URLs expire / block hotlink).
  let imagePath: string | null = null
  let imagePublicUrl: string | null = scraped.imageUrl
  if (scraped.imageUrl) {
    const uploaded = await uploadAccountMediaFromUrl(CHAT_MEDIA_BUCKET, accountId, scraped.imageUrl)
    if (uploaded) {
      imagePath = uploaded.path
      imagePublicUrl = uploaded.publicUrl
    }
  }

  // 3. Generate the copy with the operator-configured model.
  const settings = await loadPlatformAISettings()
  let copyText: string
  let generatedCopy: string
  try {
    const provider = getCopyProvider(settings)
    const result = await provider.generate({
      title: scraped.title,
      priceFromCents: scraped.priceFromCents,
      priceToCents: scraped.priceToCents,
      coupon: coupon?.trim() || null,
      affiliateUrl: affiliate_url?.trim() || null,
      persona,
    })
    generatedCopy = composeOfferCopy(result, {
      title: scraped.title,
      priceFromCents: scraped.priceFromCents,
      priceToCents: scraped.priceToCents,
      coupon: coupon?.trim() || null,
      affiliateUrl: affiliate_url?.trim() || null,
      persona,
    })
    copyText = generatedCopy
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Falha ao gerar o texto com a IA.'
    return NextResponse.json({ error: msg }, { status: 502 })
  }

  // 4. Persist the offer (RLS: agent+ on this account).
  const { data: offer, error: insErr } = await supabase
    .from('offers')
    .insert({
      account_id: accountId,
      created_by: userId,
      source_url: url,
      marketplace: scraped.marketplace,
      title: scraped.title,
      image_url: imagePublicUrl,
      image_path: imagePath,
      price_from_cents: scraped.priceFromCents,
      price_to_cents: scraped.priceToCents,
      coupon: coupon?.trim() || null,
      affiliate_url: affiliate_url?.trim() || null,
      persona,
      generated_copy: generatedCopy,
      edited_copy: null,
      ai_provider: settings.aiProvider,
      ai_model: settings.aiModel,
    })
    .select('*')
    .single()

  if (insErr || !offer) {
    return NextResponse.json({ error: insErr?.message ?? 'Falha ao salvar a oferta.' }, { status: 500 })
  }

  return NextResponse.json({ offer, copy: copyText })
}

async function resolveAccount() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { supabase, accountId: null, userId: null }
  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .maybeSingle()
  return {
    supabase,
    accountId: (profile?.account_id as string | undefined) ?? null,
    userId: user.id,
  }
}
