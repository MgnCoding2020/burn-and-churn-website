# ADR-0010: Deploys with Cloudflare Workers Builds

- **Status:** Accepted
- **Date:** 2026-11-02

## Context

Every branch needs a preview and `main` needs to deploy on merge, at no cost, without storing a Cloudflare credential in GitHub.

## Decision

Cloudflare's Git integration (Workers Builds) builds and deploys from the GitHub repository:

| Setting                          | Value                                                                                          |
| -------------------------------- | ---------------------------------------------------------------------------------------------- |
| Build command                    | `npm run build`                                                                                |
| Deploy command (`main`)          | `npx wrangler deploy`                                                                          |
| Preview command (other branches) | `npx wrangler preview` (open beta; supports preview-only secrets and config)                   |
| Build variable                   | `NODE_VERSION=22.23.4`                                                                         |
| API token                        | A dedicated token for this project ("burn-and-churn build token"), not shared with other sites |
| Cloudflare Access on previews    | Off: the site is public and previews will be scanned by ZAP                                    |

## Consequences

- No Cloudflare token exists in GitHub, so a compromised workflow can't deploy.
- Verified 2026-11-02: a merge to `main` was live in about 35 seconds; PR branches report a "Workers Builds" check.
- The first connection had to be made manually in the dashboard; until then pushes didn't build.
- `wrangler preview` is in open beta. If it changes, the fallback is `npx wrangler versions upload`.
- The token's name and creation date are kept in `docs/secrets-inventory.md`.
