# ADR-0030: No anonymous request writes to the database

- **Status:** Accepted
- **Date:** 2026-11-07
- **Supersedes:** in ADR-0027, "Sign-in attempts in D1" and "Refusals ... are written to `audit_log`"

## Context

The repository audit of 2026-11-07 found that anyone could make the site write to D1 without signing in. Starting a staff sign-in stored a row in `oidc_logins`, and every refused callback wrote an `audit_log` row. A script could use up the Workers Free plan's 100,000 daily row writes and stop staff sign-in until midnight UTC. Cloudflare's Rate Limiting binding was the chosen fix (ADR-0029), but on this account it doesn't enforce today ([workers-sdk #16097](https://github.com/cloudflare/workers-sdk/issues/16097)). Michael chose to remove the writes instead (2026-11-07).

## Decision

**Rule: a request writes to D1 only after Entra has vouched for a real account, or for a signed-in session.**

- **The sign-in attempt lives in the browser.** `__Host-bc_login` now holds the state, PKCE code verifier, nonce and expiry, sealed with AES-256-GCM (`src/lib/login-cookie.ts`). The browser can't read or change it; a changed byte fails authentication. The cookie expires after 10 minutes, and the expiry inside it is also checked.
- **Its key comes from the certificate already in place.** HKDF-SHA-256 over the staff app's private key, with a purpose label (`staff-login-cookie-v1`), gives a separate AES key. There's no extra secret to create, store or forget to set. Rotating the certificate rotates this key; sign-ins in progress at that moment fail and are simply retried.
- **Replay protection moves to Entra.** The old design deleted the D1 row on use. Now a replayed callback reaches the token request, and Entra refuses it: authorization codes are single-use (RFC 6749 §4.1.2) and bound to this attempt's PKCE verifier. The cookie is also cleared after use.
- **Refusals are split by who caused them:**
  - **Before Entra vouched for anyone** (`no_login_cookie`, `bad_login_cookie`, `expired_login`, `state_mismatch`, `authorization_error`, `token_error`): one warning line in the request log, with the reason and request ID. Anyone can cause these, so they cost no database writes. The logs are kept for 3 days (ADR-0021).
  - **After Entra issued a valid token for a real account** (`wrong_tenant`, `no_object_id`, `no_staff_role`): written to `audit_log` as before. These need a real account in a real tenant, so they can't be mass-produced.
- **Other public routes already followed the rule.** Sign-out audits only a real session, and the session layer only reads for unknown cookies.
- **`oidc_logins` is no longer used.** It's left in place, empty, so this change needs no production migration. The hourly clean-up still clears it, and a later migration drops it.

## Consequences

- Flooding the public routes now costs Workers requests only, which Cloudflare's network protection covers, not D1 writes. The rate limiter (ADR-0029) stays in the code for when Cloudflare fixes the binding.
- Refusals before identification are kept for 3 days in Workers Logs instead of permanently in `audit_log`. They carry no actor, so the audit log gains nothing from them.
- Tests (`tests/api/staff-auth.test.ts`, `tests/unit/login-cookie.test.ts`):
  - starting sign-ins and every anonymous refusal leave all four tables unchanged;
  - tampered, foreign-key and expired cookies are refused;
  - a replayed callback fails at the token request, like Entra;
  - identified refusals are still audited.
