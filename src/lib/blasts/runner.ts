/**
 * Group blast queue worker.
 *
 * Instead of one long request that loops + sleeps, dispatch is a durable
 * queue: at any moment a blast has at most ONE "armed" pending target (its
 * `next_attempt_at` is set); all others are null (not yet eligible). A
 * frequent cron tick (`tickBlasts`) promotes due scheduled blasts, claims the
 * armed+due target of each `sending` blast, sends it, then arms the NEXT
 * target at `now + random(delay)` — the anti-ban spacing. Pausing simply flips
 * the blast status so the worker skips it; resume re-arms; retry re-queues the
 * failed targets. Crash-safe and restart-safe (no in-process timers).
 *
 * Runs with the service-role client. Send-now creates the blast as
 * `scheduled` at `now` and kicks one immediate tick via `after()`.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
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
}

const LEASE_MS = 5 * 60 * 1000
const randDelayMs = (minS: number, maxS: number) =>
  Math.round((minS + Math.random() * Math.max(0, maxS - minS)) * 1000)

/**
 * One worker pass: promote due schedules, then send the due head target of
 * each in-flight blast. Meant to be called frequently (~15–30s).
 */
export async function tickBlasts(): Promise<{ sent: number }> {
  const db = supabaseAdmin()
  const now = new Date().toISOString()

  // 1. Promote due scheduled blasts → sending, arm their first target.
  const { data: due } = await db
    .from('group_blasts')
    .select('id')
    .eq('status', 'scheduled')
    .lte('scheduled_at', now)
    .limit(25)
  for (const b of (due as { id: string }[] | null) ?? []) {
    const { data: promoted } = await db
      .from('group_blasts')
      .update({ status: 'sending', started_at: now })
      .eq('id', b.id)
      .eq('status', 'scheduled')
      .select('id')
      .maybeSingle()
    if (promoted) await armHead(db, b.id)
  }

  // 2. Send the due head target of each in-flight blast.
  const { data: active } = await db.from('group_blasts').select('*').eq('status', 'sending').limit(25)
  let sent = 0
  for (const blast of (active as BlastRow[] | null) ?? []) {
    if (await processHead(db, blast)) sent++
  }
  return { sent }
}

/** Arm exactly one pending target (set next_attempt_at) if none is armed. */
async function armHead(db: SupabaseClient, blastId: string, whenIso = new Date().toISOString()) {
  const { data: armed } = await db
    .from('group_blast_targets')
    .select('id')
    .eq('blast_id', blastId)
    .eq('status', 'pending')
    .not('next_attempt_at', 'is', null)
    .limit(1)
    .maybeSingle()
  if (armed) return
  const { data: next } = await db
    .from('group_blast_targets')
    .select('id')
    .eq('blast_id', blastId)
    .eq('status', 'pending')
    .is('next_attempt_at', null)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (next) await db.from('group_blast_targets').update({ next_attempt_at: whenIso }).eq('id', next.id)
}

async function processHead(db: SupabaseClient, blast: BlastRow): Promise<boolean> {
  const nowIso = new Date().toISOString()

  const { data: head } = await db
    .from('group_blast_targets')
    .select('id, conversation_id, group_jid')
    .eq('blast_id', blast.id)
    .eq('status', 'pending')
    .not('next_attempt_at', 'is', null)
    .lte('next_attempt_at', nowIso)
    .order('next_attempt_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (!head) {
    const { count } = await db
      .from('group_blast_targets')
      .select('id', { count: 'exact', head: true })
      .eq('blast_id', blast.id)
      .eq('status', 'pending')
    if ((count ?? 0) === 0) await finishBlast(db, blast.id)
    else await armHead(db, blast.id) // self-heal (e.g. after a resume)
    return false
  }

  // Atomic claim: push next_attempt_at to a lease so a concurrent tick skips it.
  const lease = new Date(Date.now() + LEASE_MS).toISOString()
  const { data: claimed } = await db
    .from('group_blast_targets')
    .update({ next_attempt_at: lease })
    .eq('id', head.id)
    .eq('status', 'pending')
    .lte('next_attempt_at', nowIso)
    .select('id, conversation_id, group_jid')
    .maybeSingle()
  if (!claimed) return false
  const target = claimed as { id: string; conversation_id: string | null; group_jid: string }

  const instance = blast.instance_id ? await loadInstanceById(db, blast.instance_id) : null
  if (!instance) {
    await db
      .from('group_blasts')
      .update({ status: 'failed', finished_at: new Date().toISOString() })
      .eq('id', blast.id)
    return false
  }
  let provider
  try {
    provider = getProvider(instance)
  } catch {
    await db
      .from('group_blasts')
      .update({ status: 'failed', finished_at: new Date().toISOString() })
      .eq('id', blast.id)
    return false
  }

  let ok = false
  let providerMessageId = ''
  let errMsg = ''
  try {
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
    ok = true
  } catch (err) {
    errMsg = err instanceof Error ? err.message : String(err)
  }

  if (ok) {
    await db
      .from('group_blast_targets')
      .update({ status: 'sent', provider_message_id: providerMessageId, sent_at: new Date().toISOString(), next_attempt_at: null })
      .eq('id', target.id)
    await db.from('group_blasts').update({ sent_count: (blast.sent_count ?? 0) + 1 }).eq('id', blast.id)
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
  } else {
    await db
      .from('group_blast_targets')
      .update({ status: 'failed', error: errMsg.slice(0, 500), next_attempt_at: null })
      .eq('id', target.id)
    await db.from('group_blasts').update({ failed_count: (blast.failed_count ?? 0) + 1 }).eq('id', blast.id)
  }

  // Arm the next target with the anti-ban delay — unless paused/canceled meanwhile.
  const { data: cur } = await db.from('group_blasts').select('status').eq('id', blast.id).maybeSingle()
  if (cur?.status === 'sending') {
    const { data: next } = await db
      .from('group_blast_targets')
      .select('id')
      .eq('blast_id', blast.id)
      .eq('status', 'pending')
      .is('next_attempt_at', null)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    if (next) {
      const when = new Date(
        Date.now() + randDelayMs(blast.delay_min_seconds ?? 8, blast.delay_max_seconds ?? 20),
      ).toISOString()
      await db.from('group_blast_targets').update({ next_attempt_at: when }).eq('id', next.id)
    } else {
      await finishBlast(db, blast.id)
    }
  }
  return true
}

async function finishBlast(db: SupabaseClient, blastId: string) {
  const { data: b } = await db
    .from('group_blasts')
    .select('sent_count, failed_count, status')
    .eq('id', blastId)
    .maybeSingle()
  if (!b || b.status === 'canceled' || b.status === 'sent') return
  const finalStatus = (b.failed_count ?? 0) > 0 && (b.sent_count ?? 0) === 0 ? 'failed' : 'sent'
  await db
    .from('group_blasts')
    .update({ status: finalStatus, finished_at: new Date().toISOString() })
    .eq('id', blastId)
}
