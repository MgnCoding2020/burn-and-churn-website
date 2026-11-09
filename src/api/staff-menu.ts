import type { Context } from 'hono';
import { z } from 'zod';
import { activityFor, describeEvent } from '../lib/activity';
import {
  bringBack,
  decideRestock,
  liveRestockRequests,
  markSoldOut,
  receiveRestock,
  requestRestock,
  restockHistory,
  type Actor,
} from '../lib/availability';
import { problem } from '../lib/problem';
import { reasonSchema, type Reason } from '../lib/reasons';
import type { AppEnv } from '../server/types';
import type { Define } from './app';

/**
 * Sold-out items and the restock chain (plan §4.4, ADR-0033), and staff
 * activity (everyone, filtered by role, ADR-0032). Every change is audited in
 * the same transaction.
 */

const ITEM_ID = /^[a-z0-9-]{1,40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const Availability = z.strictObject({
  soldOut: z.boolean(),
  reason: reasonSchema('override').optional(),
});
const Restock = z.strictObject({
  itemId: z.string().regex(ITEM_ID),
  quantity: z.string().trim().min(1).max(40),
  note: z.string().trim().max(200).optional(),
});
const Rejection = z.strictObject({ reason: reasonSchema('reject') });

const NOT_WAITING = 'This request is no longer waiting for that step. Reload to see where it is.';

function dbOf(c: Context<AppEnv>): D1Database | undefined {
  return (c.env as unknown as { DB?: D1Database } | undefined)?.DB;
}

function actorOf(c: Context<AppEnv>): Actor {
  const user = c.get('user')!;
  return { userId: user.id, role: user.role!, requestId: c.get('requestId') };
}

function restockId(c: Context<AppEnv>): string | undefined {
  const id = c.req.param('id') ?? '';
  return UUID.test(id) ? id : undefined;
}

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

export function registerStaffMenu(define: Define) {
  // Step 1: mark an item sold out (anyone). Bringing it back outside the chain:
  // its marker within 5 minutes, or a Manager+ with a reason.
  define(
    { method: 'POST', path: '/staff/menu/:itemId/availability', principal: 'Staff.Barista' },
    async (c) => {
      const db = dbOf(c);
      if (!db) return problem(c, 503, 'Service unavailable');
      const itemId = c.req.param('itemId') ?? '';
      if (!ITEM_ID.test(itemId)) return problem(c, 404, 'Not found');
      const parsed = Availability.safeParse(await readJson(c.req.raw));
      if (!parsed.success) return problem(c, 400, 'Bad request');
      const { soldOut, reason } = parsed.data;
      if (soldOut) {
        const outcome = await markSoldOut(db, itemId, actorOf(c));
        if (outcome === 'unknown_item') return problem(c, 404, 'Not found');
        return c.json({ itemId, soldOut: true, changed: outcome === 'changed' });
      }
      const outcome = await bringBack(db, itemId, reason, actorOf(c));
      switch (outcome) {
        case 'unknown_item':
          return problem(c, 404, 'Not found');
        case 'forbidden':
          return problem(
            c,
            403,
            'Forbidden',
            'Only the person who marked it can undo it, within 5 minutes. After that it comes back when its restock is received, or a manager brings it back with a reason.',
          );
        case 'reason_required':
          return problem(c, 400, 'Bad request', 'Give a reason for bringing it back.');
        default:
          return c.json({ itemId, soldOut: false, changed: outcome !== 'unchanged', how: outcome });
      }
    },
  );

  // Live restock requests (requested or approved).
  define({ method: 'GET', path: '/staff/restock', principal: 'Staff.ShiftLead' }, async (c) => {
    const db = dbOf(c);
    if (!db) return problem(c, 503, 'Service unavailable');
    return c.json({ requests: await liveRestockRequests(db) });
  });

  // Every request, newest first: the Manager and Owner review.
  define(
    { method: 'GET', path: '/staff/restock/history', principal: 'Staff.Manager' },
    async (c) => {
      const db = dbOf(c);
      if (!db) return problem(c, 503, 'Service unavailable');
      return c.json({ requests: await restockHistory(db) });
    },
  );

  // Step 2: ask for a sold-out item to be restocked.
  define({ method: 'POST', path: '/staff/restock', principal: 'Staff.ShiftLead' }, async (c) => {
    const db = dbOf(c);
    if (!db) return problem(c, 503, 'Service unavailable');
    const parsed = Restock.safeParse(await readJson(c.req.raw));
    if (!parsed.success) return problem(c, 400, 'Bad request', 'The request is not valid.');
    const result = await requestRestock(db, parsed.data, actorOf(c));
    if (result === 'unknown_item') return problem(c, 404, 'Not found');
    if (result === 'not_sold_out')
      return problem(c, 409, 'Conflict', 'Only a sold-out item can be restocked.');
    if (result === 'already_requested')
      return problem(c, 409, 'Conflict', 'This item already has a restock request.');
    return c.json(result, 201);
  });

  // Step 3: a Manager+ approves or rejects (never their own request, unless Owner).
  for (const decision of ['approve', 'reject'] as const) {
    define(
      { method: 'POST', path: `/staff/restock/:id/${decision}`, principal: 'Staff.Manager' },
      async (c) => {
        const db = dbOf(c);
        if (!db) return problem(c, 503, 'Service unavailable');
        const id = restockId(c);
        if (!id) return problem(c, 404, 'Not found');
        let reason: Reason | undefined;
        if (decision === 'reject') {
          const parsed = Rejection.safeParse(await readJson(c.req.raw));
          if (!parsed.success)
            return problem(c, 400, 'Bad request', 'Give a reason for rejecting the request.');
          reason = parsed.data.reason;
        }
        const outcome = await decideRestock(db, id, decision, reason, actorOf(c));
        if (outcome === 'not_found') return problem(c, 409, 'Conflict', NOT_WAITING);
        if (outcome === 'own_request')
          return problem(
            c,
            403,
            'Forbidden',
            "You can't approve or reject your own request. Another manager, or the owner, decides it.",
          );
        if (outcome === 'reason_required')
          return problem(c, 400, 'Bad request', 'Give a reason for rejecting the request.');
        return c.json({ id, status: outcome });
      },
    );
  }

  // Step 4: the approved stock arrived; the item goes back on sale.
  define(
    { method: 'POST', path: '/staff/restock/:id/received', principal: 'Staff.ShiftLead' },
    async (c) => {
      const db = dbOf(c);
      if (!db) return problem(c, 503, 'Service unavailable');
      const id = restockId(c);
      if (!id) return problem(c, 404, 'Not found');
      const outcome = await receiveRestock(db, id, actorOf(c));
      if (outcome === 'not_found') return problem(c, 409, 'Conflict', NOT_WAITING);
      return c.json({ id, status: 'received', backInStock: outcome.backInStock });
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
