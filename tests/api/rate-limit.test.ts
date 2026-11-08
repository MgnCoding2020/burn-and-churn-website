import { describe, expect, it } from 'vitest';
import { API_BASE } from '../../src/api/app';
import { clientKey, type RateLimiter } from '../../src/lib/rate-limit';
import { buildApp } from '../../src/server/app';

/** A stand-in for Cloudflare's binding: allows `max` requests per key, records the keys. */
function fakeLimiter(max: number) {
  const counts = new Map<string, number>();
  const limiter: RateLimiter & { keys: string[] } = {
    keys: [],
    async limit({ key }) {
      this.keys.push(key);
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { success: n <= max };
    },
  };
  return limiter;
}

const app = () => buildApp({ log: false });
const call = (path: string, env: Record<string, unknown>, ip = '203.0.113.7') =>
  app().request(`http://localhost${path}`, { headers: { 'CF-Connecting-IP': ip } }, {
    APP_ENV: 'local',
    ...env,
  } as unknown as Env);

describe('rate limits (ADR-0029)', () => {
  it('answers 429 with Retry-After and a problem body once the API limit is used up', async () => {
    const API_LIMITER = fakeLimiter(2);
    for (let i = 0; i < 2; i++) {
      expect((await call(`${API_BASE}/health`, { API_LIMITER })).status).toBe(200);
    }
    const res = await call(`${API_BASE}/health`, { API_LIMITER });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(res.headers.get('Content-Type')).toBe('application/problem+json');
    const body = (await res.json()) as { title: string; requestId: string };
    expect(body.title).toBe('Too many requests');
    expect(body.requestId).toBeTruthy();
  });

  it('counts each client address separately', async () => {
    const API_LIMITER = fakeLimiter(1);
    expect((await call(`${API_BASE}/health`, { API_LIMITER }, '198.51.100.1')).status).toBe(200);
    expect((await call(`${API_BASE}/health`, { API_LIMITER }, '198.51.100.2')).status).toBe(200);
    expect((await call(`${API_BASE}/health`, { API_LIMITER }, '198.51.100.1')).status).toBe(429);
    expect(API_LIMITER.keys).toEqual([
      'API_LIMITER:198.51.100.1',
      'API_LIMITER:198.51.100.2',
      'API_LIMITER:198.51.100.1',
    ]);
  });

  it('applies the sign-in limit to starting and finishing a sign-in only', async () => {
    const SIGNIN_LIMITER = fakeLimiter(0);
    // Sign-in isn't configured here, so an allowed request would answer 503; the limit comes first.
    expect((await call(`${API_BASE}/auth/staff/login`, { SIGNIN_LIMITER })).status).toBe(429);
    expect((await call(`${API_BASE}/auth/staff/callback`, { SIGNIN_LIMITER })).status).toBe(429);
    expect((await call(`${API_BASE}/health`, { SIGNIN_LIMITER })).status).toBe(200);
  });

  it('pages and static files are not counted', async () => {
    const API_LIMITER = fakeLimiter(0);
    const res = await call('/robots.txt', { API_LIMITER });
    expect(res.status).not.toBe(429);
    expect(API_LIMITER.keys).toEqual([]);
  });

  it('without the binding, requests pass (defence in depth, not a dependency)', async () => {
    expect((await call(`${API_BASE}/health`, {})).status).toBe(200);
  });

  it("keys on Cloudflare's client address, never on X-Forwarded-For", () => {
    expect(clientKey(new Headers({ 'X-Forwarded-For': '1.2.3.4' }))).toBe('unknown');
    expect(clientKey(new Headers({ 'CF-Connecting-IP': '203.0.113.9' }))).toBe('203.0.113.9');
  });
});
