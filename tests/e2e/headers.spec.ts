import { expect, test } from '@playwright/test';

// §15 "Headers" gate, checked against the built Worker for every kind of response.
const paths = [
  '/',
  '/menu/',
  '/styleguide/',
  '/images/hero-espresso-960.webp',
  '/media/hero-espresso-loop.mp4',
  '/scripts/hero-video.js',
  '/robots.txt',
  '/fonts/inter-latin-variable.woff2',
  '/a-page-that-does-not-exist',
  '/api/v1/health',
  '/api/v1/nope',
];

for (const path of paths) {
  test(`security headers on ${path}`, async ({ request }) => {
    const res = await request.get(path);
    const h = res.headers();
    expect(h['content-security-policy']).toContain("script-src 'self'");
    expect(h['content-security-policy']).not.toContain('unsafe-inline');
    expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(h['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
    expect(h['x-robots-tag']).toBe('noindex, nofollow');
    expect(h['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(h['access-control-allow-origin']).toBeUndefined();
  });
}

test('static build assets get the headers too', async ({ page, request }) => {
  await page.goto('/');
  const href = await page.locator('link[rel="stylesheet"]').first().getAttribute('href');
  expect(href).toBeTruthy();
  const res = await request.get(href!);
  expect(res.headers()['content-security-policy']).toContain("default-src 'self'");
});

test('the page loads without CSP violations', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && /Content Security Policy/i.test(msg.text()))
      violations.push(msg.text());
  });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  expect(violations).toEqual([]);
});

// ADR-0020: unversioned static files are cached; pages are not.
for (const [path, maxAge] of [
  ['/fonts/inter-latin-variable.woff2', 'max-age=2592000'],
  ['/images/hero-espresso-720.webp', 'max-age=604800'],
  ['/scripts/hero-video.js', 'max-age=3600'],
] as const) {
  test(`static file ${path} is cached (${maxAge})`, async ({ request }) => {
    const res = await request.get(path);
    expect(res.headers()['cache-control']).toContain(maxAge);
  });
}

test('pages are not cached for long, so deploys show immediately', async ({ request }) => {
  const res = await request.get('/');
  expect(res.headers()['cache-control'] ?? '').not.toContain('max-age=604800');
});
