/**
 * AI copy generation for offers.
 *
 * `AICopyProvider` is the pluggable seam; `ClaudeCopyProvider` is the default
 * (Anthropic SDK). The operator picks provider/model/key in God Mode — stored
 * in `platform_settings` (migration 035), the key AES-256-GCM encrypted. The
 * end client never chooses the model and never sees the key.
 *
 * Cost control: the system prompt is STABLE and marked `cache_control`
 * ephemeral, so repeated generations read it from cache (~0.1x). The volatile
 * product data goes in the user turn, after the cache breakpoint. `max_tokens`
 * is kept small (short marketing copy), no thinking. Output is constrained to
 * a JSON schema so we always get { headline, body, cta } back.
 *
 * NOTE on caching: the 5-min ephemeral cache only kicks in once the system
 * prefix crosses the model's minimum (Haiku 4.5 = 4096 tokens). Below that it
 * silently won't cache (no error) — the prompt below is intentionally rich.
 */

import Anthropic from '@anthropic-ai/sdk'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import { getPersona, type OfferPersonaKey } from '@/lib/offers/personas'

/** Models the operator may select in God Mode, grouped by provider. */
export const AI_MODELS_BY_PROVIDER = {
  claude: ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-8'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
} as const
export type AIProvider = keyof typeof AI_MODELS_BY_PROVIDER

/** Flat allowlist for validation. */
export const ALLOWED_AI_MODELS: string[] = [
  ...AI_MODELS_BY_PROVIDER.claude,
  ...AI_MODELS_BY_PROVIDER.openai,
]
export const DEFAULT_AI_MODEL = 'claude-haiku-4-5'

/** Which provider a given model belongs to (for validation). */
export function providerForModel(model: string): AIProvider | null {
  if ((AI_MODELS_BY_PROVIDER.claude as readonly string[]).includes(model)) return 'claude'
  if ((AI_MODELS_BY_PROVIDER.openai as readonly string[]).includes(model)) return 'openai'
  return null
}

export interface CopyInput {
  title: string | null
  priceFromCents: number | null
  priceToCents: number | null
  coupon: string | null
  affiliateUrl: string | null
  persona: OfferPersonaKey
}

export interface CopyResult {
  headline: string
  body: string
  cta: string
}

export interface AICopyProvider {
  generate(input: CopyInput): Promise<CopyResult>
}

export interface PlatformAISettings {
  aiProvider: 'claude' | 'openai'
  aiModel: string
  apiKey: string | null
}

/** Assemble the full copy text the user edits / sends. */
export function composeOfferCopy(r: CopyResult, input: CopyInput): string {
  const parts = [r.headline.trim(), r.body.trim()]
  if (input.coupon) parts.push(`🏷️ Cupom: *${input.coupon}*`)
  if (input.affiliateUrl) parts.push(input.affiliateUrl.trim())
  parts.push(r.cta.trim())
  return parts.filter(Boolean).join('\n\n')
}

function brl(cents: number | null): string | null {
  if (cents == null) return null
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

const COPY_SYSTEM_PROMPT = `Você é um copywriter brasileiro especialista em marketing de afiliados para grupos de WhatsApp. Seu trabalho é transformar os dados de um produto de marketplace (Mercado Livre, Shopee, Amazon) em uma mensagem curta, persuasiva e pronta para disparar em grupos.

# Objetivo
Gerar uma oferta que pare o dedo de quem rola o feed do grupo e leve ao clique no link. A mensagem precisa soar como uma indicação humana e entusiasmada de alguém que achou uma promoção boa — nunca como anúncio robótico.

# Formato de saída (OBRIGATÓRIO)
Responda APENAS com um objeto JSON válido, sem texto fora do JSON, com exatamente estas chaves:
- "headline": uma primeira linha curta de impacto (máx ~60 caracteres), com 1-2 emojis no início. É o gancho.
- "body": 2 a 4 linhas curtas descrevendo o produto e o porquê de comprar agora. Use quebras de linha (\\n) entre as ideias. Pode usar *negrito* do WhatsApp (asteriscos) para destacar o preço ou um benefício. Mencione o preço "de/por" quando existir. Crie urgência leve (estoque/tempo) sem mentir.
- "cta": uma chamada para ação curta e imperativa com 1 emoji (ex: "👉 Garanta o seu agora!").

# Regras de estilo
- Português do Brasil, informal e caloroso, como alguém falando no grupo.
- Use emojis com moderação e propósito (não encha de emoji).
- Formatação WhatsApp: *negrito*, _itálico_. NÃO use markdown de título (#), listas com "-", nem HTML.
- NÃO invente características técnicas que não foram fornecidas. Se faltar dado, seja genérico mas honesto.
- NÃO inclua o link nem o cupom dentro do JSON — eles são adicionados depois pelo sistema. Foque no texto de venda.
- NÃO use linguagem que viole políticas (saúde milagrosa, garantias absolutas, etc.).
- Adapte o tom à PERSONA informada no prompt do usuário.

# Exemplos (few-shot)

Exemplo 1 — produto: "Fone Bluetooth TWS à prova d'água", de R$ 199,90 por R$ 89,90, persona Padrão:
{"headline":"🎧 Fone TWS por menos de R$90!","body":"Achei esse *fone Bluetooth à prova d'água* numa promoção absurda 👀\\nDe ~R$199,90~ por *R$89,90* à vista.\\nBateria que dura o dia todo e cabe no bolso. Estoque voando!","cta":"👉 Pega o seu antes que acabe!"}

Exemplo 2 — produto: "Tapete higiênico para cães 30 unidades", por R$ 49,90, persona Pet:
{"headline":"🐶 Tapetinho do seu pet baratinho!","body":"Gente, o *tapete higiênico (30un)* tá só *R$49,90* 🐾\\nAbsorve rapidinho e segura o cheiro — facilita demais a rotina com o doguinho.\\nÓtimo pra deixar de reserva em casa.","cta":"🐾 Garanta já o do seu pet!"}

Exemplo 3 — produto: "Kit 3 camisetas dry-fit masculina", de R$ 159 por R$ 99, persona Fitness:
{"headline":"💪 Kit 3 dry-fit pra treinar!","body":"Bora renovar o treino? *Kit com 3 camisetas dry-fit* de ~R$159~ por *R$99* 🔥\\nTecido que seca rápido e não pesa no movimento.\\nPreço por peça que vale muito a pena.","cta":"⚡ Equipe-se agora!"}

Siga esse mesmo padrão de qualidade. Lembre: SOMENTE o JSON na resposta.`

function buildOfferUserPrompt(input: CopyInput): string {
  const persona = getPersona(input.persona)
  const from = brl(input.priceFromCents)
  const to = brl(input.priceToCents)
  const lines: string[] = [
    `PERSONA: ${persona.label}. ${persona.promptFragment}`,
    '',
    'DADOS DO PRODUTO:',
    `- Título: ${input.title ?? '(não capturado — escreva de forma genérica e honesta)'}`,
  ]
  if (from && to) lines.push(`- Preço: de ${from} por ${to}`)
  else if (to) lines.push(`- Preço: ${to}`)
  else lines.push('- Preço: (não capturado — não invente valor, foque no benefício)')
  if (input.coupon) lines.push(`- Há cupom de desconto (o sistema adiciona depois): ${input.coupon}`)
  lines.push('', 'Gere a oferta em JSON conforme as regras.')
  return lines.join('\n')
}

class ClaudeCopyProvider implements AICopyProvider {
  private client: Anthropic
  private model: string
  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey })
    this.model = model
  }

  async generate(input: CopyInput): Promise<CopyResult> {
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 600,
      system: [
        {
          type: 'text',
          text: COPY_SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      output_config: {
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              headline: { type: 'string' },
              body: { type: 'string' },
              cta: { type: 'string' },
            },
            required: ['headline', 'body', 'cta'],
            additionalProperties: false,
          },
        },
      },
      messages: [{ role: 'user', content: buildOfferUserPrompt(input) }],
    })

    const text = res.content.find((b) => b.type === 'text')
    if (!text || text.type !== 'text') throw new Error('IA não retornou conteúdo.')
    let parsed: Partial<CopyResult>
    try {
      parsed = JSON.parse(text.text)
    } catch {
      throw new Error('IA retornou um formato inesperado.')
    }
    if (!parsed.headline || !parsed.body || !parsed.cta) {
      throw new Error('IA retornou uma oferta incompleta.')
    }
    return { headline: parsed.headline, body: parsed.body, cta: parsed.cta }
  }
}

/** OpenAI (ChatGPT) provider — raw fetch against the Chat Completions API. */
class OpenAICopyProvider implements AICopyProvider {
  constructor(
    private apiKey: string,
    private model: string,
  ) {}

  async generate(input: CopyInput): Promise<CopyResult> {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: COPY_SYSTEM_PROMPT },
          { role: 'user', content: buildOfferUserPrompt(input) },
        ],
        // The system prompt already requires JSON output (contains "JSON",
        // which json_object mode requires).
        response_format: { type: 'json_object' },
        max_tokens: 600,
        temperature: 0.8,
      }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`OpenAI ${res.status}: ${body.slice(0, 300) || 'erro na API'}`)
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[]
    }
    const content = data.choices?.[0]?.message?.content
    if (!content) throw new Error('IA não retornou conteúdo.')
    let parsed: Partial<CopyResult>
    try {
      parsed = JSON.parse(content)
    } catch {
      throw new Error('IA retornou um formato inesperado.')
    }
    if (!parsed.headline || !parsed.body || !parsed.cta) {
      throw new Error('IA retornou uma oferta incompleta.')
    }
    return { headline: parsed.headline, body: parsed.body, cta: parsed.cta }
  }
}

/**
 * Load the platform AI config (God Mode singleton). Decrypts the API key.
 * Service-role read — never expose the returned `apiKey` to the client.
 */
export async function loadPlatformAISettings(): Promise<PlatformAISettings> {
  const db = supabaseAdmin()
  const { data } = await db
    .from('platform_settings')
    .select('ai_provider, ai_model, ai_api_key_encrypted')
    .eq('id', 1)
    .maybeSingle()

  const row = data as
    | { ai_provider: 'claude' | 'openai'; ai_model: string; ai_api_key_encrypted: string | null }
    | null

  // Fall back to env ANTHROPIC_API_KEY so dev works before God Mode is wired.
  let apiKey: string | null = null
  if (row?.ai_api_key_encrypted) {
    try {
      apiKey = decrypt(row.ai_api_key_encrypted)
    } catch {
      apiKey = null
    }
  }
  const provider = row?.ai_provider ?? 'claude'
  // Dev fallback: env key for the configured provider when no key is stored.
  if (!apiKey) {
    apiKey =
      provider === 'openai'
        ? process.env.OPENAI_API_KEY ?? null
        : process.env.ANTHROPIC_API_KEY ?? null
  }

  return {
    aiProvider: provider,
    aiModel: row?.ai_model ?? DEFAULT_AI_MODEL,
    apiKey,
  }
}

/** Resolve a concrete provider from settings. Throws if no key is configured. */
export function getCopyProvider(settings: PlatformAISettings): AICopyProvider {
  if (!settings.apiKey) {
    throw new Error('Nenhuma chave de IA configurada. Configure em Settings → IA / Ofertas.')
  }
  if (settings.aiProvider === 'openai') {
    return new OpenAICopyProvider(settings.apiKey, settings.aiModel)
  }
  return new ClaudeCopyProvider(settings.apiKey, settings.aiModel)
}
