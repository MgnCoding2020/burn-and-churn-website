-- Phase 2: sign-in attempts in flight (plan §4.3; ADR-0027).
-- One row per started sign-in, holding the PKCE code verifier and the nonce until Entra
-- redirects back. Keyed by a SHA-256 hash of the state value; used once, then deleted.
-- Times are Unix epoch milliseconds.

CREATE TABLE oidc_logins (
  state_hash     TEXT PRIMARY KEY,
  idp            TEXT NOT NULL CHECK (idp IN ('workforce', 'customer')),
  code_verifier  TEXT NOT NULL,
  nonce          TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL
);
CREATE INDEX oidc_logins_expiry ON oidc_logins (expires_at);
