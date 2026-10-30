# Wiring your agent or sender to GrokBotTrack

GrokBotTrack tracks opens and clicks on outbound email. One rule governs every
integration:

> **Register the email first, then send the HTML that `register` returns —
> unmodified.** It already contains the tracking pixel and rewritten links.
> Editing it breaks tracking.

Replace `<your-worker>` below with your deployment's host (for example
`grokbottrack.your-subdomain.workers.dev`, or your custom tracking domain).

---

## Option A — MCP (for Claude, Cursor, OpenClaw, and other MCP agents)

### Connect

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

If your client can only launch stdio servers, bridge it:

```json
{
  "mcpServers": {
    "grokbottrack": {
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

## Rules that matter

1. **Send the returned HTML unmodified.** Any edit can break the pixel or links.
2. **If `register` fails, do not send untracked.** Abort and queue or report.
3. **Always set `campaign` and `agent_source`.** They are what make
   `get_campaign_stats` comparable across every tool you send from.
4. **Don't enable your ESP's own open/click tracking as well.** GrokBotTrack
   already injects a pixel and rewrites links; running both double-counts
   events and rewrites links twice.
5. **Plain-text parts are not tracked.** The pixel and rewritten links live only
   in the HTML part. Prefer HTML-only, or accept that plain-text-only readers
   go untracked.
6. **Gmail sending limits** — Google Workspace caps around 2,000 recipients/day
   and API sends count toward it. Route bulk sequences through a dedicated ESP.

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
