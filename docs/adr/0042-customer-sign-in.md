# ADR-0042: Customer sign-in with Entra External ID

- **Status:** Accepted
- **Date:** 2026-11-13

## Context

Plan §4.2 gives customers their own directory. It was created on 2026-11-12 (ADR-0041) and holds 100 fictional demo customers. The site now needs customers to sign up and sign in, before online ordering (Stripe Checkout) builds on it. Staff sign-in (ADR-0025, ADR-0027, ADR-0030) already runs the authorization code flow on the server, and sessions, users and authorization already know a `customer` identity provider. What's missing is the directory side, and the routes and pages.

**Checked on 2026-11-13:**

- **The directory's published OpenID configuration:** it signs in on `https://<tenant-id>.ciamlogin.com/<tenant-id>/`, with issuer `https://<tenant-id>.ciamlogin.com/<tenant-id>/v2.0`. It supports `private_key_jwt` client authentication.
- **Microsoft Graph v1.0 docs:**
  - user flows (`externalUsersSelfServiceSignUpEventsFlow`) need `EventListener.ReadWrite.All`;
  - an app can be linked to only one flow;
  - the email one-time passcode provider is `EmailOtpSignup-OAUTH`.
- **The Public Suffix List** includes `workers.dev`.

## Decision

- **A separate app, `bc-website-customers`,** in the customer directory. It's created by `scripts/tenant/setup-customer-app.ps1`, which the Owner runs in his own terminal.
  - **Permissions:** delegated `openid` and `profile` only, with admin consent.
  - **Credential:** its own certificate, never the staff one and never a client secret.
  - **Redirect URIs:** local and production.
  - **No app roles and no assignment requirement:** anyone may sign up.
- **One user flow, `bc-customers-sign-up-sign-in`.**
  - **Sign-up allowed;** email one-time passcode is the only method, so no passwords exist. Password guessing and reuse can't happen, and the site never handles a password reset.
  - **What it collects:** the email (used by the directory to send codes) and a display name.
- **The same server-side flow as staff**, in `src/api/customer-auth.ts`: PKCE, state, nonce, a sealed login cookie, and certificate client authentication. The browser never sees a token. The endpoints are fixed per directory, so no discovery request is made at sign-in.
  - **Its own login cookie** `__Host-bc_clogin`. It's sealed with a key derived from the customer certificate under the purpose label `customer`, so a staff attempt never opens as a customer one, or the other way round.
  - **`prompt=login` every time:** each sign-in asks for a fresh code, so signing out of the site really signs out, even on a shared computer. That costs a code per sign-in, but the session lasts up to 14 days, so it's rarely noticed.
  - **What's kept:** the token's `name` and `oid` only. The email address isn't requested, and isn't stored even if a token carries it.
  - **Sessions:** `idp = customer`, 14 days absolute and 2 days idle (plan §4.3). A new sign-in replaces any session the browser already had.
  - **Logging:** customer sign-ins, sign-outs and refusals go to the request log. They aren't staff actions, so they stay out of the staff audit log that managers read.
- **Routes:**

  | Route                         | Principal              |
  | ----------------------------- | ---------------------- |
  | `GET /auth/customer/login`    | public, `signin` limit |
  | `GET /auth/customer/callback` | public, `signin` limit |
  | `POST /auth/customer/logout`  | public, Origin-checked |
  | `GET /account/me`             | `customer`             |

  Every staff route already refuses a customer session, and the tests check it both ways.

- **Pages:**
  - `/account/` is rendered per request with `no-store`. It shows the signed-in state, or "sign in or create an account".
  - `/account/signed-out/` and `/account/sign-in-problem/`.
  - The header's "Account" is now a link.
- **The shared `workers.dev` domain stays.** The threat model's accepted risk had "before customer sign-in" as its trigger. Because `workers.dev` is a public suffix, browsers treat this Worker as its own site for cookies. All cookies are also `__Host-`. A custom domain would add nothing for cookies.

## Found in the first real sign-in (2026-11-13)

The Owner's first local sign-up got as far as the code exchange, which the directory refused with `AADSTS700023`: the client assertion's audience didn't match. The OIDC library addresses the assertion (`aud`) to the issuer by default. The staff tenant accepts that; the customer directory doesn't.

A check with the real certificate (a `client_credentials` request, which makes the directory verify the assertion straight away; nothing usable is granted) gave:

- the issuer: refused;
- the token endpoint (either host): accepted.

The token endpoint is the audience Microsoft documents for certificate credentials, so customer sign-in now sets it. Staff sign-in is unchanged, because it's verified live as it is. The request log now also records which check failed in a code exchange (error code, failing claim, the directory's `AADSTS` code), never token values.

## Not in this change

- **Delete my data** comes with online ordering, when there's order data to delete along with the account. The privacy page and the threat model say so.
- **Branding the directory's sign-in page** (café name and colours) is a later, cosmetic change.
- **Turnstile on sign-up** (plan §9). The sign-up page is Microsoft's, and the site's sign-in routes are rate-limited (ADR-0040).

## Consequences

- Customers and staff are separated at every layer: directory, app, certificate, login cookie, session marker and route principal.
- Customer sign-in is "not configured" until the Owner runs the script and sets the values. Locally they go in `.dev.vars` (`-WriteDevVars`). In production they're Worker secrets: `ENTRA_CUSTOMER_TENANT_ID`, `ENTRA_CUSTOMER_CLIENT_ID`, `ENTRA_CUSTOMER_CERT_THUMBPRINT` and `ENTRA_CUSTOMER_CERT_PRIVATE_KEY`.
- **Verification so far:** tests against a stand-in for the directory's token endpoint (`tests/api/customer-auth.test.ts`, 16 tests). The real sign-up is the Owner's test with his own address. That address never goes into the repository, and any screenshot of it is boxed out.
