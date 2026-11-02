# ADR-0004: Security headers and a strict CSP on every response

- **Status:** Accepted
- **Date:** 2026-11-02

## Context

The site will show content from people (customers), from SharePoint, and from an AI model. A strict Content Security Policy limits the damage of any injection that slips past output encoding (NIST SP 800-53 SI-10, SC-7).

## Decision

Set by the Worker on every response (`src/lib/security-headers.ts`):

| Header                                            | Value                                                                                                                                                                                                                                                       | Why                                                                                                                   |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `Content-Security-Policy`                         | `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self' https://checkout.stripe.com; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; upgrade-insecure-requests` | Only our own scripts and styles; no inline script or style; no framing; forms may post only to us and Stripe Checkout |
| `Strict-Transport-Security`                       | `max-age=31536000; includeSubDomains`                                                                                                                                                                                                                       | HTTPS for a year after the first visit (see ADR-0005 for the first visit)                                             |
| `X-Content-Type-Options`                          | `nosniff`                                                                                                                                                                                                                                                   | No MIME sniffing                                                                                                      |
| `X-Frame-Options`                                 | `DENY`                                                                                                                                                                                                                                                      | Framing protection for older browsers                                                                                 |
| `Referrer-Policy`                                 | `strict-origin-when-cross-origin`                                                                                                                                                                                                                           | No full URLs leaked to other sites                                                                                    |
| `Permissions-Policy`                              | camera, microphone, geolocation, payment, usb off                                                                                                                                                                                                           | Features the site never uses                                                                                          |
| `Cross-Origin-Opener-Policy` / `-Resource-Policy` | `same-origin`                                                                                                                                                                                                                                               | Isolation from other origins                                                                                          |
| `X-Robots-Tag`                                    | `noindex, nofollow`                                                                                                                                                                                                                                         | The fictional-business rule: never in search results                                                                  |

Supporting choices:

- `build.inlineStylesheets: 'never'` in Astro, so CSS is always an external file (`style-src 'self'` holds).
- The CSP is dropped **only** under `npm run dev`, where Vite's live reload injects inline styles. The built Worker always sends it, and CI checks it.
- No CORS headers anywhere: the site is same-origin only.

## Consequences

- Any feature that needs inline script (for example Astro islands' hydration scripts) needs its own decision. See ADR-0013.
- `tests/e2e/headers.spec.ts` fails if any response type loses a header or if `script-src` gains `unsafe-inline`; another test fails on any CSP violation in the browser console.
- Self-hosted video later falls under `default-src 'self'`. Media from another origin (for example R2 on its own domain) would need a `media-src`/`img-src` change and a new record.
