# Evidence: an online order in production (2026-11-14)

**Lab-verified 2026-11-14.** Plan §6.1 and Phase 5's check: "places a test order online; sees it go paid on the staff board; a replayed webhook is ignored". ADR-0044 (online orders), ADR-0042 (customer sign-in).

Michael placed one order on the live site in Chrome Incognito, after website PRs #60 (the cart) and #61 (Stripe Checkout) were merged. He paid in Stripe's **sandbox** with Stripe's published test card (`4242…`) and a made-up email. No real money or card data was involved.

**Redaction:** none needed.

- The account page shows a first name only; the site never stores or shows the customer's email.
- Stripe's pages show the sandbox account's name, the public site address and an event ID, none of which is secret.

| File                              | Shows                                                                                                                                                                                                                     | Control    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `01-order-signed-out.png`         | `/order/` with two drinks, priced from the server's menu ($4.75 + $5.50 = **$10.25**), and **Sign in to pay**: paying needs a customer account                                                                            | AC-3, IA-8 |
| `02-stripe-payment-page.png`      | **Stripe's own payment page** (Sandbox) with the same two lines and **$10.25**: the prices Stripe charges are the ones the server set. Card details are typed here, never on the café's site (SAQ A, `docs/pci-scope.md`) | PCI SAQ A  |
| `03-status-paid.png`              | Back on the site: **Order #1** "Paid: the café has your order", with its lines and total                                                                                                                                  | SI-10      |
| `04-stripe-payment-succeeded.png` | Stripe Dashboard: **$10.25 Succeeded**, card •••• 4242, description "Burn and Churn Coffee online order (fictional, test mode)". Paid through Stripe's Link wallet, still with the test card                              | SA-9       |
| `05-account-your-orders.png`      | The account page lists **Order #1 · $10.25 · Paid, received**, and "What this site keeps about you" now includes orders                                                                                                   | PT-2       |
| `06-staff-board-online-card.png`  | Signed in as Ethan Brooks (**Barista**): the order on the board as **#0001 · ONLINE · CARD** in New, with its two drinks                                                                                                  | AC-3       |
| `07-webhook-delivered-200.png`    | Stripe's webhook endpoint: **`checkout.session.completed` delivered automatically, 200 OK**, from production. The signed webhook is what made the order                                                                   | SC-8, SI-7 |

**What it proves:**

- **The whole online flow works in production:** cart, sign-in to pay, Stripe's page, the signed webhook, the order on the staff board, the customer's status and account pages.
- **The amount charged is the server's price.**

**Covered by tests rather than this evidence:**

- **A replayed webhook is ignored.** `tests/api/customer-checkout.test.ts` ("by a signed webhook … a replay does nothing") delivers the same signed event twice and finds exactly one order. Michael later moved the order through to collected; a live Resend from Stripe's Dashboard wasn't captured.
- **Price tampering, a double-click, sold-out drinks, and one customer reading another's order:** the same test file.

**Noted, not acted on:** Stripe's page also offered Apple Pay, Link, Bank and Klarna, although the site asks for cards only. This most likely comes from the Stripe account's payment-method settings (Link's offers). To check against Stripe's documentation in Phase 9; it has no effect in the sandbox.
