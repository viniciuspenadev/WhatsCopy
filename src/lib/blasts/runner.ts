/**
 * Group blast runner.
 *
 * Sends one campaign message to many WhatsApp groups, one at a time, with a
 * randomized delay between each (anti-ban). Each send is mirrored into the
 * group's conversation so it shows up in the inbox. Runs with the
 * service-role client (no user session) on the long-lived Node server, so a
 * multi-minute loop with sleeps is fine — it's kicked off via `after()` from
 * the create route (send now) or the cron route (scheduled).
 */

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { getProvider, loadInstanceById } from '@/lib/channels/factory'
import type { MediaKind } from '@/lib/channels/provider'

interface BlastRow {
  id: string
  account_id: string
  instance_id: string | null
  status: string
  message_text: string | null
  media_url: string | null
  media_kind: MediaKind | null
  mention_all: boolean
  delay_min_seconds: number
  delay_max_seconds: number
  sent_count: number
  failed_count: number
  started_at: string | null
}

interface TargetRow {
  id: string
  blast_id: string
  conversation_id: string | null
  group_jid: string
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const randMs = (minS: number, maxS: number) =>
  Math.round((minS + Math.random() * Math.max(0, maxS - minS)) * 1000)

/** Process a single blast end-to-end. Idempotent on already-sent targets. */
export async function processBlast(blastId: string): Promise<void> {
  const db = supabaseAdmin()

  const { data: blastData } = await db
    .from('group_blasts')
    .select('*')
    .eq('id', blastId)
    .maybeSingle()
  const blast = blastData as BlastRow | null
  if (!blast) return
  if (blast.status === 'sent' || blast.status === 'canceled') return

  const instance = blast.instance_id ? await loadInstanceById(db, blast.instance_id) : null
  if (!instance) {
    await db
      .from('group_blasts')
      .update({ status: 'failed', finished_at: new Date().toISOString() })
      .eq('id', blastId)
    return
  }

  let provider
  try {
    provider = getProvider(instance)
  } catch {
    await db
      .from('group_blasts')
      .update({ status: 'failed', finished_at: new Date().toISOString() })
      .eq('id', blastId)
    return
  }

  await db
    .from('group_blasts')
    .update({ status: 'sending', started_at: blast.started_at ?? new Date().toISOString() })
    .eq('id', blastId)

  const { data: targetData } = await db
    .from('group_blast_targets')
    .select('id, blast_id, conversation_id, group_jid')
    .eq('blast_id', blastId)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
  const targets = (targetData as TargetRow[] | null) ?? []

  let sent = blast.sent_count ?? 0
  let failed = blast.failed_count ?? 0

  for (let i = 0; i < targets.length; i++) {
    // Honor cancellation between groups.
    const { data: cur } = await db
      .from('group_blasts')
      .select('status')
      .eq('id', blastId)
      .maybeSingle()
    if (cur?.status === 'canceled') return

    const target = targets[i]
    try {
      let providerMessageId = ''
      if (blast.media_url && blast.media_kind) {
        const r = await provider.sendMedia({
          to: target.group_jid,
          kind: blast.media_kind,
          link: blast.media_url,
          caption: blast.message_text || undefined,
          mentionsEveryOne: blast.mention_all,
        })
        providerMessageId = r.messageId
      } else {
        const r = await provider.sendText({
          to: target.group_jid,
          text: blast.message_text ?? '',
          mentionsEveryOne: blast.mention_all,
        })
        providerMessageId = r.messageId
      }

      await db
        .from('group_blast_targets')
        .update({
          status: 'sent',
          provider_message_id: providerMessageId,
          sent_at: new Date().toISOString(),
        })
        .eq('id', target.id)
      sent++

      // Mirror the send into the group's conversation (shows in inbox).
      if (target.conversation_id) {
        await db.from('messages').insert({
          conversation_id: target.conversation_id,
          sender_type: 'agent',
          content_type: blast.media_kind ?? 'text',
          content_text: blast.message_text ?? null,
          media_url: blast.media_url ?? null,
          message_id: providerMessageId,
          status: 'sent',
        })
        await db
          .from('conversations')
          .update({
            last_message_text: (blast.message_text ?? `[${blast.media_kind ?? 'mídia'}]`).slice(0, 200),
            last_message_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', target.conversation_id)
      }
    } catch (err) {
      await db
        .from('group_blast_targets')
        .update({
          status: 'failed',
          error: (err instanceof Error ? err.message : String(err)).slice(0, 500),
        })
        .eq('id', target.id)
      failed++
    }

    await db.from('group_blasts').update({ sent_count: sent, failed_count: failed }).eq('id', blastId)

    // Anti-ban: wait a randomized window before the next group.
    if (i < targets.length - 1) {
      await sleep(randMs(blast.delay_min_seconds ?? 8, blast.delay_max_seconds ?? 20))
    }
  }

  await db
    .from('group_blasts')
    .update({
      status: failed > 0 && sent === 0 ? 'failed' : 'sent',
      sent_count: sent,
      failed_count: failed,
      finished_at: new Date().toISOString(),
    })
    .eq('id', blastId)
}

/** Drain campaigns whose schedule is due. Called by the cron route. */
export async function runDueBlasts(): Promise<{ processed: number }> {
  const db = supabaseAdmin()
  const { data: due } = await db
    .from('group_blasts')
    .select('id')
    .eq('status', 'scheduled')
    .lte('scheduled_at', new Date().toISOString())
    .limit(10)
  const ids = ((due as { id: string }[] | null) ?? []).map((r) => r.id)
  for (const id of ids) {
    try {
      await processBlast(id)
    } catch (err) {
      console.error('[blast] processBlast failed:', err)
    }
  }
  return { processed: ids.length }
}
