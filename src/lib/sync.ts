import { auditStatement } from './audit';
import type { Actor } from './availability';
import { GraphError, type GraphReader } from './graph';
import { SYNCED_LISTS, type Rejected, type SyncedList } from './sharepoint';

/**
 * The SharePoint sync (plan §5, ADR-0039): read each list through Graph, validate
 * every row, and publish the good rows as that list's snapshot in D1. A list that
 * can't be read, or has nothing valid to publish, keeps its last good copy. Every
 * run is recorded in `sync_runs`; a manager's Publish is also audited. The website
 * never writes to SharePoint.
 */

export type SyncStatus = 'ok' | 'partial' | 'failed';

export interface ListSummary {
  read: number;
  published: number;
  rejected: Rejected[];
  /** Why nothing was published, when the last good copy was kept. */
  error?: string;
}

export interface SyncRun {
  id: string;
  triggerKind: 'cron' | 'publish';
  triggeredBy: string | null;
  startedAt: number;
  finishedAt: number | null;
  status: 'running' | SyncStatus;
  summary: Partial<Record<SyncedList, ListSummary>> | null;
}

/** A run left "running" longer than this (a crashed Worker) no longer blocks the next one. */
export const STALE_RUN_MS = 5 * 60 * 1000;
/** Sync runs are kept 90 days, like orders (src/server/scheduled.ts). */
export const SYNC_RUN_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export type Trigger = { kind: 'cron' } | { kind: 'publish'; actor: Actor };

function errorText(err: unknown): string {
  if (err instanceof GraphError) {
    if (err.status === 403) return 'access refused by SharePoint (403)';
    if (err.status === 404) return 'list not found (404)';
    return `SharePoint error ${err.status}`;
  }
  // Never the message itself: it could carry details not meant for the page.
  return 'SharePoint could not be reached';
}

/**
 * Runs one sync. Returns 'busy' if another run started less than five minutes ago
 * and hasn't finished. `listIds` maps contract list names to SharePoint list IDs;
 * a list without an ID is reported as not set up.
 */
export async function runSync(
  db: D1Database,
  reader: GraphReader,
  listIds: Partial<Record<string, string>>,
  trigger: Trigger,
  now = Date.now(),
): Promise<{ id: string; status: SyncStatus; summary: Record<SyncedList, ListSummary> } | 'busy'> {
  const id = crypto.randomUUID();
  const actorId = trigger.kind === 'publish' ? trigger.actor.userId : null;
  const started = await db
    .prepare(
      `INSERT INTO sync_runs (id, trigger_kind, triggered_by, started_at)
       SELECT ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM sync_runs WHERE status = 'running' AND started_at > ?)`,
    )
    .bind(id, trigger.kind, actorId, now, now - STALE_RUN_MS)
    .run();
  if ((started.meta.changes ?? 0) === 0) return 'busy';

  const summary = {} as Record<SyncedList, ListSummary>;
  const writes: D1PreparedStatement[] = [];
  for (const [list, convert] of Object.entries(SYNCED_LISTS) as [
    SyncedList,
    (typeof SYNCED_LISTS)[SyncedList],
  ][]) {
    const listId = listIds[list];
    if (!listId) {
      summary[list] = { read: 0, published: 0, rejected: [], error: 'not set up' };
      continue;
    }
    try {
      const result = convert(await reader.listItems(listId));
      summary[list] = {
        read: result.read,
        published: result.published,
        rejected: result.rejected,
        ...(result.publishable ? {} : { error: 'nothing valid to publish' }),
      };
      if (result.publishable) {
        writes.push(
          db
            .prepare(
              `INSERT INTO sharepoint_snapshots (list, data, item_count, synced_at, run_id)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT (list) DO UPDATE SET data = excluded.data,
                 item_count = excluded.item_count, synced_at = excluded.synced_at,
                 run_id = excluded.run_id`,
            )
            .bind(list, JSON.stringify(result.data), result.published, now, id),
        );
      }
    } catch (err) {
      summary[list] = { read: 0, published: 0, rejected: [], error: errorText(err) };
    }
  }

  const lists = Object.values(summary);
  const status: SyncStatus = lists.every((l) => l.error)
    ? 'failed'
    : lists.some((l) => l.error || l.rejected.length)
      ? 'partial'
      : 'ok';
  writes.push(
    db
      .prepare('UPDATE sync_runs SET finished_at = ?, status = ?, summary = ? WHERE id = ?')
      .bind(Date.now(), status, JSON.stringify(summary), id),
  );
  if (trigger.kind === 'publish') {
    const { actor } = trigger;
    writes.push(
      auditStatement(db, {
        requestId: actor.requestId,
        actorUserId: actor.userId,
        actorRole: actor.role,
        action: 'sharepoint.publish',
        target: id,
        // Counts only: rejected rows' reasons stay in sync_runs.
        after: {
          status,
          lists: Object.fromEntries(
            Object.entries(summary).map(([k, v]) => [
              k,
              { published: v.published, rejected: v.rejected.length, error: v.error ?? null },
            ]),
          ),
        },
      }),
    );
  }
  await db.batch(writes);
  return { id, status, summary };
}

interface RunRow {
  id: string;
  trigger_kind: 'cron' | 'publish';
  triggered_by_name: string | null;
  started_at: number;
  finished_at: number | null;
  status: SyncRun['status'];
  summary: string | null;
}

/** The latest runs, newest first, with the publishing manager's name. */
export async function recentSyncRuns(db: D1Database, limit = 20): Promise<SyncRun[]> {
  const { results } = await db
    .prepare(
      `SELECT r.id, r.trigger_kind, u.display_name AS triggered_by_name, r.started_at,
              r.finished_at, r.status, r.summary
       FROM sync_runs r LEFT JOIN users u ON u.id = r.triggered_by
       ORDER BY r.started_at DESC LIMIT ?`,
    )
    .bind(limit)
    .all<RunRow>();
  return results.map((r) => ({
    id: r.id,
    triggerKind: r.trigger_kind,
    triggeredBy: r.triggered_by_name,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    status: r.status,
    summary: r.summary ? (JSON.parse(r.summary) as SyncRun['summary']) : null,
  }));
}

/** Each list's published copy: when it was synced and how many rows it holds. */
export async function snapshotStatus(
  db: D1Database,
): Promise<{ list: SyncedList; itemCount: number; syncedAt: number }[]> {
  const { results } = await db
    .prepare('SELECT list, item_count, synced_at FROM sharepoint_snapshots ORDER BY list')
    .all<{ list: SyncedList; item_count: number; synced_at: number }>();
  return results.map((r) => ({ list: r.list, itemCount: r.item_count, syncedAt: r.synced_at }));
}

/** A list's last good copy, or undefined if it has never synced. */
export async function readSnapshot<T>(db: D1Database, list: SyncedList): Promise<T | undefined> {
  const row = await db
    .prepare('SELECT data FROM sharepoint_snapshots WHERE list = ?')
    .bind(list)
    .first<{ data: string }>();
  return row ? (JSON.parse(row.data) as T) : undefined;
}
