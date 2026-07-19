import { Hono } from 'hono'
import { DASHBOARD_HTML } from './dashboard'
import { handleMcp } from './mcp'

type Env = {
  DB: D1Database
  ADMIN_TOKEN: string
}

type User = { id: string; name: string; email: string; api_token: string }

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

async function logEvent(
  c: { env: Env; req: { raw: Request; header: (h: string) => string | undefined } },
  messageId: string,
  linkId: string | null,
  type: 'open' | 'click',
  sentAt: string
) {
  const cf = (c.req.raw as Request & { cf?: IncomingRequestCfProperties }).cf
  const ua = c.req.header('user-agent') || ''
  const ip = c.req.header('cf-connecting-ip') || ''
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
      classify(ua, cf, sentAt, type)
    )
    .run()
}

// ---------- public tracking routes (no auth — hit by recipients' mail clients) ----------

app.get('/', (c) => c.text('DuvalTrack — internal email tracking'))

app.get('/p/:id', async (c) => {
  const id = c.req.param('id').replace(/\.gif$/, '')
  const msg = await c.env.DB.prepare('SELECT id, sent_at FROM messages WHERE id = ?')
    .bind(id)
    .first<{ id: string; sent_at: string }>()
  if (msg) {
    await logEvent(c, msg.id, null, 'open', msg.sent_at)
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
  await logEvent(c, link.message_id, link.id, 'click', link.sent_at)
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
  if (c.req.path.startsWith('/api/admin/')) return next()
  const token = (c.req.header('authorization') || '').replace(/^Bearer\s+/i, '')
  if (!token) return c.json({ error: 'missing bearer token' }, 401)
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE api_token = ?')
    .bind(token)
    .first<User>()
  if (!user) return c.json({ error: 'invalid token' }, 401)
  c.set('user', user)
  return next()
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
  const origin = new URL(c.req.url).origin
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
  handleMcp(c.req.raw, c.env.DB, { registerMessage, messageSummary })
)

// ---------- dashboard (token-gated, self-contained SPA) ----------

app.get('/app', (c) => c.html(DASHBOARD_HTML))

export default app

