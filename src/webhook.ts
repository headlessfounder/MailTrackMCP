// Real-time engagement webhooks. Fires when a recipient opens or clicks, so an
// agent can react immediately instead of polling.

export type WebhookEnv = {
  /** Fallback endpoint used for users with no webhook of their own. */
  WEBHOOK_URL?: string
  /** Fallback signing secret paired with WEBHOOK_URL. */
  WEBHOOK_SECRET?: string
  /** "all" (default) fires on every genuine event; "first" only on the first. */
  WEBHOOK_EVENTS?: string
  /**
   * Verbatim Authorization header value for receivers that require one
   * (e.g. "Bearer abc123"). Store with `wrangler secret put WEBHOOK_AUTH`.
   */
  WEBHOOK_AUTH?: string
  /**
   * Auth scheme to prepend when WEBHOOK_AUTH holds a bare key, e.g. "Bearer".
   * Leave unset to send WEBHOOK_AUTH exactly as stored. Having this as config
   * avoids the common failure of storing a key without its scheme.
   */
  WEBHOOK_AUTH_SCHEME?: string
  /**
   * Hostname WEBHOOK_AUTH belongs to, e.g. "api.your-receiver.com". Strongly
   * recommended: without it the credential is sent to whatever webhook URL a
   * user configures, which would hand your key to any endpoint they choose.
   */
  WEBHOOK_AUTH_HOST?: string
}

/**
 * Resolves the Authorization header for one delivery. Returns undefined unless
 * the destination matches WEBHOOK_AUTH_HOST, so a credential meant for one
 * receiver can never be forwarded to another.
 */
/**
 * Describes the configured Authorization value without revealing it, so a
 * misconfiguration can be diagnosed without the credential leaving the Worker.
 */
export function describeAuth(env: WebhookEnv): Record<string, unknown> {
  const v = env.WEBHOOK_AUTH
  if (!v) return { configured: false }
  const trimmed = v.trim()
  const scheme = trimmed.split(/\s+/)[0] || ''
  return {
    configured: true,
    length: v.length,
    had_surrounding_whitespace: v !== trimmed,
    // Only ever echo a RECOGNISED scheme word. Anything else is likely the
    // credential itself, so report its shape rather than its content.
    scheme_word: /^(Bearer|Basic|Token|ApiKey)$/i.test(scheme) ? scheme : '<non-standard>',
    starts_with_bearer_space: trimmed.startsWith('Bearer '),
    scheme_prepended: env.WEBHOOK_AUTH_SCHEME || null,
    word_count: trimmed.split(/\s+/).length,
    starts_with_quote: /^["']/.test(trimmed),
    has_non_ascii: /[^\x20-\x7e]/.test(trimmed),
    auth_host_configured: env.WEBHOOK_AUTH_HOST || null,
  }
}

export function authHeaderFor(env: WebhookEnv, url: string): string | undefined {
  if (!env.WEBHOOK_AUTH) return undefined
  if (!env.WEBHOOK_AUTH_HOST) return undefined
  try {
    if (new URL(url).hostname !== env.WEBHOOK_AUTH_HOST) return undefined
  } catch {
    return undefined
  }
  const value = env.WEBHOOK_AUTH.trim()
  const scheme = env.WEBHOOK_AUTH_SCHEME?.trim()
  if (!scheme) return value
  // Idempotent: a value that already carries the scheme is left alone.
  return value.toLowerCase().startsWith(scheme.toLowerCase() + ' ')
    ? value
    : `${scheme} ${value}`
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
  payload: WebhookPayload,
  authHeader?: string
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const body = JSON.stringify(payload)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'MailTrackMCP-Webhook/1',
    'X-MailTrack-Event': payload.event,
  }
  if (secret) headers['X-MailTrack-Signature'] = `sha256=${await sign(secret, body)}`
  // Sent verbatim so the receiver's expected scheme (Bearer, token, raw key)
  // is preserved exactly as configured.
  if (authHeader) headers['Authorization'] = authHeader.trim()

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
