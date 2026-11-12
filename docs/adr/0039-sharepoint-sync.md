# ADR-0039: The SharePoint sync and Publish

- **Status:** Accepted
- **Date:** 2026-11-11

## Context

Plan §5 makes SharePoint the system of record for the menu, store hours, announcements, shift notes and inventory; the website shows a published copy. ADR-0038 decided the site (`/sites/bc-operations`), the list contract and the sync app `bc-website-sync` with per-list read (`Lists.SelectedOperations.Selected`). This ADR covers how the Worker reads those lists and what it does with bad data. It's built before the Business Premium trial (2026-11-14) and tested against a fake Graph, so the trial is spent testing against the real one.

## Decision

### Reading

- **App-only token, certificate credential.** The Worker signs a client assertion with the sync app's private key (`private_key_jwt`, the same code as staff sign-in, `src/lib/entra.ts`) and asks Entra for a Graph token with `oauth4webapi`. No client secret exists. The token is kept in memory until a minute before it expires; nothing is stored.
- **A thin `fetch` wrapper** (`src/lib/graph.ts`), not the Graph SDK (plan §8). It reads `GET /sites/{site}/lists/{list}/items?$expand=fields`, 200 items a page, at most 20 pages, and follows `@odata.nextLink` **only back to `https://graph.microsoft.com/v1.0/`** so a tampered response can't send the token elsewhere.
- **Settings are checked before use.** The tenant and client IDs must be GUIDs, the thumbprint 40 hex characters, the site ID `host.sharepoint.com,<GUID>,<GUID>`. Anything missing or malformed means "not set up here" (previews, CI), never a half-configured call.

### Validating

- **Every row is checked with zod against the contract** (`src/lib/sharepoint.ts`, `docs/contracts/sharepoint-lists.md`): types, lengths, choices, the menu's tag list, times as `HH:MM`, closing after opening, end dates after start dates, unique item IDs and days.
- **A bad row is skipped and reported with its reason** (for example `Tags: unknown tag "<script>"`). The rest of the list still publishes. Reasons are shown to managers on the Publish page and kept in `sync_runs`.
- **The menu goes through the site's own menu rules** (`parseMenu`, ADR-0014) after conversion, so a SharePoint menu can never be something the seed file couldn't be. A test proves the seeded Menu list converts back to exactly today's menu.
- **A list with nothing valid keeps its last good copy.** So does a list that can't be read (403, 404, network). An empty Announcements or Shift Notes list is valid; an empty Menu or Store Hours is not.
- **Everything is plain text.** Nothing from SharePoint is rendered as HTML (`set:html` is never used, plan §9); Astro escapes it.
- **Dates:** SharePoint returns date-only columns as midnight in the site's time zone, converted to UTC. The sync keeps the first ten characters (`YYYY-MM-DD`), which is the right date for any site time zone west of UTC (the site is set to US time). Checked on day 1 of the trial (T-SP-06).

### Storing

- **One snapshot per list** in `sharepoint_snapshots` (migration 0009): the validated JSON in the shape the site uses, a row count and the run that wrote it. Not one table per list: the site reads whole lists, the data is small (tens of rows), and one shape avoids a migration for every contract change.
- **Every run is a row in `sync_runs`**: cron or publish, who published, status (`ok`, `partial`, `failed`) and a per-list summary. Runs older than 90 days are purged by the hourly clean-up.
- **One run at a time.** A run starts only if no other started in the last five minutes and is still running; a crashed run stops blocking after that.

### Triggers

- **Every 15 minutes** by Cron Trigger (`*/15 * * * *`); it does nothing where Graph isn't set up.
- **Publish now**, Manager+ (`POST /api/v1/staff/sharepoint/publish`, page `/staff/publish/`). Audited as `sharepoint.publish` with counts per list, in the same batch as the snapshots. The cron run isn't audited (it's no one's action); `sync_runs` records it.

### Not yet

- **The Schedule** (and the User Information List it needs) waits for trial test T-SH-01: if Teams Shifts does shift-change requests, the Schedule list is replaced (ADR-0038 amendment).
- **Using the snapshots:** this ADR only publishes them. The public menu, the register, hours, announcements, shift notes and the low-stock warning switch to them in the next PRs, falling back to the built-in copy when a list has never synced.

## Consequences

- SharePoint mistakes can't break the site: a bad row disappears from the site until it's fixed, and a manager sees why.
- A manager sees changes within 15 minutes, or at once with Publish.
- The trial's tests T-SP-03 (403 on an ungranted list) and T-SP-06 (price change, then Publish) can run on day 1 with no code changes.
- Fifteen-minute polling uses about 5 × 96 = 480 Graph reads a day, well within Graph's limits.
- If the trial lapses, the last snapshots stay in D1 and the site keeps showing them (plan §3.5).
