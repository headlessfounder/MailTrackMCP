import { Hono } from 'hono'
import { DASHBOARD_HTML } from './dashboard'
import { handleMcp } from './mcp'
import { type EmailEnv, emailConfigured, sendEmail } from './email'
import { type WebhookEnv, type WebhookPayload, sendWebhook } from './webhook'
import {
  consumeMagicLink,
  makeSession,
  readSession,
  requestMagicLink,
  sessionCookie,
} from './auth'

type Env = {
  DB: D1Database
  ADMIN_TOKEN: string
  /** Canonical host that pixel + link URLs are built on (e.g. go.yourdomain.com).
   *  Falls back to the request origin so the worker still works without it. */
  TRACKING_HOST?: string
  /** Cloudflare Email Sending binding. Default transport for alerts + login. */
  EMAIL?: EmailEnv['EMAIL']
  /** Set to route email through Resend instead of the Cloudflare binding. */
  RESEND_API_KEY?: string
  /** Sender address, e.g. "GrokBotTrack <notify@yourdomain.com>". */
  NOTIFY_FROM?: string
  /** Seconds after send during which a proxied open is treated as the sender
   *  re-reading their own copy rather than a genuine recipient open. */
  SELF_OPEN_WINDOW_SEC?: string
  /** Account-wide webhook defaults; per-user settings override these. */
  WEBHOOK_URL?: string
  WEBHOOK_SECRET?: string
  WEBHOOK_EVENTS?: string
  /** Optional: set to enable magic-link login (signs session cookies). */
  SESSION_SECRET?: string
}

type User = {
  id: string
  name: string
  email: string
  api_token: string
  webhook_url?: string | null
  webhook_secret?: string | null
}

/** Where tracked pixel/link URLs live. Pinning this to a custom domain keeps the
 *  embedded URLs stable regardless of which host the register call arrived on. */
function trackingOrigin(env: Env, reqUrl: string): string {
  return env.TRACKING_HOST ? `https://${env.TRACKING_HOST}` : new URL(reqUrl).origin
}

const app = new Hono<{ Bindings: Env; Variables: { user: User } }>()

// 43-byte transparent 1x1 GIF
const PIXEL = Uint8Array.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00,
  0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x01, 0x00,
  0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
  0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
])

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
function shortId(len = 14): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len))
  let out = ''
  for (const b of bytes) out += ALPHABET[b % 62]
  return out
}

function now(): string {
  return new Date().toISOString()
}

/** Default grace period for treating a proxied open as the sender's own echo. */
const DEFAULT_SELF_OPEN_WINDOW_SEC = 90

function selfOpenWindow(env: Env): number {
  const n = Number(env.SELF_OPEN_WINDOW_SEC)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SELF_OPEN_WINDOW_SEC
}

// Classify a tracking event so proxies, prefetchers, and security scanners
// don't inflate the stats. Geo is only trustworthy for 'human' events.
function classify(
  ua: string,
  cf: IncomingRequestCfProperties | undefined,
  sentAt: string,
  type: 'open' | 'click',
  selfOpenWindowSec = DEFAULT_SELF_OPEN_WINDOW_SEC
): string {
  const ageSec = (Date.now() - Date.parse(sentAt)) / 1000
  const org = (cf?.asOrganization || '').toLowerCase()
  if (/googleimageproxy/i.test(ua)) {
    // Opening your own copy in Sent goes through the same Gmail image proxy as
    // the recipient's open, so the two are indistinguishable by request alone.
    // A genuine open this soon after send is rare; a sender re-reading theirs
    // is not, so attribute it to the sender rather than inflating open counts.
    return type === 'open' && ageSec < selfOpenWindowSec ? 'sender-echo' : 'gmail-proxy'
  }
  if (org.includes('apple') || org.includes('icloud')) {
    return ageSec < 300 ? 'apple-prefetch' : 'apple-proxy'
  }
  if (
    ageSec < 60 &&
    (/bot|crawl|scan|proofpoint|mimecast|barracuda|safelinks/i.test(ua) ||
      org.includes('microsoft corporation') ||
      org.includes('amazon') ||
      org.includes('google cloud'))
  ) {
    return 'scanner'
  }
  return 'human'
}

const REAL_OPEN = ['human', 'gmail-proxy']

async function logEvent(
  c: { env: Env; req: { raw: Request; header: (h: string) => string | undefined } },
  messageId: string,
  linkId: string | null,
  type: 'open' | 'click',
  sentAt: string
): Promise<string> {
  const cf = (c.req.raw as Request & { cf?: IncomingRequestCfProperties }).cf
  const ua = c.req.header('user-agent') || ''
  const ip = c.req.header('cf-connecting-ip') || ''
  const classification = classify(ua, cf, sentAt, type, selfOpenWindow(c.env))
  await c.env.DB.prepare(
    `INSERT INTO events (message_id, link_id, type, ts, ua, ip, country, region, city, timezone, classification)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      messageId,
      linkId,
      type,
      now(),
      ua,
      ip,
      cf?.country || null,
      cf?.region || null,
      cf?.city || null,
      cf?.timezone || null,
      classification
    )
    .run()
  return classification
}

/** True when this event is the message's first genuine engagement — i.e. exactly
 *  one qualifying event exists (the one just written). Bot noise never triggers. */
async function isFirstRealEngagement(
  db: D1Database,
  messageId: string,
  type: 'open' | 'click',
  classification: string
): Promise<boolean> {
  if (type === 'click' ? classification !== 'human' : !REAL_OPEN.includes(classification)) {
    return false
  }
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM events
       WHERE message_id = ?
         AND ((type = 'open' AND classification IN ('human','gmail-proxy'))
              OR (type = 'click' AND classification = 'human'))`
    )
    .bind(messageId)
    .first<{ n: number }>()
  return (row?.n ?? 0) === 1
}

/** Email the sender the moment a recipient first engages. No-ops unless
 *  RESEND_API_KEY is configured, so the tracker works fine without it. */
async function notifyFirstEngagement(
  env: Env,
  messageId: string,
  type: 'open' | 'click',
  classification: string
) {
  if (!emailConfigured(env)) return
  const row = await env.DB.prepare(
    `SELECT m.recipient, m.subject, m.campaign, u.email AS user_email, u.name AS user_name
     FROM messages m JOIN users u ON u.id = m.user_id WHERE m.id = ?`
  )
    .bind(messageId)
    .first<{
      recipient: string
      subject: string | null
      campaign: string | null
      user_email: string
      user_name: string
    }>()
  if (!row) return

  const verb = type === 'click' ? 'clicked a link in' : 'opened'
  const geoNote =
    classification === 'gmail-proxy' ? ' (via Gmail proxy \u2014 no location available)' : ''

  // Failures are logged inside sendEmail; tracking must never depend on this.
  await sendEmail(env, {
    to: row.user_email,
    subject: `\u{1F514} ${row.recipient} ${verb} "${row.subject || '(no subject)'}"`,
    html:
      `<p><strong>${escapeHtml(row.recipient)}</strong> just ${verb} ` +
      `<strong>${escapeHtml(row.subject || '(no subject)')}</strong>${geoNote}.</p>` +
      (row.campaign ? `<p>Campaign: ${escapeHtml(row.campaign)}</p>` : '') +
      `<p style="color:#666;font-size:13px">First engagement on this message. ` +
      `See the full timeline in your GrokBotTrack dashboard.</p>`,
  })
}

/**
 * Builds and dispatches the engagement webhook for one event. Bot noise never
 * fires; location is only included when the fetch came from the reader rather
 * than a proxy, so receivers can't mistake a datacenter for a prospect.
 */
async function dispatchWebhook(
  env: Env,
  messageId: string,
  linkId: string | null,
  type: 'open' | 'click',
  classification: string,
  cf: IncomingRequestCfProperties | undefined,
  isFirst: boolean
) {
  const confirmed =
    type === 'click' ? classification === 'human' : REAL_OPEN.includes(classification)
  if (!confirmed) return

  const row = await env.DB.prepare(
    `SELECT m.recipient, m.subject, m.campaign, m.agent_source, m.sent_at,
            u.webhook_url, u.webhook_secret
     FROM messages m JOIN users u ON u.id = m.user_id WHERE m.id = ?`
  )
    .bind(messageId)
    .first<{
      recipient: string
      subject: string | null
      campaign: string | null
      agent_source: string | null
      sent_at: string
      webhook_url: string | null
      webhook_secret: string | null
    }>()
  if (!row) return

  const url = row.webhook_url || env.WEBHOOK_URL
  if (!url) return
  if ((env.WEBHOOK_EVENTS || 'all') === 'first' && !isFirst) return

  const counts = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN type='open'  AND classification IN ('human','gmail-proxy') THEN 1 ELSE 0 END) AS opens,
       SUM(CASE WHEN type='click' AND classification='human' THEN 1 ELSE 0 END) AS clicks
     FROM events WHERE message_id = ?`
  )
    .bind(messageId)
    .first<{ opens: number; clicks: number }>()

  // A proxied open geolocates to the proxy, not the reader — withhold it rather
  // than let a receiver report a datacenter as the prospect's location.
  const proxied = classification !== 'human'
  const payload: WebhookPayload = {
    event: type,
    message_id: messageId,
    recipient: row.recipient,
    subject: row.subject,
    campaign: row.campaign,
    agent_source: row.agent_source,
    sent_at: row.sent_at,
    occurred_at: now(),
    classification,
    is_confirmed: true,
    is_first_engagement: isFirst,
    open_count: counts?.opens ?? 0,
    click_count: counts?.clicks ?? 0,
    location: proxied
      ? null
      : {
          city: cf?.city as string | undefined,
          region: cf?.region as string | undefined,
          country: cf?.country as string | undefined,
          timezone: cf?.timezone as string | undefined,
        },
    ...(proxied ? { location_note: `withheld: ${classification} fetch, not the reader` } : {}),
  }

  if (linkId) {
    const link = await env.DB.prepare('SELECT original_url FROM links WHERE id = ?')
      .bind(linkId)
      .first<{ original_url: string }>()
    if (link) payload.link_url = link.original_url
  }

  await sendWebhook(url, row.webhook_secret || env.WEBHOOK_SECRET, payload)
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!))

// ---------- public tracking routes (no auth — hit by recipients' mail clients) ----------

app.get('/', (c) => c.text('GrokBotTrack — internal email tracking'))

app.get('/p/:id', async (c) => {
  const id = c.req.param('id').replace(/\.gif$/, '')
  const msg = await c.env.DB.prepare('SELECT id, sent_at FROM messages WHERE id = ?')
    .bind(id)
    .first<{ id: string; sent_at: string }>()
  if (msg) {
    const cls = await logEvent(c, msg.id, null, 'open', msg.sent_at)
    const first = await isFirstRealEngagement(c.env.DB, msg.id, 'open', cls)
    const cf = (c.req.raw as Request & { cf?: IncomingRequestCfProperties }).cf
    if (first) c.executionCtx.waitUntil(notifyFirstEngagement(c.env, msg.id, 'open', cls))
    c.executionCtx.waitUntil(
      dispatchWebhook(c.env, msg.id, null, 'open', cls, cf, first)
    )
  }
  return new Response(PIXEL, {
    headers: {
      'Content-Type': 'image/gif',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      Pragma: 'no-cache',
      Expires: '0',
    },
  })
})

app.get('/l/:id', async (c) => {
  const id = c.req.param('id')
  const link = await c.env.DB.prepare(
    `SELECT links.id, links.original_url, links.message_id, messages.sent_at
     FROM links JOIN messages ON messages.id = links.message_id
     WHERE links.id = ?`
  )
    .bind(id)
    .first<{ id: string; original_url: string; message_id: string; sent_at: string }>()
  if (!link) return c.text('Not found', 404)
  const cls = await logEvent(c, link.message_id, link.id, 'click', link.sent_at)
  const first = await isFirstRealEngagement(c.env.DB, link.message_id, 'click', cls)
  const cf = (c.req.raw as Request & { cf?: IncomingRequestCfProperties }).cf
  if (first) {
    c.executionCtx.waitUntil(notifyFirstEngagement(c.env, link.message_id, 'click', cls))
  }
  c.executionCtx.waitUntil(
    dispatchWebhook(c.env, link.message_id, link.id, 'click', cls, cf, first)
  )
  return c.redirect(link.original_url, 302)
})

// ---------- first-run setup ----------

/**
 * Creates the schema if it is missing. One-click deploys provision an empty D1
 * database but never run schema.sql, so first visit to /setup bootstraps it.
 * Every statement is idempotent, so this is safe to call repeatedly.
 */
async function ensureSchema(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
      api_token TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
      recipient TEXT NOT NULL, subject TEXT, campaign TEXT, agent_source TEXT,
      sent_at TEXT NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS links (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id),
      original_url TEXT NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL REFERENCES messages(id), link_id TEXT,
      type TEXT NOT NULL CHECK (type IN ('open','click')), ts TEXT NOT NULL,
      ua TEXT, ip TEXT, country TEXT, region TEXT, city TEXT, timezone TEXT,
      classification TEXT NOT NULL DEFAULT 'human')`),
    db.prepare(`CREATE TABLE IF NOT EXISTS login_tokens (
      token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
      expires_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0)`),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_events_message ON events(message_id, ts)'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, sent_at)'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_links_message ON links(message_id)'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_login_tokens_user ON login_tokens(user_id)'),
  ])
  // Older databases predate per-user webhooks; ALTER fails harmlessly if the
  // column is already there, so each one is attempted independently.
  for (const col of ['webhook_url TEXT', 'webhook_secret TEXT']) {
    try {
      await db.prepare(`ALTER TABLE users ADD COLUMN ${col}`).run()
    } catch {
      /* column already exists */
    }
  }
}

/**
 * /setup is open while the instance has no users, so that one-click deploys
 * work without a CLI. That leaves a window in which anyone who knows the URL
 * could claim the instance, so when ADMIN_TOKEN is configured we additionally
 * require it — letting security-conscious deployments close the window.
 */
function setupAuthorised(c: { env: Env; req: { query: (k: string) => string | undefined; header: (h: string) => string | undefined } }): boolean {
  if (!c.env.ADMIN_TOKEN) return true
  return c.req.query('k') === c.env.ADMIN_TOKEN || c.req.header('x-admin-token') === c.env.ADMIN_TOKEN
}

/** True only while the instance has no users; gates the open setup page. */
async function needsSetup(db: D1Database): Promise<boolean> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>()
  return (row?.n ?? 0) === 0
}

const setupPage = (body: string) => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>GrokBotTrack setup</title>
<style>body{font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
background:#f4f4f1;color:#0b0b0b;margin:0;display:flex;min-height:100vh;align-items:center;
justify-content:center}main{background:#fff;border:1px solid #e4e3de;border-radius:14px;
padding:28px;max-width:460px;width:92%;box-shadow:0 1px 3px rgba(0,0,0,.06)}
h1{margin:0 0 4px;font-size:20px}p{color:#52514e}input{width:100%;box-sizing:border-box;
padding:11px 13px;margin:7px 0;border:1px solid #e4e3de;border-radius:9px;font-size:14px}
button{width:100%;padding:11px;border:0;border-radius:9px;background:#2a78d6;color:#fff;
font-size:14px;font-weight:600;cursor:pointer}code{display:block;word-break:break-all;
background:#f4f4f1;padding:11px;border-radius:8px;font-size:13px;margin:8px 0}
a{color:#2a78d6}</style></head><body><main>${body}</main></body></html>`

app.get('/setup', async (c) => {
  await ensureSchema(c.env.DB)
  if (!setupAuthorised(c)) {
    return c.html(
      setupPage(
        `<h1>Setup locked</h1><p>This instance has an admin token configured. ` +
          `Open <code>/setup?k=YOUR_ADMIN_TOKEN</code> to continue.</p>`
      ),
      403
    )
  }
  if (!(await needsSetup(c.env.DB))) {
    return c.html(
      setupPage(
        `<h1>Already set up</h1><p>This instance has an account. ` +
          `<a href="/app">Go to the dashboard</a>.</p>`
      ),
      403
    )
  }
  return c.html(
    setupPage(`<h1>Welcome to GrokBotTrack</h1>
<p>Create the first account. This page disables itself afterwards.</p>
<form method="post" action="/setup${c.req.query('k') ? `?k=${encodeURIComponent(c.req.query('k')!)}` : ''}">
  <input name="name" placeholder="Your name" required>
  <input name="email" type="email" placeholder="you@yourdomain.com" required>
  <button type="submit">Create account</button>
</form>`)
  )
})

app.post('/setup', async (c) => {
  await ensureSchema(c.env.DB)
  if (!setupAuthorised(c)) return c.text('Setup locked: admin token required', 403)
  if (!(await needsSetup(c.env.DB))) return c.text('Setup already completed', 403)
  const form = await c.req.parseBody()
  const name = String(form.name || '').trim()
  const email = String(form.email || '').trim()
  if (!name || !email) return c.text('name and email required', 400)

  const user = { id: shortId(10), name, email, api_token: 'dt_' + shortId(28) }
  await c.env.DB.prepare(
    'INSERT INTO users (id, name, email, api_token, created_at) VALUES (?, ?, ?, ?, ?)'
  )
    .bind(user.id, user.name, user.email, user.api_token, now())
    .run()

  const origin = new URL(c.req.url).origin
  return c.html(
    setupPage(`<h1>You're set up</h1>
<p>This is your API token \u2014 copy it now, it's how agents and scripts authenticate.</p>
<code>${escapeHtml(user.api_token)}</code>
<p><a href="${origin}/app?token=${encodeURIComponent(user.api_token)}">Open your dashboard \u2192</a></p>
<p style="font-size:13px">Configure an email provider to enable magic-link sign-in
and engagement alerts. See the README.</p>`)
  )
})

// ---------- admin ----------

app.post('/api/admin/users', async (c) => {
  if (c.req.header('x-admin-token') !== c.env.ADMIN_TOKEN) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  const { name, email } = await c.req.json<{ name: string; email: string }>()
  if (!name || !email) return c.json({ error: 'name and email required' }, 400)
  const user = { id: shortId(10), name, email, api_token: 'dt_' + shortId(28) }
  await c.env.DB.prepare(
    'INSERT INTO users (id, name, email, api_token, created_at) VALUES (?, ?, ?, ?, ?)'
  )
    .bind(user.id, user.name, user.email, user.api_token, now())
    .run()
  const origin = new URL(c.req.url).origin
  return c.json({ ...user, dashboard_url: `${origin}/app?token=${user.api_token}` })
})

// ---------- authed API (per-user Bearer token) ----------

app.use('/api/*', async (c, next) => {
  if (c.req.path.startsWith('/api/admin/') || c.req.path.startsWith('/api/auth/')) {
    return next()
  }
  // Agents/scripts authenticate with a personal dt_ token; humans on the
  // dashboard authenticate with the session cookie set by a magic link.
  const token = (c.req.header('authorization') || '').replace(/^Bearer\s+/i, '')
  let user: User | null = null
  if (token) {
    user = await c.env.DB.prepare('SELECT * FROM users WHERE api_token = ?')
      .bind(token)
      .first<User>()
  } else {
    const userId = await readSession(c.env, c.req.header('cookie'))
    if (userId) {
      user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?')
        .bind(userId)
        .first<User>()
    }
  }
  if (!user) return c.json({ error: 'unauthorized' }, 401)
  c.set('user', user)
  return next()
})

// ---------- magic-link login ----------

app.post('/api/auth/request', async (c) => {
  if (!c.env.SESSION_SECRET || !emailConfigured(c.env)) {
    return c.json({ error: 'magic-link login not configured' }, 503)
  }
  const { email } = await c.req.json<{ email?: string }>()
  if (!email) return c.json({ error: 'email required' }, 400)
  // Response is identical whether or not the address exists.
  await requestMagicLink(c.env, email, new URL(c.req.url).origin)
  return c.json({ ok: true })
})

app.get('/auth/verify', async (c) => {
  const token = c.req.query('t')
  if (!token || !c.env.SESSION_SECRET) return c.redirect('/app?err=invalid', 302)
  const userId = await consumeMagicLink(c.env, token)
  if (!userId) return c.redirect('/app?err=expired', 302)
  c.header('Set-Cookie', sessionCookie(await makeSession(c.env, userId)))
  return c.redirect('/app', 302)
})

app.post('/api/auth/logout', (c) => {
  c.header('Set-Cookie', 'dt_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0')
  return c.json({ ok: true })
})

type RegisterBody = {
  recipient: string
  subject?: string
  campaign?: string
  agent_source?: string
  html: string
}

// Rewrites links, injects pixel, persists message + link map, returns tracked HTML.
async function registerMessage(
  db: D1Database,
  origin: string,
  userId: string,
  body: RegisterBody
) {
  const messageId = shortId()
  const links: { id: string; original_url: string }[] = []

  const trackedHtml = body.html.replace(
    /href="(https?:\/\/[^"]+)"/gi,
    (match, url: string) => {
      if (url.startsWith(origin)) return match // already tracked
      const linkId = shortId()
      links.push({ id: linkId, original_url: url })
      return `href="${origin}/l/${linkId}"`
    }
  )

  const pixelTag = `<img src="${origin}/p/${messageId}.gif" width="1" height="1" alt="" style="display:none">`
  // Injected at the TOP of the body: Gmail clips messages over ~102KB and a
  // pixel past the clip point never renders, silently losing open tracking.
  const bodyOpen = /<body[^>]*>/i.exec(trackedHtml)
  const cut = bodyOpen ? bodyOpen.index + bodyOpen[0].length : 0
  const finalHtml = bodyOpen
    ? trackedHtml.slice(0, cut) + pixelTag + trackedHtml.slice(cut)
    : pixelTag + trackedHtml

  const stmts = [
    db.prepare(
      `INSERT INTO messages (id, user_id, recipient, subject, campaign, agent_source, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      messageId,
      userId,
      body.recipient,
      body.subject || null,
      body.campaign || null,
      body.agent_source || null,
      now()
    ),
    ...links.map((l) =>
      db.prepare(
        'INSERT INTO links (id, message_id, original_url) VALUES (?, ?, ?)'
      ).bind(l.id, messageId, l.original_url)
    ),
  ]
  await db.batch(stmts)

  return {
    message_id: messageId,
    pixel_url: `${origin}/p/${messageId}.gif`,
    links: links.map((l) => ({ ...l, tracked_url: `${origin}/l/${l.id}` })),
    html: finalHtml,
  }
}

// Register an outbound email: rewrites links, injects pixel, returns tracked HTML.
app.post('/api/register', async (c) => {
  const body = await c.req.json<RegisterBody>()
  if (!body.recipient || !body.html) {
    return c.json({ error: 'recipient and html required' }, 400)
  }
  const origin = trackingOrigin(c.env, c.req.url)
  return c.json(await registerMessage(c.env.DB, origin, c.get('user').id, body))
})

// Per-message rollup for the authed user (shared by dashboard + MCP).
async function messageSummary(db: D1Database, userId: string, limit = 200) {
  const { results } = await db
    .prepare(
      `SELECT m.id, m.recipient, m.subject, m.campaign, m.agent_source, m.sent_at,
       SUM(CASE WHEN e.type = 'open' AND e.classification IN ('human','gmail-proxy') THEN 1 ELSE 0 END) AS confirmed_opens,
       SUM(CASE WHEN e.type = 'open' THEN 1 ELSE 0 END) AS raw_opens,
       SUM(CASE WHEN e.type = 'click' AND e.classification = 'human' THEN 1 ELSE 0 END) AS clicks,
       MAX(CASE WHEN e.classification = 'human' THEN e.ts END) AS last_human_activity
     FROM messages m
     LEFT JOIN events e ON e.message_id = m.id
     WHERE m.user_id = ?
     GROUP BY m.id
     ORDER BY m.sent_at DESC
     LIMIT ?`
    )
    .bind(userId, limit)
    .all()
  return results
}

app.get('/api/summary', async (c) => {
  const user = c.get('user')
  return c.json({
    user: { id: user.id, name: user.name },
    messages: await messageSummary(c.env.DB, user.id),
  })
})

// Full event timeline for one of the authed user's messages.
app.get('/api/messages/:id/events', async (c) => {
  const user = c.get('user')
  const msg = await c.env.DB.prepare(
    'SELECT id FROM messages WHERE id = ? AND user_id = ?'
  )
    .bind(c.req.param('id'), user.id)
    .first()
  if (!msg) return c.json({ error: 'not found' }, 404)
  const { results } = await c.env.DB.prepare(
    `SELECT e.type, e.ts, e.classification, e.country, e.region, e.city, e.timezone, l.original_url
     FROM events e LEFT JOIN links l ON l.id = e.link_id
     WHERE e.message_id = ? ORDER BY e.ts`
  )
    .bind(c.req.param('id'))
    .all()
  return c.json({ events: results })
})

// ---------- webhook configuration ----------

app.get('/api/webhook', async (c) => {
  const user = c.get('user')
  const row = await c.env.DB.prepare(
    'SELECT webhook_url, webhook_secret FROM users WHERE id = ?'
  )
    .bind(user.id)
    .first<{ webhook_url: string | null; webhook_secret: string | null }>()
  return c.json({
    webhook_url: row?.webhook_url || null,
    // Never echo the secret back; only say whether one is set.
    has_secret: Boolean(row?.webhook_secret),
    account_default: c.env.WEBHOOK_URL || null,
    events: c.env.WEBHOOK_EVENTS || 'all',
  })
})

app.put('/api/webhook', async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{ webhook_url?: string | null; webhook_secret?: string | null }>()
  const url = body.webhook_url?.trim() || null
  if (url && !/^https:\/\//i.test(url)) {
    return c.json({ error: 'webhook_url must be https' }, 400)
  }
  await c.env.DB.prepare('UPDATE users SET webhook_url = ?, webhook_secret = ? WHERE id = ?')
    .bind(url, body.webhook_secret?.trim() || null, user.id)
    .run()
  return c.json({ ok: true, webhook_url: url, has_secret: Boolean(body.webhook_secret) })
})

/** Sends a sample payload so you can verify the receiver before going live. */
app.post('/api/webhook/test', async (c) => {
  const user = c.get('user')
  const row = await c.env.DB.prepare(
    'SELECT webhook_url, webhook_secret FROM users WHERE id = ?'
  )
    .bind(user.id)
    .first<{ webhook_url: string | null; webhook_secret: string | null }>()
  const url = row?.webhook_url || c.env.WEBHOOK_URL
  if (!url) return c.json({ error: 'no webhook configured' }, 400)

  const res = await sendWebhook(url, row?.webhook_secret || c.env.WEBHOOK_SECRET, {
    event: 'open',
    message_id: 'test-message',
    recipient: 'test@example.com',
    subject: 'GrokBotTrack webhook test',
    campaign: 'test',
    agent_source: 'webhook-test',
    sent_at: now(),
    occurred_at: now(),
    classification: 'human',
    is_confirmed: true,
    is_first_engagement: true,
    open_count: 1,
    click_count: 0,
    location: { city: 'Testville', region: 'Test', country: 'US', timezone: 'UTC' },
  })
  return c.json({ delivered: res.ok, status: res.status ?? null, error: res.error ?? null })
})

// ---------- MCP endpoint (Bearer user token; scoped to that user) ----------

app.post('/mcp', (c) =>
  handleMcp(c.req.raw, c.env.DB, {
    registerMessage,
    messageSummary,
    trackingOrigin: trackingOrigin(c.env, c.req.url),
  })
)

// ---------- dashboard (token-gated, self-contained SPA) ----------

app.get('/app', (c) => c.html(DASHBOARD_HTML))

export default app

