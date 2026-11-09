import { beforeAll, describe, expect, it } from 'vitest';
import { API_BASE, createApi } from '../../src/api/app';
import type { StaffRole } from '../../src/api/authz';
import { writeAudit } from '../../src/lib/audit';
import {
  bringBack,
  decideRestock,
  markSoldOut,
  soldOutItems,
  UNDO_WINDOW_MS,
} from '../../src/lib/availability';
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

async function auditCount(action: string, target: string) {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM audit_log WHERE action = ? AND target = ?')
    .bind(action, target)
    .first<{ n: number }>();
  return row!.n;
}

const actorFor = (p: { userId: string; role: StaffRole }) => ({
  userId: p.userId,
  role: p.role,
  requestId: crypto.randomUUID(),
});

describe('route principals', () => {
  it('sold out: everyone; request and receive: Shift Lead; approve, reject, history: Manager', () => {
    const { routes } = createApi();
    expect(routes.filter((r) => /^\/staff\/(menu|restock|activity)/.test(r.path))).toEqual([
      { method: 'POST', path: '/staff/menu/:itemId/availability', principal: 'Staff.Barista' },
      { method: 'GET', path: '/staff/restock', principal: 'Staff.ShiftLead' },
      { method: 'GET', path: '/staff/restock/history', principal: 'Staff.Manager' },
      { method: 'POST', path: '/staff/restock', principal: 'Staff.ShiftLead' },
      { method: 'POST', path: '/staff/restock/:id/approve', principal: 'Staff.Manager' },
      { method: 'POST', path: '/staff/restock/:id/reject', principal: 'Staff.Manager' },
      { method: 'POST', path: '/staff/restock/:id/received', principal: 'Staff.ShiftLead' },
      { method: 'GET', path: '/staff/activity', principal: 'Staff.Barista' },
    ]);
  });
});

describe('step 1: mark sold out (everyone)', () => {
  it('a barista marks an item sold out, audited once with before and after', async () => {
    const barista = await staff('m-barista', 'Staff.Barista');
    const res = await post(barista.token, '/staff/menu/mocha/availability', { soldOut: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ itemId: 'mocha', soldOut: true, changed: true });
    const audit = await lastAudit('menu.item.sold_out');
    expect(audit).toMatchObject({
      actor_user_id: barista.userId,
      actor_role: 'Staff.Barista',
      target: 'mocha',
    });
    expect(JSON.parse(audit!.before!)).toMatchObject({ soldOut: false });
    expect(JSON.parse(audit!.after!)).toMatchObject({ soldOut: true });

    // Marking it again changes nothing and writes no second audit row.
    const again = await post(barista.token, '/staff/menu/mocha/availability', { soldOut: true });
    expect(await again.json()).toMatchObject({ changed: false });
    expect(await auditCount('menu.item.sold_out', 'mocha')).toBe(1);
  });

  it("a sold-out item can't be sold, even from a stale register page; its marker can undo", async () => {
    const barista = await staff('m-barista2', 'Staff.Barista');
    await post(barista.token, '/staff/menu/red-eye/availability', { soldOut: true });
    const sale = await post(barista.token, '/staff/orders', {
      idempotencyKey: crypto.randomUUID(),
      tender: 'cash',
      tenderedCents: 2000,
      lines: [{ itemId: 'red-eye', variantId: '12oz', qty: 1 }],
    });
    expect(sale.status).toBe(422);
    expect(((await sale.json()) as { detail: string }).detail).toContain('sold out');

    const undo = await post(barista.token, '/staff/menu/red-eye/availability', { soldOut: false });
    expect(await undo.json()).toMatchObject({ soldOut: false, changed: true, how: 'undone' });
    expect(await lastAudit('menu.item.undo')).toMatchObject({
      actor_user_id: barista.userId,
      target: 'red-eye',
    });
  });

  it('stays sold out across days; only its marker undoes, within 5 minutes', async () => {
    const barista = await staff('m-barista3', 'Staff.Barista');
    const other = await staff('m-barista4', 'Staff.Barista');
    const lead = await staff('m-lead', 'Staff.ShiftLead');
    const t = Date.UTC(2020, 0, 15, 15, 0);
    await markSoldOut(db, 'house-brew', actorFor(barista), t);
    expect((await soldOutItems(db)).has('house-brew')).toBe(true);

    expect(await bringBack(db, 'house-brew', undefined, actorFor(other), t + 60_000)).toBe(
      'forbidden',
    );
    expect(await bringBack(db, 'house-brew', undefined, actorFor(lead), t + 60_000)).toBe(
      'forbidden',
    );
    expect(
      await bringBack(db, 'house-brew', undefined, actorFor(barista), t + UNDO_WINDOW_MS + 1),
    ).toBe('forbidden');
    // Days later it is still sold out.
    expect((await soldOutItems(db)).has('house-brew')).toBe(true);
    expect(
      await bringBack(db, 'house-brew', undefined, actorFor(barista), t + UNDO_WINDOW_MS),
    ).toBe('undone');
  });

  it('a shift lead is refused; a manager overrides only with a reason, audited with it', async () => {
    const barista = await staff('m-barista5', 'Staff.Barista');
    const lead = await staff('m-lead2', 'Staff.ShiftLead');
    const manager = await staff('m-manager', 'Staff.Manager');
    await markSoldOut(db, 'dark-roast', actorFor(barista), Date.now() - UNDO_WINDOW_MS - 1);
    const path = '/staff/menu/dark-roast/availability';

    const refused = await post(lead.token, path, { soldOut: false });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { detail: string }).detail).toContain('manager');
    expect((await post(manager.token, path, { soldOut: false })).status).toBe(400);
    expect((await post(manager.token, path, { soldOut: false, reason: '  ' })).status).toBe(400);
    // A code from the list only; Other needs a note.
    expect(
      (await post(manager.token, path, { soldOut: false, reason: { code: 'because' } })).status,
    ).toBe(400);
    expect(
      (await post(manager.token, path, { soldOut: false, reason: { code: 'other' } })).status,
    ).toBe(400);

    const ok = await post(manager.token, path, {
      soldOut: false,
      reason: { code: 'mistake' },
    });
    expect(await ok.json()).toMatchObject({ changed: true, how: 'overridden' });
    const audit = await lastAudit('menu.item.override');
    expect(audit).toMatchObject({ actor_user_id: manager.userId, target: 'dark-roast' });
    expect(JSON.parse(audit!.after!)).toMatchObject({
      reason: 'Marked by mistake',
      reasonCode: 'mistake',
    });
  });

  it('unknown items 404, bad bodies 400, other sites 403', async () => {
    const barista = await staff('m-barista6', 'Staff.Barista');
    expect(
      (await post(barista.token, '/staff/menu/free-coffee/availability', { soldOut: true })).status,
    ).toBe(404);
    expect(
      (await post(barista.token, '/staff/menu/mocha/availability', { soldOut: 'yes' })).status,
    ).toBe(400);
    expect(
      (
        await post(
          barista.token,
          '/staff/menu/mocha/availability',
          { soldOut: true },
          'https://evil.example',
        )
      ).status,
    ).toBe(403);
  });
});

describe('steps 2 to 4: request, approve, receive', () => {
  it('the full chain: each step by its role, each audited; received puts the item back', async () => {
    const barista = await staff('c-barista', 'Staff.Barista');
    const lead = await staff('c-lead', 'Staff.ShiftLead');
    const manager = await staff('c-manager', 'Staff.Manager');
    await post(barista.token, '/staff/menu/latte/availability', { soldOut: true });

    const body = { itemId: 'latte', quantity: '2 cases', note: 'before Saturday' };
    expect((await post(barista.token, '/staff/restock', body)).status).toBe(403);
    const created = await post(lead.token, '/staff/restock', body);
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    expect(await lastAudit('restock.requested')).toMatchObject({
      actor_user_id: lead.userId,
      target: id,
    });
    // One live request per item.
    expect((await post(lead.token, '/staff/restock', body)).status).toBe(409);

    const live = (await (await get(lead.token, '/staff/restock')).json()) as {
      requests: { id: string; itemName: string; status: string; requestedBy: string }[];
    };
    expect(live.requests.find((r) => r.id === id)).toMatchObject({
      itemName: 'Caffè Latte',
      status: 'requested',
      requestedBy: 'Test c-lead',
    });

    // Can't receive before approval; a shift lead can't approve.
    expect((await post(lead.token, `/staff/restock/${id}/received`)).status).toBe(409);
    expect((await post(lead.token, `/staff/restock/${id}/approve`)).status).toBe(403);

    expect((await post(manager.token, `/staff/restock/${id}/approve`)).status).toBe(200);
    expect(await lastAudit('restock.approved')).toMatchObject({
      actor_user_id: manager.userId,
      target: id,
    });
    expect((await post(manager.token, `/staff/restock/${id}/approve`)).status).toBe(409);

    // Still sold out until the delivery is received.
    expect((await soldOutItems(db)).has('latte')).toBe(true);
    const received = await post(lead.token, `/staff/restock/${id}/received`);
    expect(await received.json()).toMatchObject({ id, status: 'received', backInStock: true });
    expect((await soldOutItems(db)).has('latte')).toBe(false);
    expect(await lastAudit('restock.received')).toMatchObject({ actor_user_id: lead.userId });
    expect(await lastAudit('menu.item.available')).toMatchObject({
      actor_user_id: lead.userId,
      target: 'latte',
    });
    expect((await post(lead.token, `/staff/restock/${id}/received`)).status).toBe(409);

    const history = (await (await get(manager.token, '/staff/restock/history')).json()) as {
      requests: { id: string; status: string; decidedBy: string; receivedBy: string }[];
    };
    expect(history.requests.find((r) => r.id === id)).toMatchObject({
      status: 'received',
      decidedBy: 'Test c-manager',
      receivedBy: 'Test c-lead',
    });
    expect((await get(lead.token, '/staff/restock/history')).status).toBe(403);
  });

  it("a manager can't decide their own request (refusal audited); the owner can", async () => {
    const manager = await staff('c-manager2', 'Staff.Manager');
    const otherManager = await staff('c-manager3', 'Staff.Manager');
    const owner = await staff('c-owner', 'Staff.Owner');
    for (const item of ['cappuccino', 'cold-brew']) {
      await post(manager.token, `/staff/menu/${item}/availability`, { soldOut: true });
    }
    const { id } = (await (
      await post(manager.token, '/staff/restock', { itemId: 'cappuccino', quantity: '1' })
    ).json()) as { id: string };

    const own = await post(manager.token, `/staff/restock/${id}/approve`);
    expect(own.status).toBe(403);
    expect(await lastAudit('restock.decision_refused')).toMatchObject({
      actor_user_id: manager.userId,
      target: id,
    });
    expect(
      (
        await post(manager.token, `/staff/restock/${id}/reject`, {
          reason: { code: 'already-ordered' },
        })
      ).status,
    ).toBe(403);
    expect((await post(otherManager.token, `/staff/restock/${id}/approve`)).status).toBe(200);

    // The Owner may decide their own.
    const { id: ownerId } = (await (
      await post(owner.token, '/staff/restock', { itemId: 'cold-brew', quantity: '1' })
    ).json()) as { id: string };
    expect((await post(owner.token, `/staff/restock/${ownerId}/approve`)).status).toBe(200);
  });

  it('rejecting needs a reason; a rejected request frees the item for a new one', async () => {
    const lead = await staff('c-lead2', 'Staff.ShiftLead');
    const manager = await staff('c-manager4', 'Staff.Manager');
    await post(lead.token, '/staff/menu/maple-smoke/availability', { soldOut: true });
    const { id } = (await (
      await post(lead.token, '/staff/restock', { itemId: 'maple-smoke', quantity: '1 bottle' })
    ).json()) as { id: string };

    expect((await post(manager.token, `/staff/restock/${id}/reject`)).status).toBe(400);
    expect((await post(manager.token, `/staff/restock/${id}/reject`, { reason: ' ' })).status).toBe(
      400,
    );
    const rejected = await post(manager.token, `/staff/restock/${id}/reject`, {
      reason: { code: 'not-reordering', note: 'seasonal syrup' },
    });
    expect(await rejected.json()).toEqual({ id, status: 'rejected' });
    expect(JSON.parse((await lastAudit('restock.rejected'))!.after!)).toMatchObject({
      reason: 'Not reordering (seasonal or discontinued): seasonal syrup',
      reasonCode: 'not-reordering',
    });
    expect((await soldOutItems(db)).has('maple-smoke')).toBe(true);
    expect(
      (await post(lead.token, '/staff/restock', { itemId: 'maple-smoke', quantity: '1' })).status,
    ).toBe(201);
  });

  it('two managers approving at once: one wins, one audit row', async () => {
    const lead = await staff('c-lead3', 'Staff.ShiftLead');
    const a = await staff('c-manager5', 'Staff.Manager');
    const b = await staff('c-manager6', 'Staff.Manager');
    await post(lead.token, '/staff/menu/iced-mocha/availability', { soldOut: true });
    const { id } = (await (
      await post(lead.token, '/staff/restock', { itemId: 'iced-mocha', quantity: '1' })
    ).json()) as { id: string };
    const results = await Promise.all([
      decideRestock(db, id, 'approve', undefined, actorFor(a)),
      decideRestock(db, id, 'approve', undefined, actorFor(b)),
    ]);
    expect(results.filter((r) => r === 'approved')).toHaveLength(1);
    expect(await auditCount('restock.approved', id)).toBe(1);
  });

  it('refuses unknown items, items not sold out, and empty quantities', async () => {
    const lead = await staff('c-lead4', 'Staff.ShiftLead');
    expect(
      (await post(lead.token, '/staff/restock', { itemId: 'free-coffee', quantity: '1' })).status,
    ).toBe(404);
    expect(
      (await post(lead.token, '/staff/restock', { itemId: 'espresso', quantity: '1' })).status,
    ).toBe(409);
    expect(
      (await post(lead.token, '/staff/restock', { itemId: 'mocha', quantity: '  ' })).status,
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
