/**
 * Evolution (Baileys) payload → provider-agnostic shapes.
 *
 * Parses the raw webhook `data` of each Evolution event into the
 * `InboundMessage` the shared ingest layer consumes, plus helpers for
 * status updates, connection state and QR extraction. Field paths mirror
 * the Baileys message envelope (msg.key.*, msg.message.*).
 */

import type { InboundMessage, InboundContentType } from '../ingest'

/* eslint-disable @typescript-eslint/no-explicit-any */

interface EvoKey {
  id?: string
  remoteJid?: string
  fromMe?: boolean
  participant?: string
}

interface EvoMessageData {
  key?: EvoKey
  pushName?: string
  message?: Record<string, any> | null
  messageType?: string
}

/** Unwrap ephemeral / view-once / edited wrappers down to the real content. */
function unwrap(m: Record<string, any> | null | undefined): Record<string, any> | null {
  if (!m) return null
  let inner = m
  for (let i = 0; i < 3; i++) {
    if (inner.ephemeralMessage?.message) { inner = inner.ephemeralMessage.message; continue }
    if (inner.viewOnceMessage?.message) { inner = inner.viewOnceMessage.message; continue }
    if (inner.viewOnceMessageV2?.message) { inner = inner.viewOnceMessageV2.message; continue }
    if (inner.documentWithCaptionMessage?.message) { inner = inner.documentWithCaptionMessage.message; continue }
    if (inner.editedMessage?.message) { inner = inner.editedMessage.message; continue }
    break
  }
  return inner
}

interface Extracted {
  contentType: InboundContentType
  contentText: string | null
  mediaMimeType: string | null
  mediaFileName: string | null
  isReaction: boolean
  reactionEmoji: string | null
  reactionTargetId: string | null
}

function textResult(content: string | null): Extracted {
  return {
    contentType: 'text',
    contentText: content,
    mediaMimeType: null,
    mediaFileName: null,
    isReaction: false,
    reactionEmoji: null,
    reactionTargetId: null,
  }
}

function extractContent(raw: Record<string, any> | null | undefined): Extracted {
  const m = unwrap(raw)
  if (!m) return textResult(null)

  // Text
  if (typeof m.conversation === 'string') return textResult(m.conversation)
  if (m.extendedTextMessage?.text) return textResult(m.extendedTextMessage.text)

  // Media
  if (m.imageMessage) {
    return { contentType: 'image', contentText: m.imageMessage.caption ?? null, mediaMimeType: m.imageMessage.mimetype ?? null, mediaFileName: null, isReaction: false, reactionEmoji: null, reactionTargetId: null }
  }
  if (m.audioMessage) {
    return { contentType: 'audio', contentText: null, mediaMimeType: m.audioMessage.mimetype ?? null, mediaFileName: null, isReaction: false, reactionEmoji: null, reactionTargetId: null }
  }
  if (m.videoMessage) {
    return { contentType: 'video', contentText: m.videoMessage.caption ?? null, mediaMimeType: m.videoMessage.mimetype ?? null, mediaFileName: null, isReaction: false, reactionEmoji: null, reactionTargetId: null }
  }
  if (m.documentMessage) {
    return { contentType: 'document', contentText: m.documentMessage.caption ?? null, mediaMimeType: m.documentMessage.mimetype ?? null, mediaFileName: m.documentMessage.fileName ?? null, isReaction: false, reactionEmoji: null, reactionTargetId: null }
  }
  // Stickers are webp images — store as image (downloaded via getBase64).
  if (m.stickerMessage) {
    return { contentType: 'image', contentText: null, mediaMimeType: m.stickerMessage.mimetype ?? 'image/webp', mediaFileName: null, isReaction: false, reactionEmoji: null, reactionTargetId: null }
  }

  // Location
  if (m.locationMessage) {
    const lat = m.locationMessage.degreesLatitude ?? 0
    const lng = m.locationMessage.degreesLongitude ?? 0
    return { contentType: 'location', contentText: `${lat},${lng}`, mediaMimeType: null, mediaFileName: null, isReaction: false, reactionEmoji: null, reactionTargetId: null }
  }

  // Reaction
  if (m.reactionMessage) {
    return {
      contentType: 'text',
      contentText: m.reactionMessage.text ?? null,
      mediaMimeType: null,
      mediaFileName: null,
      isReaction: true,
      reactionEmoji: m.reactionMessage.text ?? '',
      reactionTargetId: m.reactionMessage.key?.id ?? null,
    }
  }

  // Interactive replies (button / list)
  if (m.buttonsResponseMessage) {
    return { ...textResult(m.buttonsResponseMessage.selectedDisplayText ?? 'Resposta de botão'), contentType: 'interactive' }
  }
  if (m.listResponseMessage) {
    return { ...textResult(m.listResponseMessage.title ?? 'Item selecionado'), contentType: 'interactive' }
  }

  // Anything else → a readable text placeholder.
  return textResult(null)
}

/** Normalise a MESSAGES_UPSERT payload (single object or array) into
 *  InboundMessages, skipping status broadcasts and protocol messages. */
export function normalizeUpsert(data: unknown): InboundMessage[] {
  const list = Array.isArray(data) ? data : [data]
  const out: InboundMessage[] = []
  for (const item of list as EvoMessageData[]) {
    const key = item?.key
    const jid = key?.remoteJid
    if (!jid || jid === 'status@broadcast') continue
    // Protocol messages (delete/edit/receipts) — out of scope for the test.
    if (item.message?.protocolMessage) continue

    const isGroup = jid.includes('@g.us')
    const ex = extractContent(item.message)
    out.push({
      providerMessageId: key?.id ?? null,
      fromMe: Boolean(key?.fromMe),
      chatJid: jid,
      isGroup,
      participantJid: isGroup ? key?.participant ?? null : null,
      pushName: item.pushName ?? null,
      contentType: ex.contentType,
      contentText: ex.contentText,
      mediaMimeType: ex.mediaMimeType,
      mediaFileName: ex.mediaFileName,
      isReaction: ex.isReaction,
      reactionEmoji: ex.reactionEmoji,
      reactionTargetId: ex.reactionTargetId,
      raw: item,
    })
  }
  return out
}

/** Map a MESSAGES_UPDATE payload to { providerMessageId, status } pairs. */
export function normalizeStatusUpdates(
  data: unknown,
): Array<{ providerMessageId: string; status: 'delivered' | 'read' }> {
  const list = Array.isArray(data) ? data : [data]
  const statusMap: Record<string, 'delivered' | 'read'> = {
    DELIVERY_ACK: 'delivered',
    READ: 'read',
    PLAYED: 'read',
  }
  const out: Array<{ providerMessageId: string; status: 'delivered' | 'read' }> = []
  for (const u of list as Array<{ key?: { id?: string }; status?: string }>) {
    const id = u?.key?.id
    const mapped = u?.status ? statusMap[u.status] : undefined
    if (id && mapped) out.push({ providerMessageId: id, status: mapped })
  }
  return out
}

/** Pull a base64 QR image out of a QRCODE_UPDATED payload (shape varies). */
export function extractQrBase64(data: unknown): string | null {
  const d = data as { qrcode?: { base64?: string }; base64?: string } | undefined
  return d?.qrcode?.base64 ?? d?.base64 ?? null
}
