# Burn and Churn Coffee: website, staff portal and counter register

> **Burn and Churn Coffee is a fictional business.** This repository is a security portfolio project. Payments run in Stripe **test mode** only; no real orders are placed, no real money moves, and no real card or personal data is used.

Part of the Burn and Churn Coffee security program: [program hub](https://github.com/MgnCoding2020/grc-paper-project-coffee-shop). Company, people, systems and vendors are defined there.

---

## What this is

One web application for a fictional single-location café, serving two audiences:

| Audience      | What they get                                                                                                                   | Where                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| **Customers** | The café's site: menu, story, hours, order ahead, accounts, an AI order helper                                                  | Public pages, `/account/` |
| **Staff**     | A portal signed in with their work account: the counter register, the order board, the menu, shift notes, links to the intranet | `/staff/`                 |

It's where the program's separate pieces meet in one working system:

- **Identity:** staff sign in with Microsoft Entra ID; their portal role comes from the program's `grp-bc-*` groups. Customers use a separate Entra External ID directory.
- **Microsoft 365:** menu, store hours, announcements, shift notes and inventory are edited in SharePoint lists and published to the site through Microsoft Graph, with access limited to one site (`Sites.Selected`).
- **Payments:** Stripe Checkout online and Stripe Terminal at the counter (Stripe's simulated reader), both in test mode. Cash orders are recorded without a processor.
- **AI:** a read-only menu assistant with abuse and cost limits.
- **Security program:** every control is mapped to NIST SP 800-53 and produces evidence for the [program hub](https://github.com/MgnCoding2020/grc-paper-project-coffee-shop).

## Status

**In progress.** Phases 0 and 1 are done: the public site is live, with mobile Lighthouse Performance 97. Phase 2 is live: staff sign in with Microsoft Entra ID on the production site (first live sign-in 2026-11-07, [evidence](docs/evidence/2026-11-07-staff-sign-in/README.md)); tests of the remaining roles and one open finding are still to close. Nothing below is claimed as working until it's built, tested and evidenced in this repository with a date.

| Phase                              | What ships                                                                                              | Status                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 0. Foundations                     | Project skeleton on Cloudflare Workers, CI security checks, security headers, fictional-business banner | Done                         |
| 1. Design system and public site   | Brand tokens, styleguide, home, menu, info pages, error and maintenance pages                           | Done (cart moved to Phase 5) |
| 2. Staff sign-in                   | Entra ID sign-in, roles, sessions, audit log                                                            | Live (role tests to finish)  |
| 3. Register and order board        | Counter orders, cash, order board, sold out and restocks, refunds, cash count                           | Done                         |
| 4. Stripe Terminal                 | Card payments through the simulated reader, refunds                                                     | In progress                  |
| 5. Customers and Stripe Checkout   | Customer accounts, cart, online ordering, signed webhooks                                               | Planned                      |
| 6. Trial preparation               | Tenant scripts and test plan, dry-run only                                                              | Planned                      |
| 7. Microsoft 365 and SharePoint    | SharePoint site and lists, sync, Conditional Access, evidence                                           | Planned                      |
| 8. AI order helper                 | Read-only assistant with caps and prompt-injection tests                                                | Planned                      |
| 9. Hardening and program alignment | Scans, restore test, evidence rolled up to the hub                                                      | Planned                      |
| 10. Case study                     | Portfolio write-up, verified against the repos                                                          | Planned                      |

## Architecture (planned)

```
Browser ── HTTPS · HSTS · strict CSP
   ▼
Cloudflare Worker (one deploy)
  ├─ Astro pages: public · /account · /staff
  ├─ /api/v1 (Hono): validation · rate limits · CSRF check · role checks
  ├─ D1 (database) · R2 (menu images)
  └─ Scheduled jobs: SharePoint sync · nightly demo reset · session clean-up
        │                     │                         │
  Microsoft Entra ID   Microsoft Graph (SharePoint)   Stripe (test mode)
```

| Layer     | Choice                                                                       |
| --------- | ---------------------------------------------------------------------------- |
| Hosting   | Cloudflare Workers (free tier)                                               |
| Front end | Astro + TypeScript, Preact for interactive parts                             |
| API       | Hono at `/api/v1`                                                            |
| Data      | Cloudflare D1, R2 for images                                                 |
| Sign-in   | OpenID Connect with PKCE, run on the server (tokens never reach the browser) |
| Tests     | Vitest, Playwright, axe                                                      |

## Ground rules

- **Test mode only.** The site refuses to serve anything if a Stripe key isn't a test key. From Phase 4 it will also refuse a card reader that isn't Stripe's simulated one.
- **No secrets in the repository.** Real values live only in git-ignored files (below) and in Cloudflare's secret store.
- **No real people.** Staff are invented lab accounts from the hub's roster; customers are test accounts.
- **Not mistakable for a real business.** Every page carries the fictional-business banner and is excluded from search engines.

---

## Getting started

> Setup steps grow as each phase is built. Today: the public site (home, menu, information pages), staff sign-in and the staff portal, and a health check at `/api/v1/health`. Staff sign-in needs the Entra app first; see the [staff app runbook](docs/runbooks/entra-staff-app-registration.md). Without it, sign-in answers "not configured" and the rest of the site works.

### Quick start

```bash
npm ci                                  # install the exact locked dependencies
npx playwright install chromium         # one-time browser download for the browser tests
cp .dev.vars.example .dev.vars          # local Worker settings (see Configuration)
npm run check-env                       # confirms settings are valid and test-mode only
npm run dev                             # live-reloading dev server at http://localhost:4321
```

### Commands

| Command                        | What it does                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| `npm run dev`                  | Astro dev server with live reload (the strict CSP is relaxed here only, for the reload scripts) |
| `npm run build`                | Production build into `dist/`                                                                   |
| `npx wrangler dev --port 8787` | Runs the **built** Worker on Cloudflare's local runtime, exactly as deployed                    |
| `npm run check`                | Everything CI runs: environment check, type check, lint, formatting, unit and API tests         |
| `npm run e2e`                  | Browser tests (banner, headers, accessibility) against the built Worker, desktop and 360px      |
| `npm run check-env`            | Validates `.dev.vars` and `.env`; fails on a missing value or any non-test Stripe key           |
| `npm run format`               | Formats every file with Prettier                                                                |

### Prerequisites

| Tool                                                                                               | Version                         | Used for                                          |
| -------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------- |
| [Node.js](https://nodejs.org)                                                                      | 22.23.4 or newer (see `.nvmrc`) | Building and running the site                     |
| npm                                                                                                | Comes with Node.js              | Installing dependencies                           |
| Git                                                                                                | Any recent version              | Cloning                                           |
| [Stripe CLI](https://docs.stripe.com/stripe-cli)                                                   | Latest                          | Forwarding test webhooks locally (Phases 4 and 5) |
| [PowerShell 7](https://learn.microsoft.com/powershell/) and the Microsoft Graph module             | Latest                          | Tenant setup scripts (Phases 2, 6 and 7)          |
| OpenSSL (included with [Git for Windows](https://gitforwindows.org))                               | Any recent version              | Creating the staff sign-in certificate (Phase 2)  |
| A local clone of the [program hub](https://github.com/MgnCoding2020/grc-paper-project-coffee-shop) | `main`                          | The staff roster and user provisioning scripts    |

**Dependencies:** every JavaScript dependency is pinned to an exact version in `package.json` and `package-lock.json`. One command installs exactly the locked versions:

```bash
npm ci
```

Wrangler (Cloudflare's CLI) is a project dependency, so it's run with `npx wrangler` and doesn't need a global install.

### Configuration

Two git-ignored files hold every real value. Each has a committed example with placeholders and comments saying where each value comes from:

| Copy                | To          | Read by                      | Holds                                                                                                          |
| ------------------- | ----------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `.dev.vars.example` | `.dev.vars` | The Worker, when run locally | Sign-in app IDs and certificates, Stripe test keys, Graph credentials, Turnstile and AI keys                   |
| `.env.example`      | `.env`      | Setup scripts in `scripts/`  | Path to the hub clone, tenant ID and domain, the SharePoint site, the Stripe key used to create test resources |

```bash
cp .dev.vars.example .dev.vars
cp .env.example .env
```

For preview and production, the same Worker values are stored in Cloudflare instead of a file:

```bash
npx wrangler secret put STRIPE_API_KEY
```

What you need to create first, and where each value comes from:

| Value                                   | Where to get it                                                                    |
| --------------------------------------- | ---------------------------------------------------------------------------------- |
| Entra tenant ID and domain              | Microsoft Entra admin centre → Overview                                            |
| Staff and customer app client IDs       | Entra admin centre → App registrations, after the setup scripts create them        |
| Stripe test keys                        | Stripe Dashboard → Developers → API keys, **with Test mode on**                    |
| Stripe Terminal location and reader IDs | Printed by `scripts/stripe/setup-test.mjs` (Phase 4, not written yet)              |
| Stripe webhook secret                   | `stripe listen` (local) or the webhook endpoint in the Dashboard                   |
| Turnstile keys                          | Cloudflare dashboard → Turnstile (Cloudflare also publishes always-pass test keys) |

Never paste a live Stripe key (`sk_live_`, `rk_live_`) anywhere. The scripts and the app reject them.

---

## Documentation

| Document                                            | What it covers                                                                                                                      |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| [Architecture decision records](docs/adr/README.md) | Every significant decision, why it was made and what it costs                                                                       |
| [Threat model](docs/threat-model.md)                | STRIDE analysis of what's built, with the control and test evidence for each threat, accepted risks, and what each later phase adds |
| [Secrets inventory](docs/secrets-inventory.md)      | Every secret's name, location and rotation date (never values)                                                                      |
| [Runbooks](docs/runbooks/)                          | Step-by-step procedures: the staff sign-in app, maintenance mode                                                                    |
| [Evidence](docs/evidence/)                          | Dated results: Lighthouse runs, the Entra app, live staff sign-in, repository audits                                                |
| [Security policy](SECURITY.md)                      | How to report a vulnerability                                                                                                       |

---

## Related repositories

| Repository                                                                                      | Relationship                                                                                                          |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| [grc-paper-project-coffee-shop](https://github.com/MgnCoding2020/grc-paper-project-coffee-shop) | The program hub: policies, risks, controls, change records and evidence. The roster and tenant scripts come from here |
| [IAM-Access-Review-Lab](https://github.com/MgnCoding2020/IAM-Access-Review-Lab)                 | Access reviews that cover the `grp-bc-*` groups this site uses                                                        |
| [Vendor-Risk-Assessment-Lab](https://github.com/MgnCoding2020/Vendor-Risk-Assessment-Lab)       | Assessments of the vendors this site depends on                                                                       |

## Reporting a security issue

This is a portfolio project with no real users or data, but reports are welcome. Please open a private report through GitHub's **Security → Report a vulnerability** rather than a public issue.

## License

[MIT](LICENSE)

---

_This repository is a simulation for educational and portfolio purposes only. Burn and Churn Coffee, its staff and its customers are fictional._
