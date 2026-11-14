import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { API_BASE, createApi } from '../../src/api/app';
import { DELETE_PROBLEM_PAGE, DELETED_PAGE } from '../../src/api/customer-account';
import { eraseDirectoryAccount, ErasureError } from '../../src/lib/erasure';
import { createSession, SESSION_COOKIE } from '../../src/lib/session';
import { upsertUser } from '../../src/lib/users';
import { buildApp } from '../../src/server/app';
import { testDb } from '../setup/db';

const TENANT = '33333333-4444-4555-8666-777777777777';
const ERASER = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
const ORIGIN = 'http://localhost';
const CIAM_TOKEN = `https://${TENANT}.ciamlogin.com/${TENANT}/oauth2/v2.0/token`;
const GRAPH = 'https://graph.microsoft.com/v1.0';

let db: D1Database;
let env: Env;
let pem: string;

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
  pem = await pkcs8Pem();
  env = {
    APP_ENV: 'local',
    DB: db,
    ENTRA_CUSTOMER_TENANT_ID: TENANT,
    ENTRA_ERASURE_CLIENT_ID: ERASER,
    ENTRA_ERASURE_CERT_THUMBPRINT: 'ef'.repeat(20),
    ENTRA_ERASURE_CERT_PRIVATE_KEY: pem,
  } as unknown as Env;
});

afterEach(() => vi.unstubAllGlobals());

const cfg = () => ({
  tenantId: TENANT,
  clientId: ERASER,
  thumbprint: 'ef'.repeat(20),
  privateKeyPem: pem,
});

const decode = (part: string) => JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));

/** Stands in for the customer directory and Graph; `answers` maps "METHOD path" to statuses in order. */
function stubMicrosoft(answers: Record<string, number[]>) {
  const seen: string[] = [];
  const assertions: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u === CIAM_TOKEN) {
      const body = new URLSearchParams(String(init?.body));
      assertions.push(decode(body.get('client_assertion')!.split('.')[1]!));
      seen.push(`TOKEN ${body.get('grant_type')} ${body.get('scope')}`);
      const status = answers.TOKEN?.shift() ?? 200;
      return new Response(
        JSON.stringify(
          status === 200
            ? { token_type: 'Bearer', access_token: 'app-token', expires_in: 3600 }
            : { error: 'invalid_client' },
        ),
        { status, headers: { 'Content-Type': 'application/json' } },
      );
    }
    const key = `${init?.method ?? 'GET'} ${u.replace(GRAPH, '')}`;
    seen.push(key);
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer app-token');
    const status = answers[key]?.shift() ?? 500;
    return new Response(
      status === 204 ? null : JSON.stringify({ error: { code: `code_${status}` } }),
      {
        status,
      },
    );
  });
  return { seen, assertions };
}

async function customer(sub: string) {
  const id = await upsertUser(db, { idp: 'customer', sub, displayName: 'Erase Me' });
  const s = await createSession(db, { userId: id, idp: 'customer' });
  return { id, cookie: `${SESSION_COOKIE}=${s.token}` };
}

const app = () => buildApp({ log: false });
const post = (cookie: string, body = 'confirm=yes', e: Env = env) =>
  app().request(
    `${ORIGIN}${API_BASE}/account/delete`,
    {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: ORIGIN,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    },
    e,
  );

const rows = async (id: string) => ({
  users: (await db
    .prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?')
    .bind(id)
    .first<{ n: number }>())!.n,
  sessions: (await db
    .prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?')
    .bind(id)
    .first<{ n: number }>())!.n,
});

describe('route principals', () => {
  it('declares Delete my data for customers only, with its own limit', () => {
    expect(createApi().routes.filter((r) => r.path === '/account/delete')).toEqual([
      { method: 'POST', path: '/account/delete', principal: 'customer', limit: 'erasure' },
    ]);
  });
});

describe('eraseDirectoryAccount (ADR-0043)', () => {
  const OID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

  it('deletes the account, then empties it from the recycle bin, as the erasure app', async () => {
    const { seen, assertions } = stubMicrosoft({
      [`DELETE /users/${OID}`]: [204],
      [`DELETE /directory/deletedItems/${OID}`]: [404, 204],
    });
    expect(await eraseDirectoryAccount(cfg(), OID, { pauseMs: 0 })).toEqual({
      deleted: true,
      purged: true,
    });
    expect(seen).toEqual([
      'TOKEN client_credentials https://graph.microsoft.com/.default',
      `DELETE /users/${OID}`,
      `DELETE /directory/deletedItems/${OID}`,
      `DELETE /directory/deletedItems/${OID}`,
    ]);
    expect(assertions[0]).toMatchObject({ aud: CIAM_TOKEN, iss: ERASER, sub: ERASER });
  });

  it('counts an account that is already gone as erased', async () => {
    stubMicrosoft({
      [`DELETE /users/${OID}`]: [404],
      [`DELETE /directory/deletedItems/${OID}`]: [404],
    });
    expect(await eraseDirectoryAccount(cfg(), OID, { pauseMs: 0 })).toEqual({
      deleted: false,
      purged: true,
    });
  });

  it('reports a bin that never shows the account as not purged (Microsoft empties it within 30 days)', async () => {
    stubMicrosoft({
      [`DELETE /users/${OID}`]: [204],
      [`DELETE /directory/deletedItems/${OID}`]: [404, 404, 404],
    });
    expect(await eraseDirectoryAccount(cfg(), OID, { pauseMs: 0 })).toEqual({
      deleted: true,
      purged: false,
    });
  });

  it.each([
    ['a refused delete', { [`DELETE /users/${OID}`]: [403] }, 'delete', 403],
    ['a refused token', { TOKEN: [401] }, 'token', 401],
  ])('throws on %s', async (_l, answers, step, status) => {
    stubMicrosoft(answers);
    const err = await eraseDirectoryAccount(cfg(), OID, { pauseMs: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(ErasureError);
    expect(err).toMatchObject({ step, status });
  });

  it('refuses something that is not an object ID before calling anyone', async () => {
    const { seen } = stubMicrosoft({});
    await expect(eraseDirectoryAccount(cfg(), '../users')).rejects.toMatchObject({
      code: 'bad_object_id',
    });
    expect(seen).toEqual([]);
  });
});

describe('POST /account/delete', () => {
  it('erases the directory account, then the user and every session, and signs out', async () => {
    const oid = '11111111-aaaa-4bbb-8ccc-000000000001';
    const { id, cookie } = await customer(oid);
    await createSession(db, { userId: id, idp: 'customer' }); // a second device
    const { seen } = stubMicrosoft({
      [`DELETE /users/${oid}`]: [204],
      [`DELETE /directory/deletedItems/${oid}`]: [204],
    });
    const res = await post(cookie);
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe(DELETED_PAGE);
    expect(res.headers.getSetCookie().join()).toContain(`${SESSION_COOKIE}=;`);
    expect(seen).toContain(`DELETE /users/${oid}`);
    expect(await rows(id)).toEqual({ users: 0, sessions: 0 });
  });

  it('deletes nothing when the directory refuses: the customer can try again', async () => {
    const oid = '11111111-aaaa-4bbb-8ccc-000000000002';
    const { id, cookie } = await customer(oid);
    stubMicrosoft({ [`DELETE /users/${oid}`]: [403] });
    const res = await post(cookie);
    expect(res.headers.get('Location')).toBe(DELETE_PROBLEM_PAGE);
    expect(await rows(id)).toEqual({ users: 1, sessions: 1 });
  });

  it('deletes nothing without the confirmation box, or where erasure is not set up', async () => {
    const { id, cookie } = await customer('11111111-aaaa-4bbb-8ccc-000000000003');
    const { seen } = stubMicrosoft({});
    expect((await post(cookie, '')).headers.get('Location')).toBe(DELETE_PROBLEM_PAGE);
    const bare = { APP_ENV: 'local', DB: db } as unknown as Env;
    expect((await post(cookie, 'confirm=yes', bare)).headers.get('Location')).toBe(
      DELETE_PROBLEM_PAGE,
    );
    expect(seen).toEqual([]);
    expect(await rows(id)).toEqual({ users: 1, sessions: 1 });
  });

  it('refuses staff (403), the signed-out (401) and other sites (Origin check)', async () => {
    const staffId = await upsertUser(db, {
      idp: 'workforce',
      sub: '22222222-aaaa-4bbb-8ccc-000000000001',
      displayName: 'Olivia Carter',
      role: 'Staff.Owner',
    });
    const staff = await createSession(db, {
      userId: staffId,
      idp: 'workforce',
      role: 'Staff.Owner',
    });
    expect((await post(`${SESSION_COOKIE}=${staff.token}`)).status).toBe(403);
    expect((await post('')).status).toBe(401);
    const { cookie } = await customer('11111111-aaaa-4bbb-8ccc-000000000004');
    const cross = await app().request(
      `${ORIGIN}${API_BASE}/account/delete`,
      {
        method: 'POST',
        headers: {
          Cookie: cookie,
          Origin: 'https://evil.example',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'confirm=yes',
      },
      env,
    );
    expect(cross.status).toBe(403);
  });
});
