# homesite-form-handler

Unified form handler for `contact.html` and `prequal.html`. Replaces the prior
direct-to-Web3Forms path with a Cloudflare Worker that handles email delivery
(via Resend) and HubSpot contact upsert in one pass.

## What it does

1. Validates the POST: same-origin (`homesitemortgage.online`), honeypot empty, required fields present.
2. Sends an HTML+text email to `tcloans1@gmail.com` with `brandonjculpepper@gmail.com` BCC'd, from `leads@homesitemortgage.online`. Body includes every submitted field, TCPA consent status, and the UTM / `ref` attribution.
3. Upserts a HubSpot contact (dedupe by email) with standard properties (`email`, `firstname`, `lastname`, `phone`) plus a `message` field that contains the full submission summary including attribution.
4. Redirects the browser to `/thank-you.html` on success.

## Failure semantics

| Failure | User-visible outcome | Lead delivered? |
| --- | --- | --- |
| HubSpot down or returns 4xx/5xx | Redirect to thank-you (success). Error logged to `wrangler tail`. | Yes — via email |
| Resend down or returns 4xx/5xx | Plain-text 502 response with phone fallback (`321-432-6611`) | Surfaced to user; never silently dropped |
| Origin/Referer mismatch | 403 Forbidden | No (rejected as untrusted source) |
| Honeypot non-empty | Pretend-success redirect | No (treated as bot) |

## Deploy

```bash
cd worker
wrangler deploy
```

## Secrets (set once per Cloudflare account)

```bash
wrangler secret put RESEND_API_KEY
wrangler secret put HUBSPOT_TOKEN
```

Already set per the brief 2026-05-19 confirmation:
- `RESEND_API_KEY` — Resend account with `homesitemortgage.online` domain verified
- `HUBSPOT_TOKEN` — HubSpot Service Key, scopes: `crm.objects.contacts.read`, `crm.objects.contacts.write`

## Privacy

- No persistent storage. No KV. No D1. No R2.
- NPI fields (income, credit score, debt, employment) pass through to email and HubSpot only — never written to disk on the Worker.
- Same-origin enforcement keeps the endpoint unusable from third-party pages without explicit re-allowlisting in `src/index.js`.

## Manual test (before flipping live forms)

```bash
curl -i -X POST https://homesite-form-handler.<ACCOUNT>.workers.dev/ \
  -H 'Origin: https://homesitemortgage.online' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'name=Test User' \
  --data-urlencode 'email=test+worker@example.com' \
  --data-urlencode 'phone=555-555-5555' \
  --data-urlencode 'message=Worker smoke test' \
  --data-urlencode 'tcpa_consent=on' \
  --data-urlencode 'utm_source=brandon' \
  --data-urlencode 'utm_medium=test' \
  --data-urlencode 'lead_source_page=contact'
```

Expected: `HTTP/2 303` with `location: https://homesitemortgage.online/thank-you.html`.
Email arrives at `tcloans1@gmail.com` within a few seconds, BCC at `brandonjculpepper@gmail.com`.
HubSpot contact `test+worker@example.com` is created/updated with `Source: contact` and the attribution lines in the `message` property.

## Rollback (within first week)

`contact.html` and `prequal.html` retain their Web3Forms hidden fields
(`access_key`, `subject`, `redirect`, `_cc`) as a documented unwired
fallback per the rollback plan in P1.6.2. To revert:

1. In each HTML file, change `<form action="..." method="POST">` back to `https://api.web3forms.com/submit`.
2. Remove or ignore the honeypot + UTM hidden inputs.
3. Web3Forms keeps working as it did pre-P1.6.2.

After one full week of confirmed stability on the Worker path, the
Web3Forms-only hidden fields should be removed in a separate
follow-up commit (task 1.6.3).
