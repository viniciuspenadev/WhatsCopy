/**
 * Server → client realtime broadcast (no DB write).
 *
 * Used for ephemeral signals like "contact is typing" that must NOT be
 * persisted (one row per keystroke would hammer the table). We POST to
 * Supabase Realtime's broadcast HTTP endpoint with the service-role key; the
 * inbox subscribes to the matching channel/event.
 *
 * Entirely best-effort: if env is missing or the call fails, presence simply
 * doesn't show — it must never break the webhook.
 */
export async function broadcastPresence(
  accountId: string,
  payload: { chatJid: string; typing: boolean },
): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return
  try {
    await fetch(`${url}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [{ topic: `presence:${accountId}`, event: 'typing', payload }],
      }),
      signal: AbortSignal.timeout(5_000),
    })
  } catch {
    /* best-effort */
  }
}
