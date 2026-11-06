import { describe, expect, it } from 'vitest';
import { writeAudit } from '../../src/lib/audit';
import {
  createSession,
  destroySession,
  destroyUserSessions,
  hashToken,
  LIFETIMES,
  purgeExpiredSessions,
  readSession,
  SESSION_COOKIE,
  tokenFromCookieHeader,
} from '../../src/lib/session';
import { upsertUser } from '../../src/lib/users';
import { testDb } from '../setup/db';

const db = await testDb();
const HOUR = 3_600_000;

const staff = (sub: string, role: 'Staff.Barista' | 'Staff.Manager' = 'Staff.Barista') =>
  upsertUser(db, { idp: 'workforce', sub, displayName: `Test ${sub}`, role });

const stored = async (token: string) =>
  db
    .prepare('SELECT 1 FROM sessions WHERE id_hash = ?')
    .bind(await hashToken(token))
    .first();

describe('users', () => {
  it('creates a user once per directory and keeps the latest role', async () => {
    const first = await staff('sub-a', 'Staff.Barista');
    const again = await staff('sub-a', 'Staff.Manager');
    expect(again).toBe(first);
    const row = await db
      .prepare('SELECT role FROM users WHERE id = ?')
      .bind(first)
      .first<{ role: string }>();
    expect(row?.role).toBe('Staff.Manager');
  });

  it('never merges a staff and a customer identity with the same subject', async () => {
    const s = await upsertUser(db, { idp: 'workforce', sub: 'same-sub', displayName: 'Staff' });
    const c = await upsertUser(db, { idp: 'customer', sub: 'same-sub', displayName: 'Customer' });
    expect(s).not.toBe(c);
  });

  it('rejects an unknown role at the database', async () => {
    const insert = db
      .prepare(
        'INSERT INTO users (id, idp, idp_sub, display_name, role, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .bind('x', 'workforce', 'x', 'x', 'Staff.Admin', 'now', 'now');
    await expect(insert.run()).rejects.toThrow();
  });
});

describe('sessions (ADR-0024)', () => {
  it('issues a hardened cookie and stores only the token hash', async () => {
    const userId = await staff('sub-cookie');
    const { token, cookie } = await createSession(db, {
      userId,
      idp: 'workforce',
      role: 'Staff.Barista',
    });
    expect(cookie).toBe(
      `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=28800`,
    );
    const raw = await db.prepare('SELECT 1 FROM sessions WHERE id_hash = ?').bind(token).first();
    expect(raw).toBeNull();
    expect(await stored(token)).not.toBeNull();
  });

  it('reads back the signed-in user and role', async () => {
    const userId = await staff('sub-read');
    const { token } = await createSession(db, { userId, idp: 'workforce', role: 'Staff.Barista' });
    expect(await readSession(db, token)).toEqual({
      id: userId,
      idp: 'workforce',
      role: 'Staff.Barista',
    });
  });

  it('gives every sign-in a new token (no session fixation)', async () => {
    const userId = await staff('sub-rotate');
    const a = await createSession(db, { userId, idp: 'workforce' });
    const b = await createSession(db, { userId, idp: 'workforce' });
    expect(a.token).not.toBe(b.token);
  });

  it('ends a staff session after 1 hour idle, and deletes it', async () => {
    const userId = await staff('sub-idle');
    const t0 = Date.now();
    const { token } = await createSession(db, { userId, idp: 'workforce' }, t0);
    const lastUse = t0 + LIFETIMES.workforce.idleMs - 1;
    expect(await readSession(db, token, lastUse)).toBeDefined();
    // Using it slid the idle limit forward; now let a full idle period pass.
    expect(await readSession(db, token, lastUse + LIFETIMES.workforce.idleMs)).toBeUndefined();
    expect(await stored(token)).toBeNull();
  });

  it('ends a staff session after 8 hours however active it is', async () => {
    const userId = await staff('sub-abs');
    const t0 = Date.now();
    const { token } = await createSession(db, { userId, idp: 'workforce' }, t0);
    for (let h = 0.5; h < 8; h += 0.5) {
      expect(await readSession(db, token, t0 + h * HOUR)).toBeDefined();
    }
    expect(await readSession(db, token, t0 + 8 * HOUR)).toBeUndefined();
  });

  it('customer sessions last longer (14 days, 2 days idle)', async () => {
    const userId = await upsertUser(db, {
      idp: 'customer',
      sub: 'cust-1',
      displayName: 'Customer',
    });
    const t0 = Date.now();
    const { token, cookie } = await createSession(db, { userId, idp: 'customer' }, t0);
    expect(cookie).toContain('Max-Age=1209600');
    expect(await readSession(db, token, t0 + 47 * HOUR)).toEqual({ id: userId, idp: 'customer' });
  });

  it('signs out one session, or every session for a user', async () => {
    const userId = await staff('sub-out');
    const a = await createSession(db, { userId, idp: 'workforce' });
    const b = await createSession(db, { userId, idp: 'workforce' });
    await destroySession(db, a.token);
    expect(await readSession(db, a.token)).toBeUndefined();
    expect(await readSession(db, b.token)).toBeDefined();
    expect(await destroyUserSessions(db, userId)).toBe(1);
    expect(await readSession(db, b.token)).toBeUndefined();
  });

  it('purges expired sessions', async () => {
    const userId = await staff('sub-purge');
    await createSession(db, { userId, idp: 'workforce' }, Date.now() - 9 * HOUR);
    expect(await purgeExpiredSessions(db)).toBeGreaterThanOrEqual(1);
  });

  it('ignores malformed or injected cookie values', async () => {
    expect(tokenFromCookieHeader(undefined)).toBeUndefined();
    expect(tokenFromCookieHeader(`${SESSION_COOKIE}=short`)).toBeUndefined();
    expect(tokenFromCookieHeader(`other=1; ${SESSION_COOKIE}=%27%20OR%201%3D1`)).toBeUndefined();
    expect(await readSession(db, 'x'.repeat(43))).toBeUndefined();
  });
});

describe('audit log (AU-9)', () => {
  it('records an entry with request ID, actor and JSON before/after', async () => {
    await writeAudit(db, {
      requestId: 'req-1',
      actorUserId: 'u-1',
      actorRole: 'Staff.Manager',
      action: 'menu.item.86',
      target: 'latte',
      before: { soldOut: false },
      after: { soldOut: true },
    });
    const row = await db
      .prepare('SELECT * FROM audit_log WHERE request_id = ?')
      .bind('req-1')
      .first<Record<string, string>>();
    expect(row).toMatchObject({
      actor_role: 'Staff.Manager',
      action: 'menu.item.86',
      after: '{"soldOut":true}',
    });
  });

  it('is insert-only: updates and deletes are refused by the database', async () => {
    await writeAudit(db, { requestId: 'req-2', action: 'test.entry' });
    const update = db
      .prepare('UPDATE audit_log SET action = ? WHERE request_id = ?')
      .bind('tampered', 'req-2');
    const remove = db.prepare('DELETE FROM audit_log WHERE request_id = ?').bind('req-2');
    await expect(update.run()).rejects.toThrow(/insert-only/);
    await expect(remove.run()).rejects.toThrow(/insert-only/);
  });
});
