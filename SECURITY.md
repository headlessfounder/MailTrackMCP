# Security

## Reporting a vulnerability

Please open a private security advisory on the repository rather than a public
issue.

## What this software does

GrokBotTrack embeds a tracking pixel and rewrites links in outbound email, then
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
  `X-GrokBotTrack-Signature: sha256=<hex>` over the raw body. Verify it —
  otherwise anyone who learns your endpoint URL can forge events.
- **Tracking ids are 14 random characters** from a 62-character alphabet
  (~83 bits), so message ids are not guessable or enumerable.

## Known limitations

- **An authenticated user can register a link to any URL**, which makes your
  tracking domain a redirector for that user. This is inherent to click
  tracking. Only issue tokens to people you trust.
- **Open tracking is best-effort.** Recipients who block remote images are not
  tracked, and that is their prerogative. Treat missing opens as missing data.
- **Proxied opens reveal nothing about location.** The system marks these rather
  than guessing; do not report proxy geography as the reader's.
