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
  return {
    res,
    target,
    state: target.searchParams.get('state')!,
    sealed: cookieValue(res, LOGIN_COOKIE)!,
  };
}

/** Row counts of every table that anonymous requests must never write to. */
async function tableCounts() {
  const n = async (table: string) =>
    (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
  return {
    users: await n('users'),
    sessions: await n('sessions'),
    audit_log: await n('audit_log'),
    oidc_logins: await n('oidc_logins'),
  };
}

/** Captures the request-log warnings written during `fn`. */
async function warningsDuring(fn: () => Promise<unknown>) {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await fn();
    return warn.mock.calls.map((args) => JSON.parse(String(args[0])) as Record<string, unknown>);
  } finally {
    warn.mockRestore();
  }
}

/** Stands in for Entra's token endpoint, recording what the site sent it. */
function stubTokenEndpoint(claims: Record<string, unknown>) {
  const sent: URLSearchParams[] = [];
  const redeemed = new Set<string>();
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`);
    const body = new URLSearchParams(String(init?.body));
    sent.push(body);
    // Like Entra: an authorization code is accepted once (RFC 6749 section 4.1.2).
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
      routes.filter(
        (r) =>
          r.path.includes('/auth/staff/') ||
          r.path === '/staff/me' ||
          r.path.startsWith('/staff/session'),
      ),
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
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.get('prompt')).toBe('select_account');
    // The cookie is sealed: none of the attempt's values appear in it.
    const sealed = cookieValue(res, LOGIN_COOKIE)!;
    expect(sealed).toMatch(/^v1\./);
    for (const v of [state, p.get('nonce')!]) expect(sealed).not.toContain(v);
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

  it('writes nothing to the database (ADR-0030)', async () => {
    const before = await tableCounts();
    for (let i = 0; i < 5; i++) await startLogin();
    expect(await tableCounts()).toEqual(before);
  });
});

describe('GET /auth/staff/callback', () => {
  it('signs in a barista: session cookie, user row and audit entry; nothing sensitive in the redirect', async () => {
    const { target, state, sealed } = await startLogin();
    const sent = stubTokenEndpoint({
      nonce: target.searchParams.get('nonce'),
      tid: TENANT,
      oid: OID,
      name: 'Ethan Brooks',
      roles: ['Staff.Barista'],
    });

    const res = await call(`${API_BASE}/auth/staff/callback?code=one-time-code&state=${state}`, {
      headers: { Cookie: `${LOGIN_COOKIE}=${sealed}` },
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

  it('a replayed callback is refused: the code was already redeemed, and nothing is stored', async () => {
    const { target, state, sealed } = await startLogin();
    stubTokenEndpoint({
      nonce: target.searchParams.get('nonce'),
      tid: TENANT,
      oid: OID,
      roles: ['Staff.Barista'],
    });
    const replay = () =>
      call(`${API_BASE}/auth/staff/callback?code=c&state=${state}`, {
        headers: { Cookie: `${LOGIN_COOKIE}=${sealed}` },
      });
    const first = await replay();
    expect(first.headers.get('Location')).toBe(PORTAL_PATH);
    expect(cookieValue(first, LOGIN_COOKIE)).toBe('');
    const before = await tableCounts();
    const logged = await warningsDuring(async () => {
      expect((await replay()).headers.get('Location')).toBe(PROBLEM_PAGE);
    });
    expect(logged).toContainEqual(expect.objectContaining({ reason: 'token_error' }));
    expect(await tableCounts()).toEqual(before);
  });

  /** Breaks a sealed cookie by changing one character inside its ciphertext. */
  const altered = (sealed: string) => {
    const i = sealed.length - 5;
    return sealed.slice(0, i) + (sealed[i] === 'A' ? 'B' : 'A') + sealed.slice(i + 1);
  };

  it.each([
    [
      'no login cookie (started in another browser)',
      (state: string) => ({ query: `code=c&state=${state}`, cookie: '' }),
      'no_login_cookie',
    ],
    [
      'an altered login cookie',
      (state: string, sealed: string) => ({
        query: `code=c&state=${state}`,
        cookie: altered(sealed),
      }),
      'bad_login_cookie',
    ],
    [
      'a state that does not match the cookie',
      (_state: string, sealed: string) => ({
        query: `code=c&state=${'x'.repeat(43)}`,
        cookie: sealed,
      }),
      'state_mismatch',
    ],
    [
      'an error from Entra',
      (state: string, sealed: string) => ({
        query: `error=access_denied&state=${state}`,
        cookie: sealed,
      }),
      'authorization_error',
    ],
  ])(
    'refuses %s: logged with the reason, nothing written to the database',
    async (_label, make, reason) => {
      const { state, sealed } = await startLogin();
      const { query, cookie } = make(state, sealed);
      const before = await tableCounts();
      let res: Response | undefined;
      const logged = await warningsDuring(async () => {
        res = await call(`${API_BASE}/auth/staff/callback?${query}`, {
          headers: cookie ? { Cookie: `${LOGIN_COOKIE}=${cookie}` } : {},
        });
      });
      expect(res!.status).toBe(303);
      expect(res!.headers.get('Location')).toBe(PROBLEM_PAGE);
      expect(cookieValue(res!, SESSION_COOKIE)).toBeUndefined();
      expect(logged).toContainEqual(
        expect.objectContaining({ event: 'auth.staff.sign_in_refused', reason }),
      );
      expect(await tableCounts()).toEqual(before);
    },
  );

  it('refuses an attempt more than 10 minutes old', async () => {
    const { state, sealed } = await startLogin();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    try {
      const logged = await warningsDuring(async () => {
        const res = await call(`${API_BASE}/auth/staff/callback?code=c&state=${state}`, {
          headers: { Cookie: `${LOGIN_COOKIE}=${sealed}` },
        });
        expect(res.headers.get('Location')).toBe(PROBLEM_PAGE);
      });
      expect(logged).toContainEqual(expect.objectContaining({ reason: 'expired_login' }));
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['a token without a staff role', { roles: [] }, 'no_staff_role'],
    [
      'a token from another tenant',
      { tid: '00000000-0000-4000-8000-000000000000', roles: ['Staff.Owner'] },
      'wrong_tenant',
    ],
  ])(
    'refuses %s, and audits it (Entra vouched for a real account)',
    async (_label, extra, reason) => {
      const { target, state, sealed } = await startLogin();
      stubTokenEndpoint({
        nonce: target.searchParams.get('nonce'),
        tid: TENANT,
        oid: OID,
        ...extra,
      });
      const res = await call(`${API_BASE}/auth/staff/callback?code=c&state=${state}`, {
        headers: { Cookie: `${LOGIN_COOKIE}=${sealed}` },
      });
      expect(res.headers.get('Location')).toBe(PROBLEM_PAGE);
      expect(cookieValue(res, SESSION_COOKIE)).toBeUndefined();
      expect(JSON.parse((await lastAudit())!.after!)).toEqual({ reason });
    },
  );

  it('refuses an ID token whose nonce does not match', async () => {
    const { state, sealed } = await startLogin();
    stubTokenEndpoint({
      nonce: 'someone-elses-nonce',
      tid: TENANT,
      oid: OID,
      roles: ['Staff.Owner'],
    });
    const logged = await warningsDuring(async () => {
      const res = await call(`${API_BASE}/auth/staff/callback?code=c&state=${state}`, {
        headers: { Cookie: `${LOGIN_COOKIE}=${sealed}` },
      });
      expect(res.headers.get('Location')).toBe(PROBLEM_PAGE);
    });
    expect(logged).toContainEqual(expect.objectContaining({ reason: 'token_error' }));
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
