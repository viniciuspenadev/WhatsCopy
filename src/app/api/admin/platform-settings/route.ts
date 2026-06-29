import { NextResponse } from 'next/server'
import { requirePlatformAdmin } from '@/lib/auth/platform-admin'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { encrypt } from '@/lib/whatsapp/encryption'
import { AI_MODELS_BY_PROVIDER, providerForModel } from '@/lib/offers/ai-copy'

/**
 * GET /api/admin/platform-settings — God Mode AI config.
 * Returns { ai_provider, ai_model, has_key } — NEVER the key itself.
 */
export async function GET() {
  const admin = await requirePlatformAdmin()
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const db = supabaseAdmin()
  const { data } = await db
    .from('platform_settings')
    .select('ai_provider, ai_model, ai_api_key_encrypted')
    .eq('id', 1)
    .maybeSingle()

  const row = data as
    | { ai_provider: string; ai_model: string; ai_api_key_encrypted: string | null }
    | null

  return NextResponse.json({
    ai_provider: row?.ai_provider ?? 'claude',
    ai_model: row?.ai_model ?? 'claude-haiku-4-5',
    has_key: Boolean(row?.ai_api_key_encrypted),
    models_by_provider: AI_MODELS_BY_PROVIDER,
  })
}

/**
 * PUT /api/admin/platform-settings — update AI config.
 * Body: { ai_provider?, ai_model?, api_key? }. Empty/omitted api_key keeps
 * the existing one; the key is encrypted and never returned.
 */
export async function PUT(request: Request) {
  const admin = await requirePlatformAdmin()
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = await request.json().catch(() => ({}))
  const { ai_provider, ai_model, api_key } = body as {
    ai_provider?: string
    ai_model?: string
    api_key?: string
  }

  const update: Record<string, unknown> = { updated_by: admin.userId }

  if (ai_provider !== undefined) {
    if (ai_provider !== 'claude' && ai_provider !== 'openai') {
      return NextResponse.json({ error: 'Provedor inválido.' }, { status: 400 })
    }
    update.ai_provider = ai_provider
  }
  if (ai_model !== undefined) {
    const modelProvider = providerForModel(ai_model)
    if (!modelProvider) {
      return NextResponse.json({ error: 'Modelo não permitido.' }, { status: 400 })
    }
    // If a provider was also supplied, the model must belong to it.
    if (ai_provider !== undefined && ai_provider !== modelProvider) {
      return NextResponse.json(
        { error: 'O modelo não corresponde ao provedor selecionado.' },
        { status: 400 },
      )
    }
    update.ai_model = ai_model
  }
  if (typeof api_key === 'string' && api_key.trim().length > 0) {
    update.ai_api_key_encrypted = encrypt(api_key.trim())
  }

  const db = supabaseAdmin()
  const { error } = await db.from('platform_settings').update(update).eq('id', 1)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
