# Evidence: card refunds and separation of duties in production (2026-11-10)

**Lab-verified 2026-11-10.** Hub change record **CR-002**, **acceptance test 2**: "A refund by the person who took the payment is refused and the refusal is in the audit log". Plan §4.4 and §5; ADR-0034 and ADR-0037; control **AC-5** (separation of duties).

Michael tested the live site in Chrome (Incognito) between 7:46 and 7:52 PM Eastern, as two fictional staff members:

- Daniel Lopez (Manager);
- Olivia Carter (Owner).

The sale was a Single-Origin Feature 20 oz and a Mocha 20 oz, $11.00, taken by Daniel by card on Stripe's simulated reader in test mode. No real card or money was involved.

**Redaction:** none needed. All four screenshots show page content only: fictional names, no URLs, emails or IDs. Michael cropped the Stripe screenshot himself to the payments table.

| File                               | Shows                                                                                                                                                                                                                                                                    | Control              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- |
| `01-own-sale-refused.png`          | Daniel opened **Refund** on sale #1, which he took himself: "You took this payment, so you can't refund it. Another manager, or the owner, can." No refund form is offered                                                                                               | **AC-5**, AC-3       |
| `02-refusal-in-owner-activity.png` | Olivia's Activity: Daniel signed in (7:46), **simulated a card tap (approved): $11.00** and **Sale #1: $11.00 card** (7:47), then **"Refused: refunding sale #1, which they took"** (7:47), then signed out. The refused attempt is in the insert-only audit log         | **AC-5**, AU-2, AU-6 |
| `03-owner-refunds-to-card.png`     | Olivia refunded both drinks, with the reason "Wrong order made" and a confirmation step: "Refund $11.00 to the customer's card?" then "**Refunded $11.00 to the customer's card. No cash from the drawer.**"                                                             | AC-5, SA-9           |
| `04-stripe-refunded.png`           | Stripe Dashboard (sandbox): **$11.00, Refunded, •••• 4242** (Stripe's published test card), "Burn and Churn Coffee counter sale (fictional, test mode)", dated **Nov 11, 12:47 AM**. The Dashboard shows UTC: that's Nov 10, 7:47 PM Eastern, when the payment was taken | SA-9, AU-3           |

**What it proves together:**

- The person who took a payment can't refund it, and the attempt is recorded.
- A different authorised person can, and the money goes back to the card through Stripe, not out of the cash drawer.
- Stripe's own record agrees.

That's CR-002 acceptance test 2, met in production.

**Found in `03`:** after a successful refund, the form stayed on screen, with a greyed-out "Confirm refund" and a live "Change" button. The code hid it, but a style rule overrode the hide. It was harmless, because the refund's idempotency key prevents a second refund, but it was confusing. Fixed in the same PR as this evidence, with a browser test that the form is gone after a refund.
