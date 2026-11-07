# ADR-0027: Staff sign-in flow

- **Status:** Accepted
- **Date:** 2026-11-07

## Context

The app `bc-website-staff` exists in the tenant (2026-11-07 evidence). The Worker now has to run the sign-in itself (plan §4.3) with oauth4webapi (ADR-0025) and turn a verified sign-in into a session (ADR-0024).

## Decision

- **Flow:** authorization code with PKCE (S256), `state` and `nonce`, `response_mode=query`, scope `openid profile`. `GET /api/v1/auth/staff/login` starts it; `GET /api/v1/auth/staff/callback` finishes it; `POST /api/v1/auth/staff/logout` ends the session.
- **Fixed endpoints, no discovery.** The app is single tenant, so the issuer and endpoints are built from the tenant ID; no discovery request runs on each sign-in.
- **Sign-in attempts in D1** (`oidc_logins`, migration 0002): the PKCE verifier and nonce are kept server-side, keyed by a hash of the state, deleted when used, and expire after 10 minutes. The state is also put in a short-lived `__Host-bc_login` cookie, so a callback only completes in the browser that started it (login CSRF).
- **Client authentication:** `private_key_jwt` with the certificate's key; the assertion carries the `x5t` thumbprint Entra uses to find the certificate. No client secret exists.
- **ID token checks.** oauth4webapi checks issuer, audience, expiry and nonce. The signature isn't checked separately: the token comes straight from Entra's token endpoint over TLS, which OpenID Connect Core §3.1.3.7 accepts in place of a signature check. The site then requires our tenant (`tid`), an object ID (`oid`, stored as the subject), and at least one staff app role (the highest wins).
- **Refusals** go to one plain page (`/staff/sign-in-problem/`) and are written to `audit_log` with a reason code (`no_login_cookie`, `unknown_or_expired_state`, `state_mismatch`, `authorization_error`, `token_error`, `wrong_tenant`, `no_object_id`, `no_staff_role`). No token or upstream error text is logged.
- **Switch user:** "Sign in as someone else" adds `prompt=login`, so the next person on the counter tablet must sign in to Entra afresh. Sign-out doesn't end the Entra session (accepted, threat model v1.2).
- **Off until configured:** without the D1 binding and all four `ENTRA_STAFF_*` values (each format-checked), the routes answer 503 and the site carries on. The production and preview databases are created with the owner next, and the footer's "Employee sign-in" links to `/staff/` only then.
- **First staff route:** `GET /api/v1/staff/me` (Barista and up) returns the signed-in name and role, as the authz-tested example for later staff routes.

## Consequences

- The whole flow, including the token request, is tested against a stand-in for Entra's token endpoint (`tests/api/staff-auth.test.ts`): what's sent (PKCE verifier, certificate assertion with `x5t`, no secret) and every refusal path. The live test with the tenant is Michael's (plan §5).
- One extra D1 write and delete per sign-in; negligible.
- The test databases are copied per test file so files can run in parallel (they were locking each other).
