'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, RefreshCw, CheckCircle2, Smartphone } from 'lucide-react'

type Status = 'idle' | 'loading' | 'qr_pending' | 'connecting' | 'connected' | 'error'

export default function ConnectPage() {
  const [status, setStatus] = useState<Status>('idle')
  const [qr, setQr] = useState<string | null>(null)
  const [pairingCode, setPairingCode] = useState<string | null>(null)
  const [phone, setPhone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const provision = useCallback(async () => {
    setStatus('loading')
    setError(null)
    try {
      const res = await fetch('/api/whatsapp/connect', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Falha ao gerar o QR')
      setQr(data.qr ?? null)
      setPairingCode(data.pairingCode ?? null)
      setStatus(data.qr ? 'qr_pending' : 'connecting')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro inesperado')
      setStatus('error')
    }
  }, [])

  // Poll connection state until connected.
  useEffect(() => {
    if (status === 'connected' || status === 'idle' || status === 'error') return
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch('/api/whatsapp/connect')
        const data = await res.json()
        if (data.status === 'connected') {
          setPhone(data.phoneNumber ?? null)
          setStatus('connected')
        }
      } catch {
        /* keep polling */
      }
    }, 3000)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [status])

  useEffect(() => {
    void provision()
  }, [provision])

  const qrSrc = qr ? (qr.startsWith('data:') ? qr : `data:image/png;base64,${qr}`) : null

  return (
    <div className="mx-auto max-w-md space-y-6 py-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Conectar WhatsApp</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Abra o WhatsApp no celular → Aparelhos conectados → Conectar um aparelho e
          escaneie o código abaixo.
        </p>
      </div>

      <div className="flex min-h-[20rem] flex-col items-center justify-center rounded-xl border border-border bg-card p-6">
        {status === 'connected' ? (
          <div className="flex flex-col items-center gap-3 text-center">
            <CheckCircle2 className="h-14 w-14 text-green-500" />
            <p className="text-lg font-semibold text-foreground">Conectado!</p>
            {phone && <p className="text-sm text-muted-foreground">{phone}</p>}
            <p className="text-sm text-muted-foreground">
              Já pode receber e enviar mensagens — inclusive em grupos.
            </p>
          </div>
        ) : status === 'loading' ? (
          <div className="flex flex-col items-center gap-3 text-muted-foreground">
            <Loader2 className="h-8 w-8 animate-spin" />
            <p className="text-sm">Preparando sua instância…</p>
          </div>
        ) : status === 'error' ? (
          <div className="flex flex-col items-center gap-3 text-center">
            <p className="text-sm text-red-500">{error}</p>
            <button
              onClick={() => void provision()}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              <RefreshCw className="h-4 w-4" /> Tentar de novo
            </button>
          </div>
        ) : qrSrc ? (
          <div className="flex flex-col items-center gap-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qrSrc} alt="QR Code do WhatsApp" className="h-64 w-64 rounded-lg bg-white p-2" />
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Smartphone className="h-4 w-4" /> Aguardando leitura…
            </div>
            {pairingCode && (
              <p className="text-sm text-muted-foreground">
                Ou use o código: <span className="font-mono font-semibold">{pairingCode}</span>
              </p>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 text-muted-foreground">
            <Loader2 className="h-8 w-8 animate-spin" />
            <p className="text-sm">Gerando QR…</p>
          </div>
        )}
      </div>

      {status !== 'connected' && (
        <div className="flex justify-center">
          <button
            onClick={() => void provision()}
            className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-accent"
          >
            <RefreshCw className="h-4 w-4" /> Gerar novo QR
          </button>
        </div>
      )}
    </div>
  )
}
