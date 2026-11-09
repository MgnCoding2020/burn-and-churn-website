import { beforeAll, describe, expect, it } from 'vitest';
import { API_BASE, createApi } from '../../src/api/app';
import type { StaffRole } from '../../src/api/authz';
import { countTotal, DENOMINATIONS, salesOutsideDrawers } from '../../src/lib/cash';
import { createSession, SESSION_COOKIE } from '../../src/lib/session';
import { upsertUser } from '../../src/lib/users';
import { buildApp } from '../../src/server/app';
import { testDb } from '../setup/db';

// The cash drawer (ADR-0034): Shift Lead+ opens and closes with a blind count;
// a difference over $5 needs a reason; a Manager+ reviews, never their own.
// Tests run in order and each closes the drawer it opens (one open at a time).

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

/** A count by denomination that totals exactly `cents`. */
function countOf(cents: number): Record<string, number> {
  const counts: Record<string, number> = {};
  let left = cents;
  for (const d of DENOMINATIONS) {
    counts[String(d.cents)] = Math.floor(left / d.cents);
    left -= counts[String(d.cents)]! * d.cents;
  }
  return counts;
}

async function open(token: string, floatCents = 15_000) {
  const res = await post(token, '/staff/cash/open', { floatCents });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function cashSale(token: string) {
  const res = await post(token, '/staff/orders', {
    idempotencyKey: crypto.randomUUID(),
    tender: 'cash',
    tenderedCents: 2000,
    lines: [{ itemId: 'americano', variantId: '16oz', qty: 1 }],
  });
  return (await res.json()) as { id: string; totalCents: number };
}

async function lastAudit(action: string, target: string) {
  return db
    .prepare(
      'SELECT actor_user_id, after FROM audit_log WHERE action = ? AND target = ? ORDER BY id DESC LIMIT 1',
    )
    .bind(action, target)
    .first<{ actor_user_id: string; after: string }>();
}

describe('route principals', () => {
  it('open, close and explain need Shift Lead; review needs Manager', () => {
    const { routes } = createApi();
    expect(routes.filter((r) => r.path.startsWith('/staff/cash'))).toEqual([
      { method: 'POST', path: '/staff/cash/open', principal: 'Staff.ShiftLead' },
      { method: 'POST', path: '/staff/cash/:id/close', principal: 'Staff.ShiftLead' },
      { method: 'POST', path: '/staff/cash/:id/explain', principal: 'Staff.ShiftLead' },
      { method: 'POST', path: '/staff/cash/:id/review', principal: 'Staff.Manager' },
    ]);
  });

  it('counts total by denomination', () => {
    expect(countTotal(countOf(19_437))).toBe(19_437);
  });
});

describe('the drawer', () => {
  it('a barista is refused; one drawer open at a time; an exact count needs no review', async () => {
    const barista = await staff('d-barista', 'Staff.Barista');
    const lead = await staff('d-lead', 'Staff.ShiftLead');
    expect((await post(barista.token, '/staff/cash/open', { floatCents: 15_000 })).status).toBe(
      403,
    );
    const id = await open(lead.token);
    expect((await post(lead.token, '/staff/cash/open', { floatCents: 15_000 })).status).toBe(409);
    expect(await lastAudit('cash.drawer_opened', id)).toMatchObject({ actor_user_id: lead.userId });

    const { totalCents } = await cashSale(barista.token);
    const res = await post(lead.token, `/staff/cash/${id}/close`, {
      counts: countOf(15_000 + totalCents),
    });
    expect(await res.json()).toEqual({
      expectedCents: 15_000 + totalCents,
      countedCents: 15_000 + totalCents,
      varianceCents: 0,
      needsExplanation: false,
    });
    // Closed counts can't be redone.
    expect((await post(lead.token, `/staff/cash/${id}/close`, { counts: countOf(0) })).status).toBe(
      409,
    );
    const manager = await staff('d-manager', 'Staff.Manager');
    expect((await post(manager.token, `/staff/cash/${id}/review`)).status).toBe(409);
  });

  it('cash refunds while open come out of the expected amount', async () => {
    const barista = await staff('d-barista2', 'Staff.Barista');
    const lead = await staff('d-lead2', 'Staff.ShiftLead');
    const manager = await staff('d-manager2', 'Staff.Manager');
    const id = await open(lead.token, 10_000);
    const sale = await cashSale(barista.token);
    await post(manager.token, `/staff/orders/${sale.id}/refunds`, {
      idempotencyKey: crypto.randomUUID(),
      lines: [{ line: 1, qty: 1 }],
      reason: { code: 'quality' },
    });
    const res = await post(lead.token, `/staff/cash/${id}/close`, { counts: countOf(10_000) });
    expect(await res.json()).toMatchObject({ expectedCents: 10_000, varianceCents: 0 });
  });

  it('off by more than $5: a reason first, then another manager reviews (own review refused)', async () => {
    const lead = await staff('d-lead3', 'Staff.ShiftLead');
    const otherLead = await staff('d-lead4', 'Staff.ShiftLead');
    const manager = await staff('d-manager3', 'Staff.Manager');
    const id = await open(manager.token);
    const closed = await post(manager.token, `/staff/cash/${id}/close`, {
      counts: countOf(15_000 - 750),
    });
    expect(await closed.json()).toMatchObject({ varianceCents: -750, needsExplanation: true });
    expect(await lastAudit('cash.drawer_closed', id)).toMatchObject({
      actor_user_id: manager.userId,
    });

    // Review waits for a reason.
    const owner = await staff('d-owner', 'Staff.Owner');
    expect((await post(owner.token, `/staff/cash/${id}/review`)).status).toBe(409);
    // Explain: the closer or a Manager+, not another shift lead; a listed reason.
    const reason = { reason: { code: 'wrong-change' } };
    expect((await post(otherLead.token, `/staff/cash/${id}/explain`, reason)).status).toBe(403);
    expect(
      (await post(manager.token, `/staff/cash/${id}/explain`, { reason: { code: 'oops' } })).status,
    ).toBe(400);
    expect((await post(manager.token, `/staff/cash/${id}/explain`, reason)).status).toBe(200);
    expect((await post(manager.token, `/staff/cash/${id}/explain`, reason)).status).toBe(409);
    expect(JSON.parse((await lastAudit('cash.variance_explained', id))!.after)).toMatchObject({
      reason: 'Wrong change given',
    });

    // The closer can't review their own count; the refusal is audited.
    expect((await post(manager.token, `/staff/cash/${id}/review`)).status).toBe(403);
    expect(await lastAudit('cash.review_refused', id)).toMatchObject({
      actor_user_id: manager.userId,
    });
    expect((await post(lead.token, `/staff/cash/${id}/review`)).status).toBe(403);
    expect((await post(owner.token, `/staff/cash/${id}/review`)).status).toBe(200);
    expect((await post(owner.token, `/staff/cash/${id}/review`)).status).toBe(409);
  });

  it('off by $5 or less: no reason needed, still reviewed', async () => {
    const lead = await staff('d-lead5', 'Staff.ShiftLead');
    const manager = await staff('d-manager4', 'Staff.Manager');
    const id = await open(lead.token);
    const closed = await post(lead.token, `/staff/cash/${id}/close`, {
      counts: countOf(15_000 + 500),
    });
    expect(await closed.json()).toMatchObject({ varianceCents: 500, needsExplanation: false });
    expect(
      (await post(lead.token, `/staff/cash/${id}/explain`, { reason: { code: 'unknown' } })).status,
    ).toBe(409);
    expect((await post(manager.token, `/staff/cash/${id}/review`)).status).toBe(200);
  });

  it('bad bodies 400; unknown drawers 404', async () => {
    const lead = await staff('d-lead6', 'Staff.ShiftLead');
    expect((await post(lead.token, '/staff/cash/open', { floatCents: -1 })).status).toBe(400);
    expect((await post(lead.token, '/staff/cash/open', { floatCents: 100_001 })).status).toBe(400);
    const id = await open(lead.token);
    expect(
      (await post(lead.token, `/staff/cash/${id}/close`, { counts: { ...countOf(0), '3': 1 } }))
        .status,
    ).toBe(400);
    expect(
      (await post(lead.token, `/staff/cash/${id}/close`, { counts: { ...countOf(0), '100': -1 } }))
        .status,
    ).toBe(400);
    expect(
      (await post(lead.token, `/staff/cash/${crypto.randomUUID()}/close`, { counts: countOf(0) }))
        .status,
    ).toBe(409);
    expect(
      (await post(lead.token, `/staff/cash/${id}/close`, { counts: countOf(15_000) })).status,
    ).toBe(200);
    expect(
      (await post(lead.token, `/staff/cash/not-a-uuid/close`, { counts: countOf(0) })).status,
    ).toBe(404);
  });

  it('flags cash sales taken with no drawer open', async () => {
    const barista = await staff('d-barista3', 'Staff.Barista');
    const before = await salesOutsideDrawers(db);
    await cashSale(barista.token);
    expect(await salesOutsideDrawers(db)).toBe(before + 1);
  });
});
