// Scoped agent keys.
//
// A personal dt_ token can do everything its owner can: read every recipient,
// change the webhook, mint more keys. Handing that to an agent means a prompt
// injection inherits all of it. Agents instead get mk_ keys that carry only
// the scopes they need, can be capped per day, and can be revoked one at a
// time without rotating the owner's token. Keys are stored hashed, so a copy
// of the database does not yield working credentials.

export const SCOPES = ['register', 'read', 'webhook'] as const
export type Scope = (typeof SCOPES)[number]

export type User = {
  id: string
  name: string
  email: string
  api_token: string
  webhook_url?: string | null
  webhook_secret?: string | null
}

export type Principal = {
  user: User
  scopes: Set<Scope>
  /** null for the owner's dt_ token or a dashboard session. */
  keyId: string | null
  /** Registrations allowed per rolling 24h on this key; null = uncapped. */
  dailyRegisterLimit: number | null
}

export class RegisterLimitError extends Error {
  constructor(public limit: number) {
    super(`this key has reached its limit of ${limit} registrations per 24 hours`)
  }
}

export const ALL_SCOPES = new Set<Scope>(SCOPES)
export const KEY_PREFIX = 'mk_'

export function ownerPrincipal(user: User): Principal {
  return { user, scopes: ALL_SCOPES, keyId: null, dailyRegisterLimit: null }
}

export function hasScope(p: Principal, scope: Scope): boolean {
  return p.scopes.has(scope)
}

export function parseScopes(input: unknown): Scope[] | null {
  const list = Array.isArray(input) ? input : typeof input === 'string' ? input.split(',') : []
  const out = new Set<Scope>()
  for (const raw of list) {
    const s = String(raw).trim()
    if (!(SCOPES as readonly string[]).includes(s)) return null
    out.add(s as Scope)
  }
  return out.size ? [...out] : null
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
function randomToken(len: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len))
  let s = ''
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length]
  return s
}

export async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Returns the raw key once; only its hash is ever persisted. */
export async function mintKey(
  db: D1Database,
  userId: string,
  opts: { label?: string | null; scopes: Scope[]; dailyRegisterLimit?: number | null }
): Promise<{ id: string; key: string }> {
  const id = randomToken(10)
  const key = KEY_PREFIX + randomToken(32)
  await db
    .prepare(
      `INSERT INTO api_keys (id, user_id, token_hash, label, scopes, daily_register_limit, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      userId,
      await sha256hex(key),
      opts.label || null,
      opts.scopes.join(','),
      opts.dailyRegisterLimit ?? null,
      new Date().toISOString()
    )
    .run()
  return { id, key }
}

type KeyJoinRow = User & {
  key_id: string
  scopes: string
  daily_register_limit: number | null
  last_used_at: string | null
  revoked_at: string | null
}

/**
 * Resolves a Bearer value to a principal. mk_ keys look up api_keys by hash;
 * anything else is treated as an owner's dt_ token. Returns null when nothing
 * matches or the key has been revoked.
 */
export async function authenticate(db: D1Database, bearer: string): Promise<Principal | null> {
  if (!bearer) return null

  if (!bearer.startsWith(KEY_PREFIX)) {
    const user = await db.prepare('SELECT * FROM users WHERE api_token = ?').bind(bearer).first<User>()
    return user ? ownerPrincipal(user) : null
  }

  let row: KeyJoinRow | null
  try {
    row = await db
      .prepare(
        `SELECT k.id AS key_id, k.scopes, k.daily_register_limit, k.last_used_at, k.revoked_at,
                u.id, u.name, u.email, u.api_token, u.webhook_url, u.webhook_secret
         FROM api_keys k JOIN users u ON u.id = k.user_id
         WHERE k.token_hash = ?`
      )
      .bind(await sha256hex(bearer))
      .first<KeyJoinRow>()
  } catch {
    // Table does not exist yet on a database that predates agent keys: no
    // key can be valid, and the owner's dt_ token path above still works.
    return null
  }
  if (!row || row.revoked_at) return null

  // Touch last_used_at at most hourly so routine agent traffic does not burn
  // D1's daily row-write budget on bookkeeping.
  const stale = !row.last_used_at || Date.now() - Date.parse(row.last_used_at) > 3_600_000
  if (stale) {
    await db
      .prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?')
      .bind(new Date().toISOString(), row.key_id)
      .run()
  }

  return {
    user: {
      id: row.id,
      name: row.name,
      email: row.email,
      api_token: row.api_token,
      webhook_url: row.webhook_url,
      webhook_secret: row.webhook_secret,
    },
    scopes: new Set<Scope>(parseScopes(row.scopes) ?? []),
    keyId: row.key_id,
    dailyRegisterLimit: row.daily_register_limit,
  }
}

/** Registrations this key has made in the last 24 hours. */
export async function registrationsToday(db: D1Database, keyId: string): Promise<number> {
  const since = new Date(Date.now() - 86_400_000).toISOString()
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM messages WHERE api_key_id = ? AND sent_at > ?')
    .bind(keyId, since)
    .first<{ n: number }>()
  return row?.n ?? 0
}

export async function listKeys(db: D1Database, userId: string) {
  const { results } = await db
    .prepare(
      `SELECT id, label, scopes, daily_register_limit, created_at, last_used_at, revoked_at
       FROM api_keys WHERE user_id = ? ORDER BY created_at DESC`
    )
    .bind(userId)
    .all()
  return results
}

export async function revokeKey(db: D1Database, userId: string, keyId: string): Promise<boolean> {
  const r = await db
    .prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
    .bind(new Date().toISOString(), keyId, userId)
    .run()
  return (r.meta.changes ?? 0) > 0
}
