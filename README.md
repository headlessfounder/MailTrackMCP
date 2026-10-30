# GrokBotTrack

**Self-hosted email open & click tracking that your AI agent can query.**
One Cloudflare Worker + D1. No server, no per-seat SaaS fee, free tier is plenty.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/headlessfounder/GrokBotTrack)

![GrokBotTrack dashboard](docs/dashboard.png)

---

## Why this exists

Email trackers are a crowded space. Two things here are not:

**1. It ships an MCP server.** Connect it to Claude, Cursor, OpenClaw or any
MCP-capable agent and ask *"who opened my emails today?"* — or have the agent
register and send tracked mail itself. Tracking that an agent can both **write
to** and **reason over**.

**2. It tells you when an "open" isn't a read.** Most trackers count every pixel
hit. Mail clients and security appliances fetch pixels constantly, which is why
naive open rates are inflated. GrokBotTrack classifies every event and excludes
the noise — see [Trust model](#trust-model).

Because tracking is injected **server-side at send time**, it works for any
sender — agents, Gmail, Resend, SES, scripts — instead of needing a browser
extension.

## Features

- **Open tracking** via an invisible 1×1 GIF, injected at the top of the body so
  Gmail's ~102KB clipping can't silently kill it
- **Click tracking** by rewriting links to logging redirects (302 to the real URL)
- **Event classification** — `human`, `gmail-proxy`, `apple-prefetch`, `scanner`,
  `sender-echo`
- **Geolocation** from Cloudflare's edge, surfaced only when it's genuinely the
  reader's
- **Multi-user** — personal API tokens, isolated data per person
- **Dashboard** — per-recipient rollups with expandable event timelines
- **Passwordless login** — magic link, no passwords stored
- **Engagement alerts** — email on a recipient's first genuine open or click
- **MCP server** — four tools over Streamable HTTP

## Quick start

```bash
git clone https://github.com/headlessfounder/GrokBotTrack && cd GrokBotTrack
npm install

npx wrangler d1 create grokbottrack      # put the printed id in wrangler.jsonc
npm run db:init                        # create the tables
npx wrangler deploy
```

Then open **`https://<your-worker>.workers.dev/setup`** and create the first
account. That page disables itself once an account exists, and hands you the API
token agents authenticate with.

### Optional but recommended

**Custom tracking domain.** Serve pixels and links from a subdomain of the domain
you *send from* (`go.yourdomain.com`). Matching domains keep spam filters calm —
links pointing somewhere unrelated to the From address is a phishing signal.
Uncomment `routes` in `wrangler.jsonc`, set `TRACKING_HOST`, redeploy.

**Email (for login links and alerts).** Enable Cloudflare Email Sending once:

```bash
npx wrangler email sending enable yourdomain.com
```

Set `NOTIFY_FROM` to an address on that domain. Prefer Resend instead? Set a
`RESEND_API_KEY` secret and it takes over — no code change.

```bash
npx wrangler secret put SESSION_SECRET   # any long random string; enables login
```

## Using it

**The one rule: register before sending, then send the returned HTML unmodified.**
It already contains the pixel and rewritten links.

```bash
curl -X POST https://<your-worker>/api/register \
  -H "Authorization: Bearer dt_YOUR_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "recipient": "them@company.com",
    "subject": "Quick question",
    "campaign": "q4-outbound",
    "agent_source": "my-script",
    "html": "<html><body><p>Hi — see the <a href=\"https://example.com/demo\">demo</a>.</p></body></html>"
  }'
```

Send the `html` from the response. Set `campaign` and `agent_source` so stats stay
comparable across every tool you send from.

### Connect an agent (MCP)

```json
{
  "mcpServers": {
    "grokbottrack": {
      "type": "http",
      "url": "https://<your-worker>/mcp",
      "headers": { "Authorization": "Bearer dt_YOUR_TOKEN" }
    }
  }
}
```

| Tool | Purpose |
|---|---|
| `register_tracked_email` | Returns `tracked_html` to send |
| `list_recent_emails` | Recent sends with open/click counts |
| `get_email_status` | Full event timeline for one message |
| `get_campaign_stats` | Totals grouped by campaign |

## Trust model

Not every pixel fetch is a human reading your email.

| Signal | Classification | Counts as open? | Location trustworthy? |
|---|---|---|---|
| Normal client | `human` | ✅ | ✅ |
| `GoogleImageProxy` UA | `gmail-proxy` | ✅ | ❌ — it's Google's datacenter |
| Gmail proxy within `SELF_OPEN_WINDOW_SEC` of send | `sender-echo` | ❌ | ❌ |
| Apple/iCloud ASN < 5 min after send | `apple-prefetch` | ❌ | ❌ |
| Datacenter ASN or scanner UA < 60s | `scanner` | ❌ | ❌ |

`confirmed_opens` = `human` + `gmail-proxy`. Clicks count only when `human`.

**Trust ladder:** a human *click* is strongest (real person, real location) >
human open > gmail-proxy open (real, but location is Google's) >
`sender-echo` / `apple-prefetch` / `scanner` (excluded).

**Why `sender-echo` exists:** re-reading your own message in Sent fetches the
pixel through the same Gmail proxy as the recipient's open — the two are
indistinguishable by request alone. A real open seconds after send is rare; a
sender reviewing their own copy is not, so that window is attributed to you
rather than inflating your numbers. Tune with `SELF_OPEN_WINDOW_SEC`.

## Routes

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/register` | Bearer | Inject pixel + rewrite links, return tracked HTML |
| `GET /p/:id.gif` | none | Log open, return 1×1 GIF |
| `GET /l/:id` | none | Log click, 302 to the stored destination |
| `GET /api/summary` | Bearer / session | Per-message rollup |
| `GET /api/messages/:id/events` | Bearer / session | Event timeline |
| `POST /mcp` | Bearer | MCP server (JSON-RPC 2.0) |
| `GET /app` | session or token | Dashboard |
| `GET /setup` | first run only | Create the first account |
| `POST /api/admin/users` | `x-admin-token` | Add further users |

## Architecture

```mermaid
flowchart TD
    A["Agent via MCP"] -->|register_tracked_email| W["Worker (Hono)"]
    B["Scripts / Gmail / Resend / SES"] -->|POST /api/register| W
    W -->|tracked HTML| S["You send the email"]
    W -->|message + link map| DB[("D1")]
    S --> R["Recipient inbox"]
    R -->|pixel| PX["/p/:id.gif"]
    R -->|link| LK["/l/:id → 302"]
    PX --> CL{"Classify: UA + ASN + timing"}
    LK --> CL
    CL -->|classification + geo| DB
    DB --> DASH["Dashboard"]
    DB --> MCP["MCP read tools"]
```

## Data model

- **users** — `id, name, email, api_token, created_at`
- **messages** — `id, user_id, recipient, subject, campaign, agent_source, sent_at`
- **links** — `id, message_id, original_url` *(destinations stored server-side;
  the redirect never trusts a URL from the query string)*
- **events** — `id, message_id, link_id, type, ts, ua, ip, country, region, city,
  timezone, classification`
- **login_tokens** — single-use magic-link tokens

## Cost

Fits the Cloudflare **Workers Free** tier (100K requests/day, 5 GB D1) — each open
or click is one request. Past that, Workers Paid is $5/mo.

## Responsible use

Email tracking is a real privacy consideration, not a neutral one.

- Intended for **business correspondence you have a legitimate reason to send**,
  not surveillance of individuals.
- Many jurisdictions (GDPR/ePrivacy among them) expect disclosure that you track
  opens. A line in your privacy policy usually covers normal business outbound —
  **check what applies to you.**
- Recipients can defeat tracking by blocking remote images, and that's their right.
  Treat missing opens as missing data, not as a problem to engineer around.
- Don't use this for bulk unsolicited mail. Beyond being unpleasant, it will
  destroy the sending reputation of the domain you worked to build.

The classification system exists partly for this reason: honest numbers you can
act on beat inflated ones that flatter you.

## Development

```bash
npm run dev         # local worker
npm run typecheck   # tsc --noEmit
npm run deploy      # ship it
```

## License

MIT — see [LICENSE](LICENSE).
