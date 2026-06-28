import { NextResponse, after } from 'next/server'
import { tickBlasts } from '@/lib/blasts/runner'

/**
 * GET /api/blasts/cron — drain scheduled group blasts whose time is due.
 *
 * Meant to be hit on a schedule (external pinger / Supabase cron). Requires
 * the `x-cron-secret` header to match `BLAST_CRON_SECRET` (same convention as
 * the automations cron). Processing runs in the background via `after()`
 * because a blast sends group-by-group with anti-ban delays — we ACK fast and
 * let the long-lived server finish the work.
 */
export async function GET(request: Request) {
  const expected = process.env.BLAST_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  if (request.headers.get('x-cron-secret') !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  after(async () => {
    try {
      await tickBlasts()
    } catch (err) {
      console.error('[blasts/cron] failed:', err)
    }
  })

  return NextResponse.json({ ok: true })
}
