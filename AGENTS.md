# Wiring your agent or sender to MailTrackMCP

MailTrackMCP tracks opens and clicks on outbound email. One rule governs every
integration:

> **Register the email first, then send the HTML that `register` returns —
> unmodified.** It already contains the tracking pixel and rewritten links.
> Editing it breaks tracking.

Replace `<your-worker>` below with your deployment's host (for example
`mailtrackmcp.your-subdomain.workers.dev`, or your custom tracking domain).

---

## Option A — MCP (for Claude, Cursor, OpenClaw, and other MCP agents)

### Connect

```json
{
  "mcpServers": {
    "mailtrackmcp": {
      "type": "http",
      "url": "https://<your-worker>/mcp",
      "headers": { "Authorization": "Bearer dt_YOUR_TOKEN" }
    }
  }
}
```

If your client can only launch stdio servers, bridge it:

```json
{
  "mcpServers": {
    "mailtrackmcp": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://<your-worker>/mcp",
               "--transport", "http",
               "--header", "Authorization: Bearer dt_YOUR_TOKEN"]
    }
  }
}
```

Verify before wiring it in — this should list four tools:

```bash
curl -s -X POST https://<your-worker>/mcp \
  -H "Authorization: Bearer dt_YOUR_TOKEN" \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

### Tools

| Tool | Arguments | Returns |
|---|---|---|
| `register_tracked_email` | `recipient`, `html`, `subject?`, `campaign?`, `agent_source?` | `message_id`, `tracked_html` (send this verbatim), `links[]` |
| `list_recent_emails` | `limit?` (default 50) | Recent sends with `confirmed_opens`, `raw_opens`, `clicks`, `last_human_activity` |
| `get_email_status` | `message_id` | Full event timeline: type, timestamp, location, classification |
| `get_campaign_stats` | — | Per-campaign `emails`, `recipients`, `confirmed_opens`, `clicks` |

### Typical flow

1. Draft the email HTML.
2. `register_tracked_email` with `recipient`, `subject`, a `campaign` label, and
   `agent_source` naming your system.
3. Send the returned `tracked_html` through your mail tool.
4. Later, call `list_recent_emails` or `get_email_status` to report engagement.

---

## Option B — HTTP API (for scripts, n8n, Zapier, SES, Resend, anything else)

```bash
curl -X POST https://<your-worker>/api/register \
  -H "Authorization: Bearer dt_YOUR_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "recipient": "them@company.com",
    "subject": "Quick question",
    "campaign": "q4-outbound",
    "agent_source": "n8n",
    "html": "<html><body><p>Hi — see the <a href=\"https://example.com/demo\">demo</a>.</p></body></html>"
  }'
```

Response — send the `html` field as the email body:

```json
{
  "message_id": "abc123",
  "pixel_url": "https://<your-worker>/p/abc123.gif",
  "links": [{ "id": "...", "original_url": "...", "tracked_url": "..." }],
  "html": "<...tracked HTML — SEND THIS...>"
}
```

Read endpoints use the same Bearer token:

- `GET /api/summary` — per-message rollup
- `GET /api/messages/:id/events` — event timeline for one message

---

## Any sender works

Nothing here is Gmail-specific. The pixel and rewritten links live in the HTML
body, so any transport that sends HTML can carry them — SMTP, Outlook/Microsoft
365 (Graph or SMTP), Gmail, Resend, SES, Postmark, Mailgun, SendGrid, n8n,
Zapier, or your own backend. Register first, send the returned HTML as the
`text/html` part.

Gmail gets its own section below only because its review-card and draft
behaviour needs explaining — not because it is required.

## Sending through Gmail

The Gmail MCP exposes `create_draft` with an `htmlBody` field but no send tool,
which makes this a natural review gate:

1. Register the email.
2. Create a Gmail draft with `tracked_html` as `htmlBody`.
3. The human reviews it in Gmail and hits Send.

With your own Gmail API credentials you can skip the draft: register, build an
RFC822 MIME message with the tracked HTML as the `text/html` part, base64url
encode it, then call `users.messages.send`.

---

## Agents with an email review card ("Send Tracked")

Some agents show the user a review card before sending (Grok Bot and several
mail assistants work this way).
**These cards typically render only visible, plain formatting — they strip
images and hidden elements, so the tracking pixel does not survive the card.**
Rewritten links do survive, so clicks still track, but opens are lost.

The workaround is to bypass the card for tracked sends:

1. The user reviews the draft on the card as normal.
2. Instead of pressing **Send**, they reply **`send tracked`** in chat.
3. The agent takes the reviewed text **verbatim**, appends the rich HTML
   signature for the sending account, registers it, and sends the returned HTML
   itself through the Gmail connector as `htmlBody`.
4. The agent confirms it sent, and reminds the user **not** to also press Send
   on the card — that would deliver a second, untracked copy.

Grant this as a standing permission so it works in future chats:

> Standing permission: when I reply "send tracked" to an email draft card I have
> reviewed, register that exact email with MailTrackMCP and send the returned
> tracked HTML from the matching Gmail account. Append my rich HTML signature
> first. If registration fails, do not send.

**Signatures:** the card appends the account's Gmail signature on its own, so a
normal card send should end with no signature block. On a `send tracked` send
the card is bypassed, so the agent must append the signature itself — otherwise
you get either none or two.

**Replies:** pass the original message id so the email stays in its thread.

## Rules that matter

1. **Send the returned HTML unmodified.** Any edit can break the pixel or links.
2. **If `register` fails, do not send untracked.** Abort and queue or report.
3. **Always set `campaign` and `agent_source`.** They are what make
   `get_campaign_stats` comparable across every tool you send from.
4. **Don't enable your ESP's own open/click tracking as well.** MailTrackMCP
   already injects a pixel and rewrites links; running both double-counts
   events and rewrites links twice.
5. **Plain-text parts are not tracked.** The pixel and rewritten links live only
   in the HTML part. Prefer HTML-only, or accept that plain-text-only readers
   go untracked.
6. **Gmail sending limits** — Google Workspace caps around 2,000 recipients/day
   and API sends count toward it. Route bulk sequences through a dedicated ESP.

## Getting notified in real time (webhooks)

Rather than polling, have engagement pushed to you. Set a webhook on your
account and every genuine open or click POSTs to it immediately:

```bash
curl -X PUT https://<your-worker>/api/webhook \
  -H "Authorization: Bearer dt_YOUR_TOKEN" \
  -H "content-type: application/json" \
  -d '{"webhook_url":"https://your-agent/hooks/email","webhook_secret":"a-long-random-string"}'

# fire a sample payload at it to check your receiver
curl -X POST https://<your-worker>/api/webhook/test -H "Authorization: Bearer dt_YOUR_TOKEN"
```

Payload:

```json
{
  "event": "open",
  "message_id": "abc123",
  "recipient": "them@company.com",
  "subject": "Quick question",
  "campaign": "q4-outbound",
  "agent_source": "your-agent",
  "sent_at": "2026-10-29T20:00:00.000Z",
  "occurred_at": "2026-10-29T20:14:03.000Z",
  "classification": "human",
  "is_confirmed": true,
  "is_first_engagement": true,
  "open_count": 1,
  "click_count": 0,
  "location": { "city": "Austin", "region": "Texas", "country": "US", "timezone": "America/Chicago" },
  "link_url": "https://example.com/demo"
}
```

- **Only genuine engagement fires.** `sender-echo`, `apple-prefetch` and
  `scanner` events never produce a webhook.
- **`location` is `null` for proxied opens**, with a `location_note` explaining
  why — so a receiver can't mistake Google's datacenter for the prospect.
- **`open_count` / `click_count`** are running totals for that message. A third
  open is a much stronger signal than a first.
- **Verify the signature.** If you set a secret, each request carries
  `X-MailTrack-Signature: sha256=<hex>` — an HMAC-SHA256 of the raw body.
  Check it, or anyone who learns your URL can forge events.
- Set `WEBHOOK_EVENTS=first` to fire only on first engagement per message.

**Receiver requires its own Authorization header?** Store the key and declare
the scheme, so you never have to get a prefix right at a masked prompt:

```bash
npx wrangler secret put WEBHOOK_AUTH          # paste the bare key
```

```jsonc
"vars": {
  "WEBHOOK_AUTH_SCHEME": "Bearer",            // prepended if not already present
  "WEBHOOK_AUTH_HOST": "api.your-receiver.com" // header sent to this host ONLY
}
```

`WEBHOOK_AUTH_HOST` is important on a multi-user instance: without it the
credential would be sent to whatever webhook URL any user configures, handing
your key to an endpoint of their choosing.

`POST /api/webhook/test` returns an `auth_shape` object describing the
configured header (length, scheme, whether it carries stray whitespace) without
revealing the key — use it to diagnose 401s from a receiver.

## Reporting results honestly

Every event carries a classification. When summarising for a human:

- `human` — real person. Location is trustworthy.
- `gmail-proxy` — a real open, but Gmail fetched the pixel. **Do not report the
  location**; it is Google's datacenter, not the reader's.
- `sender-echo` — a proxied open within the self-open window; attributed to the
  sender re-reading their own copy. Not a recipient open.
- `apple-prefetch` / `scanner` — automated fetches. Not opens.

`confirmed_opens` = `human` + `gmail-proxy`. Clicks count only when `human`.
A human **click** is the strongest signal available — it proves a person acted.
