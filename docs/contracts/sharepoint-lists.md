# Contract: the SharePoint lists the website reads

Version 1, 2026-11-10. Plan §5; decisions of 2026-11-10 (Michael). The machine-readable form is [`sharepoint-lists.json`](sharepoint-lists.json); a unit test keeps the two in step. Together they're the single source for:

- `scripts/tenant/setup-sharepoint.ps1`, which builds the site, the lists and their permissions from it;
- the website's sync (Phase 7), which validates every row against it and refuses rows that don't fit.

**SharePoint is the system of record; the website keeps a published copy and never writes back.**

## The site

|                          |                                                                                                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **URL**                  | `/sites/bc-operations`                                                                                                                                      |
| **Title**                | Burn and Churn Operations                                                                                                                                   |
| **Why the `bc-` prefix** | The tenant is shared, and site URLs must be unique; the `workspace` repo already used "operations". Same convention as the `grp-bc-` groups                 |
| **Also holds**           | The hub's planned Operations content (checklists, SOPs; hub §7.4), which the website never reads                                                            |
| **Site permissions**     | `grp-bc-all-staff`: Read. `grp-bc-managers`, `grp-bc-owners`: Edit. Site owner: the `adm-` account (hub). Individuals are never granted anything (hub §7.4) |

## The website's access: per list, read only

- The sync runs as its own app registration, **`bc-website-sync`**, with a certificate credential.
  - It's separate from `bc-website-staff` (sign-in), so each app does one job.
  - It holds **one** Graph application permission, **`Lists.SelectedOperations.Selected`**, and is granted **read** on exactly the lists marked "Website reads" below.
- Microsoft's model (checked 2026-11-10, [Selected permissions](https://learn.microsoft.com/graph/permissions-selected-overview)) needs three things before the app can read a list:
  1. consent to the scope;
  2. a grant on that list;
  3. a token carrying the scope.
- **Any other list, or any other site, returns 403.** That's trial test T-SP-03.
- A list-level grant breaks permission inheritance on that list. These lists have their own permissions anyway (below).

## The lists

Internal names never change once created; display names may. Columns are created with the internal name, then given the display name. Every list also has SharePoint's built-in `Title`, `Created`, `Modified`, `Author` and `Editor`.

### 1. Menu: website reads

Who edits: `grp-bc-managers`, `grp-bc-owners`. Everyone else: Read.

| Internal name | Display         | Type                           | Required | Rules                                                                                                                                                                          |
| ------------- | --------------- | ------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Title`       | Drink           | Text (60)                      | Yes      | Shown as the drink's name                                                                                                                                                      |
| `ItemId`      | Item ID         | Text (40)                      | Yes      | Unique; `a-z`, `0-9`, `-` only; matches `seed/menu.json` ids. Changing it creates a new drink                                                                                  |
| `Category`    | Category        | Choice                         | Yes      | `espresso-bar`, `brewed-coffee`, `milk-drinks`, `cold-coffee`, `signature-seasonal`                                                                                            |
| `Description` | Description     | Multiple lines, **plain text** | Yes      | Up to 300 characters; never HTML (shown as text)                                                                                                                               |
| `PriceDouble` | Double shot ($) | Currency                       | No       | Espresso only                                                                                                                                                                  |
| `Price12`     | 12 oz ($)       | Currency                       | No       |                                                                                                                                                                                |
| `Price16`     | 16 oz ($)       | Currency                       | No       |                                                                                                                                                                                |
| `Price20`     | 20 oz ($)       | Currency                       | No       |                                                                                                                                                                                |
| `Tags`        | Tags            | Text (120)                     | No       | Comma-separated, each one of `hot`, `iced`, `dairy`, `vegan-option`, `caffeine-free`, `seasonal` (Graph can't create multi-select choice columns, so the sync checks the list) |
| `Active`      | On the menu     | Yes/No                         | Yes      | No = hidden everywhere                                                                                                                                                         |
| `ImageKey`    | Image           | Text (80)                      | No       | A file name in the site's image store, never a SharePoint link (plan §5)                                                                                                       |
| `SortOrder`   | Order           | Number (0–999)                 | Yes      | Within its category                                                                                                                                                            |

**Row rules** (the sync refuses a row that breaks one; the rest still publish):

- at least one price;
- every price from $0.50 to $20.00, stored as cents;
- espresso has a double-shot price only, and the other drinks have size prices only (plan §10.1);
- no two rows with the same `ItemId`.

**Seeded on Saturday** from `seed/menu.json` (`setup-sharepoint.ps1 -SeedMenu`), so the list starts identical to today's site.

### 2. StoreHours: website reads

Who edits: managers and owners.

| Internal name | Display        | Type       | Required | Rules                                    |
| ------------- | -------------- | ---------- | -------- | ---------------------------------------- |
| `Title`       | Day            | Text       | Yes      | `Monday` … `Sunday`                      |
| `DayOfWeek`   | Day number     | Number     | Yes      | 1 (Monday) to 7 (Sunday), unique         |
| `Opens`       | Opens          | Text (5)   | No       | `HH:MM`, 24-hour, store time zone        |
| `Closes`      | Closes         | Text (5)   | No       | `HH:MM`, after `Opens`                   |
| `Closed`      | Closed all day | Yes/No     | Yes      | If yes, `Opens` and `Closes` are ignored |
| `Note`        | Note           | Text (120) | No       | Plain text, e.g. "Holiday hours"         |

Seeded with the hours the site shows today.

### 3. Announcements: website reads

Who edits: managers and owners.

| Internal name | Display    | Type                       | Required | Rules                                           |
| ------------- | ---------- | -------------------------- | -------- | ----------------------------------------------- |
| `Title`       | Headline   | Text (80)                  | Yes      |                                                 |
| `Body`        | Message    | Multiple lines, plain text | Yes      | Up to 500 characters                            |
| `Audience`    | Audience   | Choice                     | Yes      | `public` (site banner) or `staff` (portal only) |
| `StartsOn`    | Show from  | Date                       | Yes      |                                                 |
| `EndsOn`      | Show until | Date                       | No       | Empty = until removed; must be after `StartsOn` |

### 4. ShiftNotes: website reads

Who edits: `grp-bc-shift-leads`, managers, owners. Baristas: Read.

| Internal name | Display | Type                       | Required | Rules                  |
| ------------- | ------- | -------------------------- | -------- | ---------------------- |
| `Title`       | Summary | Text (80)                  | Yes      |                        |
| `ShiftDate`   | Date    | Date                       | Yes      |                        |
| `Shift`       | Shift   | Choice                     | Yes      | `open`, `mid`, `close` |
| `Note`        | Note    | Multiple lines, plain text | Yes      | Up to 1,000 characters |

The author is SharePoint's built-in `Author`. The portal shows the last 14 days, read-only.

### 5. Inventory: website reads

Who edits: shift leads, managers, owners. Baristas: Read. Replaces xtraCHEF (hub CR-005).

| Internal name | Display   | Type            | Required | Rules                                                                                          |
| ------------- | --------- | --------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `Title`       | Supply    | Text (60)       | Yes      |                                                                                                |
| `Unit`        | Unit      | Text (20)       | Yes      | e.g. `kg`, `gallon`, `sleeve of 50`                                                            |
| `ParLevel`    | Par level | Number (0–999)  | Yes      | Reorder at or below this                                                                       |
| `OnHand`      | On hand   | Number (0–9999) | Yes      |                                                                                                |
| `MenuItems`   | Used in   | Text (200)      | No       | Comma-separated `ItemId`s from Menu, so a low supply can suggest which drinks to mark sold out |

**Starter rows** (Michael to edit before Saturday if he wants):

1. House espresso beans (kg)
2. Night Shift dark roast beans (kg)
3. Single-origin beans (kg)
4. Whole milk (gallon)
5. Oat milk (carton)
6. Heavy cream (quart)
7. Vanilla syrup (bottle)
8. Caramel syrup (bottle)
9. Mocha sauce (bottle)
10. Maple syrup (bottle)
11. Hot cups 16 oz (sleeve of 50)
12. Cold cups 16 oz (sleeve of 50)

The staff portal shows a low-stock warning when `OnHand ≤ ParLevel`. Stock counts are entered in SharePoint; restock requests stay in the portal (ADR-0033).

### 6. Schedule: website reads; **baristas can't open it**

Who sees and edits: shift leads, managers, owners only. **Baristas have no access** (Michael, 2026-11-10).

| Internal name | Display      | Type                      | Required | Rules                              |
| ------------- | ------------ | ------------------------- | -------- | ---------------------------------- |
| `Title`       | Shift        | Text (60)                 | Yes      | e.g. "Saturday open"               |
| `Staff`       | Staff member | Person (one, people only) | Yes      | Someone in `grp-bc-all-staff`      |
| `ShiftDate`   | Date         | Date                      | Yes      |                                    |
| `Starts`      | Starts       | Text (5)                  | Yes      | `HH:MM`, store time zone           |
| `Ends`        | Ends         | Text (5)                  | Yes      | `HH:MM`, after `Starts`            |
| `Position`    | Position     | Choice                    | Yes      | `barista`, `shift-lead`, `manager` |
| `Note`        | Note         | Text (120)                | No       |                                    |

**How baristas see their own shifts** (Phase 7, proposed 2026-11-10): the staff portal's **My shifts** page shows each signed-in person only their own rows from the website's copy. A shift-change request is made in the portal and approved by a Shift Lead or above (never their own), audited, like restocks. The lead then changes the SharePoint schedule. SharePoint views can't do this securely: a filtered view hides rows but doesn't stop a reader from opening them.

**To verify on trial day 1 (T-SP-05):** Graph returns only a lookup ID for a person column. The email comes from the site's hidden User Information List. The plan:

- grant the sync app read on that list too (per-list);
- match people by a SHA-256 hash of their sign-in name, so the website never stores emails.

**Fallback if app-only access to it fails:** a Choice column of employee IDs from the hub's `people.csv`, filled in by the setup script.

## What the sync does with a bad row

- It skips the row, records why in `sync_runs`, and keeps publishing the rest (plan §5).
- It never publishes HTML, script or links from these lists. Everything is plain text, validated with zod (plan §9).
- If a whole list fails (403, schema change), the website keeps its last good copy.

## Changing this contract

Add columns at the end; never rename an internal name or change a type in place. A breaking change gets a new version of this document, a migration, and a change to `setup-sharepoint.ps1`, in one PR.
