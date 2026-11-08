import { beforeAll, describe, expect, it } from 'vitest';
import { API_BASE, createApi } from '../../src/api/app';
import type { StaffRole } from '../../src/api/authz';
import { writeAudit } from '../../src/lib/audit';
import { setSoldOut, soldOutToday } from '../../src/lib/availability';
import { createSession, SESSION_COOKIE } from '../../src/lib/session';
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

async function staff(sub: string, role: StaffRole) {
  const userId = await upsertUser(db, { idp: 'workforce', sub, displayName: `Test ${sub}`, role });
  const { token } = await createSession(db, { userId, idp: 'workforce', role });
  return { userId, token, role };
}

const get = (token: string, path: string) =>
  call(`${API_BASE}${path}`, { headers: { Cookie: `${SESSION_COOKIE}=${token}` } });
const post = (token: string, path: string, body?: unknown, origin = ORIGIN) =>
  call(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      Cookie: `${SESSION_COOKIE}=${token}`,
      Origin: origin,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function lastAudit(action: string) {
  return db
    .prepare(
      'SELECT actor_user_id, actor_role, target, before, after FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT 1',
    )
    .bind(action)
    .first<{
      actor_user_id: string;
      actor_role: string;
      target: string;
      before: string | null;
      after: string | null;
    }>();
}

describe('route principals', () => {
  it('86 needs Shift Lead; restock needs Manager; activity is for every staff role', () => {
    const { routes } = createApi();
    expect(routes.filter((r) => /^\/staff\/(menu|restock|activity)/.test(r.path))).toEqual([
      { method: 'POST', path: '/staff/menu/:itemId/availability', principal: 'Staff.ShiftLead' },
      { method: 'GET', path: '/staff/restock', principal: 'Staff.Manager' },
      { method: 'POST', path: '/staff/restock', principal: 'Staff.Manager' },
      { method: 'POST', path: '/staff/restock/:id/done', principal: 'Staff.Manager' },
      { method: 'GET', path: '/staff/activity', principal: 'Staff.Barista' },
    ]);
  });
});

describe('86 an item (Shift Lead+)', () => {
  it('a barista is refused; a shift lead marks it sold out, audited with before and after', async () => {
    const barista = await staff('m-barista', 'Staff.Barista');
    const lead = await staff('m-lead', 'Staff.ShiftLead');
    expect(
      (await post(barista.token, '/staff/menu/mocha/availability', { soldOut: true })).status,
    ).toBe(403);
    const res = await post(lead.token, '/staff/menu/mocha/availability', { soldOut: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ itemId: 'mocha', soldOut: true, changed: true });
    const audit = await lastAudit('menu.item.sold_out');
    expect(audit).toMatchObject({
      actor_user_id: lead.userId,
      actor_role: 'Staff.ShiftLead',
      target: 'mocha',
    });
    expect(JSON.parse(audit!.before!)).toMatchObject({ soldOut: false });
    expect(JSON.parse(audit!.after!)).toMatchObject({ soldOut: true });
  });

  it("a sold-out item can't be sold, even from a stale register page", async () => {
    const lead = await staff('m-lead2', 'Staff.ShiftLead');
    await post(lead.token, '/staff/menu/red-eye/availability', { soldOut: true });
    const sale = await post(lead.token, '/staff/orders', {
      idempotencyKey: crypto.randomUUID(),
      tender: 'cash',
      tenderedCents: 2000,
      lines: [{ itemId: 'red-eye', variantId: '12oz', qty: 1 }],
    });
    expect(sale.status).toBe(422);
    expect(((await sale.json()) as { detail: string }).detail).toContain('sold out');
    await post(lead.token, '/staff/menu/red-eye/availability', { soldOut: false });
    expect((await lastAudit('menu.item.available'))?.target).toBe('red-eye');
  });

  it('comes back by itself the next business day', async () => {
    const lead = await staff('m-lead3', 'Staff.ShiftLead');
    // A fixed past day, so it can't overlap with sales made while the suite runs.
    const today = Date.UTC(2020, 0, 15, 15, 0);
    await setSoldOut(
      db,
      'americano',
      true,
      { userId: lead.userId, role: lead.role, requestId: 'r' },
      today,
    );
    expect((await soldOutToday(db, today)).has('americano')).toBe(true);
    expect((await soldOutToday(db, today + 24 * 3600_000)).has('americano')).toBe(false);
  });

  it('unknown items 404, bad bodies 400, other sites 403', async () => {
    const lead = await staff('m-lead4', 'Staff.ShiftLead');
    expect(
      (await post(lead.token, '/staff/menu/free-coffee/availability', { soldOut: true })).status,
    ).toBe(404);
    expect(
      (await post(lead.token, '/staff/menu/mocha/availability', { soldOut: 'yes' })).status,
    ).toBe(400);
    expect(
      (
        await post(
          lead.token,
          '/staff/menu/mocha/availability',
          { soldOut: true },
          'https://evil.example',
        )
      ).status,
    ).toBe(403);
  });
});

describe('restock requests (Manager+)', () => {
  it('a shift lead is refused; a manager requests, lists and closes, each audited', async () => {
    const lead = await staff('r-lead', 'Staff.ShiftLead');
    const manager = await staff('r-manager', 'Staff.Manager');
    const body = { itemId: 'mocha', quantity: '2 bags', note: 'before Saturday' };
    expect((await post(lead.token, '/staff/restock', body)).status).toBe(403);
    expect((await get(lead.token, '/staff/restock')).status).toBe(403);

    const created = await post(manager.token, '/staff/restock', body);
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    expect(await lastAudit('restock.requested')).toMatchObject({
      actor_user_id: manager.userId,
      target: id,
    });

    const list = (await (await get(manager.token, '/staff/restock')).json()) as {
      requests: { id: string; itemName: string; quantity: string; requestedBy: string }[];
    };
    expect(list.requests.find((r) => r.id === id)).toMatchObject({
      itemName: 'Mocha',
      quantity: '2 bags',
      requestedBy: 'Test r-manager',
    });

    expect((await post(manager.token, `/staff/restock/${id}/done`)).status).toBe(200);
    expect((await post(manager.token, `/staff/restock/${id}/done`)).status).toBe(404);
    expect((await lastAudit('restock.done'))?.target).toBe(id);
  });

  it('refuses unknown items and empty quantities', async () => {
    const manager = await staff('r-manager2', 'Staff.Manager');
    expect(
      (await post(manager.token, '/staff/restock', { itemId: 'free-coffee', quantity: '1' }))
        .status,
    ).toBe(404);
    expect(
      (await post(manager.token, '/staff/restock', { itemId: 'mocha', quantity: '  ' })).status,
    ).toBe(400);
  });
});

describe('activity: you see yourself and everyone below your role (Owner: all)', () => {
  it('each role sees exactly what the rule allows', async () => {
    const people = {
      barista: await staff('a-barista', 'Staff.Barista'),
      lead: await staff('a-lead', 'Staff.ShiftLead'),
      manager: await staff('a-manager', 'Staff.Manager'),
      owner: await staff('a-owner', 'Staff.Owner'),
      otherBarista: await staff('a-barista2', 'Staff.Barista'),
    };
    const tag = crypto.randomUUID();
    for (const [name, p] of Object.entries(people)) {
      await writeAudit(db, {
        requestId: tag,
        actorUserId: p.userId,
        actorRole: p.role,
        action: 'test.activity',
        target: name,
      });
    }
    // An event with no actor (e.g. a refused sign-in): Owner only.
    await writeAudit(db, { requestId: tag, action: 'test.activity', target: 'nobody' });

    const seen = async (token: string) => {
      const body = (await (await get(token, '/staff/activity')).json()) as {
        events: { action: string; target: string }[];
      };
      return body.events
        .filter((e) => e.action === 'test.activity')
        .map((e) => e.target)
        .sort();
    };
    expect(await seen(people.barista.token)).toEqual(['barista']);
    expect(await seen(people.lead.token)).toEqual(['barista', 'lead', 'otherBarista']);
    expect(await seen(people.manager.token)).toEqual([
      'barista',
      'lead',
      'manager',
      'otherBarista',
    ]);
    expect(await seen(people.owner.token)).toEqual([
      'barista',
      'lead',
      'manager',
      'nobody',
      'otherBarista',
      'owner',
    ]);
  });

  it('a sale appears in activity with its order number, recorded with the sale', async () => {
    const barista = await staff('a-sale', 'Staff.Barista');
    const res = await post(barista.token, '/staff/orders', {
      idempotencyKey: crypto.randomUUID(),
      tender: 'cash',
      tenderedCents: 500,
      lines: [{ itemId: 'americano', variantId: '16oz', qty: 1 }],
    });
    const { id, number } = (await res.json()) as { id: string; number: number };
    const body = (await (await get(barista.token, '/staff/activity')).json()) as {
      events: { action: string; target: string; summary: string }[];
    };
    const sale = body.events.find((e) => e.action === 'order.sale' && e.target === id);
    expect(sale?.summary).toBe(`Sale #${number}: $4.00 cash`);
  });

  it('pages with a cursor: the next page continues where the last ended', async () => {
    const owner = await staff('a-owner2', 'Staff.Owner');
    const first = (await (await get(owner.token, '/staff/activity')).json()) as {
      events: { id: number }[];
      next: number;
    };
    const second = (await (
      await get(owner.token, `/staff/activity?before=${first.next}`)
    ).json()) as {
      events: { id: number }[];
    };
    for (const e of second.events) expect(e.id).toBeLessThan(first.next);
  });

  it('signed out: 401', async () => {
    expect((await call(`${API_BASE}/staff/activity`)).status).toBe(401);
  });
});
