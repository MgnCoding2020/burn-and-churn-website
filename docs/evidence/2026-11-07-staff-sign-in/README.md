# Evidence: staff sign-in works in production (2026-11-07)

**Lab-verified 2026-11-07.** Hub change record **CR-002**; plan §4.1 and §5; ADR-0027. Michael signed in on the production site in Chrome (Incognito) as the fictional barista Ethan Brooks.

Redaction: request IDs, IP addresses and the tenant domain in user principal names are covered with solid boxes. The browser's bookmarks bar is cropped out. The Microsoft resource IDs shown (Graph, Azure Portal, Azure Resource Manager) are Microsoft's public, well-known app IDs.

| File                                 | Shows                                                                                                                                                                                                                             | Control    |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `01-portal-signed-in-production.png` | The production `/staff/` page after sign-in: the name from Entra, **Role: Barista** (from the app role in the token), the TEST MODE badge, sign-out, and the 8-hour / 1-hour session limits                                       | IA-2, AC-3 |
| `02-entra-sign-in-logs.png`          | Entra's sign-in log for the tenant (last 24 hours, UTC). Ethan Brooks to `bc-website-staff`: "Interrupted" (first sign-in, MFA set-up) then "Success". Conditional Access "Not applied": no policies yet (Entra ID Free, Phase 7) | AU-2, IA-2 |
| `03-entra-audit-log.png`             | Entra's audit log (Application Management): the app's creation by script, its certificate, its service principal and the `openid`/`profile` consent grant, matching `../2026-11-07-entra-staff-app/setup-staff-app-log.csv`       | AU-3, CM-3 |

**What the screenshots don't prove yet:**

- The Ethan rows in `02` are from the local test (`wrangler dev`, about 19:55 UTC). The production sign-in came later and doesn't appear in the interactive view, likely because Entra reused the existing session (non-interactive tab) or because the log hadn't caught up. To be confirmed.
- **Open finding:** the rows for the tenant owner's own account to `bc-website-staff` (19:48–19:49 UTC) show **Success**, although that account has no app role and the app has Assignment required = Yes. Entra issued a token; this site then refused the account itself (`no_staff_role`). So the site's role check held, but Entra's assignment check didn't stop the account. Next step: check the enterprise app's "Users and groups" for an assignment to that account (for example a default-access assignment with no role), and repeat the test with a plain staff account that has no role.
- `03` also shows several "Add service principal" failures (`SpnValidationException`) at 1:45 PM and 2:18 PM local time. They haven't been explained yet; they will be looked into with the open finding.
- Still to test: one sign-in per remaining role (Shift Lead, Manager, Owner) and the role change from Barista to Shift Lead (plan §5).
