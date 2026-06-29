/**
 * Channel provider factory + instance loaders.
 *
 * `getProvider(row)` turns a `whatsapp_instances` row into a ready-to-use
 * `ChannelProvider`, decrypting secrets and applying the Evolution
 * shared-server env fallback. The loaders resolve WHICH instance a send
 * should use: a conversation carries `instance_id` (so a reply leaves the
 * same number it arrived on); legacy threads with a NULL instance fall
 * back to the account's default connection.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { MetaProvider } from './providers/meta'
import { EvolutionProvider } from './providers/evolution'
import type { ChannelProvider, ChannelProviderName, InstanceStatus } from './provider'

/** The columns every loader selects. Includes the encrypted secret
 *  columns — server-only callers (the send routes run with the user's
 *  RLS session, which may read its own account's row; the webhook/cron
 *  use the service-role client). These are NEVER serialised to a client;
 *  the settings API redacts them. */
export const INSTANCE_COLUMNS =
  'id, account_id, provider, label, status, phone_number, ' +
  'phone_number_id, waba_id, access_token, verify_token, ' +
  'instance_name, evolution_url, evolution_key, webhook_secret'

export interface WhatsappInstanceRow {
  id: string
  account_id: string
  provider: ChannelProviderName
  label: string | null
  status: InstanceStatus
  phone_number: string | null
  // Meta
  phone_number_id: string | null
  waba_id: string | null
  access_token: string | null
  verify_token: string | null
  // Evolution
  instance_name: string | null
  evolution_url: string | null
  evolution_key: string | null
  webhook_secret: string | null
}

export function getProvider(instance: WhatsappInstanceRow): ChannelProvider {
  if (instance.provider === 'evolution') {
    const baseUrl = instance.evolution_url || process.env.EVOLUTION_API_URL
    const apiKey = instance.evolution_key
      ? decrypt(instance.evolution_key)
      : process.env.EVOLUTION_API_KEY
    if (!baseUrl) {
      throw new Error('Evolution base URL not configured (set EVOLUTION_API_URL or the instance evolution_url).')
    }
    if (!apiKey) {
      throw new Error('Evolution API key not configured (set EVOLUTION_API_KEY or the instance evolution_key).')
    }
    if (!instance.instance_name) {
      throw new Error('Evolution instance is missing instance_name.')
    }
    return new EvolutionProvider({ baseUrl, apiKey, instanceName: instance.instance_name })
  }

  // Meta
  if (!instance.phone_number_id) throw new Error('Meta instance is missing phone_number_id.')
  if (!instance.access_token) throw new Error('Meta instance is missing access_token.')
  return new MetaProvider({
    phoneNumberId: instance.phone_number_id,
    accessToken: decrypt(instance.access_token),
    wabaId: instance.waba_id ?? undefined,
  })
}

export async function loadInstanceById(
  db: SupabaseClient,
  id: string,
): Promise<WhatsappInstanceRow | null> {
  const { data } = await db.from('whatsapp_instances').select(INSTANCE_COLUMNS).eq('id', id).maybeSingle()
  return (data as WhatsappInstanceRow | null) ?? null
}

/**
 * The account's default connection — used for legacy conversations whose
 * `instance_id` predates this column. Prefers a connected instance, then
 * the oldest (the backfilled Meta number).
 */
export async function loadDefaultInstance(
  db: SupabaseClient,
  accountId: string,
): Promise<WhatsappInstanceRow | null> {
  const { data } = await db
    .from('whatsapp_instances')
    .select(INSTANCE_COLUMNS)
    .eq('account_id', accountId)
    .order('status', { ascending: false }) // 'connected' sorts after others alphabetically? handled below
    .order('created_at', { ascending: true })
  const rows = (data as WhatsappInstanceRow[] | null) ?? []
  if (rows.length === 0) return null
  return rows.find((r) => r.status === 'connected') ?? rows[0]
}

/**
 * Resolve the instance an outbound message for `conversationId` should
 * use. Falls back to the account default when the thread has no
 * instance_id yet.
 */
export async function loadInstanceForConversation(
  db: SupabaseClient,
  conversationId: string,
): Promise<WhatsappInstanceRow | null> {
  const { data: conv } = await db
    .from('conversations')
    .select('instance_id, account_id')
    .eq('id', conversationId)
    .maybeSingle()
  if (!conv) return null
  if (conv.instance_id) {
    const byId = await loadInstanceById(db, conv.instance_id as string)
    if (byId) return byId
  }
  return loadDefaultInstance(db, conv.account_id as string)
}

/**
 * Convenience for engine callers (automations / flows, service-role) that
 * just need a ready provider for a conversation. Returns null when the
 * account has no connection at all; throws (from getProvider) on a
 * misconfigured one.
 */
export async function getProviderForConversation(
  db: SupabaseClient,
  conversationId: string,
): Promise<ChannelProvider | null> {
  const instance = await loadInstanceForConversation(db, conversationId)
  if (!instance) return null
  return getProvider(instance)
}
