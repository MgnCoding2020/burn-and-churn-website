import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const pages = [
  '/',
  '/menu/',
  '/about/',
  '/privacy/',
  '/security/',
  '/accessibility/',
  '/careers/',
  '/contact/',
  '/staff/sign-in-problem/',
  '/staff/signed-out/',
  '/account/',
  '/account/sign-in-problem/',
  '/account/signed-out/',
  '/maintenance/',
  '/500',
  '/a-page-that-does-not-exist',
];

// One dark theme (ADR-0012), whatever the visitor's system preference.
for (const path of pages) {
  test(`no serious accessibility violations on ${path}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(path);
    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  test(`no horizontal scrolling at 360px on ${path}`, async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await page.goto(path);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

test('the page stays dark when the system asks for light', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe('rgb(17, 13, 11)');
});

test('the first Tab reaches the skip link, which moves to the content', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium');
  await page.goto('/');
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#main$/);
});

test('focus is visible on links and buttons', async ({ page }) => {
  await page.goto('/');
  const button = page.getByRole('link', { name: 'Explore the menu' });
  await button.focus();
  const outline = await button.evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline).toBe('solid');
});

test('reduced motion turns transitions off', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const duration = await page
    .getByRole('link', { name: 'Explore the menu' })
    .evaluate((el) => getComputedStyle(el).transitionDuration);
  expect(parseFloat(duration)).toBeLessThan(0.01);
});
