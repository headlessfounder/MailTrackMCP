import { Hono } from 'hono'
import { DASHBOARD_HTML } from './dashboard'
import { handleMcp } from './mcp'
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
  /** Canonical host that pixel + link URLs are built on (e.g. go.duvalsoftware.com).
   *  Falls back to the request origin so the worker still works without it. */
  TRACKING_HOST?: string
  /** Optional: set to enable "first open" email alerts via Resend. */
  RESEND_API_KEY?: string
  NOTIFY_FROM?: string
  /** Optional: set to enable magic-link login (signs session cookies). */
  SESSION_SECRET?: string
}

type User = { id: string; name: string; email: string; api_token: string }

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

// Classify a tracking event so proxies, prefetchers, and security scanners
// don't inflate the stats. Geo is only trustworthy for 'human' events.
function classify(
  ua: string,
  cf: IncomingRequestCfProperties | undefined,
  sentAt: string,
  type: 'open' | 'click'
): string {
  const ageSec = (Date.now() - Date.parse(sentAt)) / 1000
  const org = (cf?.asOrganization || '').toLowerCase()
  if (/googleimageproxy/i.test(ua)) return 'gmail-proxy'
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
  const classification = classify(ua, cf, sentAt, type)
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
  if (!env.RESEND_API_KEY) return
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
  const subject = `${row.recipient} ${verb} "${row.subject || '(no subject)'}"`
  const geoNote =
    classification === 'gmail-proxy' ? ' (via Gmail proxy — no location available)' : ''

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.NOTIFY_FROM || 'DuvalTrack <notify@notify.duvalsoftware.com>',
        to: [row.user_email],
        subject: `🔔 ${subject}`,
        html:
          `<p><strong>${escapeHtml(row.recipient)}</strong> just ${verb} ` +
          `<strong>${escapeHtml(row.subject || '(no subject)')}</strong>${geoNote}.</p>` +
          (row.campaign ? `<p>Campaign: ${escapeHtml(row.campaign)}</p>` : '') +
          `<p style="color:#666;font-size:13px">First engagement on this message. ` +
          `See the full timeline in your DuvalTrack dashboard.</p>`,
      }),
    })
    // Surface delivery problems in logs; a bad key or unverified sender would
    // otherwise fail invisibly.
    if (!res.ok) console.error('resend notify failed', res.status, await res.text())
  } catch (err) {
    console.error('resend notify threw', String(err))
  }
  // Notification problems must never break tracking — that's why this is
  // wrapped and fired via waitUntil.
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!))

// ---------- public tracking routes (no auth — hit by recipients' mail clients) ----------

app.get('/', (c) => c.text('DuvalTrack — internal email tracking'))

app.get('/p/:id', async (c) => {
  const id = c.req.param('id').replace(/\.gif$/, '')
  const msg = await c.env.DB.prepare('SELECT id, sent_at FROM messages WHERE id = ?')
    .bind(id)
    .first<{ id: string; sent_at: string }>()
  if (msg) {
    const cls = await logEvent(c, msg.id, null, 'open', msg.sent_at)
    if (await isFirstRealEngagement(c.env.DB, msg.id, 'open', cls)) {
      c.executionCtx.waitUntil(notifyFirstEngagement(c.env, msg.id, 'open', cls))
    }
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
  if (await isFirstRealEngagement(c.env.DB, link.message_id, 'click', cls)) {
    c.executionCtx.waitUntil(notifyFirstEngagement(c.env, link.message_id, 'click', cls))
  }
  return c.redirect(link.original_url, 302)
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
  if (!c.env.SESSION_SECRET || !c.env.RESEND_API_KEY) {
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
  const finalHtml = /<\/body>/i.test(trackedHtml)
    ? trackedHtml.replace(/<\/body>/i, `${pixelTag}</body>`)
    : trackedHtml + pixelTag

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

