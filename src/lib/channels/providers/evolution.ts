/**
 * Evolution API (Baileys) provider.
 *
 * Talks to a self-hosted Evolution server over REST. One Evolution
 * "instance" == one connected WhatsApp number == one `whatsapp_instances`
 * row. Credentials come from the row (per-instance `evolution_url` /
 * `evolution_key`) and fall back to the platform env
 * (`EVOLUTION_API_URL` / `EVOLUTION_API_KEY`) — the common shared-server
 * topology. Every request carries the `apikey` header.
 *
 * Endpoint shapes mirror the reference implementation at C:\apps\whatsapp
 * (Evolution v2 / WHATSAPP-BAILEYS integration).
 */

import {
  type ChannelProvider,
  type ChannelProviderName,
  type SendTextArgs,
  type SendMediaArgs,
  type SendTemplateArgs,
  type SendReactionArgs,
  type SendButtonsArgs,
  type SendListArgs,
  type SendResult,
  type ConnectionState,
  type InstanceStatus,
  type QrResult,
  type GroupMetadata,
  type GroupSummary,
} from '../provider'
import type { MessageTemplate } from '@/types'

export interface EvolutionProviderConfig {
  baseUrl: string
  apiKey: string
  instanceName: string
}

/** Events we want Evolution to POST to our inbound webhook. */
export const EVOLUTION_WEBHOOK_EVENTS = [
  'MESSAGES_UPSERT',
  'MESSAGES_UPDATE',
  'CONNECTION_UPDATE',
  'QRCODE_UPDATED',
  // Group monitoring (Pack 5): membership + group metadata changes.
  'GROUP_PARTICIPANTS_UPDATE',
  'GROUP_UPDATE',
  // Presence (Pack 2C): "typing…" / online indicators.
  'PRESENCE_UPDATE',
] as const

export class EvolutionProvider implements ChannelProvider {
  readonly name: ChannelProviderName = 'evolution'
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly instance: string

  constructor(config: EvolutionProviderConfig) {
    // Trim a trailing slash so `${baseUrl}${path}` never doubles up.
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.apiKey = config.apiKey
    this.instance = config.instanceName
  }

  private async req<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        apikey: this.apiKey,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    if (!res.ok) {
      let detail = ''
      try {
        detail = await res.text()
      } catch {
        /* ignore */
      }
      throw new Error(`Evolution API ${method} ${path} failed: ${res.status} ${detail}`)
    }
    // Some endpoints (logout) return empty bodies.
    const text = await res.text()
    return (text ? JSON.parse(text) : {}) as T
  }

  /** Recipient for the `number` field: a bare phone (digits) for 1:1, or
   *  the full `...@g.us` JID for a group (Evolution accepts the JID here). */
  private toNumber(to: string): string {
    return to.includes('@') ? to : to.replace(/\D/g, '')
  }

  /** remoteJid for reactions/keys. */
  private toRemoteJid(to: string): string {
    if (to.includes('@')) return to
    return `${to.replace(/\D/g, '')}@s.whatsapp.net`
  }

  private extractId(data: unknown): string {
    const d = data as { key?: { id?: string }; messageId?: string } | undefined
    return d?.key?.id ?? d?.messageId ?? ''
  }

  // ============================================================
  // Messaging
  // ============================================================

  async sendText(args: SendTextArgs): Promise<SendResult> {
    const body: Record<string, unknown> = {
      number: this.toNumber(args.to),
      text: args.text,
    }
    if (args.contextMessageId) {
      body.quoted = { key: { id: args.contextMessageId } }
    }
    // "@todos": mention every participant of the group. Evolution resolves
    // the member list server-side when mentionsEveryOne is set.
    if (args.mentionsEveryOne) {
      body.mentionsEveryOne = true
    } else if (args.mentioned && args.mentioned.length > 0) {
      body.mentioned = args.mentioned
    }
    const data = await this.req('POST', `/message/sendText/${this.instance}`, body)
    return { messageId: this.extractId(data) }
  }

  async sendMedia(args: SendMediaArgs): Promise<SendResult> {
    // Baileys voice notes have their own endpoint and no caption/filename.
    if (args.kind === 'audio') {
      const data = await this.req('POST', `/message/sendWhatsAppAudio/${this.instance}`, {
        number: this.toNumber(args.to),
        audio: args.link,
      })
      return { messageId: this.extractId(data) }
    }
    const body: Record<string, unknown> = {
      number: this.toNumber(args.to),
      mediatype: args.kind, // 'image' | 'video' | 'document'
      media: args.link,
    }
    if (args.caption) body.caption = args.caption
    if (args.filename) body.fileName = args.filename
    if (args.contextMessageId) body.quoted = { key: { id: args.contextMessageId } }
    if (args.mentionsEveryOne) {
      body.mentionsEveryOne = true
    } else if (args.mentioned && args.mentioned.length > 0) {
      body.mentioned = args.mentioned
    }
    const data = await this.req('POST', `/message/sendMedia/${this.instance}`, body)
    return { messageId: this.extractId(data) }
  }

  /**
   * Baileys has no Meta-style approved templates. We fall back to sending
   * the template's rendered body as a plain text message (header media is
   * sent first when present) so broadcasts still work on Evolution
   * numbers. The route layer is responsible for not offering Meta-only
   * template features on an Evolution instance.
   */
  async sendTemplate(args: SendTemplateArgs): Promise<SendResult> {
    const text = renderTemplateToText(args)
    if (!text) {
      throw new Error('Cannot render template to text for the Evolution provider.')
    }
    return this.sendText({ to: args.to, text, contextMessageId: args.contextMessageId })
  }

  async sendReaction(args: SendReactionArgs): Promise<SendResult> {
    const data = await this.req('POST', `/message/sendReaction/${this.instance}`, {
      key: {
        remoteJid: this.toRemoteJid(args.to),
        fromMe: args.targetFromMe ?? false,
        id: args.targetMessageId,
      },
      reaction: args.emoji,
    })
    return { messageId: this.extractId(data) }
  }

  /** Buttons/lists: Baileys interactive support is unreliable across
   *  WhatsApp clients, so we degrade to a numbered text menu. */
  async sendButtons(args: SendButtonsArgs): Promise<SendResult> {
    const lines = [
      ...(args.headerText ? [args.headerText, ''] : []),
      args.bodyText,
      '',
      ...args.buttons.map((b, i) => `${i + 1}. ${b.title}`),
      ...(args.footerText ? ['', args.footerText] : []),
    ]
    return this.sendText({ to: args.to, text: lines.join('\n'), contextMessageId: args.contextMessageId })
  }

  async sendList(args: SendListArgs): Promise<SendResult> {
    const rows = args.sections.flatMap((s) => [
      ...(s.title ? [`*${s.title}*`] : []),
      ...s.rows.map((r) => `• ${r.title}${r.description ? ` — ${r.description}` : ''}`),
    ])
    const lines = [
      ...(args.headerText ? [args.headerText, ''] : []),
      args.bodyText,
      '',
      ...rows,
      ...(args.footerText ? ['', args.footerText] : []),
    ]
    return this.sendText({ to: args.to, text: lines.join('\n'), contextMessageId: args.contextMessageId })
  }

  // ============================================================
  // Connection lifecycle
  // ============================================================

  async createInstance(): Promise<void> {
    await this.req('POST', '/instance/create', {
      instanceName: this.instance,
      integration: 'WHATSAPP-BAILEYS',
      qrcode: true,
    })
  }

  async setWebhook(webhookUrl: string): Promise<void> {
    await this.req('POST', `/webhook/set/${this.instance}`, {
      webhook: {
        url: webhookUrl,
        enabled: true,
        webhookByEvents: false,
        webhookBase64: true,
        events: [...EVOLUTION_WEBHOOK_EVENTS],
      },
    })
  }

  async getQrCode(): Promise<QrResult> {
    const data = await this.req<{ base64?: string; pairingCode?: string; code?: string }>(
      'GET',
      `/instance/connect/${this.instance}`,
    )
    return { base64: data.base64, pairingCode: data.pairingCode ?? data.code }
  }

  async getConnectionState(): Promise<ConnectionState> {
    const data = await this.req<{ instance?: { state?: string } }>(
      'GET',
      `/instance/connectionState/${this.instance}`,
    )
    return { status: mapEvolutionState(data.instance?.state) }
  }

  async logout(): Promise<void> {
    await this.req('DELETE', `/instance/logout/${this.instance}`)
  }

  async fetchGroupMetadata(groupJid: string): Promise<GroupMetadata | null> {
    try {
      const data = await this.req<{
        id?: string
        subject?: string
        desc?: string
        pictureUrl?: string
        size?: number
        owner?: string
        creation?: number
        participants?: Array<{ id: string; admin?: string | null }>
      }>('GET', `/group/findGroupInfos/${this.instance}?groupJid=${encodeURIComponent(groupJid)}`)
      if (!data?.id) return null
      return {
        jid: data.id,
        subject: data.subject,
        description: data.desc,
        pictureUrl: data.pictureUrl,
        size: data.size,
        owner: data.owner,
        creation: data.creation,
        participants: data.participants,
      }
    } catch {
      // Group metadata is best-effort — a failure shouldn't drop the message.
      return null
    }
  }

  async fetchAllGroups(): Promise<GroupSummary[]> {
    const data = await this.req<unknown>(
      'GET',
      `/group/fetchAllGroups/${this.instance}?getParticipants=false`,
    )
    const arr = Array.isArray(data) ? data : ((data as { groups?: unknown[] })?.groups ?? [])
    return (arr as Array<Record<string, unknown>>)
      .map((g) => ({
        jid: String(g.id ?? g.jid ?? ''),
        subject: (g.subject ?? g.name) as string | undefined,
        size: (g.size ??
          (Array.isArray(g.participants) ? g.participants.length : undefined)) as number | undefined,
        pictureUrl: (g.pictureUrl ?? g.profilePicUrl) as string | undefined,
      }))
      .filter((g) => g.jid)
  }

  async fetchProfilePictureUrl(jid: string): Promise<string | null> {
    try {
      // Evolution v2: POST /chat/fetchProfilePictureUrl/{instance} { number }.
      // Accepts a bare phone or a full JID; returns { profilePictureUrl }.
      const data = await this.req<{ profilePictureUrl?: string | null; url?: string | null }>(
        'POST',
        `/chat/fetchProfilePictureUrl/${this.instance}`,
        { number: this.toNumber(jid) },
      )
      return data?.profilePictureUrl ?? data?.url ?? null
    } catch {
      // Best-effort — no photo / privacy / not-on-WhatsApp must not throw.
      return null
    }
  }

  /** Download inbound media (Evolution returns base64, not a URL). Used by
   *  the inbound ingest layer to persist attachments to storage. */
  async getMediaBase64(message: unknown): Promise<{ base64: string; mimetype?: string; fileName?: string }> {
    return this.req('POST', `/chat/getBase64FromMediaMessage/${this.instance}`, {
      message,
      convertToMp4: false,
    })
  }
}

/** Map Evolution's connection state to our instance status vocabulary. */
export function mapEvolutionState(state: string | undefined): InstanceStatus {
  switch (state) {
    case 'open':
      return 'connected'
    case 'connecting':
      return 'connecting'
    case 'close':
    default:
      return 'disconnected'
  }
}

/** Render a Meta template row to plain text with `{{n}}` substitution so
 *  it can be sent over Baileys. */
function renderTemplateToText(args: SendTemplateArgs): string {
  const tpl = args.template as MessageTemplate | undefined
  const values = args.messageParams?.body ?? args.params ?? []
  const base = tpl?.body_text ?? ''
  let text = base.replace(/\{\{\s*(\d+)\s*\}\}/g, (_m, n: string) => {
    const idx = Number(n) - 1
    return values[idx] != null ? String(values[idx]) : ''
  })
  if (tpl?.footer_text) text += `\n\n${tpl.footer_text}`
  return text.trim()
}
