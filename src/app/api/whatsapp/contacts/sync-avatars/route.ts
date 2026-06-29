import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  getProvider,
  INSTANCE_COLUMNS,
  type WhatsappInstanceRow,
} from '@/lib/channels/factory'
import { uploadAccountMediaFromUrl } from '@/lib/storage/upload-media-server'

/**
 * POST /api/whatsapp/contacts/sync-avatars
 *
 * Backfills WhatsApp profile photos for the account's 1:1 contacts so the
 * inbox shows real faces instead of initials. Inbound ingest already pulls a
 * contact's avatar the first time they message (best-effort, throttled); this
 * route is the manual "sync now" pass that fills in everyone who messaged
 * before the feature existed, or whose photo is stale.
 *
 * Bounded to one batch per call (the Evolution server is shared — we don't
 * want a single click to fire hundreds of profile-pic lookups). Re-run until
 * `remaining` is 0. Photos are re-hosted into chat-media because the
 * provider's CDN URLs expire.
 */

const BATCH = 40
const TTL_MS = 7 * 24 * 60 * 60 * 1000

export async function POST() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .maybeSingle()
  const accountId = profile?.account_id as string | undefined
  if (!accountId) return NextResponse.json({ error: 'Sem conta vinculada.' }, { status: 403 })

  const { data: inst } = await supabase
    .from('whatsapp_instances')
    .select(INSTANCE_COLUMNS)
    .eq('account_id', accountId)
    .eq('provider', 'evolution')
    .eq('status', 'connected')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (!inst) {
    return NextResponse.json({ error: 'Nenhuma conexão Evolution conectada.' }, { status: 400 })
  }
  const instance = inst as unknown as WhatsappInstanceRow
  const provider = getProvider(instance)

  // Eligible = has a phone and was never synced or is past the TTL. Order by
  // avatar_updated_at NULLS FIRST so never-synced contacts get photos first.
  const staleBefore = new Date(Date.now() - TTL_MS).toISOString()
  const { data: contacts, error: cErr } = await supabase
    .from('contacts')
    .select('id, phone, avatar_updated_at')
    .eq('account_id', accountId)
    .not('phone', 'is', null)
    .or(`avatar_updated_at.is.null,avatar_updated_at.lt.${staleBefore}`)
    .order('avatar_updated_at', { ascending: true, nullsFirst: true })
    .limit(BATCH)
  if (cErr) return NextResponse.json({ error: cErr.message }, { status: 500 })

  const rows = (contacts as { id: string; phone: string | null; avatar_updated_at: string | null }[]) ?? []

  let updated = 0
  let withPhoto = 0
  for (const c of rows) {
    if (!c.phone) continue
    try {
      const cdnUrl = await provider.fetchProfilePictureUrl(c.phone)
      let publicUrl: string | null = null
      if (cdnUrl) {
        const up = await uploadAccountMediaFromUrl('chat-media', accountId, cdnUrl)
        if (up) {
          publicUrl = up.publicUrl
          withPhoto += 1
        }
      }
      await supabase
        .from('contacts')
        .update({
          ...(publicUrl ? { avatar_url: publicUrl } : {}),
          avatar_updated_at: new Date().toISOString(),
        })
        .eq('id', c.id)
      updated += 1
    } catch {
      // Best-effort per contact — keep going so one bad lookup doesn't
      // abort the whole batch. Stamp it so we don't loop on it forever.
      await supabase
        .from('contacts')
        .update({ avatar_updated_at: new Date().toISOString() })
        .eq('id', c.id)
    }
  }

  // Group photos: fetchGroupMetadata rarely yields a usable picture, so pull
  // each group's photo via the profile-picture endpoint and re-host. Bounded,
  // only groups still missing a picture.
  let groupPhotos = 0
  const { data: groups } = await supabase
    .from('conversations')
    .select('id, group_jid')
    .eq('account_id', accountId)
    .eq('is_group', true)
    .is('group_picture', null)
    .not('group_jid', 'is', null)
    .limit(30)
  for (const g of (groups as { id: string; group_jid: string | null }[]) ?? []) {
    if (!g.group_jid) continue
    try {
      const cdn = await provider.fetchProfilePictureUrl(g.group_jid)
      if (!cdn) continue
      const up = await uploadAccountMediaFromUrl('chat-media', accountId, cdn)
      if (up) {
        await supabase.from('conversations').update({ group_picture: up.publicUrl }).eq('id', g.id)
        groupPhotos += 1
      }
    } catch {
      /* best-effort per group */
    }
  }

  // How many are still eligible after this batch — lets the UI loop / show
  // "X remaining".
  const { count: remaining } = await supabase
    .from('contacts')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .not('phone', 'is', null)
    .or(`avatar_updated_at.is.null,avatar_updated_at.lt.${staleBefore}`)

  return NextResponse.json({
    processed: rows.length,
    updated,
    withPhoto,
    groupPhotos,
    remaining: remaining ?? 0,
  })
}
