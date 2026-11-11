import type { Context } from 'hono';
import { z } from 'zod';
import { currentMenu } from '../lib/availability';
import {
  cancelCardPayment,
  refreshCardPayment,
  retryCardPayment,
  simulateTap,
  startCardPayment,
  type ActionOutcome,
  type Actor,
  type CardPayment,
} from '../lib/card-payments';
import { priceOrder } from '../lib/orders';
import { problem } from '../lib/problem';
import { stripeConfig } from '../lib/stripe';
import { stripeTerminal, type TerminalGateway } from '../lib/terminal';
import type { AppEnv } from '../server/types';
import type { Define } from './app';

/**
 * Card payments at the counter through the simulated reader (plan §6.2,
 * ADR-0036). Barista and up: anyone ringing a sale can take a card. "Simulate
 * tap" exists only because the reader is simulated (Stripe's test helper has
 * no live-mode equivalent); every use is audited.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const CardOrder = z.strictObject({
  idempotencyKey: z.uuid(),
  lines: z
    .array(
      z.strictObject({
        itemId: z.string().regex(/^[a-z0-9-]{1,40}$/),
        variantId: z.string().regex(/^[a-z0-9-]{1,20}$/),
        qty: z.number().int().min(1).max(20),
      }),
    )
    .min(1)
    .max(20),
});
const Tap = z.strictObject({ card: z.enum(['approve', 'decline']) });

function dbOf(c: Context<AppEnv>): D1Database | undefined {
  return (c.env as unknown as { DB?: D1Database } | undefined)?.DB;
}

/** The reader, or undefined where Stripe isn't set up (previews, tests without keys). */
function terminal(c: Context<AppEnv>): { gateway: TerminalGateway; readerId: string } | undefined {
  const config = stripeConfig(c.env as unknown as Record<string, unknown>);
  if (!config?.terminalReaderId) return undefined;
  return { gateway: stripeTerminal(config), readerId: config.terminalReaderId };
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

const NOT_SET_UP = 'Card payments aren’t set up in this environment. Take cash instead.';

/** What the register shows. No card details exist to show. */
const view = (p: CardPayment) => ({
  id: p.id,
  status: p.status,
  totalCents: p.totalCents,
  failureCode: p.failureCode,
  orderNumber: p.orderNumber,
  orderId: p.orderId,
});

function actionProblem(c: Context<AppEnv>, outcome: ActionOutcome) {
  switch (outcome) {
    case 'not_found':
      return problem(c, 404, 'Not found');
    case 'wrong_state':
      return problem(c, 409, 'Conflict', 'The payment has moved on. Check its status.');
    case 'reader_busy':
      return problem(c, 409, 'Conflict', 'The card reader is busy with another payment.');
    case 'reader_offline':
    case 'reader_timeout':
      return problem(c, 503, 'Service unavailable', 'The card reader isn’t responding. Try again.');
    default:
      return problem(c, 502, 'Bad gateway', 'Stripe didn’t accept that. Try again, or take cash.');
  }
}

export function registerStaffCard(define: Define) {
  // Start a card payment: price the order on the server and send it to the reader.
  define(
    { method: 'POST', path: '/staff/card-payments', principal: 'Staff.Barista', limit: 'payments' },
    async (c) => {
      const db = dbOf(c);
      if (!db) return problem(c, 503, 'Service unavailable');
      const t = terminal(c);
      if (!t) return problem(c, 503, 'Service unavailable', NOT_SET_UP);
      const parsed = CardOrder.safeParse(await readJson(c.req.raw));
      if (!parsed.success) return problem(c, 400, 'Bad request', 'The order is not valid.');
      const priced = priceOrder(parsed.data.lines, await currentMenu(db));
      if (!priced.ok) {
        const detail =
          priced.error === 'unavailable'
            ? 'An item in the order is sold out.'
            : 'An item in the order is not on the menu.';
        return problem(c, 422, 'Unprocessable order', detail);
      }
      const result = await startCardPayment(
        db,
        t.gateway,
        {
          idempotencyKey: parsed.data.idempotencyKey,
          readerId: t.readerId,
          lines: priced.lines,
          totalCents: priced.totalCents,
        },
        actorOf(c),
      );
      if ('error' in result && !('payment' in result))
        return problem(c, 409, 'Conflict', 'That order key was already used.');
      if (result.error) return actionProblem(c, result.error);
      return c.json(view(result.payment), 201);
    },
  );

  // Where the payment stands. Asks Stripe directly if the webhook is late.
  define(
    { method: 'GET', path: '/staff/card-payments/:id', principal: 'Staff.Barista' },
    async (c) => {
      const db = dbOf(c);
      if (!db) return problem(c, 503, 'Service unavailable');
      const id = c.req.param('id') ?? '';
      if (!UUID.test(id)) return problem(c, 404, 'Not found');
      const payment = await refreshCardPayment(db, terminal(c)?.gateway, id, c.get('requestId'));
      if (!payment) return problem(c, 404, 'Not found');
      return c.json(view(payment));
    },
  );

  // Test mode: the simulated reader "sees" a Stripe test card (approved or declined).
  define(
    {
      method: 'POST',
      path: '/staff/card-payments/:id/simulate-tap',
      principal: 'Staff.Barista',
      limit: 'payments',
    },
    async (c) => {
      const db = dbOf(c);
      if (!db) return problem(c, 503, 'Service unavailable');
      const t = terminal(c);
      if (!t) return problem(c, 503, 'Service unavailable', NOT_SET_UP);
      const id = c.req.param('id') ?? '';
      if (!UUID.test(id)) return problem(c, 404, 'Not found');
      const parsed = Tap.safeParse(await readJson(c.req.raw));
      if (!parsed.success) return problem(c, 400, 'Bad request');
      const outcome = await simulateTap(db, t.gateway, id, parsed.data.card, actorOf(c));
      if (outcome !== 'ok') return actionProblem(c, outcome);
      return c.json({ id, tapped: parsed.data.card });
    },
  );

  // After a decline: ask for another card on the same payment.
  define(
    {
      method: 'POST',
      path: '/staff/card-payments/:id/retry',
      principal: 'Staff.Barista',
      limit: 'payments',
    },
    async (c) => {
      const db = dbOf(c);
      if (!db) return problem(c, 503, 'Service unavailable');
      const t = terminal(c);
      if (!t) return problem(c, 503, 'Service unavailable', NOT_SET_UP);
      const id = c.req.param('id') ?? '';
      if (!UUID.test(id)) return problem(c, 404, 'Not found');
      const outcome = await retryCardPayment(db, t.gateway, id);
      if (outcome !== 'ok') return actionProblem(c, outcome);
      return c.json({ id, status: 'waiting' });
    },
  );

  // Stop: the customer changed their mind or pays another way.
  define(
    {
      method: 'POST',
      path: '/staff/card-payments/:id/cancel',
      principal: 'Staff.Barista',
      limit: 'payments',
    },
    async (c) => {
      const db = dbOf(c);
      if (!db) return problem(c, 503, 'Service unavailable');
      const t = terminal(c);
      if (!t) return problem(c, 503, 'Service unavailable', NOT_SET_UP);
      const id = c.req.param('id') ?? '';
      if (!UUID.test(id)) return problem(c, 404, 'Not found');
      const outcome = await cancelCardPayment(db, t.gateway, id, actorOf(c));
      if (outcome !== 'ok') return actionProblem(c, outcome);
      return c.json({ id, status: 'canceled' });
    },
  );
}
