import { describe, expect, it } from 'vitest';
import { API_BASE, createApi, MAX_BODY_BYTES } from '../../src/api/app';
import { PROBLEM_CONTENT_TYPE } from '../../src/lib/problem';
import { buildApp } from '../../src/server/app';

const ORIGIN = 'http://localhost';
const env = { APP_ENV: 'local' } as unknown as Env;

function app() {
  return buildApp({
    log: false,
    tail: (a) => {
      a.get('/page', (c) => c.html('<p>page</p>'));
      a.get('/boom', () => {
        throw new Error('internal detail that must not leak');
      });
    },
  });
}

const get = (path: string, init?: RequestInit, e = env) => app().request(path, init, e);

describe('every response', () => {
  it.each([`${API_BASE}/health`, `${API_BASE}/nope`, '/page'])(
    'has the security headers: %s',
    async (path) => {
      const res = await get(path);
      expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
      expect(res.headers.get('Content-Security-Policy')).toMatch(/script-src 'self'(;|$)/);
      expect(res.headers.get('Content-Security-Policy')).not.toContain('unsafe-inline');
      expect(res.headers.get('Strict-Transport-Security')).toBe(
        'max-age=31536000; includeSubDomains',
      );
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(res.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    },
  );

  it('gets a fresh request ID and ignores one sent by the client', async () => {
    const res = await get(`${API_BASE}/health`, { headers: { 'X-Request-Id': 'attacker-value' } });
    const id = res.headers.get('X-Request-Id');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(id).not.toBe('attacker-value');
  });
});

describe('/api/v1', () => {
  it('health is public and not cached', async () => {
    const res = await get(`${API_BASE}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('unknown routes are a 404 problem carrying the request ID', async () => {
    const res = await get(`${API_BASE}/nope`);
    expect(res.status).toBe(404);
    expect(res.headers.get('Content-Type')).toBe(PROBLEM_CONTENT_TYPE);
    const body = (await res.json()) as { requestId?: string };
    expect(body).toMatchObject({ status: 404, title: 'Not found' });
    expect(body.requestId).toBe(res.headers.get('X-Request-Id'));
  });

  it('every route declares a principal', () => {
    const { api, routes } = createApi();
    const declared = new Set(routes.map((r) => `${r.method} ${r.path}`));
    const registered = api.routes
      .filter((r) => r.method !== 'ALL')
      .map((r) => `${r.method} ${r.path}`);
    expect(registered.length).toBeGreaterThan(0);
    for (const route of registered) expect(declared).toContain(route);
  });
});

describe('CSRF origin check', () => {
  const post = (headers: Record<string, string>, body?: string) =>
    get(`${API_BASE}/health`, { method: 'POST', headers, body });

  it('refuses a state-changing request with no Origin', async () => {
    expect((await post({})).status).toBe(403);
  });

  it('refuses a cross-origin request', async () => {
    expect((await post({ Origin: 'https://evil.example' })).status).toBe(403);
  });

  it('lets a same-origin request through to routing', async () => {
    // No POST route exists yet, so passing the check ends in a 404.
    expect((await post({ Origin: ORIGIN })).status).toBe(404);
  });

  it('refuses an oversized body', async () => {
    const res = await post(
      { Origin: ORIGIN, 'Content-Length': String(MAX_BODY_BYTES + 1) },
      'x'.repeat(MAX_BODY_BYTES + 1),
    );
    expect(res.status).toBe(413);
  });
});

describe('HTTPS only', () => {
  it('redirects plain HTTP to HTTPS, keeping path and query', async () => {
    const res = await get('http://burn-and-churn.example/page?x=1');
    expect(res.status).toBe(308);
    expect(res.headers.get('Location')).toBe('https://burn-and-churn.example/page?x=1');
    expect(res.headers.get('Strict-Transport-Security')).toBeTruthy();
  });

  it('redirects state-changing requests too (308 keeps the method)', async () => {
    const res = await get(`http://burn-and-churn.example${API_BASE}/health`, { method: 'POST' });
    expect(res.status).toBe(308);
  });

  it('serves HTTPS requests normally', async () => {
    expect((await get(`https://burn-and-churn.example${API_BASE}/health`)).status).toBe(200);
  });

  it.each(['localhost', '127.0.0.1'])(
    'does not redirect loopback (%s) for local development',
    async (host) => {
      expect((await get(`http://${host}${API_BASE}/health`)).status).toBe(200);
    },
  );
});

describe('errors', () => {
  it('a thrown error is a 500 problem without internal details', async () => {
    const res = await get('/boom');
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('internal detail');
    expect(text).not.toContain('at ');
  });
});

describe('test-mode guard', () => {
  it('refuses to serve anything with a live Stripe key', async () => {
    const live = { APP_ENV: 'production', STRIPE_API_KEY: 'sk_live_x' } as unknown as Env;
    for (const path of [`${API_BASE}/health`, '/page']) {
      const res = await get(path, undefined, live);
      expect(res.status).toBe(503);
      expect(await res.text()).not.toContain('sk_live_x');
    }
  });

  it('refuses to serve with an invalid APP_ENV', async () => {
    const res = await get(`${API_BASE}/health`, undefined, {
      APP_ENV: 'nonsense',
    } as unknown as Env);
    expect(res.status).toBe(503);
  });
});
