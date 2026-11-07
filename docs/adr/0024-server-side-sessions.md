# ADR-0024: Server-side sessions in D1, with hashed tokens

- **Status:** Accepted
- **Date:** 2026-11-05

## Context

Staff (and, from Phase 5, customers) sign in with OpenID Connect. The plan (§4.3) keeps tokens away from browser JavaScript: the Worker runs the sign-in flow and gives the browser only a session cookie. The session store has to resist theft of the cookie, theft of the database, session fixation, and sessions left open on the shared counter tablet.

## Decision

- **Tables** (`migrations/0001_identity_sessions_audit.sql`): `users` (one row per person per directory, `UNIQUE (idp, idp_sub)`, roles restricted to the four app roles), `sessions`, and an **insert-only** `audit_log`: database triggers refuse UPDATE and DELETE.
- **Token:** 256 random bits, base64url. The browser holds it in one cookie, `__Host-bc_session` (`HttpOnly; Secure; SameSite=Lax; Path=/`). The database stores only its **SHA-256 hash**, so a copy of the table can't sign anyone in. A cookie that isn't exactly the token's shape is rejected without a lookup.
- **Rotation:** a new token at every sign-in; nothing from before sign-in is reused.
- **Lifetimes:** staff 8 hours absolute, 1 hour idle; customers 14 days absolute, 2 days idle. Each use slides the idle limit forward, never past the absolute one. Expired sessions are deleted when seen and by a scheduled purge. Register screens tighten idle to 15 minutes (Phase 3).
- **Role** is copied into the session at sign-in, so a role change takes effect at the next sign-in (the plan's "move a barista into shift leads and sign in again" test).
- **Revocation:** sign out one session, or every session for a person (incident response).
- **Tests run against a real local D1** through wrangler's `getPlatformProxy`; migrations are applied fresh on every run. No extra test dependency (the Workers Vitest pool wasn't needed, ADR-0015).

## Consequences

- Every authenticated request costs a D1 read and a small write (sliding the idle limit). Acceptable at this scale.
- The production D1 database is created with the owner during Phase 2 (ADR-0011); until then the session layer is built and tested but not wired into the deployed Worker.
