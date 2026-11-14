import type { Context } from 'hono';
import { customerCheckout, parseLines, startCheckout, stripeCheckout } from '../lib/checkout';
import { getMenuSnapshot } from '../lib/menu';
import { problem } from '../lib/problem';
import { stripeConfig } from '../lib/stripe';
import type { AppEnv } from '../server/types';
import type { Define } from './app';

/**
 * Online orders (plan §6.1, ADR-0044): a signed-in customer pays through
 * Stripe Checkout. Both routes are the customer's own: staff sessions are
 * refused, and one customer can never see another's checkout.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function setup(c: Context<AppEnv>) {
  const env = c.env as unknown as Record<string, unknown> | undefined;
  const config = stripeConfig(env);
  return {
    db: env?.DB as D1Database | undefined,
    gateway: config ? stripeCheckout(config) : undefined,
  };
}

const itemName = (id: string) => getMenuSnapshot().items.find((i) => i.id === id)?.name ?? id;

export function registerCustomerCheckout(define: Define) {
  // Starts a payment: the server prices the cart, Stripe hosts the payment page.
  define(
    { method: 'POST', path: '/checkout', principal: 'customer', limit: 'payments' },
    async (c) => {
      const { db, gateway } = setup(c);
      if (!db || !gateway) {
        return problem(c, 503, 'Service unavailable', "Paying online isn't set up here yet.");
      }
      const body = (await c.req.json().catch(() => undefined)) as
        { key?: unknown; lines?: unknown } | undefined;
      const lines = parseLines(body?.lines);
      if (typeof body?.key !== 'string' || !UUID.test(body.key) || !lines) {
        return problem(c, 400, 'Bad request', 'That order could not be read.');
      }
      const outcome = await startCheckout(db, gateway, {
        userId: c.get('user')!.id,
        lines,
        key: body.key.toLowerCase(),
        origin: new URL(c.req.url).origin,
      });
      if (outcome.ok) return c.json({ id: outcome.checkoutId, url: outcome.url }, 201);
      switch (outcome.error) {
        case 'unavailable':
          return problem(c, 409, 'Conflict', `${itemName(outcome.itemId)} is sold out today.`);
        case 'unknown_item':
        case 'unknown_variant':
          return problem(c, 409, 'Conflict', 'Something in your order is no longer on the menu.');
        case 'duplicate':
          return problem(c, 409, 'Conflict', 'That payment was already started. Please try again.');
        case 'stripe':
          return problem(c, 502, 'Bad gateway', "Stripe didn't accept that. Please try again.");
      }
    },
  );

  // The status page's check: the customer's own checkout only.
  define({ method: 'GET', path: '/checkout/:id', principal: 'customer' }, async (c) => {
    const { db, gateway } = setup(c);
    if (!db) return problem(c, 503, 'Service unavailable');
    const id = c.req.param('id') ?? '';
    if (!UUID.test(id)) return problem(c, 404, 'Not found');
    const view = await customerCheckout(db, gateway, id.toLowerCase(), c.get('user')!.id);
    return view ? c.json(view) : problem(c, 404, 'Not found');
  });
}
