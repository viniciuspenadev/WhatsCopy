import { NextResponse, after } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { tickBlasts } from '@/lib/blasts/runner'

const MEDIA_KINDS = ['image', 'video', 'document', 'audio']

/**
 * GET /api/blasts — list the account's blast campaigns.
 */
export async function GET() {
  const { supabase, accountId, error } = await resolveAccount()
  if (error || !accountId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data } = await supabase
    .from('group_blasts')
    .select('*')
    .eq('account_id', accountId)
    .order('created_at', { ascending: false })
  return NextResponse.json({ blasts: data ?? [] })
}

/**
 * POST /api/blasts — create a group blast.
 *
 * Body: {
 *   name?, message_text?, media_url?, media_kind?, mention_all?,
 *   conversation_ids: string[],   // the selected group conversations
 *   scheduled_at?: ISO, send_now?: boolean,
 *   delay_min_seconds?, delay_max_seconds?
 * }
 */
export async function POST(request: Request) {
  const { supabase, accountId, userId, error } = await resolveAccount()
  if (error || !accountId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => ({}))
  const {
    name,
    message_text,
    media_url,
    media_kind,
    mention_all,
    conversation_ids,
    scheduled_at,
    send_now,
    delay_min_seconds,
    delay_max_seconds,
  } = body

  if (!Array.isArray(conversation_ids) || conversation_ids.length === 0) {
    return NextResponse.json({ error: 'Selecione ao menos um grupo.' }, { status: 400 })
  }
  if (!message_text && !media_url) {
    return NextResponse.json({ error: 'Escreva uma mensagem ou anexe uma mídia.' }, { status: 400 })
  }
  if (media_url && !MEDIA_KINDS.includes(media_kind)) {
    return NextResponse.json({ error: 'media_kind inválido.' }, { status: 400 })
  }

  // Resolve the selected groups → their JIDs + the connection they belong to.
  const { data: groups } = await supabase
    .from('conversations')
    .select('id, group_jid, instance_id')
    .eq('account_id', accountId)
    .eq('is_group', true)
    .in('id', conversation_ids)
  const groupRows = (groups as { id: string; group_jid: string; instance_id: string | null }[] | null) ?? []
  if (groupRows.length === 0) {
    return NextResponse.json({ error: 'Nenhum grupo válido encontrado.' }, { status: 400 })
  }
  const instanceId = groupRows.find((g) => g.instance_id)?.instance_id ?? null

  const sendNow = send_now === true
  // Send-now is just a schedule for "right now" — the queue worker promotes it.
  const scheduledAt = sendNow ? new Date().toISOString() : scheduled_at ?? null
  const status = scheduledAt ? 'scheduled' : 'draft'

  const { data: blast, error: insErr } = await supabase
    .from('group_blasts')
    .insert({
      account_id: accountId,
      instance_id: instanceId,
      created_by: userId,
      name: name ?? null,
      status,
      message_text: message_text ?? null,
      media_url: media_url ?? null,
      media_kind: media_url ? media_kind : null,
      mention_all: mention_all === true,
      scheduled_at: scheduledAt,
      delay_min_seconds: clampInt(delay_min_seconds, 8, 1, 600),
      delay_max_seconds: clampInt(delay_max_seconds, 20, 1, 600),
      total_count: groupRows.length,
    })
    .select('id')
    .single()
  if (insErr || !blast) {
    return NextResponse.json({ error: insErr?.message ?? 'Falha ao criar campanha.' }, { status: 500 })
  }

  const targets = groupRows.map((g) => ({
    blast_id: blast.id,
    conversation_id: g.id,
    group_jid: g.group_jid,
  }))
  const { error: tErr } = await supabase.from('group_blast_targets').insert(targets)
  if (tErr) {
    return NextResponse.json({ error: `Campanha criada, mas falha nos alvos: ${tErr.message}` }, { status: 500 })
  }

  // Kick an immediate worker tick so "send now" starts without waiting for cron.
  if (sendNow) {
    after(() => tickBlasts())
  }

  return NextResponse.json({ id: blast.id, status, total: groupRows.length })
}

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, Math.round(n)))
}

async function resolveAccount() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { supabase, accountId: null, userId: null, error: true as const }
  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .maybeSingle()
  return {
    supabase,
    accountId: (profile?.account_id as string | undefined) ?? null,
    userId: user.id,
    error: false as const,
  }
}
