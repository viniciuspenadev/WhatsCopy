import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import {
  getProvider,
  INSTANCE_COLUMNS,
  type WhatsappInstanceRow,
} from '@/lib/channels/factory'
import { ensureEvolutionInstance } from '@/lib/channels/provisioning'

/**
 * POST /api/whatsapp/connect
 *
 * Ensures the caller's account has a Baileys instance (provisioning it on the
 * Evolution server if needed) and returns a fresh QR / pairing code to scan.
 * Works without the inbound webhook being reachable — this call goes straight
 * from us to the Evolution server.
 */
export async function POST() {
  const accountId = await resolveAccount()
  if (!accountId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let instance: WhatsappInstanceRow
  try {
    instance = await ensureEvolutionInstance(accountId, await resolveUserId())
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Provisioning failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }

  try {
    const provider = getProvider(instance)
    const qr = await provider.getQrCode()
    // Cache the QR on the row so the page can also pick it up via realtime.
    if (qr.base64) {
      await supabaseAdmin()
        .from('whatsapp_instances')
        .update({ qr_code: qr.base64, last_qr_at: new Date().toISOString(), status: 'qr_pending' })
        .eq('id', instance.id)
    }
    return NextResponse.json({
      instanceId: instance.id,
      status: instance.status,
      qr: qr.base64 ?? null,
      pairingCode: qr.pairingCode ?? null,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fetch QR'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}

/**
 * GET /api/whatsapp/connect
 *
 * Current connection state for the account's Baileys instance. The connect
 * screen polls this to flip to "connected" once the QR is scanned (works even
 * without the inbound webhook).
 */
export async function GET() {
  const accountId = await resolveAccount()
  if (!accountId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = supabaseAdmin()
  const { data: instance } = await db
    .from('whatsapp_instances')
    .select(INSTANCE_COLUMNS)
    .eq('account_id', accountId)
    .eq('provider', 'evolution')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (!instance) {
    return NextResponse.json({ status: 'none', phoneNumber: null })
  }

  const row = instance as unknown as WhatsappInstanceRow
  try {
    const state = await getProvider(row).getConnectionState()
    // Persist a transition so realtime subscribers + the dashboard agree.
    if (state.status !== row.status) {
      const patch: Record<string, unknown> = { status: state.status }
      if (state.status === 'connected') {
        patch.connected_at = new Date().toISOString()
        patch.qr_code = null
      }
      if (state.phoneNumber) patch.phone_number = state.phoneNumber
      await db.from('whatsapp_instances').update(patch).eq('id', row.id)
    }
    return NextResponse.json({
      status: state.status,
      phoneNumber: state.phoneNumber ?? row.phone_number ?? null,
    })
  } catch {
    // Evolution unreachable — fall back to the stored status.
    return NextResponse.json({ status: row.status, phoneNumber: row.phone_number ?? null })
  }
}

async function resolveAccount(): Promise<string | null> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null
  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .maybeSingle()
  return (profile?.account_id as string | undefined) ?? null
}

async function resolveUserId(): Promise<string | null> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  return user?.id ?? null
}
