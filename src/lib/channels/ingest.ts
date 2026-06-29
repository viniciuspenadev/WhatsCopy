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
import { uploadAccountMediaFromUrl } from '@/lib/storage/upload-media-server'
import { getProvider, type WhatsappInstanceRow } from './factory'
import { EvolutionProvider } from './providers/evolution'
import type { GroupEvent } from './normalize/evolution'

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
  let avatarToSync: { contactId: string; phone: string; avatarUpdatedAt: string | null } | null =
    null
  if (msg.isGroup) {
    const conv = await findOrCreateGroupConversation(db, instance, ownerUserId, msg)
    conversationId = conv.id
    unreadCount = conv.unread_count ?? 0
  } else {
    const phone = jidToPhone(msg.chatJid)
    const contact = await findOrCreateContact(db, accountId, ownerUserId, phone, msg.pushName)
    const conv = await findOrCreateConversation(db, accountId, ownerUserId, contact.id, instance.id)
    conversationId = conv.id
    unreadCount = conv.unread_count ?? 0
    // Premium inbox: pull the contact's WhatsApp profile photo (best-effort,
    // throttled). Stash it to run after the message is persisted so a slow /
    // failing avatar fetch never delays or blocks the actual message insert.
    avatarToSync = { contactId: contact.id, phone, avatarUpdatedAt: contact.avatarUpdatedAt }
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

  // ---- Best-effort contact avatar (after the message is safely persisted) ----
  if (avatarToSync) {
    await ensureContactAvatar(db, instance, avatarToSync)
  }
}

/**
 * Pull a 1:1 contact's WhatsApp profile photo and re-host it in chat-media so
 * the inbox shows real faces instead of initials. Throttled by
 * `avatar_updated_at` (provider photos rarely change; re-fetching on every
 * inbound message would hammer the Evolution server). Entirely best-effort:
 * any failure (no photo, privacy, provider down) is swallowed and we still
 * stamp `avatar_updated_at` so we don't retry on the next message.
 */
const AVATAR_REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000

async function ensureContactAvatar(
  db: SupabaseClient,
  instance: WhatsappInstanceRow,
  info: { contactId: string; phone: string; avatarUpdatedAt: string | null },
): Promise<void> {
  // Throttle: skip if synced within the TTL window.
  if (info.avatarUpdatedAt) {
    const age = Date.now() - new Date(info.avatarUpdatedAt).getTime()
    if (age >= 0 && age < AVATAR_REFRESH_TTL_MS) return
  }
  try {
    const provider = getProvider(instance)
    const cdnUrl = await provider.fetchProfilePictureUrl(info.phone)
    let publicUrl: string | null = null
    if (cdnUrl) {
      const up = await uploadAccountMediaFromUrl(CHAT_BUCKET, instance.account_id, cdnUrl)
      publicUrl = up?.publicUrl ?? null
    }
    await db
      .from('contacts')
      .update({
        // Only overwrite the photo when we actually got one — a privacy-hidden
        // contact (null) shouldn't wipe a previously-synced avatar.
        ...(publicUrl ? { avatar_url: publicUrl } : {}),
        avatar_updated_at: new Date().toISOString(),
      })
      .eq('id', info.contactId)
  } catch (err) {
    console.error('[ingest] avatar sync failed:', err instanceof Error ? err.message : err)
  }
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

interface ResolvedContact {
  id: string
  avatarUpdatedAt: string | null
}

async function findOrCreateContact(
  db: SupabaseClient,
  accountId: string,
  ownerUserId: string,
  phone: string,
  pushName: string | null,
): Promise<ResolvedContact> {
  const norm = phone.replace(/\D/g, '')
  const findByNorm = () =>
    db
      .from('contacts')
      .select('id, name, avatar_updated_at')
      .eq('account_id', accountId)
      .eq('phone_normalized', norm)
      .maybeSingle()

  const { data: existing } = await findByNorm()
  if (existing) {
    if (pushName && !existing.name) {
      await db.from('contacts').update({ name: pushName }).eq('id', existing.id)
    }
    return { id: existing.id as string, avatarUpdatedAt: existing.avatar_updated_at ?? null }
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
      if (raced) return { id: raced.id as string, avatarUpdatedAt: raced.avatar_updated_at ?? null }
    }
    throw error
  }
  // Brand-new contact → never synced.
  return { id: created.id as string, avatarUpdatedAt: null }
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

// ------------------------------------------------------------
// Group monitoring (Pack 5): record membership/metadata events as SYSTEM
// messages in the group's timeline and keep member_count/group_members exact.
// ------------------------------------------------------------

function fmtJid(jid: string | null): string {
  if (!jid) return 'Alguém'
  const phone = jidToPhone(jid)
  return phone ? `+${phone}` : 'Alguém'
}

function buildGroupEventLines(ev: GroupEvent): Array<{ text: string; targetJid: string | null }> {
  const lines: Array<{ text: string; targetJid: string | null }> = []
  const author = ev.author
  switch (ev.action) {
    case 'add':
      for (const p of ev.participants)
        lines.push({
          text: author && author !== p ? `${fmtJid(author)} adicionou ${fmtJid(p)}` : `${fmtJid(p)} entrou`,
          targetJid: p,
        })
      break
    case 'remove':
      for (const p of ev.participants)
        lines.push({
          text: author && author !== p ? `${fmtJid(author)} removeu ${fmtJid(p)}` : `${fmtJid(p)} saiu`,
          targetJid: p,
        })
      break
    case 'promote':
      for (const p of ev.participants)
        lines.push({ text: `${fmtJid(p)} agora é admin`, targetJid: p })
      break
    case 'demote':
      for (const p of ev.participants)
        lines.push({ text: `${fmtJid(p)} deixou de ser admin`, targetJid: p })
      break
    case 'subject':
      lines.push({
        text: `Nome do grupo alterado${ev.subject ? ` para "${ev.subject}"` : ''}`,
        targetJid: null,
      })
      break
    case 'description':
      lines.push({ text: 'Descrição do grupo alterada', targetJid: null })
      break
    case 'picture':
      lines.push({ text: 'Foto do grupo alterada', targetJid: null })
      break
  }
  return lines
}

async function ensureGroupConversation(
  db: SupabaseClient,
  instance: WhatsappInstanceRow,
  ownerUserId: string,
  groupJid: string,
): Promise<{ id: string } | null> {
  const find = () =>
    db
      .from('conversations')
      .select('id')
      .eq('account_id', instance.account_id)
      .eq('instance_id', instance.id)
      .eq('group_jid', groupJid)
      .maybeSingle()

  const { data: existing } = await find()
  if (existing) return existing as { id: string }

  let groupName: string | null = null
  let groupPicture: string | null = null
  let groupMembers: unknown = null
  let groupMetadata: unknown = null
  let memberCount: number | null = null
  try {
    const meta = await getProvider(instance).fetchGroupMetadata(groupJid)
    if (meta) {
      groupName = meta.subject ?? null
      groupPicture = meta.pictureUrl ?? null
      groupMembers = meta.participants ?? null
      groupMetadata = meta
      memberCount = meta.size ?? (Array.isArray(meta.participants) ? meta.participants.length : null)
    }
  } catch {
    /* metadata optional */
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
      member_count: memberCount,
    })
    .select('id')
    .single()
  if (error) {
    if (error.code === '23505') {
      const { data: raced } = await find()
      if (raced) return raced as { id: string }
    }
    return null
  }
  return created as { id: string }
}

/**
 * Persist a group membership/metadata event. Each line becomes a `system`
 * message in the group timeline (rendered as a centered pill, WhatsApp-style)
 * and powers the /monitoring counters. We intentionally do NOT bump the
 * conversation's unread/preview — joins and leaves shouldn't spam the inbox.
 * Membership is then re-fetched so the monitoring bar stays exact.
 */
export async function ingestGroupEvent(
  instance: WhatsappInstanceRow,
  ev: GroupEvent,
): Promise<void> {
  const db = supabaseAdmin()
  const ownerUserId = await getAccountOwner(db, instance.account_id)
  const conv = await ensureGroupConversation(db, instance, ownerUserId, ev.groupJid)
  if (!conv) return

  // Coarse dedup window so a webhook retry within the same minute doesn't
  // double-log; legitimate repeats (leave + rejoin later) stay distinct.
  const bucket = Math.floor(Date.now() / 60_000)
  for (const line of buildGroupEventLines(ev)) {
    const dedupId = `grpevt:${ev.action}:${line.targetJid ?? ev.groupJid}:${bucket}`
    const { error } = await db.from('messages').insert({
      conversation_id: conv.id,
      sender_type: 'system',
      content_type: 'system',
      content_text: line.text,
      message_id: dedupId,
      status: 'delivered',
      payload: {
        kind: 'group_event',
        action: ev.action,
        actorJid: ev.author ?? null,
        targetJid: line.targetJid ?? null,
      },
    })
    if (error && error.code !== '23505') {
      console.error('[ingest] group event insert failed:', error.message)
    }
  }

  // Authoritative membership refresh (cheap; group events are infrequent).
  try {
    const meta = await getProvider(instance).fetchGroupMetadata(ev.groupJid)
    if (meta) {
      await db
        .from('conversations')
        .update({
          member_count:
            meta.size ?? (Array.isArray(meta.participants) ? meta.participants.length : null),
          group_members: meta.participants ?? null,
          group_metadata: meta,
          ...(meta.subject ? { group_name: meta.subject } : {}),
          ...(meta.pictureUrl ? { group_picture: meta.pictureUrl } : {}),
          updated_at: new Date().toISOString(),
        })
        .eq('id', conv.id)
    }
  } catch {
    /* membership refresh is best-effort */
  }
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
