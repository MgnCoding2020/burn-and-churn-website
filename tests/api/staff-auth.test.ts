import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { API_BASE, createApi } from '../../src/api/app';
import { LOGIN_COOKIE, PORTAL_PATH, PROBLEM_PAGE, SIGNED_OUT_PAGE } from '../../src/api/staff-auth';
import { x5t } from '../../src/lib/entra';
import { createSession, hashToken, SESSION_COOKIE } from '../../src/lib/session';
import { upsertUser } from '../../src/lib/users';
import { buildApp } from '../../src/server/app';
import { testDb } from '../setup/db';

const TENANT = '11111111-2222-4333-8444-555555555555';
const CLIENT = '22222222-3333-4444-8555-666666666666';
const THUMB = 'ab'.repeat(20);
const OID = '99999999-8888-4777-8666-555555555555';
const ORIGIN = 'http://localhost';

let db: D1Database;
let env: Env;

async function pkcs8Pem(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const b64 = btoa(String.fromCharCode(...der)).match(/.{1,64}/g)!;
  return ['-----BEGIN PRIVATE KEY-----', ...b64, '-----END PRIVATE KEY-----'].join('\n');
}

beforeAll(async () => {
  db = await testDb();
  env = {
    APP_ENV: 'local',
    DB: db,
    ENTRA_STAFF_TENANT_ID: TENANT,
    ENTRA_STAFF_CLIENT_ID: CLIENT,
    ENTRA_STAFF_CERT_THUMBPRINT: THUMB,
    ENTRA_STAFF_CERT_PRIVATE_KEY: await pkcs8Pem(),
  } as unknown as Env;
});

afterEach(() => vi.unstubAllGlobals());

const app = () => buildApp({ log: false });
const call = (path: string, init?: RequestInit, e: Env = env) =>
  app().request(`${ORIGIN}${path}`, init, e);

const b64url = (v: object) =>
  btoa(JSON.stringify(v)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const decode = (part: string) => JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));

const cookieValue = (res: Response, name: string) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0]!)
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1);

async function lastAudit() {
  return db
    .prepare(
      'SELECT action, actor_user_id, actor_role, after FROM audit_log ORDER BY id DESC LIMIT 1',
    )
    .first<{
      action: string;
      actor_user_id: string | null;
      actor_role: string | null;
      after: string | null;
    }>();
}

/** Starts a sign-in and returns the state cookie and the parameters sent to Entra. */
async function startLogin(query = '') {
  const res = await call(`${API_BASE}/auth/staff/login${query}`);
  expect(res.status).toBe(302);
  const target = new URL(res.headers.get('Location')!);
  return { res, target, state: cookieValue(res, LOGIN_COOKIE)! };
}

/** Stands in for Entra's token endpoint, recording what the site sent it. */
function stubTokenEndpoint(claims: Record<string, unknown>) {
  const sent: URLSearchParams[] = [];
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`);
    sent.push(new URLSearchParams(String(init?.body)));
    const now = Math.floor(Date.now() / 1000);
    const idToken = [
      b64url({ alg: 'RS256', typ: 'JWT' }),
      b64url({
        iss: `https://login.microsoftonline.com/${TENANT}/v2.0`,
        aud: CLIENT,
        iat: now,
        nbf: now,
        exp: now + 3600,
        sub: 'pairwise-sub',
        ...claims,
      }),
      'c2lnbmF0dXJl',
    ].join('.');
    return new Response(
      JSON.stringify({
        token_type: 'Bearer',
        access_token: 'unused',
        expires_in: 3600,
        id_token: idToken,
        scope: 'openid profile',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });
  return sent;
}

describe('route principals', () => {
  it('declares every staff auth route', () => {
    const { routes } = createApi();
    expect(
      routes.filter((r) => r.path.includes('/auth/staff/') || r.path.startsWith('/staff/')),
    ).toEqual([
      { method: 'GET', path: '/auth/staff/login', principal: 'public' },
      { method: 'GET', path: '/auth/staff/callback', principal: 'public' },
      { method: 'POST', path: '/auth/staff/logout', principal: 'public' },
      { method: 'GET', path: '/staff/me', principal: 'Staff.Barista' },
      { method: 'GET', path: '/staff/session', principal: 'Staff.Barista' },
      { method: 'POST', path: '/staff/session/extend', principal: 'Staff.Barista' },
    ]);
  });
});

describe('when sign-in is not configured', () => {
  it('login and callback answer 503 with a problem body', async () => {
    const bare = { APP_ENV: 'local' } as unknown as Env;
    for (const path of ['/auth/staff/login', '/auth/staff/callback']) {
      const res = await call(`${API_BASE}${path}`, undefined, bare);
      expect(res.status).toBe(503);
      expect(((await res.json()) as { detail: string }).detail).toBe(
        'Staff sign-in is not configured here yet.',
      );
    }
  });
});

describe('GET /auth/staff/login', () => {
  it('redirects to Entra with PKCE, state and nonce, and binds the state to this browser', async () => {
    const { res, target, state } = await startLogin();
    expect(target.origin + target.pathname).toBe(
      `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`,
    );
    const p = target.searchParams;
    expect(p.get('client_id')).toBe(CLIENT);
    expect(p.get('response_type')).toBe('code');
    expect(p.get('redirect_uri')).toBe(`${ORIGIN}/api/v1/auth/staff/callback`);
    expect(p.get('scope')).toBe('openid profile');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.get('nonce')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.get('state')).toBe(state);
    expect(p.get('prompt')).toBe('select_account');
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith(LOGIN_COOKIE))!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=600');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('asks Entra for the account again on switch-user', async () => {
    const { target } = await startLogin('?switch=1');
    expect(target.searchParams.get('prompt')).toBe('login');
  });
});

describe('GET /auth/staff/callback', () => {
  it('signs in a barista: session cookie, user row and audit entry; nothing sensitive in the redirect', async () => {
    const { target, state } = await startLogin();
    const sent = stubTokenEndpoint({
      nonce: target.searchParams.get('nonce'),
      tid: TENANT,
      oid: OID,
      name: 'Ethan Brooks',
      roles: ['Staff.Barista'],
    });

    const res = await call(`${API_BASE}/auth/staff/callback?code=one-time-code&state=${state}`, {
      headers: { Cookie: `${LOGIN_COOKIE}=${state}` },
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe(PORTAL_PATH);

    // What went to Entra: the PKCE verifier and a certificate assertion, no secret
    const body = sent[0]!;
    expect(body.get('code')).toBe('one-time-code');
    expect(body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.get('client_secret')).toBeNull();
    expect(body.get('client_assertion_type')).toBe(
      'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    );
    const header = decode(body.get('client_assertion')!.split('.')[0]!);
    expect(header).toMatchObject({ alg: 'RS256', x5t: x5t(THUMB) });

    const token = cookieValue(res, SESSION_COOKIE)!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookieValue(res, LOGIN_COOKIE)).toBe('');

    const me = await call(`${API_BASE}/staff/me`, {
      headers: { Cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(await me.json()).toEqual({ displayName: 'Ethan Brooks', role: 'Staff.Barista' });

    const audit = await lastAudit();
    expect(audit).toMatchObject({ action: 'auth.staff.sign_in', actor_role: 'Staff.Barista' });
  });

  it('uses each sign-in attempt once: a replayed callback is refused', async () => {
    const { target, state } = await startLogin();
    stubTokenEndpoint({
      nonce: target.searchParams.get('nonce'),
      tid: TENANT,
      oid: OID,
      roles: ['Staff.Barista'],
    });
    const replay = () =>
      call(`${API_BASE}/auth/staff/callback?code=c&state=${state}`, {
        headers: { Cookie: `${LOGIN_COOKIE}=${state}` },
      });
    expect((await replay()).headers.get('Location')).toBe(PORTAL_PATH);
    const second = await replay();
    expect(second.headers.get('Location')).toBe(PROBLEM_PAGE);
    expect(JSON.parse((await lastAudit())!.after!)).toEqual({ reason: 'unknown_or_expired_state' });
  });

  it.each([
    [
      'no login cookie (started in another browser)',
      (s: string) => ({ query: `code=c&state=${s}`, cookie: '' }),
      'no_login_cookie',
    ],
    [
      'a state that does not match the cookie',
      (s: string) => ({ query: `code=c&state=${'x'.repeat(43)}`, cookie: s }),
      'state_mismatch',
    ],
    [
      'an error from Entra',
      (s: string) => ({ query: `error=access_denied&state=${s}`, cookie: s }),
      'authorization_error',
    ],
  ])('refuses %s, and records why', async (_label, make, reason) => {
    const { state } = await startLogin();
    const { query, cookie } = make(state);
    const res = await call(`${API_BASE}/auth/staff/callback?${query}`, {
      headers: cookie ? { Cookie: `${LOGIN_COOKIE}=${cookie}` } : {},
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe(PROBLEM_PAGE);
    expect(cookieValue(res, SESSION_COOKIE)).toBeUndefined();
    const audit = await lastAudit();
    expect(audit?.action).toBe('auth.staff.sign_in_refused');
    expect(JSON.parse(audit!.after!)).toEqual({ reason });
  });

  it.each([
    ['a token without a staff role', { roles: [] }, 'no_staff_role'],
    [
      'a token from another tenant',
      { tid: '00000000-0000-4000-8000-000000000000', roles: ['Staff.Owner'] },
      'wrong_tenant',
    ],
  ])('refuses %s', async (_label, extra, reason) => {
    const { target, state } = await startLogin();
    stubTokenEndpoint({ nonce: target.searchParams.get('nonce'), tid: TENANT, oid: OID, ...extra });
    const res = await call(`${API_BASE}/auth/staff/callback?code=c&state=${state}`, {
      headers: { Cookie: `${LOGIN_COOKIE}=${state}` },
    });
    expect(res.headers.get('Location')).toBe(PROBLEM_PAGE);
    expect(cookieValue(res, SESSION_COOKIE)).toBeUndefined();
    expect(JSON.parse((await lastAudit())!.after!)).toEqual({ reason });
  });

  it('refuses an ID token whose nonce does not match', async () => {
    const { state } = await startLogin();
    stubTokenEndpoint({
      nonce: 'someone-elses-nonce',
      tid: TENANT,
      oid: OID,
      roles: ['Staff.Owner'],
    });
    const res = await call(`${API_BASE}/auth/staff/callback?code=c&state=${state}`, {
      headers: { Cookie: `${LOGIN_COOKIE}=${state}` },
    });
    expect(res.headers.get('Location')).toBe(PROBLEM_PAGE);
    expect(JSON.parse((await lastAudit())!.after!)).toEqual({ reason: 'token_error' });
  });
});

describe('POST /auth/staff/logout', () => {
  it('ends the session, clears the cookie and records it', async () => {
    const userId = await upsertUser(db, {
      idp: 'workforce',
      sub: 'logout-sub',
      displayName: 'Mia Chen',
      role: 'Staff.ShiftLead',
    });
    const { token } = await createSession(db, {
      userId,
      idp: 'workforce',
      role: 'Staff.ShiftLead',
    });
    const cookie = { Cookie: `${SESSION_COOKIE}=${token}`, Origin: ORIGIN };

    const res = await call(`${API_BASE}/auth/staff/logout`, { method: 'POST', headers: cookie });
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe(SIGNED_OUT_PAGE);
    expect(cookieValue(res, SESSION_COOKIE)).toBe('');
    expect(await lastAudit()).toMatchObject({
      action: 'auth.staff.sign_out',
      actor_user_id: userId,
    });

    const after = await call(`${API_BASE}/staff/me`, { headers: cookie });
    expect(after.status).toBe(401);
  });

  it('is refused from another site (CSRF)', async () => {
    const res = await call(`${API_BASE}/auth/staff/logout`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
  });
});

describe('GET /staff/me (Staff.Barista and up)', () => {
  it('needs a sign-in', async () => {
    expect((await call(`${API_BASE}/staff/me`)).status).toBe(401);
  });

  it('refuses a customer session', async () => {
    const userId = await upsertUser(db, {
      idp: 'customer',
      sub: 'cust-me',
      displayName: 'A customer',
    });
    const { token } = await createSession(db, { userId, idp: 'customer' });
    const res = await call(`${API_BASE}/staff/me`, {
      headers: { Cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(res.status).toBe(403);
  });

  it('ignores a forged cookie', async () => {
    const res = await call(`${API_BASE}/staff/me`, {
      headers: { Cookie: `${SESSION_COOKIE}=${'A'.repeat(43)}` },
    });
    expect(res.status).toBe(401);
  });
});

describe('session time left (ADR-0028, Staff.Barista and up)', () => {
  const HOUR = 3_600_000;

  async function staffSession(sub: string) {
    const userId = await upsertUser(db, {
      idp: 'workforce',
      sub,
      displayName: 'Ethan Brooks',
      role: 'Staff.Barista',
    });
    const { token } = await createSession(db, { userId, idp: 'workforce', role: 'Staff.Barista' });
    return token;
  }

  /** Puts the session's idle limit `ms` from now. */
  async function idleIn(token: string, ms: number) {
    await db
      .prepare('UPDATE sessions SET idle_expires_at = ? WHERE id_hash = ?')
      .bind(Date.now() + ms, await hashToken(token))
      .run();
  }

  const asStaff = (token: string, init: RequestInit = {}) => ({
    ...init,
    headers: { Cookie: `${SESSION_COOKIE}=${token}`, ...init.headers },
  });

  it('both routes need a sign-in', async () => {
    expect((await call(`${API_BASE}/staff/session`)).status).toBe(401);
    const res = await call(`${API_BASE}/staff/session/extend`, {
      method: 'POST',
      headers: { Origin: ORIGIN },
    });
    expect(res.status).toBe(401);
  });

  it('both routes refuse a customer session', async () => {
    const userId = await upsertUser(db, { idp: 'customer', sub: 'cust-t', displayName: 'C' });
    const { token } = await createSession(db, { userId, idp: 'customer' });
    expect((await call(`${API_BASE}/staff/session`, asStaff(token))).status).toBe(403);
    const res = await call(
      `${API_BASE}/staff/session/extend`,
      asStaff(token, { method: 'POST', headers: { Origin: ORIGIN } }),
    );
    expect(res.status).toBe(403);
  });

  it('reports the time left without counting as activity', async () => {
    const token = await staffSession('oid-status');
    await idleIn(token, 90_000);
    for (let i = 0; i < 2; i++) {
      const res = await call(`${API_BASE}/staff/session`, asStaff(token));
      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      const times = (await res.json()) as { idleMsLeft: number; absoluteMsLeft: number };
      expect(times.idleMsLeft).toBeLessThanOrEqual(90_000);
      expect(times.idleMsLeft).toBeGreaterThan(80_000);
      expect(times.absoluteMsLeft).toBeGreaterThan(7 * HOUR);
    }
  });

  it('"Stay signed in" moves the idle limit back to a full hour', async () => {
    const token = await staffSession('oid-extend');
    await idleIn(token, 90_000);
    const res = await call(
      `${API_BASE}/staff/session/extend`,
      asStaff(token, { method: 'POST', headers: { Origin: ORIGIN } }),
    );
    expect(res.status).toBe(200);
    const times = (await res.json()) as { idleMsLeft: number };
    expect(times.idleMsLeft).toBeGreaterThan(HOUR - 60_000);
  });

  it('"Stay signed in" is refused from another site (CSRF)', async () => {
    const token = await staffSession('oid-csrf');
    const res = await call(
      `${API_BASE}/staff/session/extend`,
      asStaff(token, { method: 'POST', headers: { Origin: 'https://evil.example' } }),
    );
    expect(res.status).toBe(403);
  });

  it('an idle-expired session is signed out, and the status check says so', async () => {
    const token = await staffSession('oid-expired');
    await idleIn(token, -1);
    expect((await call(`${API_BASE}/staff/session`, asStaff(token))).status).toBe(401);
  });
});
