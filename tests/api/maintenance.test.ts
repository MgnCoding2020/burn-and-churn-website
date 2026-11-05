import { describe, expect, it } from 'vitest';
import { checkEnv } from '../../src/lib/env';
import { PROBLEM_CONTENT_TYPE } from '../../src/lib/problem';
import { buildApp } from '../../src/server/app';

/** A stand-in for Cloudflare's asset store: serves two prerendered pages. */
const ASSETS = {
  fetch: async (input: URL | string) => {
    const path = new URL(String(input)).pathname;
    if (path === '/maintenance/') return new Response('<h1>We will be back shortly.</h1>');
    if (path === '/500') return new Response('<h1>Something went wrong.</h1>');
    return new Response('not found', { status: 404 });
  },
};

const env = (vars: Record<string, string>) =>
  ({ APP_ENV: 'local', ASSETS, ...vars }) as unknown as Env;

function app() {
  return buildApp({
    log: false,
    tail: (a) => {
      a.get('/', (c) => c.html('<p>home</p>'));
      a.get('/_astro/site.css', (c) => c.body('body{}', 200, { 'Content-Type': 'text/css' }));
      a.get('/boom', () => {
        throw new Error('internal detail');
      });
    },
  });
}

describe('maintenance mode (ADR-0022)', () => {
  const on = env({ MAINTENANCE_MODE: 'on' });

  it('serves the maintenance page with 503, Retry-After and no caching', async () => {
    const res = await app().request('/', undefined, on);
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('600');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Content-Type')).toContain('text/html');
    expect(await res.text()).toContain('back shortly');
    // Security headers still apply.
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  });

  it('answers the API with a 503 problem', async () => {
    const res = await app().request('/api/v1/anything', undefined, on);
    expect(res.status).toBe(503);
    expect(res.headers.get('Content-Type')).toBe(PROBLEM_CONTENT_TYPE);
    expect(res.headers.get('Retry-After')).toBe('600');
  });

  it('keeps the health check and the maintenance page assets working', async () => {
    const health = await app().request('/api/v1/health', undefined, on);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: 'ok', maintenance: true });
    const css = await app().request('/_astro/site.css', undefined, on);
    expect(css.status).toBe(200);
  });

  it('is off by default and when set to "off"', async () => {
    for (const vars of [{}, { MAINTENANCE_MODE: 'off' }] as Record<string, string>[]) {
      const res = await app().request('/', undefined, env(vars));
      expect(res.status).toBe(200);
    }
  });

  it('refuses an unknown value rather than guessing', () => {
    expect(checkEnv({ APP_ENV: 'local', MAINTENANCE_MODE: 'yes' }).ok).toBe(false);
    expect(checkEnv({ APP_ENV: 'local', MAINTENANCE_MODE: 'on' }).ok).toBe(true);
  });
});

describe('error pages', () => {
  it('a failing page gets the branded 500 page, without internal details', async () => {
    const res = await app().request('/boom', undefined, env({}));
    expect(res.status).toBe(500);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await res.text();
    expect(body).toContain('Something went wrong');
    expect(body).not.toContain('internal detail');
  });
});
