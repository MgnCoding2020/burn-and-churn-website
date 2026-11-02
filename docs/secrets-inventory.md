# Secrets inventory

Names, locations and dates only. **Never values.** Updated in the same PR that adds, rotates or removes a secret (IA-5, SC-12).

| Secret                                            | Where it lives                       | Used by                                     | Created    | Last rotated | Rotate by  |
| ------------------------------------------------- | ------------------------------------ | ------------------------------------------- | ---------- | ------------ | ---------- |
| Cloudflare API token "burn-and-churn build token" | Cloudflare (Workers Builds settings) | Workers Builds deploys of this project only | 2026-11-02 | —            | 2027-11-02 |

**Not secrets, listed for clarity:** `APP_ENV` (a plain variable in `wrangler.jsonc`), `NODE_VERSION` (a Workers Builds build variable).

**Local only, never committed:** `.dev.vars` and `.env` on the developer's laptop hold local values; their templates (`.dev.vars.example`, `.env.example`) list every name with placeholders.

## Planned

| Secret                                              | Phase | Where it will live                      |
| --------------------------------------------------- | ----- | --------------------------------------- |
| Entra certificate (staff app `bc-website-staff`)    | 2     | Worker secret                           |
| Stripe restricted test key, webhook signing secrets | 4–5   | Worker secrets, one set per environment |
| Entra External ID client secret (customer app)      | 5     | Worker secret                           |
| Graph certificate (`Sites.Selected`)                | 7     | Worker secret                           |
| AI provider key                                     | 8     | Worker secret                           |
