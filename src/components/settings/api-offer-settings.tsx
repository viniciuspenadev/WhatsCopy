'use client'

import { useEffect, useState } from 'react'
import { Loader2, KeyRound, Save, Sparkles } from 'lucide-react'
import { toast } from 'sonner'

type Provider = 'claude' | 'openai'
type ModelsByProvider = Record<Provider, string[]>

const PROVIDER_LABEL: Record<Provider, string> = {
  claude: 'Claude (Anthropic)',
  openai: 'ChatGPT (OpenAI)',
}

/**
 * God Mode AI config — the operator picks which model writes the offer copy
 * and pastes the API key. The key is write-only: the server stores it
 * encrypted and only ever reports whether one is set (`has_key`).
 *
 * Requires platform-admin (the API enforces it). For non-admins the GET
 * returns 403 and we show a notice.
 */
export function ApiOfferSettings() {
  const [loading, setLoading] = useState(true)
  const [forbidden, setForbidden] = useState(false)
  const [saving, setSaving] = useState(false)

  const [provider, setProvider] = useState<Provider>('claude')
  const [model, setModel] = useState('claude-haiku-4-5')
  const [models, setModels] = useState<ModelsByProvider>({ claude: [], openai: [] })
  const [hasKey, setHasKey] = useState(false)
  const [apiKey, setApiKey] = useState('')

  useEffect(() => {
    ;(async () => {
      try {
        const res = await fetch('/api/admin/platform-settings', { cache: 'no-store' })
        if (res.status === 403) {
          setForbidden(true)
          return
        }
        const data = await res.json()
        if (res.ok) {
          setProvider(data.ai_provider)
          setModel(data.ai_model)
          setModels(data.models_by_provider)
          setHasKey(Boolean(data.has_key))
        }
      } catch {
        /* ignore */
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const onProviderChange = (next: Provider) => {
    setProvider(next)
    const list = models[next] ?? []
    if (!list.includes(model)) setModel(list[0] ?? '')
  }

  const save = async () => {
    setSaving(true)
    try {
      const res = await fetch('/api/admin/platform-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ai_provider: provider,
          ai_model: model,
          api_key: apiKey.trim() || undefined,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(data.error ?? 'Falha ao salvar.')
        return
      }
      if (apiKey.trim()) setHasKey(true)
      setApiKey('')
      toast.success('Configuração de IA salva.')
    } catch {
      toast.error('Erro de rede ao salvar.')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex h-48 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    )
  }

  if (forbidden) {
    return (
      <section className="rounded-xl border border-border bg-card p-6">
        <div className="flex items-center gap-2 text-foreground">
          <Sparkles className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">IA / Ofertas</h2>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          Esta configuração é da plataforma (God Mode). Sua conta não tem permissão de
          administrador de plataforma para editá-la.
        </p>
      </section>
    )
  }

  const modelList = models[provider] ?? []

  return (
    <section className="animate-in fade-in-50 space-y-5 duration-200">
      <div>
        <h2 className="text-lg font-semibold text-foreground">IA / Ofertas</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Escolha o provedor de IA, o modelo e a chave usada para gerar o texto das ofertas.
          A chave fica criptografada no servidor e nunca é exibida de volta.
        </p>
      </div>

      <div className="space-y-4 rounded-xl border border-border bg-card p-5">
        {/* Provider */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">Provedor</label>
          <div className="grid grid-cols-2 gap-2">
            {(['claude', 'openai'] as Provider[]).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => onProviderChange(p)}
                className={`rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors ${
                  provider === p
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border bg-background text-muted-foreground hover:bg-muted'
                }`}
              >
                {PROVIDER_LABEL[p]}
              </button>
            ))}
          </div>
        </div>

        {/* Model */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">Modelo</label>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-foreground focus:border-primary/50 focus:outline-none"
          >
            {modelList.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>

        {/* API key */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">
            Chave da API {hasKey && <span className="text-green-500">· configurada ✓</span>}
          </label>
          <div className="relative">
            <KeyRound className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={hasKey ? '•••••••••• (deixe em branco para manter)' : provider === 'openai' ? 'sk-...' : 'sk-ant-...'}
              autoComplete="off"
              className="w-full rounded-lg border border-border bg-background py-2.5 pl-9 pr-3 text-sm text-foreground placeholder-muted-foreground focus:border-primary/50 focus:outline-none"
            />
          </div>
          <p className="text-[11px] text-muted-foreground">
            {provider === 'openai'
              ? 'Cole a chave da OpenAI (platform.openai.com → API keys).'
              : 'Cole a chave da Anthropic (console.anthropic.com → API keys).'}
          </p>
        </div>

        <div className="flex justify-end pt-1">
          <button
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Salvar
          </button>
        </div>
      </div>
    </section>
  )
}
