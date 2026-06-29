import { NextResponse, after } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { INSTANCE_COLUMNS, type WhatsappInstanceRow } from '@/lib/channels/factory'
import { ingestInboundMessage, ingestGroupEvent } from '@/lib/channels/ingest'
import {
  normalizeUpsert,
  normalizeStatusUpdates,
  normalizeGroupParticipants,
  normalizeGroupUpdate,
  normalizePresence,
  extractQrBase64,
} from '@/lib/channels/normalize/evolution'
import { broadcastPresence } from '@/lib/realtime/broadcast-server'
import { mapEvolutionState } from '@/lib/channels/providers/evolution'

/**
 * POST /api/webhooks/evolution/[secret]
 *
 * Inbound events from the Evolution server. The `[secret]` path segment is the
 * per-instance `webhook_secret` — looked up against `whatsapp_instances`, which
 * both authenticates the call and identifies the instance. We ACK fast (200)
 * and process in the background via `after()` so the Evolution server never
 * waits on our DB work.
 *
 * Events: MESSAGES_UPSERT (new message), MESSAGES_UPDATE (status),
 * CONNECTION_UPDATE (open/close), QRCODE_UPDATED (fresh QR for the connect UI).
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ secret: string }> },
) {
  const { secret } = await params
  if (!secret) {
    return NextResponse.json({ error: 'missing secret' }, { status: 404 })
  }

  const db = supabaseAdmin()
  const { data: instance } = await db
    .from('whatsapp_instances')
    .select(INSTANCE_COLUMNS)
    .eq('webhook_secret', secret)
    .maybeSingle()
  if (!instance) {
    // Unknown secret — don't reveal whether an instance exists.
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  let body: { event?: string; data?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  }

  after(async () => {
    try {
      await handleEvent(instance as unknown as WhatsappInstanceRow, body)
    } catch (err) {
      console.error('[evolution-webhook] handler failed:', err)
    }
  })

  return NextResponse.json({ ok: true })
}

async function handleEvent(
  instance: WhatsappInstanceRow,
  body: { event?: string; data?: unknown },
): Promise<void> {
  const event = body?.event
  if (!event) return
  const db = supabaseAdmin()
  const normalized = String(event).toUpperCase().replace(/\./g, '_')

  switch (normalized) {
    case 'MESSAGES_UPSERT': {
      for (const msg of normalizeUpsert(body.data)) {
        try {
          await ingestInboundMessage(instance, msg)
        } catch (err) {
          console.error('[evolution-webhook] ingest failed:', err)
        }
      }
      break
    }

    case 'MESSAGES_UPDATE': {
      for (const u of normalizeStatusUpdates(body.data)) {
        // message_id is unique within a conversation; collisions across
        // accounts are vanishingly unlikely for a Baileys key id.
        await db
          .from('messages')
          .update({ status: u.status })
          .eq('message_id', u.providerMessageId)
      }
      break
    }

    case 'GROUP_PARTICIPANTS_UPDATE': {
      const ev = normalizeGroupParticipants(body.data)
      if (ev) {
        try {
          await ingestGroupEvent(instance, ev)
        } catch (err) {
          console.error('[evolution-webhook] group participants failed:', err)
        }
      }
      break
    }

    case 'GROUP_UPDATE': {
      const ev = normalizeGroupUpdate(body.data)
      if (ev) {
        try {
          await ingestGroupEvent(instance, ev)
        } catch (err) {
          console.error('[evolution-webhook] group update failed:', err)
        }
      }
      break
    }

    case 'PRESENCE_UPDATE': {
      // Ephemeral typing/online → broadcast to the inbox, never persisted.
      // Return early so the high-frequency event doesn't write last_webhook_at.
      const p = normalizePresence(body.data)
      if (p) await broadcastPresence(instance.account_id, p)
      return
    }

    case 'CONNECTION_UPDATE': {
      const state = (body.data as { state?: string } | undefined)?.state
      const status = mapEvolutionState(state)
      const patch: Record<string, unknown> = { status, last_webhook_at: new Date().toISOString() }
      if (status === 'connected') {
        patch.connected_at = new Date().toISOString()
        patch.qr_code = null
        patch.last_error = null
        patch.reconnect_attempts = 0
      }
      await db.from('whatsapp_instances').update(patch).eq('id', instance.id)
      return
    }

    case 'QRCODE_UPDATED': {
      const qr = extractQrBase64(body.data)
      if (qr) {
        await db
          .from('whatsapp_instances')
          .update({ qr_code: qr, last_qr_at: new Date().toISOString(), status: 'qr_pending' })
          .eq('id', instance.id)
      }
      return
    }
  }

  await db
    .from('whatsapp_instances')
    .update({ last_webhook_at: new Date().toISOString() })
    .eq('id', instance.id)
}
