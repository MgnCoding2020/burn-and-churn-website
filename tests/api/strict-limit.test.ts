import { beforeAll, describe, expect, it } from 'vitest';
import { API_BASE, createApi } from '../../src/api/app';
import type { StaffRole } from '../../src/api/authz';
import { createSession, SESSION_COOKIE } from '../../src/lib/session';
import { FixedWindow, LIMITS, type LimiterNamespace } from '../../src/lib/strict-limit';
import { upsertUser } from '../../src/lib/users';
import { buildApp } from '../../src/server/app';
import { testDb } from '../setup/db';

// Strict limits on routes that cost something (ADR-0040). The Durable Object is
// replaced by a stand-in that runs the same FixedWindow, one per object name.

function fakeNamespace(fail = false) {
  const windows = new Map<string, FixedWindow>();
  const names: string[] = [];
  const ns: LimiterNamespace & { names: string[] } = {
    names,
    idFromName: (name: string) => name,
    get: ((name: string) => ({
      async hit(limit: number, periodMs: number) {
        if (fail) throw new Error('object unavailable');
        names.push(name);
        if (!windows.has(name)) windows.set(name, new FixedWindow());
        return windows.get(name)!.hit(limit, periodMs);
      },
    })) as never,
  };
  return ns;
}

const ORIGIN = 'http://localhost';
let db: D1Database;

beforeAll(async () => {
  db = await testDb();
});

const call = (path: string, env: Record<string, unknown>, init: RequestInit = {}) =>
  buildApp({ log: false }).request(`${ORIGIN}${path}`, init, {
    APP_ENV: 'local',
    DB: db,
    ...env,
  } as unknown as Env);

async function staff(sub: string, role: StaffRole) {
  const userId = await upsertUser(db, { idp: 'workforce', sub, displayName: `Test ${sub}`, role });
  const { token } = await createSession(db, { userId, idp: 'workforce', role });
  return { userId, token };
}

const publish = (token: string, env: Record<string, unknown>) =>
  call(`${API_BASE}/staff/sharepoint/publish`, env, {
    method: 'POST',
    headers: { Cookie: `${SESSION_COOKIE}=${token}`, Origin: ORIGIN },
  });

describe('FixedWindow', () => {
  it('allows the limit, refuses after it with the seconds left, and resets after the period', () => {
    const w = new FixedWindow();
    expect(w.hit(2, 60_000, 0)).toEqual({ ok: true, retryAfterSec: 0 });
    expect(w.hit(2, 60_000, 1_000).ok).toBe(true);
    expect(w.hit(2, 60_000, 20_500)).toEqual({ ok: false, retryAfterSec: 40 });
    expect(w.hit(2, 60_000, 60_000).ok).toBe(true);
  });
});

describe('which routes are strictly limited', () => {
  it('sign-in, every Stripe call and Publish, and nothing else', () => {
    const limited = createApi()
      .routes.filter((r) => r.limit)
      .map((r) => `${r.method} ${r.path} ${r.limit}`);
    expect(limited).toEqual([
      'GET /auth/staff/login signin',
      'GET /auth/staff/callback signin',
      'POST /staff/card-payments payments',
      'POST /staff/card-payments/:id/simulate-tap payments',
      'POST /staff/card-payments/:id/retry payments',
      'POST /staff/card-payments/:id/cancel payments',
      'POST /staff/orders/:id/refunds payments',
      'POST /staff/sharepoint/publish publish',
    ]);
  });
});

describe('strict limits (ADR-0040)', () => {
  it('refuses the fifth Publish in a minute with 429 and Retry-After, per person', async () => {
    const LIMITER = fakeNamespace();
    const a = await staff('sub-limit-a', 'Staff.Manager');
    const b = await staff('sub-limit-b', 'Staff.Manager');
    for (let i = 0; i < LIMITS.publish.limit; i++) {
      // Not set up here, so the handler answers 503: the limiter let it through.
      expect((await publish(a.token, { LIMITER })).status).toBe(503);
    }
    const refused = await publish(a.token, { LIMITER });
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(((await refused.json()) as { title: string }).title).toBe('Too many requests');
    // Another manager has their own count.
    expect((await publish(b.token, { LIMITER })).status).toBe(503);
    expect(new Set(LIMITER.names)).toEqual(new Set([`publish:${a.userId}`, `publish:${b.userId}`]));
  });

  it('checks the role first: a refused Barista never reaches the limiter', async () => {
    const LIMITER = fakeNamespace();
    const { token } = await staff('sub-limit-barista', 'Staff.Barista');
    expect((await publish(token, { LIMITER })).status).toBe(403);
    expect(LIMITER.names).toEqual([]);
  });

  it('counts sign-in starts per IP address', async () => {
    const LIMITER = fakeNamespace();
    const start = (ip: string) =>
      call(`${API_BASE}/auth/staff/login`, { LIMITER }, { headers: { 'CF-Connecting-IP': ip } });
    for (let i = 0; i < LIMITS.signin.limit; i++) {
      expect((await start('203.0.113.9')).status).not.toBe(429);
    }
    expect((await start('203.0.113.9')).status).toBe(429);
    expect((await start('203.0.113.10')).status).not.toBe(429);
    expect(LIMITER.names[0]).toBe('signin:ip:203.0.113.9');
  });

  it('lets requests through when the limiter is missing or unreachable', async () => {
    const { token } = await staff('sub-limit-open', 'Staff.Manager');
    for (let i = 0; i < LIMITS.publish.limit + 2; i++) {
      expect((await publish(token, {})).status).toBe(503);
      expect((await publish(token, { LIMITER: fakeNamespace(true) })).status).toBe(503);
    }
  });
});
