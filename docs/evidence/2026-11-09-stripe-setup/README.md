# Evidence: Stripe test-mode set-up (2026-11-09)

**Lab-verified 2026-11-09.** Hub change record **CR-002** (step 5); ADR-0035; runbook `docs/runbooks/stripe-setup.md`.

Michael ran `scripts/stripe/setup-test.mjs` in his own terminal at 21:29 UTC, with a one-time restricted key (`bc-website-setup-once`) typed at a hidden prompt. He then deleted that key in the Dashboard. `setup-record.json` is the script's own record: IDs only, which aren't secret. The webhook's signing secret isn't in it, because the script piped it straight into the production Worker without displaying it.

| What              | Value                                                                                                              | Control     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ | ----------- |
| Terminal location | `tml_Gu7ugxaeEouzSU`, fictional address, visible only in the Stripe Dashboard                                      | CM-8        |
| Reader            | `tmr_Gu7ugbpHD5YjUe`, **`simulated_wisepos_e`** (no hardware; the script refuses a non-simulated reader)           | CM-7, SA-9  |
| Webhook endpoint  | Production URL only, the 8 events counter payments and refunds need, API version pinned                            | SC-8, SI-10 |
| Signing secret    | Saved to the production Worker by the script, never shown                                                          | IA-5, SC-12 |
| Worker key        | `bc-website-worker-test` (restricted, custom permissions) set as the production secret `STRIPE_API_KEY` by Michael | AC-6, IA-5  |

**Checked afterwards (2026-11-09, from outside):**

- an unsigned call to the production webhook was refused with **400**;
- so was one with a forged signature, also **400**.

Before the set-up, the same calls gave 503 (no secret), so the endpoint now verifies every event. `/api/v1/health` reported production, OK.

**Then, against Stripe's real test API** (local key and the same simulated reader, ADR-0036):

- an approved tap became a paid order;
- a declined tap returned `generic_decline`;
- cancelling worked.

This confirms the restricted key has every permission the register needs, including the test helper.
