/**
 * Channel provider abstraction.
 *
 * WhatsCopy started life speaking only the Meta WhatsApp Cloud API. To
 * add the Evolution API (Baileys) as a second provider WITHOUT forking
 * every send/receive path, all outbound messaging now goes through the
 * `ChannelProvider` interface below. A provider is constructed from a
 * `whatsapp_instances` row (see `factory.ts`) and owns its own
 * credentials, so callers never juggle phone_number_id / access tokens —
 * they just `getProvider(instance).sendText({ to, text })`.
 *
 * Messaging methods (sendText/Media/Template/Reaction/Buttons/List) are
 * implemented by every provider. Connection-lifecycle methods
 * (createInstance/getQrCode/...) only make sense for self-hosted Baileys;
 * the Meta provider throws `UnsupportedChannelOperation` for those, since
 * a Cloud API number is connected out-of-band in Meta's own UI.
 */

import type { MediaKind, InteractiveButton, InteractiveListSection } from '@/lib/whatsapp/meta-api'
import type { MessageTemplate } from '@/types'
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder'

export type ChannelProviderName = 'meta' | 'evolution'

export type {
  MediaKind,
  InteractiveButton,
  InteractiveListSection,
} from '@/lib/whatsapp/meta-api'

/** Thrown when a method is called on a provider that doesn't support it
 *  (e.g. `getQrCode()` on the Meta provider). Callers can catch this to
 *  branch UI without string-matching error messages. */
export class UnsupportedChannelOperation extends Error {
  constructor(provider: ChannelProviderName, operation: string) {
    super(`Operation "${operation}" is not supported by the ${provider} provider.`)
    this.name = 'UnsupportedChannelOperation'
  }
}

export interface SendResult {
  /** Provider message id — Meta wamid or Baileys key.id. Persisted to
   *  messages.message_id so status webhooks can mirror back. */
  messageId: string
}

export interface SendTextArgs {
  /** Recipient: an E.164-ish number for 1:1, or a `...@g.us` JID for a group. */
  to: string
  text: string
  /** Provider message id being replied to (renders a quote). */
  contextMessageId?: string
  /**
   * Group blasts only (Evolution): mention every participant — the
   * programmatic "@todos". Notifies even muted/archived members. Meta has
   * no groups, so the Meta provider ignores it.
   */
  mentionsEveryOne?: boolean
  /** Explicit list of JIDs to mention (fallback when mentionsEveryOne is
   *  unavailable). Built from group_members. */
  mentioned?: string[]
}

export interface SendMediaArgs {
  to: string
  kind: MediaKind
  /** Public URL the provider fetches at send time. */
  link: string
  caption?: string
  filename?: string
  contextMessageId?: string
  /** Group blasts (Evolution): mention every participant. */
  mentionsEveryOne?: boolean
  mentioned?: string[]
}

export interface SendTemplateArgs {
  to: string
  templateName: string
  language?: string
  params?: string[]
  template?: MessageTemplate
  messageParams?: SendTimeParams
  contextMessageId?: string
}

export interface SendReactionArgs {
  to: string
  /** Provider id of the message being reacted to. */
  targetMessageId: string
  /** Single emoji, or '' to remove. */
  emoji: string
  /** Evolution-only: the reacted message's key flags. Ignored by Meta. */
  targetFromMe?: boolean
}

export interface SendButtonsArgs {
  to: string
  bodyText: string
  headerText?: string
  footerText?: string
  buttons: InteractiveButton[]
  contextMessageId?: string
}

export interface SendListArgs {
  to: string
  bodyText: string
  buttonLabel: string
  headerText?: string
  footerText?: string
  sections: InteractiveListSection[]
  contextMessageId?: string
}

export type InstanceStatus = 'disconnected' | 'connecting' | 'qr_pending' | 'connected'

export interface ConnectionState {
  status: InstanceStatus
  phoneNumber?: string
}

export interface QrResult {
  /** Base64-encoded PNG (data the QR <img> renders). */
  base64?: string
  /** Alternative pairing code (8-char) some clients prefer over the QR. */
  pairingCode?: string
}

export interface GroupParticipant {
  /** Participant JID, e.g. `5511999999999@s.whatsapp.net`. */
  id: string
  /** 'admin' | 'superadmin' | null. */
  admin?: string | null
}

export interface GroupMetadata {
  jid: string
  subject?: string
  description?: string
  pictureUrl?: string
  size?: number
  owner?: string
  /** Unix seconds the group was created. */
  creation?: number
  participants?: GroupParticipant[]
}

export interface ChannelProvider {
  readonly name: ChannelProviderName

  // ---- Messaging (all providers) ----
  sendText(args: SendTextArgs): Promise<SendResult>
  sendMedia(args: SendMediaArgs): Promise<SendResult>
  sendTemplate(args: SendTemplateArgs): Promise<SendResult>
  sendReaction(args: SendReactionArgs): Promise<SendResult>
  sendButtons(args: SendButtonsArgs): Promise<SendResult>
  sendList(args: SendListArgs): Promise<SendResult>

  // ---- Connection lifecycle (Evolution; Meta throws Unsupported) ----
  /** Create the Baileys instance on the Evolution server. */
  createInstance(): Promise<void>
  /** Point the instance's inbound events at `webhookUrl`. */
  setWebhook(webhookUrl: string): Promise<void>
  /** Fetch a fresh QR / pairing code to connect the number. */
  getQrCode(): Promise<QrResult>
  /** Current connection state on the provider's side. */
  getConnectionState(): Promise<ConnectionState>
  /** Disconnect / log the number out (keeps the instance row). */
  logout(): Promise<void>
  /** Group subject / picture / participants for a `...@g.us` JID. */
  fetchGroupMetadata(groupJid: string): Promise<GroupMetadata | null>
}
