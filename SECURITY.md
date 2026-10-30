# Security

## Reporting a vulnerability

Please open a private security advisory on the repository rather than a public
issue.

## What this software does

MailTrackMCP embeds a tracking pixel and rewrites links in outbound email, then
records when those are fetched. Run it only for correspondence you have a
legitimate reason to send. See "Responsible use" in the README.

## Deploying safely

**Set `ADMIN_TOKEN` before or immediately after your first deploy.**
`/setup` is open while the instance has no accounts — that is what makes
one-click deploys work without a CLI, but it means anyone who reaches the URL
first could claim the instance. When `ADMIN_TOKEN` is set, `/setup` requires it
(`/setup?k=YOUR_ADMIN_TOKEN`), closing that window.

```bash
npx wrangler secret put ADMIN_TOKEN      # before you share the URL
npx wrangler secret put SESSION_SECRET   # openssl rand -hex 32
```

**Never commit `.dev.vars` or `wrangler.local.jsonc`.** Both are gitignored.
Secrets belong in `wrangler secret put`, never in the repo.

## How the system protects itself

- **Per-user isolation.** Every query is scoped by the authenticated user; one
  person's token can never read another's messages or events.
- **Redirect targets are stored server-side.** `/l/:id` looks the destination up
  by id — it never redirects to a URL supplied in the request, so the endpoint
  cannot be abused as an open redirect by outsiders.
- **Parameterised SQL everywhere.** No string-built queries.
- **Login links are single-use and short-lived** (15 minutes), and the request
  endpoint responds identically whether or not an address has an account, so it
  cannot be used to enumerate users.
- **Sessions are HMAC-signed** HttpOnly/Secure cookies; the signature is
  compared without early return.
- **Webhooks can be signed.** Set a secret and every delivery carries
  `X-MailTrack-Signature: sha256=<hex>` over the raw body. Verify it —
  otherwise anyone who learns your endpoint URL can forge events.
- **Tracking ids are 14 random characters** from a 62-character alphabet
  (~83 bits), so message ids are not guessable or enumerable.
- **Agent keys are scoped, capped, hashed and revocable.** `mk_` keys carry
  only `register`, `read` and/or `webhook`; the MCP server advertises only the
  tools a key may call; a key can be limited to N registrations per 24 hours;
  only the SHA-256 of a key is stored; and revoking one key leaves the owner's
  token and every other key untouched.

## Threat model: a compromised or prompt-injected agent

Agents that read inbound mail will eventually read an instruction written by an
attacker. This section is explicit about what such an agent can and cannot do
*through this system*.

**What MailTrackMCP cannot do, with any credential:** send email. It holds no
credential for your mailbox. `register_tracked_email` returns HTML; your
agent's own mail tool sends it. The Worker's only outbound mail is engagement
alerts and login links to the account owner's own address. If an injected agent
mass-mails your contacts, that is the agent's send tool at work; constrain that
tool with the same care as this one.

**What an agent holding your personal `dt_` token could do** — and why that
token should never sit in an agent config:

| Action | Consequence |
|---|---|
| `list_recent_emails` / `GET /api/summary` | your entire recipient list and who engaged, pulled into the agent's context, from where an injection can forward it anywhere the agent can write |
| `PUT /api/webhook` | every future engagement event — recipient, subject, time, location — delivered to an attacker's URL |
| unlimited `register` | your tracking domain minted into an unbounded set of redirect links |

**What scoped keys change.** Give the sending agent a `register`-only key with
a daily cap and the reporting agent a `read`-only key; give no agent the
`webhook` scope. Now:

- The sending agent cannot see the contact list at all — the read tools are not
  even listed to it — and can register at most N messages a day before `register`
  returns an error the agent is told to treat as a hard stop.
- The reporting agent can read engagement but, holding no send tool and no
  `register` scope, has no channel that MailTrackMCP provides to move it.
- Nobody but you can redirect the webhook or mint keys.
- A leaked key is revoked on its own; the owner's token is never rotated for it.

**What remains yours to manage.** A `read` key in an agent that *also* has an
outbound channel (mail, chat, HTTP) can still leak the list — the scope limits
what this system hands over, not what the agent does with it. The cap on
`register` bounds abuse; it does not detect it. Put the read key only in agents
whose output goes to you.

## Known limitations

- **An authenticated user can register a link to any URL**, which makes your
  tracking domain a redirector for that user. This is inherent to click
  tracking. Only issue tokens to people you trust, and cap agent keys with
  `daily_register_limit`.
- **Open tracking is best-effort.** Recipients who block remote images are not
  tracked, and that is their prerogative. Treat missing opens as missing data.
- **Proxied opens reveal nothing about location.** The system marks these rather
  than guessing; do not report proxy geography as the reader's.
