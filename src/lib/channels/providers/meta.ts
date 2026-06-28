/**
 * Meta WhatsApp Cloud API provider.
 *
 * A thin adapter over the existing `src/lib/whatsapp/meta-api.ts` helpers:
 * it carries the instance's credentials so callers don't, and forwards
 * each messaging call straight through. Behaviour is byte-for-byte what
 * the routes did before the channel abstraction — this file adds no new
 * Meta logic, it only relocates the credential plumbing.
 *
 * Connection-lifecycle methods throw `UnsupportedChannelOperation`: a
 * Cloud API number is connected in Meta's own Embedded Signup / WhatsApp
 * Manager UI, never via a QR we render.
 */

import {
  sendTextMessage,
  sendMediaMessage,
  sendTemplateMessage,
  sendReactionMessage,
  sendInteractiveButtons,
  sendInteractiveList,
} from '@/lib/whatsapp/meta-api'
import {
  type ChannelProvider,
  type SendTextArgs,
  type SendMediaArgs,
  type SendTemplateArgs,
  type SendReactionArgs,
  type SendButtonsArgs,
  type SendListArgs,
  type SendResult,
  type ConnectionState,
  type QrResult,
  type GroupMetadata,
  UnsupportedChannelOperation,
} from '../provider'

export interface MetaProviderConfig {
  phoneNumberId: string
  /** Already decrypted by the factory. */
  accessToken: string
  wabaId?: string
}

export class MetaProvider implements ChannelProvider {
  readonly name = 'meta' as const
  private readonly phoneNumberId: string
  private readonly accessToken: string

  constructor(config: MetaProviderConfig) {
    this.phoneNumberId = config.phoneNumberId
    this.accessToken = config.accessToken
  }

  private creds() {
    return { phoneNumberId: this.phoneNumberId, accessToken: this.accessToken }
  }

  sendText(args: SendTextArgs): Promise<SendResult> {
    return sendTextMessage({ ...this.creds(), ...args })
  }

  sendMedia(args: SendMediaArgs): Promise<SendResult> {
    return sendMediaMessage({ ...this.creds(), ...args })
  }

  sendTemplate(args: SendTemplateArgs): Promise<SendResult> {
    return sendTemplateMessage({ ...this.creds(), ...args })
  }

  sendReaction(args: SendReactionArgs): Promise<SendResult> {
    return sendReactionMessage({
      ...this.creds(),
      to: args.to,
      targetMessageId: args.targetMessageId,
      emoji: args.emoji,
    })
  }

  sendButtons(args: SendButtonsArgs): Promise<SendResult> {
    return sendInteractiveButtons({ ...this.creds(), ...args })
  }

  sendList(args: SendListArgs): Promise<SendResult> {
    return sendInteractiveList({ ...this.creds(), ...args })
  }

  // ---- Lifecycle: not applicable to the Cloud API ----
  createInstance(): Promise<void> {
    throw new UnsupportedChannelOperation('meta', 'createInstance')
  }
  setWebhook(): Promise<void> {
    throw new UnsupportedChannelOperation('meta', 'setWebhook')
  }
  getQrCode(): Promise<QrResult> {
    throw new UnsupportedChannelOperation('meta', 'getQrCode')
  }
  getConnectionState(): Promise<ConnectionState> {
    throw new UnsupportedChannelOperation('meta', 'getConnectionState')
  }
  logout(): Promise<void> {
    throw new UnsupportedChannelOperation('meta', 'logout')
  }
  fetchGroupMetadata(): Promise<GroupMetadata | null> {
    throw new UnsupportedChannelOperation('meta', 'fetchGroupMetadata')
  }
}
