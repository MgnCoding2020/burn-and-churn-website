# ADR-0044: Online orders with Stripe Checkout

- **Status:** Accepted
- **Date:** 2026-11-14

## Context

Plan §6.1: online orders are paid with Stripe Checkout. The order is marked paid only by a verified webhook, prices come from the server, never the browser, and the session is created with an idempotency key. The cart (PR #60) already keeps drink, size and quantity in the browser, never a price.

The PCI scope document (`docs/pci-scope.md`) made the online channel **SAQ A** on one condition: a **redirect** to Stripe's own payment page, not an embedded form.

**The Owner's decisions on 2026-11-14:**

- a customer must be signed in to pay;
- Turnstile waits for Phase 8 and covers checkout then;
- Delete my data keeps orders but unlinks them;
- the cart is a page.

## Decision

- **A checkout is an attempt, kept in `online_checkouts`** (migration 0010), like a counter card payment (ADR-0036). The order only exists once Stripe confirms payment, so an abandoned or expired checkout never reaches the board.
- **`POST /api/v1/checkout`:**
  - **Who:** customer only, Origin-checked, `payments` limit.
  - **Request:** the cart's lines and a key per attempt.
  - **Pricing:** the server prices the lines with `priceOrder` against today's menu, sold-out drinks refused by name. Any price in the request is ignored.
  - **Session:** it stores the attempt and creates a Checkout Session with `price_data` from those server prices, card only, a 30-minute expiry (Stripe's minimum), and the attempt's ID as `client_reference_id`.
  - **Stripe's own idempotency key** is `checkout-<key>`.
  - **A repeated key** returns the same payment page and never makes a second session.
- **The browser goes to the URL Stripe returned,** and only if it starts with `https://checkout.stripe.com/`. It's a navigation, so the strict CSP (`script-src 'self'`) needs no change, and the site loads no Stripe script.
- **The order is created once.** Either path can create it, and whichever comes second finds it done, because of the unique PaymentIntent and idempotency key on `orders`:
  - the signed webhook `checkout.session.completed`, with payment status `paid`;
  - the status page's check, which asks Stripe directly once a checkout has been open for 3 seconds. That makes it work locally without `stripe listen` and covers a late webhook.

  The order is `channel = online`, `tender = card`, `customer_id` set, and no `taken_by`. `checkout.session.expired` marks the attempt expired.

- **Status:**
  - `/order/status/?id=` shows the customer's own checkout only (anyone else's is 404). It polls every 5 seconds: confirming, then paid, being made, ready, collected (or refunded or expired).
  - Once paid, the browser's cart is cleared.
  - The account page lists the customer's paid orders.
- **"Sign in to pay"** sends `?next=order`. The sealed login cookie carries only the fixed value `order` (any other `next` is ignored), so the customer lands back on `/order/`.
- **Refunds:** Managers refund online orders through the existing refund screen, by PaymentIntent (ADR-0037). The separation-of-duties rule passes because no staff member took the payment.
- **Delete my data** sets `customer_id` and the attempt's `user_id` to NULL: the shop keeps the sale, unlinked.
- **Retention:** attempts are deleted after 90 days, like orders.
- **Stripe:** the webhook endpoint subscribes to `checkout.session.completed` and `checkout.session.expired`. The Owner adds them by re-running `scripts/stripe/setup-test.mjs` with a one-time key. The Worker key already has Checkout Sessions Write (ADR-0035), so there's no new permission.

## Consequences

- **The webhook and the status check are the only ways an order is created,** and both need Stripe to say `paid`.
- **No card data touches the site.** The site stores Stripe's IDs and the order: the conditions of SAQ A in `docs/pci-scope.md`.
- **No bot check on checkout yet.** Only signed-in customers (email code) can start one, and the payments limit applies. Turnstile arrives in Phase 8.
- **Verification:**
  - Tests against a stand-in for Stripe: `tests/api/customer-checkout.test.ts`, 15 tests, including a signed webhook and its replay.
  - The real flow is the Owner's: a test card payment in Stripe test mode.
