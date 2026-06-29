import { supabaseAdmin } from '@/lib/automations/admin-client'
import { buildMediaPath, type UploadAccountMediaResult } from '@/lib/storage/upload-media'

/**
 * Server-side twin of `uploadAccountMedia` (which uses the browser client +
 * the signed-in session). This one runs with the service-role client and an
 * explicit `accountId`, so background/API code can stage media into an
 * account-scoped bucket path.
 *
 * Used by the offer generator: the scraped product image lives on a
 * marketplace CDN that may expire or block hotlinking, so we re-host it in
 * our own `chat-media` bucket — giving the blast a stable, fetchable URL.
 *
 * Reuses `buildMediaPath` so the object lands under `account-<id>/…`, which
 * is what the bucket's RLS write policy matches (a mismatched first segment
 * is silently rejected — but the service-role client bypasses RLS anyway;
 * keeping the convention means the URL is consistent with browser uploads).
 */
export async function uploadAccountMediaFromUrl(
  bucket: string,
  accountId: string,
  sourceUrl: string,
): Promise<UploadAccountMediaResult | null> {
  let bytes: ArrayBuffer
  let contentType: string
  try {
    const res = await fetch(sourceUrl, {
      headers: {
        // Some marketplace CDNs 403 a bare fetch — present a browser UA.
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    contentType = res.headers.get('content-type') ?? 'image/jpeg'
    if (!contentType.startsWith('image/')) return null
    bytes = await res.arrayBuffer()
  } catch {
    return null
  }

  // Cap at the bucket's image limit (5 MB, matching MEDIA_MAX_BYTES_BY_KIND).
  if (bytes.byteLength > 5 * 1024 * 1024) return null

  const ext = contentType.split('/')[1]?.split(';')[0] || 'jpg'
  const path = buildMediaPath(accountId, `offer.${ext}`)

  const db = supabaseAdmin()
  const { error } = await db.storage.from(bucket).upload(path, bytes, {
    cacheControl: '3600',
    upsert: false,
    contentType,
  })
  if (error) return null

  const {
    data: { publicUrl },
  } = db.storage.from(bucket).getPublicUrl(path)
  return { publicUrl, path }
}
