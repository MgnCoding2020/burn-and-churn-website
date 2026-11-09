# Evidence: staff roles and the restock chain in production (2026-11-08 and 2026-11-09)

**Lab-verified 2026-11-08 and 2026-11-09.** Hub change record **CR-002** (steps 3 and 4); plan §4.4 and §5; ADR-0032, ADR-0033.

Michael signed in on the production site in Chrome (Incognito) as four fictional staff members, one at a time, setting up Authenticator MFA for each on first sign-in:

- Ethan Brooks (Barista);
- Mia Chen (Shift Lead);
- Daniel Lopez (Manager);
- Olivia Carter (Owner).

The screenshots are his, taken from the page content only. They show no address bar, email addresses, tenant domain or IDs, so they needed no redaction. Times are the store's time zone (America/New_York).

## Part 1: each role sees what its role allows (2026-11-08, about 8:13–8:24 PM)

This closes the Phase 2 check "one sign-in per remaining role" (evidence `../2026-11-07-staff-sign-in/`).

| File                                   | Shows                                                                                                                                                                                                                               | Control    |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `01-shift-lead-portal.png`             | Mia Chen, **Role: Shift Lead**: Register, Orders, Menu, Activity                                                                                                                                                                    | AC-3, IA-2 |
| `02-register-red-eye-sold-out.png`     | After Mia marked Red Eye sold out on the Menu screen, the register shows it greyed out with "Sold out"                                                                                                                              | AC-3       |
| `03-manager-portal.png`                | Daniel Lopez, **Role: Manager**                                                                                                                                                                                                     | AC-3, IA-2 |
| `04-restock-requested-old-flow.png`    | Daniel's restock request for Red Eye (the ADR-0032 flow, since replaced)                                                                                                                                                            | AU-2       |
| `05-manager-activity.png`              | Daniel's Activity: his own entries plus the Shift Lead's and the Barista's, nothing above his role                                                                                                                                  | AC-6, AU-6 |
| `06-owner-portal.png`                  | Olivia Carter, **Role: Owner**                                                                                                                                                                                                      | AC-3, IA-2 |
| `07-open-restock-request-old-flow.png` | Olivia sees Daniel's open request with a Done button                                                                                                                                                                                | AC-3       |
| `08-done-left-item-sold-out.png`       | **Finding:** after Done, Red Eye was still sold out and the request form came back, which read as if Done had marked it sold out again. Fixed in PR #35, then replaced by the restock chain (PR #36, ADR-0033) at Michael's request | —          |
| `09-barista-portal-no-menu.png`        | Ethan Brooks, **Role: Barista**: no Menu button (Menu was Shift Lead+ at the time; since PR #36 everyone can mark items sold out)                                                                                                   | AC-3, AC-6 |
| `10-barista-activity-own-only.png`     | Ethan's Activity: "Your own activity", his sign-ins only                                                                                                                                                                            | AC-6       |

## Part 2: the restock chain (2026-11-09, about 8:20–8:25 AM; ADR-0033)

Michael ran each step and reported every check as expected. He didn't take a screenshot of each step; these are the ones he took.

| File                               | Shows                                                                                                                                                                                                | Control  |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `11-barista-mark-and-undo.png`     | Ethan's Activity: marked Americano sold out, undid it (within 5 minutes), then marked Espresso sold out                                                                                              | AU-2     |
| `12-own-request-not-decidable.png` | As Daniel (Manager): Mia's Espresso request has Approve and Reject (with a reason). His own Red Eye request says "Your request: another manager or the owner decides it"                             | **AC-5** |
| `13-restock-history.png`           | Restock history: Espresso requested by Mia, decided by Daniel, received; Daniel's own Red Eye request still waiting. The 2026-11-08 rows have no decision because they came before the chain existed | AU-6     |

## Still open

- **The role-change test:** move a barista into a higher role and sign in again (plan §5). This needs group-based roles (Entra ID P1, Phase 7) or a manual reassignment by script.
- **The Entra assignment finding** from `../2026-11-07-staff-sign-in/`, still to investigate.
- **Phase 3's refund and cash checks** (PR #37, ADR-0034) are run separately.
