import type { Context } from 'hono';
import type { Actor } from '../lib/availability';
import { graphConfig, graphReader } from '../lib/graph';
import { problem } from '../lib/problem';
import { SYNCED_LISTS } from '../lib/sharepoint';
import { recentSyncRuns, runSync } from '../lib/sync';
import type { AppEnv } from '../server/types';
import type { Define } from './app';

/**
 * Publishing from SharePoint (plan §5, ADR-0039): a Manager+ runs the sync now
 * instead of waiting for the 15-minute cron, and sees how recent runs went.
 */

function dbOf(c: Context<AppEnv>): D1Database | undefined {
  return (c.env as unknown as { DB?: D1Database } | undefined)?.DB;
}

function actorOf(c: Context<AppEnv>): Actor {
  const user = c.get('user')!;
  return { userId: user.id, role: user.role!, requestId: c.get('requestId') };
}

export function registerStaffSharePoint(define: Define) {
  define(
    {
      method: 'POST',
      path: '/staff/sharepoint/publish',
      principal: 'Staff.Manager',
      limit: 'publish',
    },
    async (c) => {
      const db = dbOf(c);
      if (!db) return problem(c, 503, 'Service unavailable');
      const cfg = graphConfig(
        c.env as unknown as Record<string, unknown>,
        Object.keys(SYNCED_LISTS),
      );
      if (!cfg)
        return problem(
          c,
          503,
          'Service unavailable',
          'Publishing from SharePoint isn’t set up in this environment.',
        );
      const result = await runSync(db, graphReader(cfg), cfg.lists, {
        kind: 'publish',
        actor: actorOf(c),
      });
      if (result === 'busy')
        return problem(c, 409, 'Conflict', 'A sync is already running. Wait a minute and reload.');
      return c.json(result);
    },
  );

  define(
    { method: 'GET', path: '/staff/sharepoint/runs', principal: 'Staff.Manager' },
    async (c) => {
      const db = dbOf(c);
      if (!db) return problem(c, 503, 'Service unavailable');
      return c.json({ runs: await recentSyncRuns(db) });
    },
  );
}
