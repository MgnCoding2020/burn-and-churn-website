import { expect, test } from '@playwright/test';

// Fonts are self-hosted (CSP font-src 'self'): they must load, and only from this site.
test('brand fonts load from this site only', async ({ page, baseURL }) => {
  const fontRequests: string[] = [];
  page.on('request', (req) => {
    if (req.resourceType() === 'font') fontRequests.push(req.url());
  });

  await page.goto('/styleguide/');
  await page.evaluate(() => document.fonts.ready);

  const loaded = await page.evaluate(() => ({
    serif: document.fonts.check('400 48px "DM Serif Display"'),
    sans: document.fonts.check('600 16px "Inter"'),
    brand: document.fonts.check('600 32px "Oswald"'),
  }));
  expect(loaded).toEqual({ serif: true, sans: true, brand: true });

  expect(fontRequests.length).toBeGreaterThan(0);
  for (const url of fontRequests) expect(url.startsWith(baseURL!)).toBe(true);
});

test('font licences are published alongside the fonts', async ({ request }) => {
  for (const name of ['dm-serif-display', 'inter', 'oswald']) {
    const res = await request.get(`/fonts/LICENSE-${name}.txt`);
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain('SIL Open Font License');
  }
});
