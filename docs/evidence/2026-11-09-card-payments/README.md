# Evidence: card payments at the counter in production (2026-11-09)

**Lab-verified 2026-11-09.** Hub change record **CR-002** (step 5); plan §6.2; ADR-0036. Stripe set-up: `../2026-11-09-stripe-setup/`.

Michael tested the live site in Chrome (Incognito) between 5:47 and 5:54 PM Eastern, signing in as three fictional staff members:

- Ethan Brooks (Barista);
- Daniel Lopez (Manager);
- Olivia Carter (Owner).

The sale was one Red Eye, 12 oz, for $4.25, using Stripe's simulated reader in test mode. No real card or money was involved.

**Redaction:**

- `01`–`05` are page content only (fictional names, no URLs, emails or IDs).
- `06` was cropped to remove the browser's address bar (which showed the Stripe account ID), the bookmarks bar and the profile icon, and a faint area beside the search box was covered with a solid box.

| File                              | Shows                                                                                                                                                                                                                                                 | Control     |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `01-card-declined.png`            | Ethan pressed **Simulate tap: declined card**. The dialog shows Stripe's code (`generic_decline`) and offers **Try another card** or **Cancel card payment**. No order was created                                                                    | SI-10, AU-2 |
| `02-paid-by-card.png`             | After **Try another card** and **Simulate tap: approved card**: "Order #3 paid by card"; the order cleared from the register                                                                                                                          | AC-3        |
| `03-board-counter-card.png`       | Order board: ticket **#0003**, **COUNTER · CARD**, 1 × Red Eye 12 oz                                                                                                                                                                                  | AU-3        |
| `04-card-sale-no-cash-refund.png` | Daniel (Manager) opened the refund for sale #3: "This sale was paid by card… it can't be refunded in cash". The cash-refund path for card sales is closed                                                                                             | AC-3, SA-9  |
| `05-owner-activity.png`           | Olivia's Activity, newest first: Ethan's **Card declined: $4.25 (generic_decline)** at 5:47, **Simulated a card tap (test mode, approved card)** at 5:48, **Sale #3: $4.25 card** at 5:48, then the sign-ins and sign-outs                            | AU-2, AU-6  |
| `06-stripe-payment-succeeded.png` | Stripe Dashboard (sandbox): **$4.25, Succeeded, •••• 4242** (Stripe's published test card), "Burn and Churn Coffee counter sale (fictional, test mode)", at **10:48 PM**. The Dashboard shows UTC: that's 5:48 PM Eastern, the same moment as sale #3 | SA-9, AU-3  |

**What it proves together:** one card sale traced end to end. It was declined first, then approved on the same payment. It appears once on the site (sale #3, board, activity) and once in Stripe, with the same amount and time. The browser never handled a card number: the dialog offered only "approved" or "declined", and Stripe's record shows its own test card.

**Still to evidence:** card refunds back to the card, with the separation-of-duties rule (PR 4.3). That also closes CR-002 acceptance test 2.
