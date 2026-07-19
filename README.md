# DuvalTrack

Internal email open/click tracking for the Duval Software agent stack — a
self-hosted alternative to services like mail-tracker.app, built as a single
Cloudflare Worker + D1 database. No Chrome extension, no per-seat SaaS fee.
Outbound mail is registered server-side at send time, so tracking works for
**anything that sends email** — Claude agents, Phantombuster sequences, Resend
flows, or plain scripts — all reporting into one dashboard.

**Live:** https://duvaltrack.duvalsoftware.workers.dev
**Dashboard:** `/app?token=<your dt_ token>`

---

## What it does

- **Open tracking** via an invisible 1×1 GIF pixel injected into the email HTML.
- **Click tracking** by rewriting every `<a href>` to a logging redirect (302 to
  the real URL). Clicks are the highest-confidence engagement signal.
- **Event classification** — every open/click is tagged `human`, `gmail-proxy`,
  `apple-prefetch`, or `scanner` so bots and mail-client prefetching don't inflate
  the numbers. `confirmed_opens` excludes the noise.
- **Geolocation** from Cloudflare's edge (`request.cf`): country / region / city /
  timezone on every event. Reliable on clicks and direct-fetch mail clients;
  hidden for Gmail/Apple proxied opens (they geolocate to the proxy, not the reader).
- **Multi-user** — each teammate has a personal `dt_` token; their sends land in
  their own isolated dashboard.
- **Per-recipient dashboard** — recipients ranked by last activity, with open/click
  counts, per-message rows, and an expandable event timeline showing when, where,
  and which link.
- **MCP server** — Claude sessions register and query tracking through four tools.

## Architecture

```mermaid
flowchart TD
    A[Claude agent - duvaltrack MCP] -->|register_tracked_email| W[duvaltrack Worker<br/>Hono on Cloudflare]
    B[Non-Claude senders<br/>Phantombuster / scripts / Resend] -->|POST /api/register - Bearer dt_| W
    W -->|tracked_html: pixel injected + links rewritten| S[Agent sends email]
    W -->|persist message + link map| DB[(D1: users / messages / links / events)]
    S --> R[Recipient inbox]
    R -->|open: GET /p/:id.gif| PX[Pixel route<br/>43-byte GIF, no-store]
    R -->|click: GET /l/:id| LK[Click route<br/>log then 302]
    PX --> CL{Classify<br/>UA + ASN + timing}
    LK --> CL
    W -.geo from request.cf.-> CL
    CL -->|human / gmail-proxy / apple-prefetch / scanner| DB
    DB --> API[Read API<br/>/api/summary + /api/messages/:id/events]
    API --> DASH[Dashboard /app?token=]
    DB --> MCP[MCP read tools]
    MCP --> A
```

## Routes

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/register` | Bearer `dt_` | Inject pixel + rewrite links, persist, return tracked HTML |
| `GET /p/:id.gif` | none | Log open, return 1×1 transparent GIF (`no-store`) |
| `GET /l/:id` | none | Log click, 302-redirect to the stored destination |
| `GET /api/summary` | Bearer `dt_` | Per-message rollup for the authed user |
| `GET /api/messages/:id/events` | Bearer `dt_` | Full event timeline for one message |
| `POST /api/admin/users` | `x-admin-token` | Onboard a teammate, mint their token |
| `POST /mcp` | Bearer `dt_` | MCP server (JSON-RPC): register + read tools |
| `GET /app` | token in URL/session | Self-contained dashboard SPA |

## Data model (D1)

- **users** — `id, name, email, api_token (dt_...), created_at`
- **messages** — `id, user_id, recipient, subject, campaign, agent_source, sent_at`
- **links** — `id, message_id, original_url` (destinations stored server-side; the
  redirect never trusts a URL from the query string)
- **events** — `id, message_id, link_id, type (open|click), ts, ua, ip, country,
  region, city, timezone, classification`

## Event classification

The logic that separates a real read from noise (`src/index.ts` → `classify()`):

| Signal | Classification | Counts as open? | Geo trustworthy? |
|---|---|---|---|
| Normal browser/client | `human` | ✅ | ✅ |
| `GoogleImageProxy` UA | `gmail-proxy` | ✅ | ❌ (Google DC) |
| Apple/iCloud ASN, <5 min after send | `apple-prefetch` | ❌ | ❌ |
| Datacenter ASN / scanner UA, <60 s after send | `scanner` | ❌ | ❌ |

`confirmed_opens` = `human` + `gmail-proxy`. Clicks are counted only when `human`.

## Integrating your senders

See [AGENTS.md](AGENTS.md) for the full contract. The one rule: **register first,
send the HTML that register returns, unmodified.**

- **Claude agents** → MCP tool `register_tracked_email`, then send `tracked_html`.
- **Everything else** → `POST /api/register` with a Bearer token, send the returned
  `html`.

## Deploy

```bash
npm install
npx wrangler d1 create duvaltrack          # once; put the id in wrangler.jsonc
npx wrangler d1 execute duvaltrack --remote --file schema.sql
npx wrangler secret put ADMIN_TOKEN        # onboarding secret
npx wrangler deploy
```

Onboard the first user:

```bash
curl -X POST https://duvaltrack.duvalsoftware.workers.dev/api/admin/users \
  -H "x-admin-token: $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"name":"Your Name","email":"you@duvalsoftware.com"}'
# → returns api_token + dashboard_url
```

## Stack

Cloudflare Workers · D1 (SQLite) · Hono · TypeScript · MCP (Streamable HTTP /
JSON-RPC 2.0). Comfortably inside the Workers Free tier (100K req/day, 5 GB D1)
for internal volume.

## Roadmap

- [ ] Custom tracking domain `go.duvalsoftware.com` (domain transfer to Cloudflare
      in progress) — deliverability + branded links.
- [ ] Magic-link login via Resend (pending Resend domain verification).
- [ ] First-confirmed-open notifications: Resend email + Loupedeck toast.

## Privacy / use

Internal, legitimate business outreach only. Tracking pixels warrant disclosure in
GDPR jurisdictions — a privacy-policy line covers standard internal outbound use.
