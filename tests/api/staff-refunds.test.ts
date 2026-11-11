import { beforeAll, describe, expect, it } from 'vitest';
import { API_BASE, createApi } from '../../src/api/app';
import type { StaffRole } from '../../src/api/authz';
import { issueRefund } from '../../src/lib/refunds';
import { createSession, SESSION_COOKIE } from '../../src/lib/session';
import { upsertUser } from '../../src/lib/users';
import { buildApp } from '../../src/server/app';
import { testDb } from '../setup/db';

// Refunds (ADR-0034): Manager+, never the person who took the payment unless
// Owner, amounts from the sale, never more than was sold.

const ORIGIN = 'http://localhost';
let db: D1Database;
let env: Env;

beforeAll(async () => {
  db = await testDb();
  env = { APP_ENV: 'local', DB: db } as unknown as Env;
});

const call = (path: string, init: RequestInit = {}) =>
  buildApp({ log: false }).request(`${ORIGIN}${path}`, init, env);

async function staff(sub: string, role: StaffRole) {
  const userId = await upsertUser(db, { idp: 'workforce', sub, displayName: `Test ${sub}`, role });
  const { token } = await createSession(db, { userId, idp: 'workforce', role });
  return { userId, token, role };
}

const post = (token: string, path: string, body?: unknown) =>
  call(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      Cookie: `${SESSION_COOKIE}=${token}`,
      Origin: ORIGIN,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** A cash sale: 2 × Americano 16 oz ($4.00) and 1 × Mocha 12 oz. */
async function sale(token: string) {
  const res = await post(token, '/staff/orders', {
    idempotencyKey: crypto.randomUUID(),
    tender: 'cash',
    tenderedCents: 5000,
    lines: [
      { itemId: 'americano', variantId: '16oz', qty: 2 },
      { itemId: 'mocha', variantId: '12oz', qty: 1 },
    ],
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; number: number; totalCents: number };
}

const refund = (lines: { line: number; qty: number }[], key = crypto.randomUUID()) => ({
  idempotencyKey: key,
  lines,
  reason: { code: 'wrong-order' },
});

async function audits(action: string, target: string) {
  const rows = await db
    .prepare('SELECT actor_user_id, after FROM audit_log WHERE action = ? AND target = ?')
    .bind(action, target)
    .all<{ actor_user_id: string; after: string }>();
  return rows.results;
}

describe('route principal', () => {
  it('refunds need Manager', () => {
    const { routes } = createApi();
    expect(routes.filter((r) => r.path.includes('refund'))).toEqual([
      {
        method: 'POST',
        path: '/staff/orders/:id/refunds',
        principal: 'Staff.Manager',
        limit: 'payments',
      },
    ]);
  });
});

describe('who may refund', () => {
  it('baristas and shift leads are refused by role', async () => {
    const barista = await staff('f-barista', 'Staff.Barista');
    const lead = await staff('f-lead', 'Staff.ShiftLead');
    const { id } = await sale(barista.token);
    expect(
      (await post(barista.token, `/staff/orders/${id}/refunds`, refund([{ line: 1, qty: 1 }])))
        .status,
    ).toBe(403);
    expect(
      (await post(lead.token, `/staff/orders/${id}/refunds`, refund([{ line: 1, qty: 1 }]))).status,
    ).toBe(403);
  });

  it('a manager who took the payment is refused, and the refusal is audited (AC-5)', async () => {
    const manager = await staff('f-manager', 'Staff.Manager');
    const { id, number } = await sale(manager.token);
    const res = await post(
      manager.token,
      `/staff/orders/${id}/refunds`,
      refund([{ line: 1, qty: 1 }]),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { detail: string }).detail).toContain('You took this payment');
    const refused = await audits('order.refund_refused', id);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.actor_user_id).toBe(manager.userId);
    expect(JSON.parse(refused[0]!.after)).toMatchObject({ reason: 'own_sale', number });
  });

  it('another manager can refund it; the owner can refund their own sale', async () => {
    const barista = await staff('f-barista2', 'Staff.Barista');
    const manager = await staff('f-manager2', 'Staff.Manager');
    const owner = await staff('f-owner', 'Staff.Owner');
    const { id } = await sale(barista.token);
    expect(
      (await post(manager.token, `/staff/orders/${id}/refunds`, refund([{ line: 2, qty: 1 }])))
        .status,
    ).toBe(201);
    const own = await sale(owner.token);
    expect(
      (await post(owner.token, `/staff/orders/${own.id}/refunds`, refund([{ line: 1, qty: 1 }])))
        .status,
    ).toBe(201);
  });
});

describe('what a refund can be', () => {
  it('amounts come from the sale; partial, then the rest; never more than was sold', async () => {
    const barista = await staff('f-barista3', 'Staff.Barista');
    const manager = await staff('f-manager3', 'Staff.Manager');
    const { id, totalCents } = await sale(barista.token);

    const first = await post(
      manager.token,
      `/staff/orders/${id}/refunds`,
      refund([{ line: 1, qty: 1 }]),
    );
    expect(first.status).toBe(201);
    const body = (await first.json()) as { id: string; amountCents: number; tender: string };
    expect(body).toMatchObject({ amountCents: 400, tender: 'cash' });
    const audit = await audits('order.refund', body.id);
    expect(JSON.parse(audit[0]!.after)).toMatchObject({
      orderId: id,
      amountCents: 400,
      reason: 'Wrong order made',
      reasonCode: 'wrong-order',
    });

    // Only one Americano is left to refund on line 1.
    expect(
      (await post(manager.token, `/staff/orders/${id}/refunds`, refund([{ line: 1, qty: 2 }])))
        .status,
    ).toBe(409);
    expect(
      (await post(manager.token, `/staff/orders/${id}/refunds`, refund([{ line: 9, qty: 1 }])))
        .status,
    ).toBe(422);

    const rest = await post(
      manager.token,
      `/staff/orders/${id}/refunds`,
      refund([
        { line: 1, qty: 1 },
        { line: 2, qty: 1 },
      ]),
    );
    expect(((await rest.json()) as { amountCents: number }).amountCents).toBe(totalCents - 400);
    const order = await db
      .prepare('SELECT payment FROM orders WHERE id = ?')
      .bind(id)
      .first<{ payment: string }>();
    expect(order!.payment).toBe('refunded');
    expect(
      (await post(manager.token, `/staff/orders/${id}/refunds`, refund([{ line: 2, qty: 1 }])))
        .status,
    ).toBe(409);
  });

  it('a reason from the list is required; Other needs a note; bodies are strict', async () => {
    const barista = await staff('f-barista4', 'Staff.Barista');
    const manager = await staff('f-manager4', 'Staff.Manager');
    const { id } = await sale(barista.token);
    const path = `/staff/orders/${id}/refunds`;
    const base = { idempotencyKey: crypto.randomUUID(), lines: [{ line: 1, qty: 1 }] };
    expect((await post(manager.token, path, base)).status).toBe(400);
    expect((await post(manager.token, path, { ...base, reason: { code: 'because' } })).status).toBe(
      400,
    );
    expect((await post(manager.token, path, { ...base, reason: { code: 'other' } })).status).toBe(
      400,
    );
    expect(
      (await post(manager.token, path, { ...base, reason: { code: 'quality' }, amountCents: 1 }))
        .status,
    ).toBe(400);
    expect(
      (
        await post(manager.token, path, {
          ...base,
          lines: [
            { line: 1, qty: 1 },
            { line: 1, qty: 1 },
          ],
          reason: { code: 'quality' },
        })
      ).status,
    ).toBe(400);
    expect(
      (await post(manager.token, path, { ...base, reason: { code: 'other', note: 'spilled' } }))
        .status,
    ).toBe(201);
  });

  it('the same key refunds once; another person reusing it gets nothing', async () => {
    const barista = await staff('f-barista5', 'Staff.Barista');
    const manager = await staff('f-manager5', 'Staff.Manager');
    const other = await staff('f-manager6', 'Staff.Manager');
    const { id } = await sale(barista.token);
    const body = refund([{ line: 1, qty: 1 }]);
    const a = await post(manager.token, `/staff/orders/${id}/refunds`, body);
    const b = await post(manager.token, `/staff/orders/${id}/refunds`, body);
    expect([a.status, b.status]).toEqual([201, 200]);
    expect(((await b.json()) as { id: string }).id).toBe(((await a.json()) as { id: string }).id);
    expect((await post(other.token, `/staff/orders/${id}/refunds`, body)).status).toBe(409);
  });

  it('two managers refunding the last drink at once: one wins, no over-refund', async () => {
    const barista = await staff('f-barista6', 'Staff.Barista');
    const a = await staff('f-manager7', 'Staff.Manager');
    const b = await staff('f-manager8', 'Staff.Manager');
    const { id } = await sale(barista.token);
    const input = (key: string) => ({
      orderId: id,
      idempotencyKey: key,
      lines: [{ line: 2, qty: 1 }],
      reason: { code: 'quality' },
    });
    const results = await Promise.all([
      issueRefund(db, input(crypto.randomUUID()), {
        userId: a.userId,
        role: a.role,
        requestId: 'a',
      }),
      issueRefund(db, input(crypto.randomUUID()), {
        userId: b.userId,
        role: b.role,
        requestId: 'b',
      }),
    ]);
    expect(results.filter((r) => typeof r === 'object')).toHaveLength(1);
    expect(results).toContain('over_refund');
    const refunded = await db
      .prepare('SELECT SUM(qty) AS n FROM refund_lines WHERE order_id = ? AND line = 2')
      .bind(id)
      .first<{ n: number }>();
    expect(refunded!.n).toBe(1);
  });

  it('unknown sales 404; signed out 401', async () => {
    const manager = await staff('f-manager9', 'Staff.Manager');
    expect(
      (
        await post(
          manager.token,
          `/staff/orders/${crypto.randomUUID()}/refunds`,
          refund([{ line: 1, qty: 1 }]),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await call(`${API_BASE}/staff/orders/${crypto.randomUUID()}/refunds`, {
          method: 'POST',
          headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(401);
  });
});
