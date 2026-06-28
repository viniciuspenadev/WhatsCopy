/**
 * Evolution instance provisioning.
 *
 * `ensureEvolutionInstance` is idempotent: it returns the account's existing
 * Baileys instance, or creates one — generating a unique `instance_name` and
 * a random `webhook_secret`, inserting the `whatsapp_instances` row, then
 * calling the Evolution server to create the instance and point its webhook
 * back at us. Called on account creation (God Mode / self-registration) and
 * lazily when the connect screen opens, so a client always has a number ready
 * to scan.
 */

import crypto from 'node:crypto'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import {
  getProvider,
  INSTANCE_COLUMNS,
  type WhatsappInstanceRow,
} from './factory'

/** Public URL Evolution POSTs inbound events to. Requires APP_PUBLIC_URL to be
 *  reachable from the Evolution server (a tunnel in local dev). */
export function evolutionWebhookUrl(secret: string): string {
  const base = (process.env.APP_PUBLIC_URL ?? '').replace(/\/+$/, '')
  return `${base}/api/webhooks/evolution/${secret}`
}

export async function ensureEvolutionInstance(
  accountId: string,
  createdBy?: string | null,
): Promise<WhatsappInstanceRow> {
  const db = supabaseAdmin()

  // Idempotent — reuse the account's existing Evolution instance.
  const { data: existing } = await db
    .from('whatsapp_instances')
    .select(INSTANCE_COLUMNS)
    .eq('account_id', accountId)
    .eq('provider', 'evolution')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (existing) return existing as unknown as WhatsappInstanceRow

  const instanceName = `wc_${accountId.replace(/-/g, '').slice(0, 12)}_${crypto
    .randomBytes(3)
    .toString('hex')}`
  const webhookSecret = crypto.randomBytes(24).toString('hex')

  const { data: created, error } = await db
    .from('whatsapp_instances')
    .insert({
      account_id: accountId,
      created_by: createdBy ?? null,
      provider: 'evolution',
      label: 'WhatsApp (Baileys)',
      status: 'qr_pending',
      instance_name: instanceName,
      webhook_secret: webhookSecret,
    })
    .select(INSTANCE_COLUMNS)
    .single()
  if (error) throw error
  const row = created as unknown as WhatsappInstanceRow

  const provider = getProvider(row)
  try {
    await provider.createInstance()
  } catch (err) {
    // "already exists" on the server is fine — fall through to (re)set webhook.
    console.warn('[provisioning] createInstance:', err instanceof Error ? err.message : err)
  }
  try {
    await provider.setWebhook(evolutionWebhookUrl(webhookSecret))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[provisioning] setWebhook failed:', message)
    await db
      .from('whatsapp_instances')
      .update({ last_error: `setWebhook: ${message}` })
      .eq('id', row.id)
  }

  return row
}
