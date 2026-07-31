// Minimal MCP server over Streamable HTTP (JSON-RPC 2.0).
// Auth: Bearer user token (same dt_ token as the API). Each session is scoped
// to one user, so tools never need a user_id argument.

type User = { id: string; name: string; email: string; api_token: string }

type Ctx = {
  db: D1Database
  origin: string
  user: User
  registerMessage: (
    db: D1Database,
    origin: string,
    userId: string,
    body: {
      recipient: string
      subject?: string
      campaign?: string
      agent_source?: string
      html: string
    }
  ) => Promise<{ message_id: string; pixel_url: string; links: unknown[]; html: string }>
  messageSummary: (db: D1Database, userId: string, limit?: number) => Promise<unknown[]>
}

const SERVER_INFO = { name: 'duvaltrack', version: '1.0.0' }

const TOOLS = [
  {
    name: 'register_tracked_email',
    description:
      'Register an outbound email for open/click tracking. Pass the raw HTML body; returns tracked HTML (with a tracking pixel injected and all links rewritten) that you must send as-is, plus the message_id. Call this right before sending, then send the returned html.',
    inputSchema: {
      type: 'object',
      required: ['recipient', 'html'],
      properties: {
        recipient: { type: 'string', description: 'Recipient email address' },
        html: { type: 'string', description: 'The HTML body of the email to send' },
        subject: { type: 'string', description: 'Email subject (for the dashboard)' },
        campaign: { type: 'string', description: 'Optional campaign/sequence label to group by' },
        agent_source: { type: 'string', description: 'Which agent/system is sending (for attribution)' },
      },
    },
  },
  {
    name: 'list_recent_emails',
    description:
      'List your recently tracked emails with open/click counts and last human activity. Use to see who has engaged.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max rows (default 50)' } },
    },
  },
  {
    name: 'get_email_status',
    description:
      'Get the full event timeline for one tracked email (opens and clicks with timestamps, location when available, and bot/proxy classification). Pass the message_id from register_tracked_email or list_recent_emails.',
    inputSchema: {
      type: 'object',
      required: ['message_id'],
      properties: { message_id: { type: 'string' } },
    },
  },
  {
    name: 'get_campaign_stats',
    description:
      'Aggregate open/click stats grouped by campaign label across your tracked emails.',
    inputSchema: { type: 'object', properties: {} },
  },
]

function ok(id: unknown, result: unknown) {
  return { jsonrpc: '2.0', id, result }
}
function err(id: unknown, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}
function toolResult(data: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
}

async function callTool(ctx: Ctx, name: string, args: Record<string, unknown>) {
  switch (name) {
    case 'register_tracked_email': {
      const r = await ctx.registerMessage(ctx.db, ctx.origin, ctx.user.id, {
        recipient: String(args.recipient),
        html: String(args.html),
        subject: args.subject as string | undefined,
        campaign: args.campaign as string | undefined,
        agent_source: (args.agent_source as string) || 'mcp',
      })
      return toolResult({
        message_id: r.message_id,
        tracked_html: r.html,
        links: r.links,
        note: 'Send tracked_html as the email body (do not modify it).',
      })
    }
    case 'list_recent_emails': {
      const rows = await ctx.messageSummary(
        ctx.db,
        ctx.user.id,
        typeof args.limit === 'number' ? args.limit : 50
      )
      return toolResult({ count: rows.length, emails: rows })
    }
    case 'get_email_status': {
      const mid = String(args.message_id)
      const msg = await ctx.db
        .prepare('SELECT id, recipient, subject, campaign, sent_at FROM messages WHERE id = ? AND user_id = ?')
        .bind(mid, ctx.user.id)
        .first()
      if (!msg) return toolResult({ error: 'message not found' })
      const { results } = await ctx.db
        .prepare(
          `SELECT e.type, e.ts, e.classification, e.country, e.region, e.city, e.timezone, l.original_url
           FROM events e LEFT JOIN links l ON l.id = e.link_id
           WHERE e.message_id = ? ORDER BY e.ts`
        )
        .bind(mid)
        .all()
      return toolResult({ message: msg, events: results })
    }
    case 'get_campaign_stats': {
      const { results } = await ctx.db
        .prepare(
          `SELECT COALESCE(m.campaign,'(none)') AS campaign,
             COUNT(DISTINCT m.id) AS emails,
             COUNT(DISTINCT m.recipient) AS recipients,
             SUM(CASE WHEN e.type='open' AND e.classification IN ('human','gmail-proxy') THEN 1 ELSE 0 END) AS confirmed_opens,
             SUM(CASE WHEN e.type='click' AND e.classification='human' THEN 1 ELSE 0 END) AS clicks
           FROM messages m LEFT JOIN events e ON e.message_id = m.id
           WHERE m.user_id = ?
           GROUP BY COALESCE(m.campaign,'(none)')
           ORDER BY emails DESC`
        )
        .bind(ctx.user.id)
        .all()
      return toolResult({ campaigns: results })
    }
    default:
      return null
  }
}

export async function handleMcp(
  req: Request,
  db: D1Database,
  deps: Pick<Ctx, 'registerMessage' | 'messageSummary'> & { trackingOrigin?: string }
): Promise<Response> {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
  if (!token) return json(err(null, -32001, 'missing bearer token'), 401)
  const user = await db.prepare('SELECT * FROM users WHERE api_token = ?').bind(token).first<User>()
  if (!user) return json(err(null, -32001, 'invalid token'), 401)

  let msg: { method?: string; id?: unknown; params?: Record<string, unknown> }
  try {
    msg = await req.json()
  } catch {
    return json(err(null, -32700, 'parse error'))
  }

  const ctx: Ctx = {
    db,
    origin: deps.trackingOrigin || new URL(req.url).origin,
    user,
    ...deps,
  }
  const id = msg.id ?? null

  switch (msg.method) {
    case 'initialize':
      return json(
        ok(id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        })
      )
    case 'notifications/initialized':
      return new Response(null, { status: 202 })
    case 'tools/list':
      return json(ok(id, { tools: TOOLS }))
    case 'tools/call': {
      const params = msg.params || {}
      const name = String(params.name)
      const args = (params.arguments as Record<string, unknown>) || {}
      const result = await callTool(ctx, name, args)
      if (!result) return json(err(id, -32602, `unknown tool: ${name}`))
      return json(ok(id, result))
    }
    default:
      return json(err(id, -32601, `method not found: ${msg.method}`))
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
