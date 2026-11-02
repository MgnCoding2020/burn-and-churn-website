# ADR-0011: Astro sessions off; D1 binding deferred to Phase 2

- **Status:** Accepted
- **Date:** 2026-11-02

## Context

The Cloudflare adapter enables Astro's session feature by default, backed by a Workers KV namespace that is created automatically on deploy. The plan keeps sessions in D1 instead, with hashed IDs, rotation at sign-in and idle and absolute timeouts (plan §4.3).

The plan also lists a D1 binding in Phase 0, but nothing reads or writes a table until Phase 2, and previews must never share the production database.

## Decision

- `session: false` in `astro.config.mjs`: no Astro sessions, no KV namespace. The deploy log confirms the Worker's only bindings are `ASSETS` and `APP_ENV`.
- No D1 binding until Phase 2. When it's added, how previews get their own database is checked against Cloudflare's current documentation (preview bindings with `wrangler preview`) and recorded, rather than guessed now.

## Consequences

- No unused cloud resources to secure or explain.
- Phase 2 starts with the D1 binding, migrations and a preview-isolation test.
