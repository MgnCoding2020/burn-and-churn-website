# Secrets inventory

Names, locations and dates only. **Never values.** Updated in the same PR that adds, rotates or removes a secret (IA-5, SC-12).

| Secret                                                      | Where it lives                                                                                                                                                                                  | Used by                                                                                    | Created    | Last rotated | Rotate by                            |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------- | ------------ | ------------------------------------ |
| Cloudflare API token "burn-and-churn build token"           | Cloudflare (Workers Builds settings)                                                                                                                                                            | Workers Builds deploys of this project only                                                | 2026-11-02 | —            | 2027-11-02                           |
| Entra certificate `CN=bc-website-staff` (private key)       | Owner's laptop, `Documents\burn-and-churn-secrets\` (outside the repo), local `.dev.vars`, and the production Worker secrets (set 2026-11-07; previews have none)                               | Staff sign-in (`private_key_jwt`), app `bc-website-staff`                                  | 2026-11-07 | —            | 2027-11-07 (expires)                 |
| Entra certificate `CN=bc-website-customers` (private key)   | Owner's laptop, `Documents\burn-and-churn-secrets\` (outside the repo) and local `.dev.vars`, once `setup-customer-app.ps1` makes it; production Worker secrets when customer sign-in goes live | Customer sign-in (`private_key_jwt`), app `bc-website-customers` in the customer directory | Pending    | —            | One year after creation (expires)    |
| Stripe restricted key `bc-website-worker-test` (`rk_test_`) | Local `.dev.vars` (`STRIPE_API_KEY`) and the production Worker secret (set 2026-11-09)                                                                                                          | The Worker's Stripe calls (ADR-0035 lists its permissions)                                 | 2026-11-09 | —            | 2027-11-09 (yearly)                  |
| Stripe webhook signing secret (production endpoint)         | Production Worker secret `STRIPE_WEBHOOK_SECRET`, set by `scripts/stripe/setup-test.mjs` without being shown (2026-11-09)                                                                       | Verifying Stripe webhooks                                                                  | 2026-11-09 | —            | 2027-11-09 (yearly), or on suspicion |
| Stripe set-up key `bc-website-setup-once` (`rk_test_`)      | Nowhere: typed at the script's hidden prompt; **deleted 2026-11-09** after one run                                                                                                              | `scripts/stripe/setup-test.mjs`                                                            | 2026-11-09 | —            | Deleted 2026-11-09                   |

The production Worker also holds `STRIPE_TERMINAL_LOCATION_ID` and `STRIPE_TERMINAL_READER_ID` as secrets (set 2026-11-09): IDs, not secret, but secrets survive deploys. It also holds `ENTRA_STAFF_TENANT_ID`, `ENTRA_STAFF_CLIENT_ID` and `ENTRA_STAFF_CERT_THUMBPRINT` as secrets (set 2026-11-07). They aren't secret in themselves; keeping them out of `wrangler.jsonc` keeps the tenant out of the public repo.

**Retired:** the Stripe test secret key (`sk_test_`) pasted into a chat on 2026-11-09 was expired in the Dashboard the same day; nothing uses a full secret key.

The owner's `wrangler login` (an OAuth token on the laptop) was used to create the D1 databases and set those secrets on 2026-11-07, then revoked with `wrangler logout` the same day.

**Not secrets, listed for clarity:** `APP_ENV` (a plain variable in `wrangler.jsonc`), `NODE_VERSION` (a Workers Builds build variable).

**Local only, never committed:** `.dev.vars` and `.env` on the developer's laptop hold local values; their templates (`.dev.vars.example`, `.env.example`) list every name with placeholders.

## Planned

| Secret                                              | Phase | Where it will live                      |
| --------------------------------------------------- | ----- | --------------------------------------- |
| Stripe restricted test key, webhook signing secrets | 4–5   | Worker secrets, one set per environment |
| Graph certificate (`Sites.Selected`)                | 7     | Worker secret                           |
| AI provider key                                     | 8     | Worker secret                           |
