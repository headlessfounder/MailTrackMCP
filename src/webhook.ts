// Real-time engagement webhooks. Fires when a recipient opens or clicks, so an
// agent can react immediately instead of polling.

export type WebhookEnv = {
  /** Fallback endpoint used for users with no webhook of their own. */
  WEBHOOK_URL?: string
  /** Fallback signing secret paired with WEBHOOK_URL. */
  WEBHOOK_SECRET?: string
  /** "all" (default) fires on every genuine event; "first" only on the first. */
  WEBHOOK_EVENTS?: string
}

export type WebhookPayload = {
  event: 'open' | 'click'
  message_id: string
  recipient: string
  subject: string | null
  campaign: string | null
  agent_source: string | null
  sent_at: string
  occurred_at: string
  classification: string
  /** Whether this counts toward confirmed engagement (bot noise never does). */
  is_confirmed: boolean
  /** Whether this is the message's first genuine engagement. */
  is_first_engagement: boolean
  /** Totals for this message so far — repeat opens are a strong signal. */
  open_count: number
  click_count: number
  /** Only present when the fetch came from the reader, not a proxy. */
  location: { city?: string; region?: string; country?: string; timezone?: string } | null
  /** Set when location is withheld, explaining why. */
  location_note?: string
  /** Destination URL, for click events. */
  link_url?: string
}

const enc = new TextEncoder()

/** Hex HMAC-SHA256 so receivers can verify the request really came from us. */
async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(body))
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * POSTs one engagement event. Never throws and never retries more than once:
 * this runs inside a tracking request, where delivery of the pixel matters far
 * more than delivery of the notification.
 */
export async function sendWebhook(
  url: string,
  secret: string | undefined,
  payload: WebhookPayload
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const body = JSON.stringify(payload)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'GrokBotTrack-Webhook/1',
    'X-GrokBotTrack-Event': payload.event,
  }
  if (secret) headers['X-GrokBotTrack-Signature'] = `sha256=${await sign(secret, body)}`

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { method: 'POST', headers, body })
      if (res.ok) return { ok: true, status: res.status }
      // 4xx means the receiver rejected it; retrying won't help.
      if (res.status < 500) {
        console.error('webhook rejected', res.status, await res.text())
        return { ok: false, status: res.status }
      }
      console.error('webhook server error', res.status, 'attempt', attempt + 1)
    } catch (err) {
      console.error('webhook threw', String(err), 'attempt', attempt + 1)
      if (attempt === 1) return { ok: false, error: String(err) }
    }
  }
  return { ok: false }
}
