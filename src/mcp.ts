// Minimal MCP server (JSON-RPC 2.0 over HTTP POST).
// Auth: Bearer agent key (mk_) or owner token (dt_). Each session is scoped
// to one user, so tools never need a user_id argument — and to that key's
// scopes, so an agent holding a register-only key is never even shown the
// read tools, let alone allowed to call them.

import { type Principal, type Scope, RegisterLimitError, hasScope } from './keys'

type Ctx = {
  db: D1Database
  origin: string
  principal: Principal
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
    },
    key?: { id: string; dailyLimit: number | null }
  ) => Promise<{ message_id: string; pixel_url: string; links: unknown[]; html: string }>
  messageSummary: (db: D1Database, userId: string, limit?: number) => Promise<unknown[]>
  comparisonReport: (db: D1Database, userId: string, days?: number) => Promise<unknown>
}

const SERVER_INFO = { name: 'mailtrackmcp', version: '1.1.0' }

type Tool = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /** Scope the caller's key must carry; the tool is hidden otherwise. */
  scope: Scope
}

const TOOLS: Tool[] = [
  {
    name: 'register_tracked_email',
    scope: 'register',
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
    scope: 'read',
    description:
      'List your recently tracked emails with open/click counts and last human activity. Use to see who has engaged.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max rows (default 50)' } },
    },
  },
  {
    name: 'get_email_status',
    scope: 'read',
    description:
      'Get the full event timeline for one tracked email (opens and clicks with timestamps, location when available, and bot/proxy classification). Pass the message_id from register_tracked_email or list_recent_emails.',
    inputSchema: {
      type: 'object',
      required: ['message_id'],
      properties: { message_id: { type: 'string' } },
    },
  },
  {
    name: 'get_filtering_comparison',
    scope: 'read',
    description:
      'Compare what this tracker reports against counting every pixel hit, on the same messages. Shows how many opens and how many recipients a naive tracker would over-report, broken down by which rule suppressed each event. Use when asked how much bot/prefetch filtering actually changes the numbers.',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Limit to the last N days (default: all time)' },
      },
    },
  },
  {
    name: 'get_campaign_stats',
    scope: 'read',
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

/** Tools this principal may call, in wire shape (no internal scope field). */
function visibleTools(p: Principal) {
  return TOOLS.filter((t) => hasScope(p, t.scope)).map(({ scope: _scope, ...wire }) => wire)
}

async function callTool(ctx: Ctx, name: string, args: Record<string, unknown>) {
  const userId = ctx.principal.user.id
  switch (name) {
    case 'register_tracked_email': {
      const p = ctx.principal
      const key = p.keyId ? { id: p.keyId, dailyLimit: p.dailyRegisterLimit } : undefined
      const r = await ctx.registerMessage(
        ctx.db,
        ctx.origin,
        userId,
        {
          recipient: String(args.recipient),
          html: String(args.html),
          subject: args.subject as string | undefined,
          campaign: args.campaign as string | undefined,
          agent_source: (args.agent_source as string) || 'mcp',
        },
        key
      )
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
        userId,
        typeof args.limit === 'number' ? args.limit : 50
      )
      return toolResult({ count: rows.length, emails: rows })
    }
    case 'get_email_status': {
      const mid = String(args.message_id)
      const msg = await ctx.db
        .prepare('SELECT id, recipient, subject, campaign, sent_at FROM messages WHERE id = ? AND user_id = ?')
        .bind(mid, userId)
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
    case 'get_filtering_comparison': {
      const days = typeof args.days === 'number' ? args.days : undefined
      return toolResult(await ctx.comparisonReport(ctx.db, userId, days))
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
        .bind(userId)
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
  principal: Principal | null,
  deps: Pick<Ctx, 'registerMessage' | 'messageSummary' | 'comparisonReport'> & {
    trackingOrigin?: string
  }
): Promise<Response> {
  if (!principal) return json(err(null, -32001, 'missing or invalid bearer token'), 401)

  let msg: { method?: string; id?: unknown; params?: Record<string, unknown> }
  try {
    msg = await req.json()
  } catch {
    return json(err(null, -32700, 'parse error'))
  }

  const ctx: Ctx = {
    db,
    origin: deps.trackingOrigin || new URL(req.url).origin,
    principal,
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
      return json(ok(id, { tools: visibleTools(principal) }))
    case 'tools/call': {
      const params = msg.params || {}
      const name = String(params.name)
      const args = (params.arguments as Record<string, unknown>) || {}
      const tool = TOOLS.find((t) => t.name === name)
      if (!tool) return json(err(id, -32602, `unknown tool: ${name}`))
      if (!hasScope(principal, tool.scope)) {
        return json(err(id, -32003, `this key lacks the '${tool.scope}' scope required by ${name}`))
      }
      try {
        const result = await callTool(ctx, name, args)
        return json(ok(id, result))
      } catch (e) {
        if (e instanceof RegisterLimitError) return json(err(id, -32004, e.message))
        throw e
      }
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
