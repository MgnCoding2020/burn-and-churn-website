import { expect, test } from '@playwright/test';

const BANNER =
  'Burn and Churn Coffee is a fictional business. This site is a security portfolio project. Payments are in test mode; no real orders are placed.';

// §1 "Never mistakable for a real business": banner and noindex on every page.
for (const path of [
  '/',
  '/menu/',
  '/about/',
  '/privacy/',
  '/security/',
  '/accessibility/',
  '/maintenance/',
  '/500',
  '/a-page-that-does-not-exist',
]) {
  test(`banner and noindex on ${path}`, async ({ page }) => {
    await page.goto(path);
    const banner = page.getByRole('complementary', { name: 'Fictional business notice' });
    await expect(banner).toBeVisible();
    await expect(banner).toHaveText(BANNER);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      'content',
      'noindex, nofollow',
    );
  });
}

test('robots.txt disallows everything', async ({ request }) => {
  const res = await request.get('/robots.txt');
  expect(await res.text()).toMatch(/User-agent: \*\s+Disallow: \//);
});

test('the banner stays visible when scrolled', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    document.body.style.minHeight = '3000px';
    window.scrollTo(0, 2000);
  });
  await expect(
    page.getByRole('complementary', { name: 'Fictional business notice' }),
  ).toBeInViewport();
});
