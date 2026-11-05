import { describe, expect, it } from 'vitest';
import { cacheControlFor } from '../../src/lib/cache-policy';
import { buildApp } from '../../src/server/app';

const env = { APP_ENV: 'local' } as unknown as Env;

describe('cache policy (ADR-0020)', () => {
  it.each([
    ['/fonts/inter-latin-variable.woff2', 'public, max-age=2592000'],
    ['/images/hero-espresso-720.webp', 'public, max-age=604800, stale-while-revalidate=86400'],
    ['/media/hero-espresso-loop.mp4', 'public, max-age=604800, stale-while-revalidate=86400'],
    ['/scripts/hero-video.js', 'public, max-age=3600'],
  ])('caches %s', (path, value) => {
    expect(cacheControlFor(path)).toBe(value);
  });

  it.each(['/', '/menu/', '/_astro/Base.css', '/api/v1/health', '/robots.txt'])(
    'leaves %s as served',
    (path) => {
      expect(cacheControlFor(path)).toBeUndefined();
    },
  );

  it('applies only to successful responses', async () => {
    const app = buildApp({
      log: false,
      tail: (a) => {
        a.get('/images/ok.webp', (c) => c.body('img', 200, { 'Cache-Control': 'no-cache' }));
        a.get('/images/missing.webp', (c) => c.body('nope', 404));
      },
    });
    const ok = await app.request('/images/ok.webp', undefined, env);
    expect(ok.headers.get('Cache-Control')).toBe(cacheControlFor('/images/x'));
    const missing = await app.request('/images/missing.webp', undefined, env);
    expect(missing.headers.get('Cache-Control')).toBeNull();
  });
});
