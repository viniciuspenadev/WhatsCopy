/**
 * Shared inbound ingestion.
 *
 * Both providers normalise their webhook payload into the provider-agnostic
 * `InboundMessage` shape below, then call `ingestInboundMessage` to persist
 * it: find-or-create the contact (1:1) or group conversation, download media,
 * insert the message (deduped by provider message id), and bump the
 * conversation preview / unread counter.
 *
 * Runs with the service-role client (the webhook has no user session), so it
 * sets `user_id` to the account owner — the same audit identity the Meta
 * webhook uses for inbound rows.
 *
 * Groups appear automatically (no opt-in whitelist): a `@g.us` chat becomes a
 * conversation with `is_group = true`, `contact_id = NULL`, and whatever
 * metadata Baileys exposes (subject / picture / participants). Each message
 * records the sending participant in `group_participant_jid` + `sender_display`.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { getProvider, type WhatsappInstanceRow } from './factory'
import { EvolutionProvider } from './providers/evolution'

const CHAT_BUCKET = 'chat-media'

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/amr': 'amr',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'application/pdf': 'pdf',
}

/** Content types that map onto the `messages.content_type` CHECK constraint. */
export type InboundContentType =
  | 'text'
  | 'image'
  | 'audio'
  | 'video'
  | 'document'
  | 'location'
  | 'interactive'

/** Provider-agnostic inbound message — what every normaliser emits. */
export interface InboundMessage {
  /** Provider message id (Meta wamid / Baileys key.id). Dedup key. */
  providerMessageId: string | null
  /** True when sent by the connected number itself (agent / synced from phone). */
  fromMe: boolean
  /** Chat JID: `<phone>@s.whatsapp.net` (1:1) or `<id>@g.us` (group). */
  chatJid: string
  isGroup: boolean
  /** Group sender JID (groups only). */
  participantJid: string | null
  /** Sender push name. */
  pushName: string | null
  contentType: InboundContentType
  contentText: string | null
  mediaMimeType: string | null
  mediaFileName: string | null
  /** Reactions are stored in message_reactions, not messages. */
  isReaction: boolean
  reactionEmoji?: string | null
  reactionTargetId?: string | null
  /** The raw provider message — passed to the media downloader. */
  raw?: unknown
}

const MEDIA_TYPES: ReadonlySet<InboundContentType> = new Set([
  'image',
  'audio',
  'video',
  'document',
])

export function jidToPhone(jid: string): string {
  return jid.split('@')[0].split(':')[0].replace(/\D/g, '')
}

export async function ingestInboundMessage(
  instance: WhatsappInstanceRow,
  msg: InboundMessage,
): Promise<void> {
  const db = supabaseAdmin()
  const accountId = instance.account_id
  const ownerUserId = await getAccountOwner(db, accountId)

  // ---- Resolve conversation (+ contact for 1:1) ----
  let conversationId: string
  let unreadCount: number
  if (msg.isGroup) {
    const conv = await findOrCreateGroupConversation(db, instance, ownerUserId, msg)
    conversationId = conv.id
    unreadCount = conv.unread_count ?? 0
  } else {
    const phone = jidToPhone(msg.chatJid)
    const contactId = await findOrCreateContact(db, accountId, ownerUserId, phone, msg.pushName)
    const conv = await findOrCreateConversation(db, accountId, ownerUserId, contactId, instance.id)
    conversationId = conv.id
    unreadCount = conv.unread_count ?? 0
  }

  // ---- Reactions live in message_reactions, not messages ----
  if (msg.isReaction) {
    await handleReaction(db, conversationId, msg)
    return
  }

  // ---- Media download → chat-media bucket (Evolution returns base64) ----
  let mediaUrl: string | null = null
  if (MEDIA_TYPES.has(msg.contentType) && instance.provider === 'evolution' && msg.raw) {
    try {
      const provider = getProvider(instance) as EvolutionProvider
      const res = await provider.getMediaBase64(msg.raw)
      if (res?.base64) {
        mediaUrl = await uploadMedia(db, accountId, res, msg)
      }
    } catch (err) {
      console.error('[ingest] media download failed:', err instanceof Error ? err.message : err)
    }
  }

  // ---- Insert message (deduped by the unique (conversation_id, message_id)) ----
  const senderType = msg.fromMe ? 'agent' : 'customer'
  const { error: insertErr } = await db.from('messages').insert({
    conversation_id: conversationId,
    sender_type: senderType,
    content_type: msg.contentType,
    content_text: msg.contentText,
    media_url: mediaUrl,
    message_id: msg.providerMessageId,
    status: msg.fromMe ? 'sent' : 'delivered',
    group_participant_jid: msg.isGroup ? msg.participantJid : null,
    sender_display: msg.isGroup ? msg.pushName : null,
  })
  // 23505 = the same provider message id was already ingested (webhook retry).
  if (insertErr) {
    if (insertErr.code === '23505') return
    throw insertErr
  }

  // ---- Bump conversation preview / unread ----
  const preview = (msg.contentText ?? `[${msg.contentType}]`).slice(0, 200)
  await db
    .from('conversations')
    .update({
      last_message_text: preview,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      // Only inbound (customer) messages increment the unread badge.
      ...(msg.fromMe ? {} : { unread_count: unreadCount + 1 }),
    })
    .eq('id', conversationId)

  await db
    .from('whatsapp_instances')
    .update({ last_inbound_at: new Date().toISOString() })
    .eq('id', instance.id)
}

// ------------------------------------------------------------

async function getAccountOwner(db: SupabaseClient, accountId: string): Promise<string> {
  const { data } = await db
    .from('accounts')
    .select('owner_user_id')
    .eq('id', accountId)
    .maybeSingle()
  if (!data?.owner_user_id) throw new Error(`account ${accountId} has no owner_user_id`)
  return data.owner_user_id as string
}

async function findOrCreateContact(
  db: SupabaseClient,
  accountId: string,
  ownerUserId: string,
  phone: string,
  pushName: string | null,
): Promise<string> {
  const norm = phone.replace(/\D/g, '')
  const findByNorm = () =>
    db
      .from('contacts')
      .select('id, name')
      .eq('account_id', accountId)
      .eq('phone_normalized', norm)
      .maybeSingle()

  const { data: existing } = await findByNorm()
  if (existing) {
    if (pushName && !existing.name) {
      await db.from('contacts').update({ name: pushName }).eq('id', existing.id)
    }
    return existing.id as string
  }

  const { data: created, error } = await db
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: ownerUserId,
      phone: `+${norm}`,
      name: pushName ?? null,
    })
    .select('id')
    .single()
  if (error) {
    // Concurrent insert hit the (account_id, phone_normalized) unique index.
    if (error.code === '23505') {
      const { data: raced } = await findByNorm()
      if (raced) return raced.id as string
    }
    throw error
  }
  return created.id as string
}

async function findOrCreateConversation(
  db: SupabaseClient,
  accountId: string,
  ownerUserId: string,
  contactId: string,
  instanceId: string,
): Promise<{ id: string; unread_count: number | null }> {
  const { data: existing } = await db
    .from('conversations')
    .select('id, unread_count')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (existing) {
    // Heal threads created before instance_id existed.
    await db
      .from('conversations')
      .update({ instance_id: instanceId })
      .eq('id', existing.id)
      .is('instance_id', null)
    return existing
  }

  const { data: created, error } = await db
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: ownerUserId,
      contact_id: contactId,
      instance_id: instanceId,
      status: 'open',
      unread_count: 0,
    })
    .select('id, unread_count')
    .single()
  if (error) throw error
  return created
}

async function findOrCreateGroupConversation(
  db: SupabaseClient,
  instance: WhatsappInstanceRow,
  ownerUserId: string,
  msg: InboundMessage,
): Promise<{ id: string; unread_count: number | null }> {
  const groupJid = msg.chatJid
  const findGroup = () =>
    db
      .from('conversations')
      .select('id, unread_count')
      .eq('account_id', instance.account_id)
      .eq('instance_id', instance.id)
      .eq('group_jid', groupJid)
      .maybeSingle()

  const { data: existing } = await findGroup()
  if (existing) return existing

  // Best-effort group metadata (subject / picture / participants).
  let groupName: string | null = null
  let groupPicture: string | null = null
  let groupMembers: unknown = null
  let groupMetadata: unknown = null
  try {
    const meta = await getProvider(instance).fetchGroupMetadata(groupJid)
    if (meta) {
      groupName = meta.subject ?? null
      groupPicture = meta.pictureUrl ?? null
      groupMembers = meta.participants ?? null
      groupMetadata = meta
    }
  } catch {
    /* metadata is optional — never block the message on it */
  }

  const { data: created, error } = await db
    .from('conversations')
    .insert({
      account_id: instance.account_id,
      user_id: ownerUserId,
      contact_id: null,
      instance_id: instance.id,
      status: 'open',
      unread_count: 0,
      is_group: true,
      group_jid: groupJid,
      group_name: groupName,
      group_picture: groupPicture,
      group_members: groupMembers,
      group_metadata: groupMetadata,
    })
    .select('id, unread_count')
    .single()
  if (error) {
    // Concurrent webhook already created it (unique account_id, instance_id, group_jid).
    if (error.code === '23505') {
      const { data: raced } = await findGroup()
      if (raced) return raced
    }
    throw error
  }
  return created
}

async function uploadMedia(
  db: SupabaseClient,
  accountId: string,
  res: { base64: string; mimetype?: string; fileName?: string },
  msg: InboundMessage,
): Promise<string | null> {
  const mime = (res.mimetype ?? msg.mediaMimeType ?? 'application/octet-stream')
    .split(';')[0]
    .trim()
  const ext = MIME_EXT[mime] ?? 'bin'
  const base = (msg.mediaFileName ?? res.fileName ?? `${msg.contentType}_${Date.now()}.${ext}`).replace(
    /[^a-zA-Z0-9.\-_]/g,
    '_',
  )
  const path = `account-${accountId}/${Date.now()}_${base}`
  const buffer = Buffer.from(res.base64, 'base64')
  const { error } = await db.storage.from(CHAT_BUCKET).upload(path, buffer, {
    contentType: mime,
    upsert: false,
  })
  if (error) {
    console.error('[ingest] media upload failed:', error.message)
    return null
  }
  const { data } = db.storage.from(CHAT_BUCKET).getPublicUrl(path)
  return data.publicUrl
}

async function handleReaction(
  db: SupabaseClient,
  conversationId: string,
  msg: InboundMessage,
): Promise<void> {
  if (!msg.reactionTargetId) return
  const { data: target } = await db
    .from('messages')
    .select('id')
    .eq('conversation_id', conversationId)
    .eq('message_id', msg.reactionTargetId)
    .maybeSingle()
  if (!target) return
  const actorType = msg.fromMe ? 'agent' : 'customer'
  try {
    if (!msg.reactionEmoji) {
      await db
        .from('message_reactions')
        .delete()
        .eq('message_id', target.id)
        .eq('actor_type', actorType)
    } else {
      await db.from('message_reactions').upsert(
        {
          message_id: target.id,
          conversation_id: conversationId,
          actor_type: actorType,
          actor_id: null,
          emoji: msg.reactionEmoji,
        },
        { onConflict: 'message_id,actor_type,actor_id' },
      )
    }
  } catch (err) {
    console.error('[ingest] reaction mirror failed:', err instanceof Error ? err.message : err)
  }
}
