import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  getProvider,
  INSTANCE_COLUMNS,
  type WhatsappInstanceRow,
} from '@/lib/channels/factory'
import { uploadAccountMediaFromUrl } from '@/lib/storage/upload-media-server'

/**
 * POST /api/whatsapp/groups/refresh-members  { conversationId }
 *
 * Pulls fresh group metadata (exact member count + participant list, incl.
 * admin flags) for one group and stores it on the conversation. Used when a
 * group is added to the watchlist and by the "Atualizar" button on the
 * monitoring detail page — so the X / 1024 bar and member list reflect the
 * group's CURRENT state, not just whatever events have arrived since.
 */
export async function POST(req: Request) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = (await req.json().catch(() => ({}))) as { conversationId?: string }
  const conversationId = body.conversationId
  if (!conversationId) {
    return NextResponse.json({ error: 'conversationId obrigatório' }, { status: 400 })
  }

  // RLS scopes this to the user's account.
  const { data: conv } = await supabase
    .from('conversations')
    .select('id, group_jid, instance_id, is_group')
    .eq('id', conversationId)
    .maybeSingle()
  if (!conv?.is_group || !conv.group_jid) {
    return NextResponse.json({ error: 'Conversa de grupo não encontrada' }, { status: 404 })
  }

  const { data: inst } = await supabase
    .from('whatsapp_instances')
    .select(INSTANCE_COLUMNS)
    .eq('id', conv.instance_id as string)
    .maybeSingle()
  if (!inst) {
    return NextResponse.json({ error: 'Conexão não encontrada' }, { status: 400 })
  }
  const instance = inst as unknown as WhatsappInstanceRow

  const provider = getProvider(instance)
  let meta
  try {
    meta = await provider.fetchGroupMetadata(conv.group_jid as string)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Falha ao buscar grupo' },
      { status: 502 },
    )
  }
  if (!meta) {
    return NextResponse.json({ error: 'Metadata indisponível' }, { status: 502 })
  }

  const memberCount =
    meta.size ?? (Array.isArray(meta.participants) ? meta.participants.length : null)

  // Group photo: fetchGroupMetadata rarely returns a usable pictureUrl, so pull
  // it via the profile-picture endpoint (works for group JIDs) and re-host —
  // the provider CDN URL expires / blocks hotlinking, so the inbox <img> needs
  // a stable URL of our own.
  let picture: string | null = meta.pictureUrl ?? null
  try {
    const cdn = await provider.fetchProfilePictureUrl(conv.group_jid as string)
    if (cdn) {
      const up = await uploadAccountMediaFromUrl('chat-media', instance.account_id, cdn)
      if (up) picture = up.publicUrl
    }
  } catch {
    /* best-effort */
  }

  const { error } = await supabase
    .from('conversations')
    .update({
      member_count: memberCount,
      group_members: meta.participants ?? null,
      group_metadata: meta,
      ...(meta.subject ? { group_name: meta.subject } : {}),
      ...(picture ? { group_picture: picture } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({
    member_count: memberCount,
    members: Array.isArray(meta.participants) ? meta.participants.length : 0,
  })
}
