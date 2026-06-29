/**
 * Lightweight inbox notifications — sound + browser Notification.
 *
 * The "ping" is synthesized with the Web Audio API (a short two-tone chirp) so
 * we don't ship a binary audio asset or depend on autoplay of an <audio> tag.
 * Everything is wrapped in try/catch and feature-checks: notifications are a
 * nice-to-have, never allowed to throw into the realtime handler.
 */

let audioCtx: AudioContext | null = null

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null
  try {
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null
    audioCtx = audioCtx ?? new Ctor()
    return audioCtx
  } catch {
    return null
  }
}

/** Short pleasant chirp. No-op if Web Audio is unavailable/blocked. */
export function playPing(): void {
  const ctx = getCtx()
  if (!ctx) return
  try {
    if (ctx.state === 'suspended') void ctx.resume()
    const now = ctx.currentTime
    const tones = [
      { freq: 880, start: 0 },
      { freq: 1175, start: 0.09 },
    ]
    for (const t of tones) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.type = 'sine'
      osc.frequency.value = t.freq
      const s = now + t.start
      gain.gain.setValueAtTime(0.0001, s)
      gain.gain.exponentialRampToValueAtTime(0.18, s + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.0001, s + 0.22)
      osc.start(s)
      osc.stop(s + 0.24)
    }
  } catch {
    /* ignore */
  }
}

/** Ask for Notification permission once (best-effort). */
export function ensureNotifPermission(): void {
  try {
    if (typeof window === 'undefined' || !('Notification' in window)) return
    if (Notification.permission === 'default') void Notification.requestPermission()
  } catch {
    /* ignore */
  }
}

function showBrowserNotification(title: string, body: string): void {
  try {
    if (typeof window === 'undefined' || !('Notification' in window)) return
    if (Notification.permission !== 'granted') return
    const n = new Notification(title, { body, tag: 'wacrm-inbox' })
    // Focus the tab when the user clicks the OS notification.
    n.onclick = () => {
      window.focus()
      n.close()
    }
  } catch {
    /* ignore */
  }
}

/**
 * Notify about a new inbound message: always chirps (when eligible), and pops
 * an OS notification only when the tab is in the background (foreground sound
 * alone is enough; a banner would be redundant noise).
 */
export function notifyNewMessage(senderName: string, preview: string): void {
  playPing()
  if (typeof document !== 'undefined' && document.hidden) {
    showBrowserNotification(senderName, preview)
  }
}
