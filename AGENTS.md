# Wiring your agent stack to GrokBotTrack

GrokBotTrack tracks opens and clicks on outbound email. The rule for any agent that
sends mail: **register the email first, then send the HTML that register returns.**

Two ways to call it.

## Option A — MCP (for Claude agents / sessions)

The server is registered user-scope as `grokbottrack` and exposes four tools:

- `register_tracked_email(recipient, html, subject?, campaign?, agent_source?)`
  → returns `message_id` + `tracked_html`. **Send `tracked_html` verbatim** — it has
  the pixel injected and links rewritten. Modifying it breaks tracking.
- `list_recent_emails(limit?)` → recent emails with open/click counts.
- `get_email_status(message_id)` → full event timeline (opens/clicks, location,
  bot/proxy classification).
- `get_campaign_stats()` → open/click totals grouped by campaign.

Typical agent flow:
1. Draft the email HTML.
2. Call `register_tracked_email` with recipient, subject, and a `campaign` label.
3. Send the returned `tracked_html` via your mail tool (Gmail MCP, Resend, etc.).
4. Later, call `get_email_status` / `list_recent_emails` to see engagement.

## Option B — HTTP API (for non-Claude senders: Phantombuster, scripts, Resend flows)

Each user has a personal token (`dt_...`). Send it as `Authorization: Bearer <token>`.

```
POST https://grokbottrack.duvalsoftware.workers.dev/api/register
Authorization: Bearer dt_xxx
Content-Type: application/json

{ "recipient": "a@b.com", "subject": "...", "campaign": "q3-outbound",
  "agent_source": "phantombuster", "html": "<html>...</html>" }
```

Response: `{ message_id, pixel_url, links[], html }` — send `html` as the email body.

Read endpoints (same Bearer token):
- `GET /api/summary` — per-message rollup for the dashboard.
- `GET /api/messages/:id/events` — event timeline for one message.

## Notes

- **Per-user isolation:** the token identifies who is sending; each person's emails
  land in their own dashboard at `/app?token=<their token>`.
- **Onboarding a teammate:** admin calls
  `POST /api/admin/users` with header `x-admin-token: <ADMIN_TOKEN>` and body
  `{name, email}`; response includes their personal token + dashboard URL.
- **What counts:** a `confirmed_opens` figure excludes security scanners and Apple
  prefetches. Clicks (classification `human`) are the highest-confidence signal.
- **Geo:** reliable on clicks and on opens from direct-fetch clients; Gmail/Apple
  proxy the pixel so those opens have no real location (dashboard hides it).
- **Resend already has native open/click tracking** — the reason to route Resend
  sends through GrokBotTrack anyway is one unified dashboard across every sender.
