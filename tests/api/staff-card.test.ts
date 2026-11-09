import Stripe from 'stripe';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_BASE, createApi } from '../../src/api/app';
import type { StaffRole } from '../../src/api/authz';
import type { PaymentState, TerminalGateway, TestCard } from '../../src/lib/terminal';
import { createSession, SESSION_COOKIE } from '../../src/lib/session';
import { upsertUser } from '../../src/lib/users';
import { buildApp } from '../../src/server/app';
import { testDb } from '../setup/db';

// Card payments at the counter (ADR-0036), with a fake Stripe Terminal that
// behaves like the simulated reader: an approved tap succeeds, a declined
// tap is declined. Stripe itself is never called from tests.

const fake = vi.hoisted(() => {
  const state = new Map<string, PaymentState>();
  const calls: string[] = [];
  let failNext: string | undefined;
  return {
    state,
    calls,
    failNext: (code?: string) => (failNext = code),
    take: () => {
      const c = failNext;
      failNext = undefined;
      return c;
    },
  };
});

vi.mock('../../src/lib/terminal', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/terminal')>();
  const gateway: TerminalGateway = {
    async createPayment({ cardPaymentId }) {
      fake.calls.push('create');
      const id = `pi_test_${cardPaymentId.replaceAll('-', '').slice(0, 20)}`;
      fake.state.set(id, { state: 'waiting' });
      return { paymentIntentId: id };
    },
    async process(_reader, pi) {
      fake.calls.push(`process:${pi}`);
      const code = fake.take();
      if (code) throw new real.TerminalError(code as never);
      fake.state.set(pi, { state: 'waiting' });
    },
    async presentTestCard(_reader, card: TestCard) {
      fake.calls.push(`tap:${card}`);
      for (const [pi, s] of fake.state) {
        if (s.state === 'waiting') {
          fake.state.set(
            pi,
            card === 'approve'
              ? { state: 'succeeded' }
              : { state: 'declined', failureCode: 'card_declined' },
          );
        }
      }
    },
    async cancel(_reader, pi) {
      fake.calls.push(`cancel:${pi}`);
      fake.state.set(pi, { state: 'canceled' });
    },
    async state(pi) {
      return fake.state.get(pi) ?? { state: 'waiting' };
    },
  };
  return { ...real, stripeTerminal: () => gateway };
});

const ORIGIN = 'http://localhost';
const SECRET = ['whsec', 'testonlynotarealsecret0000000000'].join('_');
let db: D1Database;
let env: Env;

beforeAll(async () => {
  db = await testDb();
  env = {
    APP_ENV: 'local',
    DB: db,
    STRIPE_API_KEY: ['rk', 'test', 'testonlynotarealkey'].join('_'),
    STRIPE_WEBHOOK_SECRET: SECRET,
    STRIPE_TERMINAL_READER_ID: 'tmr_testreader',
  } as unknown as Env;
});

beforeEach(() => {
  fake.calls.length = 0;
});

const call = (path: string, init: RequestInit = {}, withEnv: Env = env) =>
  buildApp({ log: false }).request(`${ORIGIN}${path}`, init, withEnv);

async function staff(sub: string, role: StaffRole = 'Staff.Barista') {
  const userId = await upsertUser(db, { idp: 'workforce', sub, displayName: `Test ${sub}`, role });
  const { token } = await createSession(db, { userId, idp: 'workforce', role });
  return { userId, token, role };
}

const get = (token: string, path: string) =>
  call(`${API_BASE}${path}`, { headers: { Cookie: `${SESSION_COOKIE}=${token}` } });
const post = (token: string, path: string, body?: unknown, withEnv?: Env) =>
  call(
    `${API_BASE}${path}`,
    {
      method: 'POST',
      headers: {
        Cookie: `${SESSION_COOKIE}=${token}`,
        Origin: ORIGIN,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    withEnv,
  );

const ORDER = [
  { itemId: 'americano', variantId: '16oz', qty: 1 },
  { itemId: 'latte', variantId: '12oz', qty: 1 },
];

async function start(token: string, key = crypto.randomUUID()) {
  const res = await post(token, '/staff/card-payments', { idempotencyKey: key, lines: ORDER });
  return { res, body: (await res.json()) as { id: string; status: string; totalCents: number } };
}

async function webhook(event: object) {
  const payload = JSON.stringify({
    id: `evt_test_${crypto.randomUUID().replaceAll('-', '')}`,
    object: 'event',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    ...event,
  });
  const signature = await Stripe.webhooks.generateTestHeaderStringAsync({
    payload,
    secret: SECRET,
  });
  return call(`${API_BASE}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature },
    body: payload,
  });
}

async function intentOf(id: string) {
  const row = await db
    .prepare('SELECT payment_intent_id FROM card_payments WHERE id = ?')
    .bind(id)
    .first<{ payment_intent_id: string }>();
  return row!.payment_intent_id;
}

async function ordersFor(pi: string) {
  return db
    .prepare('SELECT id, tender, total_cents, taken_by FROM orders WHERE payment_intent_id = ?')
    .bind(pi)
    .all<{ id: string; tender: string; total_cents: number; taken_by: string }>();
}

async function audits(action: string, target: string) {
  return (
    await db
      .prepare('SELECT actor_user_id, after FROM audit_log WHERE action = ? AND target = ?')
      .bind(action, target)
      .all<{ actor_user_id: string; after: string }>()
  ).results;
}

describe('routes', () => {
  it('every card route is for Barista and up', () => {
    const { routes } = createApi();
    expect(routes.filter((r) => r.path.startsWith('/staff/card-payments'))).toEqual([
      { method: 'POST', path: '/staff/card-payments', principal: 'Staff.Barista' },
      { method: 'GET', path: '/staff/card-payments/:id', principal: 'Staff.Barista' },
      { method: 'POST', path: '/staff/card-payments/:id/simulate-tap', principal: 'Staff.Barista' },
      { method: 'POST', path: '/staff/card-payments/:id/retry', principal: 'Staff.Barista' },
      { method: 'POST', path: '/staff/card-payments/:id/cancel', principal: 'Staff.Barista' },
    ]);
  });

  it('signed out: 401; not set up (no reader): 503 with advice to take cash', async () => {
    expect((await call(`${API_BASE}/staff/card-payments/${crypto.randomUUID()}`)).status).toBe(401);
    const barista = await staff('c-setup');
    const noReader = { ...env, STRIPE_TERMINAL_READER_ID: undefined } as unknown as Env;
    const res = await post(
      barista.token,
      '/staff/card-payments',
      { idempotencyKey: crypto.randomUUID(), lines: ORDER },
      noReader,
    );
    expect(res.status).toBe(503);
    expect(((await res.json()) as { detail: string }).detail).toContain('Take cash');
  });
});

describe('a card sale', () => {
  it('approved by webhook: one order, card tender, priced by the server, audited', async () => {
    const barista = await staff('c-barista');
    const { res, body } = await start(barista.token);
    expect(res.status).toBe(201);
    expect(body).toMatchObject({ status: 'waiting' });
    const pi = await intentOf(body.id);
    expect((await ordersFor(pi)).results).toHaveLength(0); // nothing on the board yet

    expect(
      (
        await post(barista.token, `/staff/card-payments/${body.id}/simulate-tap`, {
          card: 'approve',
        })
      ).status,
    ).toBe(200);
    expect(await audits('payment.test_tap', body.id)).toHaveLength(1);

    const hook = await webhook({
      type: 'payment_intent.succeeded',
      data: { object: { id: pi, object: 'payment_intent' } },
    });
    expect(hook.status).toBe(200);
    // Stripe also sends the reader's event: the order isn't created twice.
    await webhook({
      type: 'terminal.reader.action_succeeded',
      data: {
        object: {
          id: 'tmr_testreader',
          object: 'terminal.reader',
          action: {
            type: 'process_payment_intent',
            status: 'succeeded',
            process_payment_intent: { payment_intent: pi },
          },
        },
      },
    });

    const orders = (await ordersFor(pi)).results;
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      tender: 'card',
      total_cents: body.totalCents,
      taken_by: barista.userId,
    });
    const sale = await audits('order.sale', orders[0]!.id);
    expect(sale[0]!.actor_user_id).toBe(barista.userId);
    expect(JSON.parse(sale[0]!.after)).toMatchObject({ tender: 'card' });

    const status = (await (await get(barista.token, `/staff/card-payments/${body.id}`)).json()) as {
      status: string;
      orderNumber: number;
    };
    expect(status.status).toBe('succeeded');
    expect(status.orderNumber).toBeGreaterThan(0);
  });

  it('approved with no webhook: the register status check asks Stripe and finishes it', async () => {
    const barista = await staff('c-barista2');
    const { body } = await start(barista.token);
    await post(barista.token, `/staff/card-payments/${body.id}/simulate-tap`, { card: 'approve' });
    // Older than the 3-second wait before asking Stripe.
    await db
      .prepare('UPDATE card_payments SET updated_at = updated_at - 5000 WHERE id = ?')
      .bind(body.id)
      .run();
    const status = (await (await get(barista.token, `/staff/card-payments/${body.id}`)).json()) as {
      status: string;
    };
    expect(status.status).toBe('succeeded');
    expect((await ordersFor(await intentOf(body.id))).results).toHaveLength(1);
  });

  it('declined: no order; another card on the same payment; or cancel', async () => {
    const barista = await staff('c-barista3');
    const { body } = await start(barista.token);
    const pi = await intentOf(body.id);
    await post(barista.token, `/staff/card-payments/${body.id}/simulate-tap`, { card: 'decline' });
    await webhook({
      type: 'terminal.reader.action_failed',
      data: {
        object: {
          id: 'tmr_testreader',
          object: 'terminal.reader',
          action: {
            type: 'process_payment_intent',
            status: 'failed',
            failure_code: 'card_declined',
            process_payment_intent: { payment_intent: pi },
          },
        },
      },
    });
    let status = (await (await get(barista.token, `/staff/card-payments/${body.id}`)).json()) as {
      status: string;
      failureCode: string;
    };
    expect(status).toMatchObject({ status: 'declined', failureCode: 'card_declined' });
    expect(await audits('payment.card_declined', body.id)).toHaveLength(1);
    expect((await ordersFor(pi)).results).toHaveLength(0);

    // Stripe's advice: reuse the same PaymentIntent for the next card.
    expect((await post(barista.token, `/staff/card-payments/${body.id}/retry`)).status).toBe(200);
    // Sent to the reader twice: at the start and for the next card.
    expect(fake.calls.filter((c) => c === `process:${pi}`)).toHaveLength(2);

    expect((await post(barista.token, `/staff/card-payments/${body.id}/cancel`)).status).toBe(200);
    expect(fake.calls).toContain(`cancel:${pi}`);
    status = (await (
      await get(barista.token, `/staff/card-payments/${body.id}`)
    ).json()) as typeof status;
    expect(status.status).toBe('canceled');
    expect(await audits('payment.card_canceled', body.id)).toHaveLength(1);
    expect((await ordersFor(pi)).results).toHaveLength(0);
  });

  it('a busy reader: the attempt fails with advice, nothing charged', async () => {
    const barista = await staff('c-barista4');
    fake.failNext('reader_busy');
    const { res, body } = await start(barista.token);
    expect(res.status).toBe(409);
    expect((body as unknown as { detail: string }).detail).toContain('busy');
  });
});

describe('guards', () => {
  it('server prices; strict bodies; sold-out refused; one key per person; tap only while waiting', async () => {
    const barista = await staff('c-barista5');
    const other = await staff('c-barista6');
    const path = '/staff/card-payments';
    expect(
      (
        await post(barista.token, path, {
          idempotencyKey: crypto.randomUUID(),
          lines: ORDER,
          totalCents: 1,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(barista.token, path, {
          idempotencyKey: crypto.randomUUID(),
          lines: [{ itemId: 'free-coffee', variantId: '12oz', qty: 1 }],
        })
      ).status,
    ).toBe(422);
    const lead = await staff('c-lead', 'Staff.ShiftLead');
    await post(lead.token, '/staff/menu/mocha/availability', { soldOut: true });
    expect(
      (
        await post(barista.token, path, {
          idempotencyKey: crypto.randomUUID(),
          lines: [{ itemId: 'mocha', variantId: '12oz', qty: 1 }],
        })
      ).status,
    ).toBe(422);

    const key = crypto.randomUUID();
    const first = await start(barista.token, key);
    const again = await start(barista.token, key);
    expect(again.body.id).toBe(first.body.id);
    expect(fake.calls.filter((c) => c === 'create')).toHaveLength(1);
    expect((await start(other.token, key)).res.status).toBe(409);

    await post(barista.token, `/staff/card-payments/${first.body.id}/cancel`);
    expect(
      (
        await post(barista.token, `/staff/card-payments/${first.body.id}/simulate-tap`, {
          card: 'approve',
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await post(barista.token, `/staff/card-payments/${first.body.id}/simulate-tap`, {
          card: '4242424242424242',
        })
      ).status,
    ).toBe(400);
  });

  it("a card sale is never refunded in cash, and isn't counted in the cash drawer", async () => {
    const barista = await staff('c-barista7');
    const manager = await staff('c-manager', 'Staff.Manager');
    const lead = await staff('c-lead2', 'Staff.ShiftLead');
    const open = await post(lead.token, '/staff/cash/open', { floatCents: 10_000 });
    const drawer = ((await open.json()) as { id: string }).id;

    const { body } = await start(barista.token);
    const pi = await intentOf(body.id);
    await webhook({
      type: 'payment_intent.succeeded',
      data: { object: { id: pi, object: 'payment_intent' } },
    });
    const order = (await ordersFor(pi)).results[0]!;

    const refund = await post(manager.token, `/staff/orders/${order.id}/refunds`, {
      idempotencyKey: crypto.randomUUID(),
      lines: [{ line: 1, qty: 1 }],
      reason: { code: 'quality' },
    });
    expect(refund.status).toBe(409);
    expect(((await refund.json()) as { detail: string }).detail).toContain('card');

    const counts = {
      '10000': 1,
      '5000': 0,
      '2000': 0,
      '1000': 0,
      '500': 0,
      '100': 0,
      '25': 0,
      '10': 0,
      '5': 0,
      '1': 0,
    };
    const closed = (await (
      await post(lead.token, `/staff/cash/${drawer}/close`, { counts })
    ).json()) as {
      expectedCents: number;
    };
    expect(closed.expectedCents).toBe(10_000);
  });
});
