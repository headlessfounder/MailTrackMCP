// Passwordless dashboard login: email a one-time magic link, exchange it for a
// signed session cookie. Personal dt_ API tokens still work for agents/scripts;
// this is only for humans opening the dashboard.

import { type EmailEnv, emailConfigured, sendEmail } from './email'

export type AuthEnv = EmailEnv & {
  DB: D1Database
  SESSION_SECRET?: string
}

const SESSION_DAYS = 30
const LINK_TTL_MIN = 15

const enc = new TextEncoder()
const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf as ArrayBuffer)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(data)))
}

/** Constant-time-ish compare; avoids leaking match position via early return. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export async function makeSession(env: AuthEnv, userId: string): Promise<string> {
  const exp = Date.now() + SESSION_DAYS * 86400_000
  const payload = `${userId}.${exp}`
  return `${payload}.${await hmac(env.SESSION_SECRET!, payload)}`
}

export async function readSession(
  env: AuthEnv,
  cookie: string | undefined
): Promise<string | null> {
  if (!cookie || !env.SESSION_SECRET) return null
  const match = /(?:^|;\s*)dt_session=([^;]+)/.exec(cookie)
  if (!match) return null
  const [userId, exp, sig] = decodeURIComponent(match[1]).split('.')
  if (!userId || !exp || !sig) return null
  if (Date.now() > Number(exp)) return null
  const expected = await hmac(env.SESSION_SECRET, `${userId}.${exp}`)
  return safeEqual(sig, expected) ? userId : null
}

const randToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)))

/** Always returns success — never reveals whether an email is registered. */
export async function requestMagicLink(
  env: AuthEnv,
  email: string,
  origin: string
): Promise<{ ok: true; sent: boolean }> {
  const user = await env.DB.prepare('SELECT id, email FROM users WHERE lower(email) = lower(?)')
    .bind(email.trim())
    .first<{ id: string; email: string }>()
  if (!user || !emailConfigured(env)) return { ok: true, sent: false }

  const token = randToken()
  const expiresAt = new Date(Date.now() + LINK_TTL_MIN * 60_000).toISOString()
  await env.DB.prepare(
    'INSERT INTO login_tokens (token, user_id, expires_at, used) VALUES (?, ?, ?, 0)'
  )
    .bind(token, user.id, expiresAt)
    .run()

  const link = `${origin}/auth/verify?t=${encodeURIComponent(token)}`
  const res = await sendEmail(env, {
    to: user.email,
    subject: 'Your GrokBotTrack sign-in link',
    html:
      `<p>Click to open your GrokBotTrack dashboard:</p>` +
      `<p><a href="${link}" style="display:inline-block;padding:10px 18px;` +
      `background:#2a78d6;color:#fff;border-radius:8px;text-decoration:none;` +
      `font-family:sans-serif">Open dashboard</a></p>` +
      `<p style="color:#666;font-size:13px">This link expires in ${LINK_TTL_MIN} minutes ` +
      `and can only be used once. If you didn't request it, you can ignore this email.</p>`,
  })
  return { ok: true, sent: res.sent }
}

/** Burns the token and returns the user id, or null if invalid/expired/used. */
export async function consumeMagicLink(
  env: AuthEnv,
  token: string
): Promise<string | null> {
  const row = await env.DB.prepare(
    'SELECT user_id, expires_at, used FROM login_tokens WHERE token = ?'
  )
    .bind(token)
    .first<{ user_id: string; expires_at: string; used: number }>()
  if (!row || row.used || Date.parse(row.expires_at) < Date.now()) return null
  await env.DB.prepare('UPDATE login_tokens SET used = 1 WHERE token = ?').bind(token).run()
  return row.user_id
}

export function sessionCookie(value: string): string {
  return (
    `dt_session=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; ` +
    `SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`
  )
}
