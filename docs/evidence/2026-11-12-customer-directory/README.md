# Evidence: the customer directory and its demo customers (2026-11-12)

**Lab-verified 2026-11-12.** Plan §4.2 (a separate directory for customers); ADR-0041 (created by script); runbook `docs/runbooks/customer-directory.md`.

Michael ran two scripts from his own terminal: `setup-customer-directory.ps1` created the directory, its resource group and the $5 budget, and `seed-customers.ps1` added the demo customers, a dry run first in each case. He then took one screenshot in the Entra admin center (Chrome Incognito), switched to the new directory.

Per the Owner's decision of 2026-11-11, evidence for the directory is kept light: this one screenshot.

**Redaction:** the account name at the top right had a hand-drawn scribble, and its characters were still readable. The committed copy covers it with a solid box. The original stays outside the repo. The directory's domain and IDs aren't shown or recorded anywhere in the repo. The object IDs in the "User principal name" column belong to fictional demo accounts.

| File                    | Shows                                                                                                                                                                                                                                                                                                                                                                                                           | Control    |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `01-demo-customers.png` | Entra admin center → **Burn and Churn Customers** (the customer directory, not the staff tenant) → Users: **101 users found**, which is the 100 demo customers plus the admin account that created the directory. Each demo row is a **local account** with company name "Burn and Churn demo c[ustomer (fictional)]", the tag `remove-customers.ps1` uses to find them. Names are made-up pairs from two lists | AC-2, IA-8 |

**What it proves:**

- Customers have their own directory, separate from the staff tenant (plan §4.2), so staff Conditional Access never applies to them and a customer account can't become a staff account.
- The directory holds only fictional customers, made by a script that can remove them again.

Not checked in this evidence:

- **That the demo customers can't sign in.** Their passwords are random and never shown, and their `example.com` addresses can't receive a one-time code (RFC 2606). The script is the record.
- **The $5 budget and its alerts.** The script output showed `bc-budget ... created`; Azure sends no alert until spend passes $4.
- **Real customer sign-in.** It's tested in the next PR, through the website, with the Owner's own addresses. Those addresses stay out of the repository.
