# Evidence: strict rate limits and the Publish page in production (2026-11-11)

**Lab-verified 2026-11-11.** Plan §9 "Abuse" (SC-5); ADR-0040 (strict rate limits), ADR-0039 (Publish from SharePoint); plan §4.4 (Publish is Manager+).

Michael checked the live site after PR #49 (SharePoint sync) and PR #50 (Durable Object limiter) were deployed. The checks used Chrome (Incognito) as Daniel Lopez (Manager, fictional), the Cloudflare dashboard, and Windows PowerShell.

**Redaction:** `03` had a hand-drawn scribble over the folder path in the PowerShell prompt, and the characters were still readable. The committed copy covers the whole prompt path with a solid box. The original stays outside the repo. The site address (`*.workers.dev`) is public. `01` and `02` show page content only.

| File                             | Shows                                                                                                                                                                                                                                                                                                                                                                                           | Control    |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `01-manager-publish-page.png`    | Daniel (Role: Manager) sees **Publish** in the portal navigation and the Publish page. It says publishing from SharePoint **isn't set up in this environment**, so every list shows "not synced yet (built-in copy)" and there are no syncs yet. That's correct before trial day: the Graph secrets are added on 2026-11-14 (`docs/tenant-setup.md`)                                            | AC-3, AC-6 |
| `02-durable-object-listed.png`   | Cloudflare dashboard → Durable Objects: **`RateLimiterDO`** bound to `burn-and-churn-website` twice, once for production and once for the preview, which gets its own copy (ADR-0040). SQLite storage class, **0 B stored**: the counter keeps nothing in storage                                                                                                                               | SC-5       |
| `03-production-429-after-20.png` | 25 sign-in starts against production from one address: **20 × `302`** (sent on to Microsoft sign-in), then **5 × `429`** (too many requests). Before PR #50, production never returned 429 (ADR-0029's verification table), because Cloudflare's own limiter doesn't enforce on this account ([cloudflare/developer-platform#123](https://github.com/cloudflare/developer-platform/issues/123)) | **SC-5**   |

**What it proves:**

- The strict limit works in production: 20 sign-in starts a minute per address, refused after that.
- The Publish page is live for a Manager.

Not checked in this evidence:

- **A Barista not seeing Publish.** It's covered by the staff-layout browser test and the route test (`tests/api/staff-sharepoint.test.ts`).
- **The `payments` and `publish` limits.** Their tests are `tests/api/strict-limit.test.ts`.
