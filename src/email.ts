// Pluggable transactional email. Cloudflare Email Sending is the default so a
// fresh deploy needs no third-party account; Resend is used instead when an API
// key is configured, which keeps existing deployments working unchanged.

/** Shape of the Cloudflare `send_email` binding we rely on. */
type CfEmailBinding = {
  send(message: {
    to: string | string[]
    from: { email: string; name?: string }
    subject: string
    html?: string
    text?: string
  }): Promise<unknown>
}

export type EmailEnv = {
  /** Cloudflare Email Sending binding (preferred; no API key needed). */
  EMAIL?: CfEmailBinding
  /** Set to route through Resend instead of the Cloudflare binding. */
  RESEND_API_KEY?: string
  /** Sender, as "Name <address@domain>" or a bare address. */
  NOTIFY_FROM?: string
}

const DEFAULT_FROM = 'MailTrackMCP <notify@example.com>'

/** Splits "Name <addr@domain>" into parts; tolerates a bare address. */
export function parseFrom(value: string): { email: string; name?: string } {
  const m = /^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/.exec(value)
  return m ? { name: m[1] || undefined, email: m[2] } : { email: value.trim() }
}

/** Strips tags for the plain-text alternative. Not a sanitiser — input is ours. */
const toText = (html: string) =>
  html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

export type SendResult = { sent: boolean; provider: string; error?: string }

/**
 * Sends one transactional email. Never throws: callers run inside tracking
 * requests where a notification failure must not break the response.
 */
export async function sendEmail(
  env: EmailEnv,
  msg: { to: string; subject: string; html: string }
): Promise<SendResult> {
  const from = env.NOTIFY_FROM || DEFAULT_FROM
  const text = toText(msg.html)

  // Resend wins when configured, so existing deployments keep their provider.
  if (env.RESEND_API_KEY) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from, to: [msg.to], subject: msg.subject, html: msg.html, text }),
      })
      if (!res.ok) {
        const body = await res.text()
        console.error('resend send failed', res.status, body)
        return { sent: false, provider: 'resend', error: `${res.status} ${body}` }
      }
      return { sent: true, provider: 'resend' }
    } catch (err) {
      console.error('resend send threw', String(err))
      return { sent: false, provider: 'resend', error: String(err) }
    }
  }

  if (env.EMAIL) {
    try {
      await env.EMAIL.send({
        to: msg.to,
        from: parseFrom(from),
        subject: msg.subject,
        html: msg.html,
        text,
      })
      return { sent: true, provider: 'cloudflare' }
    } catch (err) {
      console.error('cloudflare email send threw', String(err))
      return { sent: false, provider: 'cloudflare', error: String(err) }
    }
  }

  return { sent: false, provider: 'none', error: 'no email provider configured' }
}

/** True when some provider is available — gates login + notification features. */
export const emailConfigured = (env: EmailEnv) => Boolean(env.RESEND_API_KEY || env.EMAIL)
