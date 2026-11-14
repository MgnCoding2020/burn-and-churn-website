# ADR-0043: Delete my data

- **Status:** Accepted
- **Date:** 2026-11-13

## Context

Plan §9 "Privacy" (PT-2, SI-12) promises customers a way to delete their data. Since ADR-0042, a customer has a sign-in account in the customer directory, and the site holds a user row (a name and the directory's object ID) and sessions. Orders come later, with Checkout.

The Owner chose full erasure on 2026-11-13: the site's records **and** the directory account. Deleting a directory account needs a Microsoft Graph application permission.

**Checked on 2026-11-13:**

- **Microsoft Graph's "Delete a user" page** lists `User.ReadWrite.All` (read and change every user) as least privileged.
- **The `Remove-MgUser` reference** lists the narrower **`User.DeleteRestore.All`** (delete and restore users; no read or change) as an application permission.
- **The deleted-items docs** list it for permanently removing a user from the recycle bin. Deleted users otherwise stay there for 30 days.

## Decision

- **A separate app, `bc-website-erasure`,** in the customer directory, not the sign-in app.
  - **No sign-in and no redirect URIs.**
  - **One application permission:** `User.DeleteRestore.All`, with admin consent. It can delete and restore customer accounts. It can't read them, change them, or do anything else.
  - **Its own certificate.** A stolen sign-in key can't erase anyone, and a stolen erasure key can't sign anyone in.
  - **Created by `scripts/tenant/setup-customer-app.ps1`,** in the same run as the sign-in app.
- **`POST /account/delete`:**
  - **Who:** a signed-in customer only (staff refused). It checks the Origin header and is limited to 3 a minute per person (`erasure`).
  - **Confirmation:** a required checkbox ("I understand this can't be undone"), checked on the server too.
  - **Directory first.** The Worker gets an app-only token from the customer directory (assertion addressed to the token endpoint, ADR-0042). It deletes the account, then removes it from the recycle bin, retrying briefly because the bin can lag a moment. An account that's already gone counts as done.
  - **If the directory refuses, nothing is deleted** and the customer sees "we couldn't delete your account; nothing was deleted".
  - **Then the site:** the user row and every session, in one batch. The cookie is cleared, and the customer lands on "Your account is deleted".
  - **The record:** one request-log line (`customer.erased`) with the internal user ID (meaningless once the row is gone) and whether the bin was emptied. No name, email or object ID.
- **Account page:** a "Delete your account" section with the checkbox and button. Where erasure isn't configured, it says so instead.

## Consequences

- **The erasure key is powerful:** whoever holds it can delete any customer account, though not read them. It lives only in Worker secrets and `.dev.vars`, like the other keys, and is listed in the secrets inventory.
- **If Microsoft refuses the delete with `User.DeleteRestore.All`** (`403` in the request log), the fallback is `User.ReadWrite.All`, which is broader. That needs the Owner's decision and an update to this ADR.
- **Checkout's orders** will need erasure too. That PR adds them to this route (delete or anonymise), and states which.
- **Verification:**
  - Tests against a stand-in for the directory and Graph: `tests/api/customer-account.test.ts` (12 tests).
  - The setup script run against a stand-in Graph.
  - The real test is the Owner's, with a throwaway sign-up on his second address.
