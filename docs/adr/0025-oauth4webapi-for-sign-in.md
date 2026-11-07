# ADR-0025: oauth4webapi for OpenID Connect sign-in

- **Status:** Accepted
- **Date:** 2026-11-06

## Context

The Worker runs the staff sign-in flow itself (plan §4.3, ADR-0024): authorization code with PKCE, `state` and `nonce`, and a certificate credential (`private_key_jwt`) instead of a client secret. Customers use the same flow against Entra External ID in Phase 5. Writing the protocol checks by hand (ID token signature, issuer, audience, expiry, nonce) is where sign-in code usually goes wrong. The library has to run on Cloudflare Workers, which have Web Crypto and `fetch` but no Node.js built-ins.

## Decision

Use **`oauth4webapi` 3.8.8** (MIT, by Filip Skokan, the maintainer of `jose` and `openid-client`). The owner approved it on 2026-11-06.

- Built only on Web APIs (Web Crypto, `fetch`), so it runs on Workers without Node compatibility.
- **No dependencies**, so it adds one package to the supply chain, not a tree.
- Covers exactly what the plan needs: discovery, PKCE, `state` and `nonce` checks, ID token validation, and `private_key_jwt` client authentication.
- OpenID Foundation certified (relying party profiles).
- Pinned exactly; 3.8.8 was published 2026-09-05, more than a week before adoption (ADR-0015). `npm audit` reports no vulnerabilities.

Rejected: Microsoft's MSAL Node (needs Node.js APIs and is far larger), `openid-client` (built on oauth4webapi; its extra Node-oriented layer isn't needed), and hand-written token checks.

## Consequences

- One runtime dependency in the sign-in path. Dependabot and Dependency Review watch it like the others; a major version needs a new decision.
- The library validates the protocol; the site still decides what a valid sign-in means for it (tenant, role present, `idp = workforce`), and those checks get their own tests.
