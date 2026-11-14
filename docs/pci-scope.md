# PCI DSS scope and SAQ type

**Written 2026-11-14.** Plan §6.4; closes Vendor-Risk-Assessment-Lab finding VRA-V013:F-02 ("the company's own PCI scope and SAQ type not determined for either channel"), which had to be done before online ordering goes live (CR-002 step 6).

Burn and Churn Coffee is fictional, and **every payment on this site is Stripe test mode**: no real card data exists anywhere. This document records which validation the company **would** use if it took real payments, as an exercise in scoping. It's written the way a real merchant's would be, and every rule below was checked against the source on the date shown.

## Sources (checked 2026-11-14)

| Source                                                                                                                           | What it says                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [PCI SSC FAQ 1588](https://www.pcisecuritystandards.org/faqs/1588/) (February 2025)                                              | SAQ A's criterion about script attacks applies to merchant pages with an **embedded** payment form (iframe), not to pages that **redirect** to the payment provider                                                                                               |
| [PCI SSC FAQ 1604](https://www.pcisecuritystandards.org/faqs/1604/) (June 2026)                                                  | Quarterly external vulnerability scans by an Approved Scanning Vendor (Requirement 11.3.2) **still apply** to SAQ A merchants whose pages redirect to a payment provider                                                                                          |
| [Stripe: Terminal payments and PCI compliance](https://support.stripe.com/questions/stripe-terminal-payments-and-pci-compliance) | In-person Terminal payments are validated with the **SAQ C** template (Terminal is end-to-end encrypted by default), or SAQ P2PE for accounts enrolled in Terminal P2PE; Stripe offers both pre-filled in the Dashboard (Compliance settings)                     |
| [Stripe: integration security guide](https://docs.stripe.com/security/guide)                                                     | Stripe is a PCI Level 1 service provider; compliance is shared; low-risk integrations such as Checkout keep card data off the merchant's servers                                                                                                                  |
| PCI SSC FAQ "If a merchant has multiple processing environments, should the merchant complete multiple SAQs?"                    | **Only the title could be read on 2026-11-14.** Secondary sources summarise the answer: a separate SAQ per channel, or one SAQ covering all, and the acquirer (here, Stripe) can require a particular one. Stripe offering a pre-filled SAQ per channel fits that |

The acquirer decides in the end (FAQ 1588 says to confirm with the acquirer or payment brands). For a Stripe merchant, that's the **Compliance settings** page in the Stripe Dashboard.

## The three ways the shop is paid

### 1. Online: Stripe Checkout (Phase 5, next PR): **SAQ A**

The customer builds an order on this site, then is **redirected** to Stripe's own payment page (`checkout.stripe.com`) and back. Card details are typed only on Stripe's page.

| SAQ A eligibility (as it applies here)                                | This site                                                                                                                                             |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Card-not-present only, for this channel                               | Yes: the online channel is separate from the counter                                                                                                  |
| All processing of account data outsourced to a PCI DSS compliant TPSP | Stripe (PCI Level 1). The Worker sends Stripe the order's line items and prices from its own database; it never receives a card number                |
| The payment page comes entirely from the TPSP                         | A redirect, not an embedded form; the site loads no Stripe script (CSP allows `form-action https://checkout.stripe.com` and nothing else from Stripe) |
| No electronic storage, processing or transmission of account data     | The site stores Stripe's IDs and the order's status only: no card number, expiry or security code                                                     |
| Not susceptible to script attacks                                     | **Doesn't apply to redirects** (FAQ 1588). The site also has a strict CSP (`script-src 'self'`) and no third-party scripts                            |

**What still applies under SAQ A:** the merchant's own pages, which start the redirect, stay in scope. In particular:

- quarterly ASV scans of the site (11.3.2, FAQ 1604);
- secure configuration and patching;
- managing Stripe as a service provider (12.8);
- incident response (12.10).

### 2. At the counter: Stripe Terminal (live since 2026-11-09): **SAQ C**, or SAQ P2PE

The register is **server-driven**:

1. The barista's tablet asks the Worker for a payment.
2. The Worker asks Stripe.
3. Stripe tells the reader to collect the card.

The reader talks only to Stripe. The tablet and the Worker never connect to the reader and never see card data. They get Stripe's PaymentIntent ID, the outcome and a decline code.

- **SAQ C** is what Stripe says applies to Terminal with its default end-to-end encryption.
- **SAQ P2PE** is shorter, but only for accounts enrolled in Stripe's Terminal P2PE.
- **In scope:** the reader and the network it sits on (the cardholder data environment). The register tablet is a connected system only if it shares that network.
- **SAQ C's eligibility includes isolating the payment system from the merchant's other systems.** **Gap:** the store network has staff Wi-Fi, guest Wi-Fi and a planned devices segment, but **no payment segment** (hub assets NET-001 to NET-006). A real reader would need its own network segment, or would bring the staff network into scope.

In this project the reader is **Stripe's simulated reader**: there's no hardware and no network to segment. The gap is recorded for the fictional store, not for anything that exists.

### 3. Cash: out of PCI scope

Cash sales involve no card data. They're covered by cash-handling controls (the blind end-of-shift count, ADR-0034), not PCI DSS.

## Decision

- **Two SAQs, one per channel:** SAQ A for online (Checkout) and SAQ C for the counter (Terminal). This is a Stripe merchant's normal route: Stripe pre-fills both in the Dashboard.
- **SAQ D is not needed:** the site never handles card data. The shop would only fall back to it if one channel stopped qualifying, for example if the reader shared a network with everything else and no segment were added.
- **The Owner signs both, yearly,** in the Stripe Dashboard (Compliance settings). Hub policy P-004 says the Business Owner completes SAQ documentation with the payment processor.

## Actions this creates

| #   | Action                                                                                                                                                                           | Where it's tracked                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 1   | Quarterly ASV scans of the public site would be required before live online payments (FAQ 1604). Not done: test mode only, and `workers.dev` is shared Cloudflare infrastructure | Hub POA&M (new item)                  |
| 2   | A separate payment network segment for card readers, before a real reader is used (SAQ C isolation)                                                                              | Hub POA&M (new item); hub asset list  |
| 3   | Look at Stripe's Compliance settings page and record what it says the account must file (test accounts may show nothing)                                                         | Owner; noted in VRA-V013:F-02 closure |
| 4   | Update the hub's NIST–PCI crosswalk scope note with this decision                                                                                                                | Hub (with this document)              |

## Kept honest

- No SAQ has been completed or signed. This document **determines** the type. Completing one is a live-merchant task, and this project never takes real payments.
- **Re-check this document** when any of these changes:
  - the online flow (for example, an embedded form instead of a redirect would bring SAQ A's script criterion and stricter scoping in);
  - the reader setup;
  - Stripe's or the PCI SSC's guidance.
