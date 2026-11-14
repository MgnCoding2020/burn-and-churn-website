import Stripe from 'stripe';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_BASE, createApi } from '../../src/api/app';
import { markSoldOut } from '../../src/lib/availability';
import {
  ASK_STRIPE_AFTER_MS,
  completeCheckout,
  expireCheckout,
  type CheckoutGateway,
} from '../../src/lib/checkout';
import { getMenuSnapshot } from '../../src/lib/menu';
import { listBoard } from '../../src/lib/orders';
import { createSession, SESSION_COOKIE } from '../../src/lib/session';
import { upsertUser } from '../../src/lib/users';
import { buildApp } from '../../src/server/app';
import { testDb } from '../setup/db';

// Online orders through Stripe Checkout (ADR-0044), against a stand-in for Stripe.

const ORIGIN = 'http://localhost';
const SECRET = ['whsec', 'testonlynotarealsecret0000000000'].join('_');

let created: Parameters<CheckoutGateway['create']>[0][] = [];
let sessionStates = new Map<string, Awaited<ReturnType<CheckoutGateway['state']>>>();
let createFails = false;
let sessionCounter = 0;

const fakeGateway: CheckoutGateway = {
  async create(input) {
    if (createFails) throw new Error('stripe down');
    created.push(input);
    sessionCounter += 1;
    const id = `cs_test_${sessionCounter}`;
    return { sessionId: id, url: `https://checkout.stripe.com/c/pay/${id}` };
  },
  async state(sessionId) {
    return sessionStates.get(sessionId) ?? { status: 'open', paid: false };
  },
};

vi.mock('../../src/lib/checkout', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/checkout')>();
  return { ...real, stripeCheckout: () => fakeGateway };
});

let db: D1Database;
let env: Env;
beforeAll(async () => {
  db = await testDb();
  env = {
    APP_ENV: 'local',
    DB: db,
    STRIPE_API_KEY: ['rk', 'test', 'testonlynotarealkey'].join('_'),
    STRIPE_WEBHOOK_SECRET: SECRET,
  } as unknown as Env;
});
beforeEach(() => {
  created = [];
  sessionStates = new Map();
  createFails = false;
});

const menu = getMenuSnapshot();
const drink = menu.items.find((i) => i.available && i.variants.length === 3)!;
const size = drink.variants.find((v) => v.id === '16oz')!;

async function customer(sub: string) {
  const id = await upsertUser(db, { idp: 'customer', sub, displayName: 'Avery Test' });
  const s = await createSession(db, { userId: id, idp: 'customer' });
  return { id, cookie: `${SESSION_COOKIE}=${s.token}` };
}

const app = () => buildApp({ log: false });
const pay = (cookie: string, body: unknown, e: Env = env) =>
  app().request(
    `${ORIGIN}${API_BASE}/checkout`,
    {
      method: 'POST',
      headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    e,
  );
const status = (cookie: string, id: string) =>
  app().request(`${ORIGIN}${API_BASE}/checkout/${id}`, { headers: { Cookie: cookie } }, env);

const cartBody = (key = crypto.randomUUID(), qty = 2) => ({
  key,
  lines: [{ itemId: drink.id, variantId: '16oz', qty, priceCents: 1 }],
});

async function checkoutRow(id: string) {
  return db
    .prepare('SELECT status, total_cents, session_id, order_id FROM online_checkouts WHERE id = ?')
    .bind(id)
    .first<{
      status: string;
      total_cents: number;
      session_id: string | null;
      order_id: string | null;
    }>();
}

describe('route principals', () => {
  it('both routes are for customers only; starting a payment has the payments limit', () => {
    expect(createApi().routes.filter((r) => r.path.startsWith('/checkout'))).toEqual([
      { method: 'POST', path: '/checkout', principal: 'customer', limit: 'payments' },
      { method: 'GET', path: '/checkout/:id', principal: 'customer' },
    ]);
  });

  it('refuses the signed-out (401), staff (403) and other sites (Origin check)', async () => {
    expect((await pay('', cartBody())).status).toBe(401);
    const staffId = await upsertUser(db, {
      idp: 'workforce',
      sub: '88888888-0000-4000-8000-000000000001',
      displayName: 'Olivia Carter',
      role: 'Staff.Owner',
    });
    const staff = await createSession(db, {
      userId: staffId,
      idp: 'workforce',
      role: 'Staff.Owner',
    });
    expect((await pay(`${SESSION_COOKIE}=${staff.token}`, cartBody())).status).toBe(403);
    const { cookie } = await customer('11111111-cccc-4000-8000-000000000001');
    const cross = await app().request(
      `${ORIGIN}${API_BASE}/checkout`,
      {
        method: 'POST',
        headers: {
          Cookie: cookie,
          Origin: 'https://evil.example',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(cartBody()),
      },
      env,
    );
    expect(cross.status).toBe(403);
    expect(created).toEqual([]);
  });
});

describe('POST /checkout', () => {
  it("prices the cart on the server (the browser's price is ignored) and returns Stripe's page", async () => {
    const { cookie } = await customer('11111111-cccc-4000-8000-000000000002');
    const res = await pay(cookie, cartBody());
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; url: string };
    expect(body.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    expect(created).toHaveLength(1);
    expect(created[0]!.lines).toEqual([
      {
        itemId: drink.id,
        variantId: '16oz',
        qty: 2,
        name: drink.name,
        variantLabel: size.label,
        unitPriceCents: size.priceCents,
      },
    ]);
    expect(created[0]!.successUrl).toBe(`${ORIGIN}/order/status/?id=${body.id}`);
    expect(created[0]!.cancelUrl).toBe(`${ORIGIN}/order/`);
    expect(await checkoutRow(body.id)).toMatchObject({
      status: 'open',
      total_cents: size.priceCents * 2,
      order_id: null,
    });
  });

  it('a repeated key (double-click) returns the same payment page, never a second session', async () => {
    const { cookie } = await customer('11111111-cccc-4000-8000-000000000003');
    const key = crypto.randomUUID();
    const a = (await (await pay(cookie, cartBody(key))).json()) as { url: string };
    const b = (await (await pay(cookie, cartBody(key))).json()) as { url: string };
    expect(b.url).toBe(a.url);
    expect(created).toHaveLength(1);
  });

  it('refuses a sold-out drink by name, and starts nothing', async () => {
    const soldOut = menu.items.filter((i) => i.available && i.id !== drink.id)[2]!;
    const staffId = await upsertUser(db, {
      idp: 'workforce',
      sub: '88888888-0000-4000-8000-000000000002',
      displayName: 'Ethan Brooks',
      role: 'Staff.Barista',
    });
    await markSoldOut(db, soldOut.id, { userId: staffId, role: 'Staff.Barista', requestId: 't' });
    const { cookie } = await customer('11111111-cccc-4000-8000-000000000004');
    const res = await pay(cookie, {
      key: crypto.randomUUID(),
      lines: [{ itemId: soldOut.id, variantId: soldOut.variants[0]!.id, qty: 1 }],
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { detail: string }).detail).toBe(
      `${soldOut.name} is sold out today.`,
    );
    expect(created).toEqual([]);
  });

  it.each([
    ['no key', { lines: [{ itemId: 'latte', variantId: '16oz', qty: 1 }] }],
    ['no lines', { key: crypto.randomUUID(), lines: [] }],
    [
      'a quantity over 20',
      { key: crypto.randomUUID(), lines: [{ itemId: 'latte', variantId: '16oz', qty: 21 }] },
    ],
    [
      'an unknown size',
      { key: crypto.randomUUID(), lines: [{ itemId: 'latte', variantId: 'xl', qty: 1 }] },
    ],
  ])('refuses %s (400)', async (_l, body) => {
    const { cookie } = await customer(
      `11111111-cccc-4000-8000-0000000001${String(Math.random()).slice(2, 4)}`,
    );
    expect((await pay(cookie, body)).status).toBe(400);
    expect(created).toEqual([]);
  });

  it('reports Stripe refusing (502) and marks the attempt failed', async () => {
    const { cookie } = await customer('11111111-cccc-4000-8000-000000000005');
    createFails = true;
    const res = await pay(cookie, cartBody());
    expect(res.status).toBe(502);
    const row = await db
      .prepare(`SELECT status FROM online_checkouts ORDER BY created_at DESC LIMIT 1`)
      .first<{ status: string }>();
    expect(row!.status).toBe('failed');
  });

  it('is not configured without a Stripe key (503)', async () => {
    const { cookie } = await customer('11111111-cccc-4000-8000-000000000006');
    const res = await pay(cookie, cartBody(), { APP_ENV: 'local', DB: db } as unknown as Env);
    expect(res.status).toBe(503);
  });
});

describe('payment confirmed: the order is created once', () => {
  async function started(sub: string) {
    const c = await customer(sub);
    const { id } = (await (await pay(c.cookie, cartBody())).json()) as { id: string };
    const row = await checkoutRow(id);
    return { ...c, checkoutId: id, sessionId: row!.session_id! };
  }

  it('by a signed webhook: an ONLINE card order for this customer on the board; a replay does nothing', async () => {
    const {
      id: userId,
      checkoutId,
      sessionId,
    } = await started('11111111-cccc-4000-8000-000000000007');
    const payload = JSON.stringify({
      id: `evt_test_${crypto.randomUUID().replaceAll('-', '')}`,
      object: 'event',
      type: 'checkout.session.completed',
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      api_version: '2026-10-28.endive',
      data: {
        object: {
          id: sessionId,
          object: 'checkout.session',
          status: 'complete',
          payment_status: 'paid',
          payment_intent: 'pi_test_online_1',
        },
      },
    });
    const deliver = async () =>
      app().request(
        `${ORIGIN}${API_BASE}/webhooks/stripe`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Stripe-Signature': await Stripe.webhooks.generateTestHeaderStringAsync({
              payload,
              secret: SECRET,
            }),
          },
          body: payload,
        },
        env,
      );
    expect((await deliver()).status).toBe(200);
    expect((await deliver()).status).toBe(200);

    const order = await db
      .prepare(
        `SELECT o.channel, o.tender, o.stage, o.customer_id, o.taken_by, o.total_cents, o.payment_intent_id
         FROM online_checkouts c JOIN orders o ON o.id = c.order_id WHERE c.id = ?`,
      )
      .bind(checkoutId)
      .first();
    expect(order).toEqual({
      channel: 'online',
      tender: 'card',
      stage: 'new',
      customer_id: userId,
      taken_by: null,
      total_cents: size.priceCents * 2,
      payment_intent_id: 'pi_test_online_1',
    });
    const count = await db
      .prepare(`SELECT COUNT(*) AS n FROM orders WHERE payment_intent_id = 'pi_test_online_1'`)
      .first<{ n: number }>();
    expect(count!.n).toBe(1);
    expect((await listBoard(db)).some((o) => o.channel === 'online')).toBe(true);
  });

  it('by the status check asking Stripe, when the webhook is late', async () => {
    const { cookie, checkoutId, sessionId } = await started('11111111-cccc-4000-8000-000000000008');
    sessionStates.set(sessionId, {
      status: 'complete',
      paid: true,
      paymentIntentId: 'pi_test_online_2',
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + ASK_STRIPE_AFTER_MS + 1000);
    try {
      const view = (await (await status(cookie, checkoutId)).json()) as {
        status: string;
        orderNumber: number;
        stage: string;
      };
      expect(view).toMatchObject({ status: 'paid', stage: 'new' });
      expect(view.orderNumber).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
    // The webhook arriving afterwards finds it done.
    expect(
      await completeCheckout(db, sessionId, {
        status: 'complete',
        paid: true,
        paymentIntentId: 'pi_test_online_2',
      }),
    ).toBe('already_done');
  });

  it('never for an unpaid session; an expired one is marked expired', async () => {
    const { checkoutId, sessionId } = await started('11111111-cccc-4000-8000-000000000009');
    expect(await completeCheckout(db, sessionId, { status: 'complete', paid: false })).toBe(
      'not_paid',
    );
    expect(await expireCheckout(db, sessionId)).toBe('expired');
    expect(await checkoutRow(checkoutId)).toMatchObject({ status: 'expired', order_id: null });
  });

  it("a customer sees only their own checkout (anyone else's is 404)", async () => {
    const owner = await started('11111111-cccc-4000-8000-000000000010');
    const other = await customer('11111111-cccc-4000-8000-000000000011');
    expect((await status(owner.cookie, owner.checkoutId)).status).toBe(200);
    expect((await status(other.cookie, owner.checkoutId)).status).toBe(404);
    expect((await status(other.cookie, 'not-a-uuid')).status).toBe(404);
  });
});
