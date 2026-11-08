# ADR-0028: Session timeout warning and scheduled clean-up

- **Status:** Accepted
- **Date:** 2026-11-07

## Context

Staff sessions end after 1 hour without use or 8 hours in all (ADR-0024). Until now the end came without notice: the next click led back to Microsoft's sign-in. WCAG 2.2 success criterion 2.2.1 (Timing Adjustable, level A) requires that a person is warned before a time limit and can extend it with a simple action, unless the limit is essential or longer than 20 hours. The plan also lists "Session timeout warning before auto sign-out" as a staff portal component (§10), and the register will need a tighter 15-minute limit in Phase 3.

Expired sessions and abandoned sign-in attempts were deleted only when someone presented them again, so rows could stay in D1 indefinitely, against the plan's retention rule (§9: sessions purged on expiry).

## Decision

- **Two staff routes (Barista and up):**
  - `GET /api/v1/staff/session` returns `idleMsLeft` and `absoluteMsLeft`. The session layer reads the session for this route without moving its idle limit, so a page checking the time can't keep someone signed in forever.
  - `POST /api/v1/staff/session/extend` is "Stay signed in". Like any other request, it moves the idle limit forward, never past the absolute one. As a POST it passes the Origin check (CSRF).
- **Times left, not clock times.** The server sends milliseconds left, and the page tracks them with `performance.now()`, so a tablet with a wrong clock still warns on time.
- **The warning** (`src/components/staff/SessionTimeout.astro`, `public/scripts/session-timeout.js`) is a native modal `<dialog>`, opened two minutes before sign-out. It says the clock time of sign-out once, rather than counting down aloud.
  - **Inactivity:** "Stay signed in" (focused first) or Escape extends the session; "Sign out now" ends it.
  - **8-hour limit:** it can't be extended (it limits the damage from a stolen session and a tablet left signed in), so the dialog offers "Sign in again" and "Close" instead. The accessibility statement says so.
  - **The server stays the authority.** Before warning and at the deadline the page asks the server again, because another tab may have kept the session alive. When time is up it clears the cookie and goes to `/staff/signed-out/`. Without JavaScript the server still ends the session on time; there's just no warning.
- **Hourly clean-up:** a Cron Trigger (`17 * * * *`) runs `scheduled()` in `src/fetch.ts`. It deletes expired sessions and sign-in attempts and logs only the counts. It never touches `audit_log`. The Worker's default export becomes `{ fetch, scheduled }`; the Cloudflare adapter passes it through as is, and Astro's prerender only calls `fetch`.

## Consequences

- Each portal page renders the time left into the dialog's data attributes; the status route is called at most twice per warning, plus whenever the tab becomes visible again.
- The register (Phase 3) gets its 15-minute limit by giving those sessions a shorter idle time; the warning works unchanged.
- Cron Triggers run on the production Worker only; preview databases keep expired rows until they're presented or the preview is reset. Accepted: previews hold test data only.
- Tests: route authorization and behaviour (`tests/api/staff-auth.test.ts`), the non-sliding read and the clean-up (`tests/db/session.test.ts`), and the dialog in a real browser against the built Worker, including axe (`tests/e2e/staff-timeout.spec.ts`). The browser tests use their own local database, rebuilt from the migrations on every run (`tests/setup/e2e-db.mjs`).
