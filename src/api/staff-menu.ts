import type { Context } from 'hono';
import { z } from 'zod';
import { activityFor, describeEvent } from '../lib/activity';
import {
  completeRestock,
  openRestockRequests,
  requestRestock,
  setSoldOut,
  type Actor,
} from '../lib/availability';
import { problem } from '../lib/problem';
import type { AppEnv } from '../server/types';
import type { Define } from './app';

/**
 * "86" an item (Shift Lead+), restock requests (Manager+) and staff activity
 * (everyone, filtered by role), plan §4.4 and ADR-0032. Every change is
 * audited in the same transaction.
 */

const ITEM_ID = /^[a-z0-9-]{1,40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const Availability = z.strictObject({ soldOut: z.boolean() });
const Restock = z.strictObject({
  itemId: z.string().regex(ITEM_ID),
  quantity: z.string().trim().min(1).max(40),
  note: z.string().trim().max(200).optional(),
});

function dbOf(c: Context<AppEnv>): D1Database | undefined {
  return (c.env as unknown as { DB?: D1Database } | undefined)?.DB;
}

function actorOf(c: Context<AppEnv>): Actor {
  const user = c.get('user')!;
  return { userId: user.id, role: user.role!, requestId: c.get('requestId') };
}

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

export function registerStaffMenu(define: Define) {
  // 86 an item for today, or bring it back.
  define(
    { method: 'POST', path: '/staff/menu/:itemId/availability', principal: 'Staff.ShiftLead' },
    async (c) => {
      const db = dbOf(c);
      if (!db) return problem(c, 503, 'Service unavailable');
      const itemId = c.req.param('itemId') ?? '';
      if (!ITEM_ID.test(itemId)) return problem(c, 404, 'Not found');
      const parsed = Availability.safeParse(await readJson(c.req.raw));
      if (!parsed.success) return problem(c, 400, 'Bad request');
      const outcome = await setSoldOut(db, itemId, parsed.data.soldOut, actorOf(c));
      if (outcome === 'unknown_item') return problem(c, 404, 'Not found');
      return c.json({ itemId, soldOut: parsed.data.soldOut, changed: outcome === 'changed' });
    },
  );

  // Open restock requests.
  define({ method: 'GET', path: '/staff/restock', principal: 'Staff.Manager' }, async (c) => {
    const db = dbOf(c);
    if (!db) return problem(c, 503, 'Service unavailable');
    return c.json({ requests: await openRestockRequests(db) });
  });

  // Ask for a sold-out item to be restocked.
  define({ method: 'POST', path: '/staff/restock', principal: 'Staff.Manager' }, async (c) => {
    const db = dbOf(c);
    if (!db) return problem(c, 503, 'Service unavailable');
    const parsed = Restock.safeParse(await readJson(c.req.raw));
    if (!parsed.success) return problem(c, 400, 'Bad request', 'The request is not valid.');
    const result = await requestRestock(db, parsed.data, actorOf(c));
    if (result === 'unknown_item') return problem(c, 404, 'Not found');
    return c.json(result, 201);
  });

  // Stock arrived: close the request.
  define(
    { method: 'POST', path: '/staff/restock/:id/done', principal: 'Staff.Manager' },
    async (c) => {
      const db = dbOf(c);
      if (!db) return problem(c, 503, 'Service unavailable');
      const id = c.req.param('id') ?? '';
      if (!UUID.test(id)) return problem(c, 404, 'Not found');
      const outcome = await completeRestock(db, id, actorOf(c));
      if (outcome === 'not_found') return problem(c, 404, 'Not found');
      return c.json({ id, status: 'done' });
    },
  );

  // Staff activity this person may see (their own, and everyone below their role).
  define({ method: 'GET', path: '/staff/activity', principal: 'Staff.Barista' }, async (c) => {
    const db = dbOf(c);
    if (!db) return problem(c, 503, 'Service unavailable');
    const beforeParam = c.req.query('before');
    const before = beforeParam && /^\d{1,15}$/.test(beforeParam) ? Number(beforeParam) : undefined;
    const user = c.get('user')!;
    const events = await activityFor(db, { id: user.id, role: user.role! }, before);
    return c.json({
      events: events.map((e) => ({ ...e, summary: describeEvent(e) })),
      next: events.length ? events[events.length - 1]!.id : null,
    });
  });
}
