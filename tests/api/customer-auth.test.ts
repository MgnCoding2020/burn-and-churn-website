import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { API_BASE, createApi } from '../../src/api/app';
import {
  ACCOUNT_PATH,
  CUSTOMER_LOGIN_COOKIE,
  CUSTOMER_PROBLEM_PAGE,
  CUSTOMER_SIGNED_OUT_PAGE,
} from '../../src/api/customer-auth';
import { LOGIN_COOKIE } from '../../src/api/staff-auth';
import { x5t } from '../../src/lib/entra';
import { createSession, SESSION_COOKIE } from '../../src/lib/session';
import { upsertUser } from '../../src/lib/users';
import { buildApp } from '../../src/server/app';
import { testDb } from '../setup/db';

const TENANT = '33333333-4444-4555-8666-777777777777';
const CLIENT = '44444444-5555-4666-8777-888888888888';
const THUMB = 'cd'.repeat(20);
const OID = '55555555-6666-4777-8888-999999999999';
const STAFF_TENANT = '11111111-2222-4333-8444-555555555555';
const ORIGIN = 'http://localhost';
const CIAM = `https://${TENANT}.ciamlogin.com/${TENANT}`;

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
    ENTRA_STAFF_TENANT_ID: STAFF_TENANT,
    ENTRA_STAFF_CLIENT_ID: '22222222-3333-4444-8555-666666666666',
    ENTRA_STAFF_CERT_THUMBPRINT: 'ab'.repeat(20),
    ENTRA_STAFF_CERT_PRIVATE_KEY: await pkcs8Pem(),
    ENTRA_CUSTOMER_TENANT_ID: TENANT,
    ENTRA_CUSTOMER_CLIENT_ID: CLIENT,
    ENTRA_CUSTOMER_CERT_THUMBPRINT: THUMB,
    ENTRA_CUSTOMER_CERT_PRIVATE_KEY: await pkcs8Pem(),
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

async function startLogin(query = '') {
  const res = await call(`${API_BASE}/auth/customer/login${query}`);
  expect(res.status).toBe(302);
  const target = new URL(res.headers.get('Location')!);
  return {
    res,
    target,
    state: target.searchParams.get('state')!,
    nonce: target.searchParams.get('nonce')!,
    sealed: cookieValue(res, CUSTOMER_LOGIN_COOKIE)!,
  };
}

async function tableCounts() {
  const n = async (table: string) =>
    (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
  return {
    users: await n('users'),
    sessions: await n('sessions'),
    audit_log: await n('audit_log'),
  };
}

async function warningsDuring(fn: () => Promise<unknown>) {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await fn();
    return warn.mock.calls.map((args) => JSON.parse(String(args[0])) as Record<string, unknown>);
  } finally {
    warn.mockRestore();
  }
}

/** Stands in for the customer directory's token endpoint. */
function stubTokenEndpoint(claims: Record<string, unknown>) {
  const sent: URLSearchParams[] = [];
  const redeemed = new Set<string>();
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe(`${CIAM}/oauth2/v2.0/token`);
    const body = new URLSearchParams(String(init?.body));
    sent.push(body);
    const code = body.get('code')!;
    if (redeemed.has(code)) {
      return new Response(JSON.stringify({ error: 'invalid_grant' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    redeemed.add(code);
    const now = Math.floor(Date.now() / 1000);
    const idToken = [
      b64url({ alg: 'RS256', typ: 'JWT' }),
      b64url({
        iss: `${CIAM}/v2.0`,
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

/** A full customer sign-in; returns the session token. */
async function signInCustomer(name = 'Avery Test') {
  const { state, nonce, sealed } = await startLogin();
  stubTokenEndpoint({ nonce, tid: TENANT, oid: OID, name });
  const res = await call(`${API_BASE}/auth/customer/callback?code=code-${state}&state=${state}`, {
    headers: { Cookie: `${CUSTOMER_LOGIN_COOKIE}=${sealed}` },
  });
  expect(res.headers.get('Location')).toBe(ACCOUNT_PATH);
  vi.unstubAllGlobals();
  return { res, token: cookieValue(res, SESSION_COOKIE)! };
}

describe('route principals', () => {
  it('declares every customer auth route, with the sign-in limit on login and callback', () => {
    const { routes } = createApi();
    expect(
      routes.filter((r) => r.path.includes('/auth/customer/') || r.path === '/account/me'),
    ).toEqual([
      { method: 'GET', path: '/auth/customer/login', principal: 'public', limit: 'signin' },
      { method: 'GET', path: '/auth/customer/callback', principal: 'public', limit: 'signin' },
      { method: 'POST', path: '/auth/customer/logout', principal: 'public' },
      { method: 'GET', path: '/account/me', principal: 'customer' },
    ]);
  });
});

describe('when customer sign-in is not configured', () => {
  it('login and callback answer 503, and staff sign-in settings alone are not enough', async () => {
    const staffOnly = { ...env } as unknown as Record<string, unknown>;
    for (const k of Object.keys(staffOnly)) if (k.startsWith('ENTRA_CUSTOMER')) delete staffOnly[k];
    for (const path of ['/auth/customer/login', '/auth/customer/callback']) {
      const res = await call(`${API_BASE}${path}`, undefined, staffOnly as unknown as Env);
      expect(res.status).toBe(503);
      expect(((await res.json()) as { detail: string }).detail).toBe(
        'Customer sign-in is not configured here yet.',
      );
    }
  });
});

describe('GET /auth/customer/login', () => {
  it('redirects to the customer directory with PKCE, state, nonce and a fresh code each time', async () => {
    const { res, target, state, nonce, sealed } = await startLogin();
    expect(target.origin + target.pathname).toBe(`${CIAM}/oauth2/v2.0/authorize`);
    const p = target.searchParams;
    expect(p.get('client_id')).toBe(CLIENT);
    expect(p.get('response_type')).toBe('code');
    expect(p.get('redirect_uri')).toBe(`${ORIGIN}/api/v1/auth/customer/callback`);
    expect(p.get('scope')).toBe('openid profile');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.get('prompt')).toBe('login');
    expect(sealed).toMatch(/^v1\./);
    for (const v of [state, nonce]) expect(sealed).not.toContain(v);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith(CUSTOMER_LOGIN_COOKIE))!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=600');
    // Its own cookie: the staff sign-in cookie is untouched.
    expect(cookieValue(res, LOGIN_COOKIE)).toBeUndefined();
  });

  it('writes nothing to the database (ADR-0030)', async () => {
    const before = await tableCounts();
    for (let i = 0; i < 5; i++) await startLogin();
    expect(await tableCounts()).toEqual(before);
  });
});

describe('GET /auth/customer/callback', () => {
  it('"Sign in to pay" (?next=order) comes back to the order; any other next is ignored', async () => {
    for (const [query, landing] of [
      ['?next=order', '/order/'],
      ['?next=https://evil.example', ACCOUNT_PATH],
      ['?next=/staff/', ACCOUNT_PATH],
    ] as const) {
      const { state, nonce, sealed } = await startLogin(query);
      stubTokenEndpoint({ nonce, tid: TENANT, oid: OID, name: 'Avery Test' });
      const res = await call(`${API_BASE}/auth/customer/callback?code=c-${state}&state=${state}`, {
        headers: { Cookie: `${CUSTOMER_LOGIN_COOKIE}=${sealed}` },
      });
      expect(res.headers.get('Location')).toBe(landing);
      vi.unstubAllGlobals();
    }
  });

  it('signs a customer in: certificate assertion, customer session, name only, no audit row', async () => {
    const before = await tableCounts();
    const { state, nonce, sealed } = await startLogin();
    const sent = stubTokenEndpoint({
      nonce,
      tid: TENANT,
      oid: OID,
      name: 'Avery Test',
      email: 'avery@example.com',
    });
    const res = await call(`${API_BASE}/auth/customer/callback?code=one-time&state=${state}`, {
      headers: { Cookie: `${CUSTOMER_LOGIN_COOKIE}=${sealed}` },
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe(ACCOUNT_PATH);

    const body = sent[0]!;
    expect(body.get('client_secret')).toBeNull();
    expect(decode(body.get('client_assertion')!.split('.')[0]!)).toMatchObject({
      alg: 'RS256',
      x5t: x5t(THUMB),
    });
    // Addressed to the token endpoint: the customer directory refuses the issuer (AADSTS700023).
    expect(decode(body.get('client_assertion')!.split('.')[1]!)).toMatchObject({
      aud: `${CIAM}/oauth2/v2.0/token`,
      iss: CLIENT,
      sub: CLIENT,
    });

    const token = cookieValue(res, SESSION_COOKIE)!;
    const session = await db
      .prepare(
        `SELECT s.idp, s.role, s.expires_at - s.created_at AS life, u.idp_sub, u.display_name, u.role AS user_role
         FROM sessions s JOIN users u ON u.id = s.user_id ORDER BY s.created_at DESC LIMIT 1`,
      )
      .first<Record<string, unknown>>();
    expect(session).toEqual({
      idp: 'customer',
      role: null,
      life: 14 * 24 * 60 * 60 * 1000,
      idp_sub: OID,
      display_name: 'Avery Test',
      user_role: null,
    });
    // The email address in the token is not stored anywhere.
    const dump = JSON.stringify(await db.prepare('SELECT * FROM users').all());
    expect(dump).not.toContain('avery@example.com');

    const me = await call(`${API_BASE}/account/me`, {
      headers: { Cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(await me.json()).toEqual({ displayName: 'Avery Test' });
    // Customer sign-ins aren't staff actions: nothing in the staff audit log.
    expect((await tableCounts()).audit_log).toBe(before.audit_log);
  });

  it('a customer session is refused on staff routes (403), and a staff session on customer routes', async () => {
    const { token } = await signInCustomer();
    const asCustomer = { headers: { Cookie: `${SESSION_COOKIE}=${token}` } };
    for (const path of ['/staff/me', '/staff/session', '/staff/orders']) {
      expect((await call(`${API_BASE}${path}`, asCustomer)).status).toBe(403);
    }

    const staffId = await upsertUser(db, {
      idp: 'workforce',
      sub: '66666666-7777-4888-8999-000000000000',
      displayName: 'Daniel Lopez',
      role: 'Staff.Owner',
    });
    const staff = await createSession(db, {
      userId: staffId,
      idp: 'workforce',
      role: 'Staff.Owner',
    });
    const asOwner = { headers: { Cookie: `${SESSION_COOKIE}=${staff.token}` } };
    expect((await call(`${API_BASE}/account/me`, asOwner)).status).toBe(403);
    expect((await call(`${API_BASE}/account/me`)).status).toBe(401);
  });

  it('replaces a session the browser already had', async () => {
    const first = await signInCustomer();
    const { state, nonce, sealed } = await startLogin();
    stubTokenEndpoint({ nonce, tid: TENANT, oid: OID, name: 'Avery Test' });
    const res = await call(`${API_BASE}/auth/customer/callback?code=again&state=${state}`, {
      headers: { Cookie: `${CUSTOMER_LOGIN_COOKIE}=${sealed}; ${SESSION_COOKIE}=${first.token}` },
    });
    expect(res.headers.get('Location')).toBe(ACCOUNT_PATH);
    const old = await call(`${API_BASE}/account/me`, {
      headers: { Cookie: `${SESSION_COOKIE}=${first.token}` },
    });
    expect(old.status).toBe(401);
  });

  it('refuses a staff sign-in cookie: it was sealed for another purpose', async () => {
    const staffStart = await call(`${API_BASE}/auth/staff/login`);
    const staffSealed = cookieValue(staffStart, LOGIN_COOKIE)!;
    const state = new URL(staffStart.headers.get('Location')!).searchParams.get('state');
    const logged = await warningsDuring(async () => {
      const res = await call(`${API_BASE}/auth/customer/callback?code=c&state=${state}`, {
        headers: { Cookie: `${CUSTOMER_LOGIN_COOKIE}=${staffSealed}` },
      });
      expect(res.headers.get('Location')).toBe(CUSTOMER_PROBLEM_PAGE);
    });
    expect(logged).toContainEqual(expect.objectContaining({ reason: 'bad_login_cookie' }));
  });

  it.each([
    ['a token from another directory', { tid: STAFF_TENANT }, 'wrong_tenant'],
    ['a token without an object ID', { oid: undefined }, 'no_object_id'],
  ])('refuses %s: logged, nothing stored', async (_label, extra, reason) => {
    const { state, nonce, sealed } = await startLogin();
    stubTokenEndpoint({ nonce, tid: TENANT, oid: OID, name: 'X', ...extra });
    const before = await tableCounts();
    const logged = await warningsDuring(async () => {
      const res = await call(`${API_BASE}/auth/customer/callback?code=c&state=${state}`, {
        headers: { Cookie: `${CUSTOMER_LOGIN_COOKIE}=${sealed}` },
      });
      expect(res.headers.get('Location')).toBe(CUSTOMER_PROBLEM_PAGE);
      expect(cookieValue(res, SESSION_COOKIE)).toBeUndefined();
    });
    expect(logged).toContainEqual(
      expect.objectContaining({ event: 'auth.customer.sign_in_refused', reason }),
    );
    expect(await tableCounts()).toEqual(before);
  });

  it.each([
    [
      'no login cookie',
      (state: string) => ({ query: `code=c&state=${state}`, cookie: '' }),
      'no_login_cookie',
    ],
    [
      'a state that does not match',
      (_s: string, sealed: string) => ({ query: `code=c&state=${'x'.repeat(43)}`, cookie: sealed }),
      'state_mismatch',
    ],
    [
      'an error from the directory (cancelled)',
      (state: string, sealed: string) => ({
        query: `error=access_denied&state=${state}`,
        cookie: sealed,
      }),
      'authorization_error',
    ],
  ])('refuses %s', async (_label, make, reason) => {
    const { state, sealed } = await startLogin();
    const { query, cookie } = make(state, sealed);
    const before = await tableCounts();
    const logged = await warningsDuring(async () => {
      const res = await call(`${API_BASE}/auth/customer/callback?${query}`, {
        headers: cookie ? { Cookie: `${CUSTOMER_LOGIN_COOKIE}=${cookie}` } : {},
      });
      expect(res.headers.get('Location')).toBe(CUSTOMER_PROBLEM_PAGE);
    });
    expect(logged).toContainEqual(expect.objectContaining({ reason }));
    expect(await tableCounts()).toEqual(before);
  });

  it('refuses an ID token whose nonce does not match', async () => {
    const { state, sealed } = await startLogin();
    stubTokenEndpoint({ nonce: 'someone-elses', tid: TENANT, oid: OID });
    const logged = await warningsDuring(async () => {
      const res = await call(`${API_BASE}/auth/customer/callback?code=c&state=${state}`, {
        headers: { Cookie: `${CUSTOMER_LOGIN_COOKIE}=${sealed}` },
      });
      expect(res.headers.get('Location')).toBe(CUSTOMER_PROBLEM_PAGE);
    });
    expect(logged).toContainEqual(expect.objectContaining({ reason: 'token_error' }));
  });
});

describe('POST /auth/customer/logout', () => {
  it('ends the session and clears the cookie', async () => {
    const { token } = await signInCustomer();
    const res = await call(`${API_BASE}/auth/customer/logout`, {
      method: 'POST',
      headers: { Cookie: `${SESSION_COOKIE}=${token}`, Origin: ORIGIN },
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe(CUSTOMER_SIGNED_OUT_PAGE);
    expect(cookieValue(res, SESSION_COOKIE)).toBe('');
    const after = await call(`${API_BASE}/account/me`, {
      headers: { Cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(after.status).toBe(401);
  });

  it('refuses a cross-site sign-out (no matching Origin)', async () => {
    const res = await call(`${API_BASE}/auth/customer/logout`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
  });
});

describe('account pages', () => {
  it('see the signed-in customer (the session is read on /account/)', async () => {
    const { token } = await signInCustomer('Page Reader');
    const withPage = buildApp({
      log: false,
      tail: (a) => {
        a.get('/account/', (c) => c.json({ idp: c.get('user')?.idp ?? null }));
        a.get('/menu/', (c) => c.json({ idp: c.get('user')?.idp ?? null }));
      },
    });
    const get = (path: string) =>
      withPage.request(
        `${ORIGIN}${path}`,
        { headers: { Cookie: `${SESSION_COOKIE}=${token}` } },
        env,
      );
    expect(await (await get('/account/')).json()).toEqual({ idp: 'customer' });
    // Public pages don't look the session up.
    expect(await (await get('/menu/')).json()).toEqual({ idp: null });
  });
});
