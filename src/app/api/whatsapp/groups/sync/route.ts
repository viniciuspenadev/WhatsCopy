import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  getProvider,
  INSTANCE_COLUMNS,
  type WhatsappInstanceRow,
} from '@/lib/channels/factory'

/**
 * POST /api/whatsapp/groups/sync
 *
 * Lists every group the account's Evolution number belongs to and creates a
 * group conversation for any not seen yet. Without this, a group only appears
 * after it sends an inbound message — useless for a blast picker, where you
 * want to target groups you just created too.
 */
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
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (!inst) {
    return NextResponse.json({ error: 'Nenhuma conexão Evolution conectada.' }, { status: 400 })
  }
  const instance = inst as unknown as WhatsappInstanceRow

  let groups
  try {
    groups = await getProvider(instance).fetchAllGroups()
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Falha ao buscar grupos.' },
      { status: 502 },
    )
  }

  const { data: existing } = await supabase
    .from('conversations')
    .select('id, group_jid, group_name, member_count')
    .eq('account_id', accountId)
    .eq('instance_id', instance.id)
    .eq('is_group', true)
  const byJid = new Map(
    ((existing as
      | { id: string; group_jid: string; group_name: string | null; member_count: number | null }[]
      | null) ?? []).map((r) => [r.group_jid, r]),
  )

  const toInsert: Record<string, unknown>[] = []
  for (const g of groups) {
    if (!g.jid) continue
    const ex = byJid.get(g.jid)
    if (ex) {
      // Keep the name + member count fresh (size comes from fetchAllGroups).
      const patch: Record<string, unknown> = {}
      if (g.subject && ex.group_name !== g.subject) patch.group_name = g.subject
      if (g.size != null && ex.member_count !== g.size) patch.member_count = g.size
      if (Object.keys(patch).length > 0) {
        await supabase.from('conversations').update(patch).eq('id', ex.id)
      }
      continue
    }
    toInsert.push({
      account_id: accountId,
      user_id: user.id,
      instance_id: instance.id,
      is_group: true,
      group_jid: g.jid,
      group_name: g.subject ?? null,
      group_picture: g.pictureUrl ?? null,
      member_count: g.size ?? null,
      status: 'open',
      unread_count: 0,
    })
  }

  if (toInsert.length > 0) {
    const { error } = await supabase.from('conversations').insert(toInsert)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ total: groups.length, synced: toInsert.length })
}
