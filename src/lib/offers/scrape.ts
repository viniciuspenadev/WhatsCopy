/**
 * Marketplace product scraper.
 *
 * Detects the marketplace by hostname, fetches the product page HTML with a
 * browser UA, and extracts {title, image, price} in layers:
 *   1. JSON-LD  (<script type="application/ld+json"> @type Product) — richest
 *   2. OpenGraph (og:title / og:image / product:price:amount) — reliable
 *   3. Marketplace-specific regex fallback
 *
 * This is intentionally dependency-free (regex over the HTML string, no DOM
 * library). It is FRAGILE by nature — marketplaces change markup and deploy
 * anti-bot. Every field is optional; the caller falls back to manual editing
 * when scraping comes up empty. Official affiliate APIs are the robust path
 * later (Fase C+).
 */

export type Marketplace = 'ml' | 'shopee' | 'amazon' | 'other'

export interface ScrapedProduct {
  marketplace: Marketplace
  title: string | null
  imageUrl: string | null
  priceFromCents: number | null
  priceToCents: number | null
}

export function detectMarketplace(url: string): Marketplace {
  let host = ''
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return 'other'
  }
  if (host.includes('mercadolivre') || host.includes('mercadolibre') || host.includes('mlstatic')) return 'ml'
  if (host.includes('shopee')) return 'shopee'
  if (host.includes('amazon') || host.includes('amzn')) return 'amazon'
  return 'other'
}

/** Parse a BRL-ish price string ("R$ 1.299,90" / "1299.90") into cents. */
function priceToCents(raw: unknown): number | null {
  if (raw == null) return null
  let s = String(raw).trim()
  if (!s) return null
  // Strip currency + spaces.
  s = s.replace(/[^\d.,]/g, '')
  if (!s) return null
  // Normalize: if both separators present, the LAST one is the decimal.
  const lastComma = s.lastIndexOf(',')
  const lastDot = s.lastIndexOf('.')
  if (lastComma > -1 && lastDot > -1) {
    if (lastComma > lastDot) {
      s = s.replace(/\./g, '').replace(',', '.')
    } else {
      s = s.replace(/,/g, '')
    }
  } else if (lastComma > -1) {
    // Only comma: treat as decimal if it looks like one (2 trailing digits).
    s = /,\d{2}$/.test(s) ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '')
  }
  const n = Number.parseFloat(s)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.round(n * 100)
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .trim()
}

function metaContent(html: string, prop: string): string | null {
  // Matches <meta property="og:title" content="..."> in either attr order.
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']+)["']`,
    'i',
  )
  const alt = new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${prop}["']`,
    'i',
  )
  const m = re.exec(html) ?? alt.exec(html)
  return m ? decodeEntities(m[1]) : null
}

interface JsonLdOffer {
  price?: string | number
  highPrice?: string | number
  lowPrice?: string | number
  priceSpecification?: { price?: string | number }
}

interface JsonLdProduct {
  name?: string
  image?: string | string[] | { url?: string }
  offers?: JsonLdOffer | JsonLdOffer[]
}

function fromJsonLd(html: string): Partial<ScrapedProduct> {
  const out: Partial<ScrapedProduct> = {}
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    let parsed: unknown
    try {
      parsed = JSON.parse(m[1].trim())
    } catch {
      continue
    }
    const nodes: unknown[] = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && '@graph' in parsed
        ? ((parsed as { '@graph': unknown[] })['@graph'] ?? [])
        : [parsed]
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue
      const type = (node as { '@type'?: unknown })['@type']
      const isProduct = Array.isArray(type) ? type.includes('Product') : type === 'Product'
      if (!isProduct) continue
      const p = node as JsonLdProduct
      if (p.name && !out.title) out.title = String(p.name)
      if (p.image && !out.imageUrl) {
        const img = Array.isArray(p.image) ? p.image[0] : typeof p.image === 'object' ? p.image.url : p.image
        if (img) out.imageUrl = String(img)
      }
      const offer = Array.isArray(p.offers) ? p.offers[0] : p.offers
      if (offer) {
        const to = priceToCents(offer.price ?? offer.priceSpecification?.price ?? offer.lowPrice)
        const from = priceToCents(offer.highPrice)
        if (to && !out.priceToCents) out.priceToCents = to
        if (from && !out.priceFromCents) out.priceFromCents = from
      }
      if (out.title && out.imageUrl && out.priceToCents) return out
    }
  }
  return out
}

export async function scrapeProduct(url: string): Promise<ScrapedProduct> {
  const marketplace = detectMarketplace(url)
  const result: ScrapedProduct = {
    marketplace,
    title: null,
    imageUrl: null,
    priceFromCents: null,
    priceToCents: null,
  }

  let html = ''
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'accept-language': 'pt-BR,pt;q=0.9,en;q=0.8',
      },
      signal: AbortSignal.timeout(12_000),
    })
    if (res.ok) html = await res.text()
  } catch {
    return result
  }
  if (!html) return result

  // Layer 1 — JSON-LD.
  const ld = fromJsonLd(html)
  result.title = ld.title ?? result.title
  result.imageUrl = ld.imageUrl ?? result.imageUrl
  result.priceFromCents = ld.priceFromCents ?? result.priceFromCents
  result.priceToCents = ld.priceToCents ?? result.priceToCents

  // Layer 2 — OpenGraph.
  if (!result.title) result.title = metaContent(html, 'og:title')
  if (!result.imageUrl) result.imageUrl = metaContent(html, 'og:image')
  if (!result.priceToCents) {
    result.priceToCents =
      priceToCents(metaContent(html, 'product:price:amount')) ??
      priceToCents(metaContent(html, 'og:price:amount'))
  }

  // Layer 3 — <title> as a last resort for the name.
  if (!result.title) {
    const t = /<title[^>]*>([^<]+)<\/title>/i.exec(html)
    if (t) result.title = decodeEntities(t[1]).slice(0, 160)
  }

  return result
}
