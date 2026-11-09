import { beforeAll, describe, expect, it } from 'vitest';
import { API_BASE, createApi } from '../../src/api/app';
import { createSession, hashToken, REGISTER_IDLE_MS, SESSION_COOKIE } from '../../src/lib/session';
import { upsertUser } from '../../src/lib/users';
import { buildApp } from '../../src/server/app';
import { testDb } from '../setup/db';

const ORIGIN = 'http://localhost';
let db: D1Database;
let env: Env;

beforeAll(async () => {
  db = await testDb();
  env = { APP_ENV: 'local', DB: db } as unknown as Env;
});

const call = (path: string, init: RequestInit = {}) =>
  buildApp({ log: false }).request(`${ORIGIN}${path}`, init, env);

async function sessionFor(
  sub: string,
  role?: 'Staff.Barista' | 'Staff.Manager',
  idp: 'workforce' | 'customer' = 'workforce',
) {
  const userId = await upsertUser(db, {
    idp,
    sub,
    displayName: `Test ${sub}`,
    ...(role ? { role } : {}),
  });
  const { token } = await createSession(db, { userId, idp, ...(role ? { role } : {}) });
  return { userId, token };
}

const as = (token: string, init: RequestInit = {}) => ({
  ...init,
  headers: { Cookie: `${SESSION_COOKIE}=${token}`, ...init.headers },
});

const sale = (token: string, body: Record<string, unknown>) =>
  call(
    `${API_BASE}/staff/orders`,
    as(token, {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

const cash = (lines: unknown[], tenderedCents: number, key = crypto.randomUUID()) => ({
  idempotencyKey: key,
  tender: 'cash',
  tenderedCents,
  lines,
});

const latte16 = { itemId: 'americano', variantId: '16oz', qty: 1 }; // $4.00

describe('route principals', () => {
  it('order routes need Barista or above; refunds need Manager', () => {
    const { routes } = createApi();
    expect(routes.filter((r) => r.path.startsWith('/staff/orders'))).toEqual([
      { method: 'POST', path: '/staff/orders', principal: 'Staff.Barista' },
      { method: 'GET', path: '/staff/orders', principal: 'Staff.Barista' },
      { method: 'POST', path: '/staff/orders/:id/stage', principal: 'Staff.Barista' },
      { method: 'POST', path: '/staff/orders/:id/refunds', principal: 'Staff.Manager' },
    ]);
  });
});

describe('authorization', () => {
  it('signed out: 401 on every order route', async () => {
    expect((await call(`${API_BASE}/staff/orders`)).status).toBe(401);
    const post = { method: 'POST', headers: { Origin: ORIGIN } };
    expect((await call(`${API_BASE}/staff/orders`, post)).status).toBe(401);
    const stage = `${API_BASE}/staff/orders/${crypto.randomUUID()}/stage`;
    expect((await call(stage, post)).status).toBe(401);
  });

  it('a customer session or a staff account with no role: 403', async () => {
    const customer = await sessionFor('cust-orders', undefined, 'customer');
    const noRole = await sessionFor('staff-norole');
    for (const s of [customer, noRole]) {
      expect((await call(`${API_BASE}/staff/orders`, as(s.token))).status).toBe(403);
      expect((await sale(s.token, cash([latte16], 400))).status).toBe(403);
    }
  });

  it('a sale from another site is refused (CSRF)', async () => {
    const { token } = await sessionFor('barista-csrf', 'Staff.Barista');
    const res = await call(
      `${API_BASE}/staff/orders`,
      as(token, {
        method: 'POST',
        headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
        body: JSON.stringify(cash([latte16], 400)),
      }),
    );
    expect(res.status).toBe(403);
  });
});

describe('POST /staff/orders: a cash sale', () => {
  it('records the sale with server prices, the change due and who took it', async () => {
    const { userId, token } = await sessionFor('barista-sale', 'Staff.Barista');
    const res = await sale(
      token,
      cash([latte16, { itemId: 'espresso', variantId: 'double-shot', qty: 2 }], 2000),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      number: number;
      totalCents: number;
      changeCents: number;
    };
    expect(body.totalCents).toBe(400 + 600);
    expect(body.changeCents).toBe(1000);
    const row = await db
      .prepare('SELECT taken_by, tender, channel, stage, payment FROM orders WHERE id = ?')
      .bind(body.id)
      .first();
    expect(row).toEqual({
      taken_by: userId,
      tender: 'cash',
      channel: 'counter',
      stage: 'new',
      payment: 'paid',
    });
  });

  it('never accepts a price from the browser', async () => {
    const { token } = await sessionFor('barista-price', 'Staff.Barista');
    const res = await sale(token, cash([{ ...latte16, unitPriceCents: 1 }], 400));
    expect(res.status).toBe(400);
  });

  it('refuses unknown items, too little cash, and malformed orders', async () => {
    const { token } = await sessionFor('barista-bad', 'Staff.Barista');
    const bad = [
      [cash([{ itemId: 'free-coffee', variantId: '16oz', qty: 1 }], 1000), 422],
      [cash([latte16], 399), 422],
      [cash([], 400), 400],
      [cash([{ ...latte16, qty: 21 }], 10000), 400],
      [{ ...cash([latte16], 400), tender: 'card' }, 400],
      [{ ...cash([latte16], 400), idempotencyKey: 'not-a-uuid' }, 400],
    ] as const;
    for (const [body, status] of bad) {
      expect(
        (await sale(token, body as Record<string, unknown>)).status,
        JSON.stringify(body),
      ).toBe(status);
    }
  });

  it('a double-tap with the same key records one sale, not two', async () => {
    const { token } = await sessionFor('barista-twice', 'Staff.Barista');
    const key = crypto.randomUUID();
    const first = await sale(token, cash([latte16], 500, key));
    const second = await sale(token, cash([latte16], 500, key));
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    const a = (await first.json()) as { id: string };
    const b = (await second.json()) as { id: string };
    expect(b.id).toBe(a.id);
    const n = await db
      .prepare('SELECT COUNT(*) AS n FROM orders WHERE idempotency_key = ?')
      .bind(key)
      .first<{ n: number }>();
    expect(n!.n).toBe(1);
  });

  it("someone else can't use another person's key to read their sale", async () => {
    const a = await sessionFor('barista-key-a', 'Staff.Barista');
    const b = await sessionFor('barista-key-b', 'Staff.Barista');
    const key = crypto.randomUUID();
    expect((await sale(a.token, cash([latte16], 400, key))).status).toBe(201);
    expect((await sale(b.token, cash([latte16], 400, key))).status).toBe(409);
  });

  it('numbers orders one after another within the day', async () => {
    const { token } = await sessionFor('barista-numbers', 'Staff.Barista');
    const one = (await (await sale(token, cash([latte16], 400))).json()) as { number: number };
    const two = (await (await sale(token, cash([latte16], 400))).json()) as { number: number };
    expect(two.number).toBe(one.number + 1);
  });
});

describe('the order board', () => {
  it('shows paid orders and moves them one step at a time; a second tap gets a conflict', async () => {
    const { token } = await sessionFor('barista-board', 'Staff.Barista');
    const { id, number } = (await (await sale(token, cash([latte16], 400))).json()) as {
      id: string;
      number: number;
    };

    const board = (await (await call(`${API_BASE}/staff/orders`, as(token))).json()) as {
      orders: { id: string; number: number; stage: string; items: unknown[] }[];
    };
    expect(board.orders.find((o) => o.id === id)).toMatchObject({
      number,
      stage: 'new',
      items: [{ name: 'Americano', variantLabel: '16 oz', qty: 1 }],
    });

    const move = (from: string, to: string) =>
      call(
        `${API_BASE}/staff/orders/${id}/stage`,
        as(token, {
          method: 'POST',
          headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from, to }),
        }),
      );
    expect((await move('new', 'ready')).status).toBe(422);
    expect((await move('new', 'in_progress')).status).toBe(200);
    expect((await move('new', 'in_progress')).status).toBe(409);
    expect((await move('in_progress', 'ready')).status).toBe(200);
    expect((await move('ready', 'collected')).status).toBe(200);

    const after = (await (await call(`${API_BASE}/staff/orders`, as(token))).json()) as {
      orders: { id: string }[];
    };
    expect(after.orders.find((o) => o.id === id)).toBeUndefined();
  });

  it('an unknown order is a 404', async () => {
    const { token } = await sessionFor('barista-404', 'Staff.Barista');
    const res = await call(
      `${API_BASE}/staff/orders/${crypto.randomUUID()}/stage`,
      as(token, {
        method: 'POST',
        headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'new', to: 'in_progress' }),
      }),
    );
    expect(res.status).toBe(404);
  });
});

describe('sessions on register screens (ADR-0031)', () => {
  const idle = async (token: string) =>
    (await db
      .prepare('SELECT idle_ms, idle_expires_at FROM sessions WHERE id_hash = ?')
      .bind(await hashToken(token))
      .first<{ idle_ms: number; idle_expires_at: number }>())!;

  it('using the register API tightens the session to 15 minutes idle, for good', async () => {
    const { token } = await sessionFor('barista-idle', 'Staff.Barista');
    expect((await idle(token)).idle_ms).toBe(60 * 60 * 1000);
    await sale(token, cash([latte16], 400));
    expect((await idle(token)).idle_ms).toBe(REGISTER_IDLE_MS);
    // A later non-register request doesn't loosen it again.
    await call(`${API_BASE}/staff/me`, as(token));
    const after = await idle(token);
    expect(after.idle_ms).toBe(REGISTER_IDLE_MS);
    expect(after.idle_expires_at - Date.now()).toBeLessThanOrEqual(REGISTER_IDLE_MS);
  });

  it("polling the board doesn't count as activity", async () => {
    const { token } = await sessionFor('barista-poll', 'Staff.Barista');
    await call(`${API_BASE}/staff/orders`, as(token)); // first read tightens the window
    const before = (await idle(token)).idle_expires_at;
    await new Promise((r) => setTimeout(r, 20));
    await call(`${API_BASE}/staff/orders`, as(token));
    expect((await idle(token)).idle_expires_at).toBe(before);
  });
});
