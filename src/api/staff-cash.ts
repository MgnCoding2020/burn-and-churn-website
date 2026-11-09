import type { Context } from 'hono';
import { z } from 'zod';
import {
  closeDrawer,
  DENOMINATIONS,
  explainVariance,
  openDrawer,
  reviewDrawer,
  type Actor,
} from '../lib/cash';
import { problem } from '../lib/problem';
import { reasonSchema } from '../lib/reasons';
import type { AppEnv } from '../server/types';
import type { Define } from './app';

/**
 * The cash drawer (plan §4.4, ADR-0034): Shift Lead+ opens it, closes it with
 * a blind count and explains a variance; Manager+ reviews counts that were
 * off, never their own unless Owner.
 */

const DRAWER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const Open = z.strictObject({ floatCents: z.number().int().min(0).max(100_000) });
const Close = z.strictObject({
  counts: z.strictObject(
    Object.fromEntries(
      DENOMINATIONS.map((d) => [String(d.cents), z.number().int().min(0).max(5_000)]),
    ),
  ),
});
const Explain = z.strictObject({ reason: reasonSchema('variance') });

function dbOf(c: Context<AppEnv>): D1Database | undefined {
  return (c.env as unknown as { DB?: D1Database } | undefined)?.DB;
}

function actorOf(c: Context<AppEnv>): Actor {
  const user = c.get('user')!;
  return { userId: user.id, role: user.role!, requestId: c.get('requestId') };
}

function drawerId(c: Context<AppEnv>): string | undefined {
  const id = c.req.param('id') ?? '';
  return DRAWER_ID.test(id) ? id : undefined;
}

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

export function registerStaffCash(define: Define) {
  define({ method: 'POST', path: '/staff/cash/open', principal: 'Staff.ShiftLead' }, async (c) => {
    const db = dbOf(c);
    if (!db) return problem(c, 503, 'Service unavailable');
    const parsed = Open.safeParse(await readJson(c.req.raw));
    if (!parsed.success) return problem(c, 400, 'Bad request', 'The float is not valid.');
    const result = await openDrawer(db, parsed.data.floatCents, actorOf(c));
    if (result === 'already_open')
      return problem(c, 409, 'Conflict', 'A drawer is already open. Close it first.');
    return c.json(result, 201);
  });

  // A blind count: the expected amount comes back only after the count is saved.
  define(
    { method: 'POST', path: '/staff/cash/:id/close', principal: 'Staff.ShiftLead' },
    async (c) => {
      const db = dbOf(c);
      if (!db) return problem(c, 503, 'Service unavailable');
      const id = drawerId(c);
      if (!id) return problem(c, 404, 'Not found');
      const parsed = Close.safeParse(await readJson(c.req.raw));
      if (!parsed.success) return problem(c, 400, 'Bad request', 'The count is not valid.');
      const result = await closeDrawer(db, id, parsed.data.counts, actorOf(c));
      if (result === 'not_open')
        return problem(c, 409, 'Conflict', 'This drawer is already closed. Reload the page.');
      return c.json(result);
    },
  );

  define(
    { method: 'POST', path: '/staff/cash/:id/explain', principal: 'Staff.ShiftLead' },
    async (c) => {
      const db = dbOf(c);
      if (!db) return problem(c, 503, 'Service unavailable');
      const id = drawerId(c);
      if (!id) return problem(c, 404, 'Not found');
      const parsed = Explain.safeParse(await readJson(c.req.raw));
      if (!parsed.success) return problem(c, 400, 'Bad request', 'Choose a reason.');
      const outcome = await explainVariance(db, id, parsed.data.reason, actorOf(c));
      if (outcome === 'not_found') return problem(c, 404, 'Not found');
      if (outcome === 'forbidden')
        return problem(
          c,
          403,
          'Forbidden',
          'Only the person who closed the drawer, or a manager, can explain its count.',
        );
      if (outcome === 'not_needed')
        return problem(c, 409, 'Conflict', 'This count doesn’t need an explanation.');
      return c.json({ id, explained: true });
    },
  );

  define(
    { method: 'POST', path: '/staff/cash/:id/review', principal: 'Staff.Manager' },
    async (c) => {
      const db = dbOf(c);
      if (!db) return problem(c, 503, 'Service unavailable');
      const id = drawerId(c);
      if (!id) return problem(c, 404, 'Not found');
      const outcome = await reviewDrawer(db, id, actorOf(c));
      switch (outcome) {
        case 'not_found':
          return problem(c, 404, 'Not found');
        case 'own_count':
          return problem(
            c,
            403,
            'Forbidden',
            'You closed this drawer, so you can’t review its count. Another manager, or the owner, can.',
          );
        case 'needs_explanation':
          return problem(c, 409, 'Conflict', 'The count needs a reason before it can be reviewed.');
        case 'nothing_to_review':
          return problem(c, 409, 'Conflict', 'This count has nothing to review.');
        default:
          return c.json({ id, reviewed: true });
      }
    },
  );
}
