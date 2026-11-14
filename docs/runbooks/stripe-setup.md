# Runbook: Stripe set-up (test mode)

For Michael. ADR-0035. **Test mode only:** if the Dashboard's Test mode toggle is off, stop. Never paste a key into a chat, an issue or a file other than `.dev.vars`.

## 1. The Worker key (done 2026-11-09)

Restricted key `bc-website-worker-test` (`rk_test_`). Its permissions are listed in ADR-0035. It's saved in local `.dev.vars` as `STRIPE_API_KEY`.

## 2. One-time set-up: location, simulated reader, webhook

1. In the Dashboard (Test mode): **Developers → API keys → Create restricted key → Custom permissions**.
   - Name it `bc-website-setup-once`.
   - Set **Write** on: **Terminal Locations**, **Terminal Readers**, **Webhook Endpoints**.
   - Leave everything else on **None**.
   - Don't save the key anywhere; you paste it into the script in step 3.
2. In your VS Code terminal, run `npx wrangler login`. The script saves the webhook secret straight into Cloudflare, so it needs this sign-in.
3. Run a dry run first:
   ```
   node scripts/stripe/setup-test.mjs --dry-run
   ```
   Paste the set-up key at the hidden prompt (nothing appears as you paste). It lists what exists and changes nothing.
4. Run it for real:
   ```
   node scripts/stripe/setup-test.mjs
   ```
   - It creates the location, the simulated reader and the webhook endpoint.
   - Answer **Y** when it asks to save the signing secret. It goes straight to the production Worker and is never shown.
   - It prints the location and reader IDs (not secret) and saves a record in `scripts/stripe/logs/`.
5. Add the two IDs:
   - **To the production Worker**, as secrets, so deploys keep them. Paste each ID at the prompt:
     ```
     npx wrangler secret put STRIPE_TERMINAL_LOCATION_ID
     npx wrangler secret put STRIPE_TERMINAL_READER_ID
     ```
   - **To `.dev.vars`**, as two lines:
     ```
     STRIPE_TERMINAL_LOCATION_ID=tml_...
     STRIPE_TERMINAL_READER_ID=tmr_...
     ```
6. **Delete the set-up key:** Developers → API keys → `bc-website-setup-once` → ⋯ → **Delete**.
7. Run `npx wrangler logout`.

Running the script again is safe: it finds what exists and creates nothing twice. Stripe shows the webhook's signing secret only once, at creation. If it's ever needed again, roll it in the Dashboard (**Developers → Webhooks → the endpoint → Roll secret**), then set it with `npx wrangler secret put STRIPE_WEBHOOK_SECRET`.

## 3. When Phase 4's code is merged

Set the Worker key on production. Paste it at the prompt (from your password manager, or from `.dev.vars`), and never into a chat:

```
npx wrangler secret put STRIPE_API_KEY
```

## 3a. Online orders (Phase 5, ADR-0044): add the Checkout events

The webhook endpoint needs two more events: `checkout.session.completed` and `checkout.session.expired`. Re-run the set-up script; it finds the endpoint and adds what's missing:

1. Create the one-time key again (step 2.1 above: **Write** on Terminal Locations, Terminal Readers and Webhook Endpoints).
2. Run `npx wrangler login`, then `node scripts/stripe/setup-test.mjs --dry-run`, and paste the key. It should say the endpoint exists and list the two events as missing.
3. Run `node scripts/stripe/setup-test.mjs` for real: the endpoint is updated. The signing secret doesn't change, so there's nothing to save.
4. Delete the one-time key, then run `npx wrangler logout`.

Locally, no webhook is needed: after you pay, the order status page asks Stripe directly.

## 4. Local webhooks (optional, for testing on your laptop)

Stripe can't reach `localhost`, so the Stripe CLI forwards events:

1. Install the CLI: `npm install -g @stripe/cli`, or the installer from Stripe's docs.
2. Run `stripe login` (in the browser, test mode).
3. Start forwarding:
   ```
   stripe listen --forward-to localhost:8787/api/v1/webhooks/stripe
   ```
   It prints a `whsec_...` secret for this local session. Put it in `.dev.vars` as `STRIPE_WEBHOOK_SECRET`. It's different from production's.

## Undo

- **Terminal → Locations:** delete the reader, then the location.
- **Developers → Webhooks:** delete the endpoint.
- **Then:** `npx wrangler secret delete STRIPE_WEBHOOK_SECRET`.
