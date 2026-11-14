import { expect, test } from '@playwright/test';

test('header navigation is Home, Menu, Story, Hours', async ({ page }) => {
  await page.goto('/menu/');
  const toggle = page.getByText('Navigation', { exact: true });
  if (await toggle.isVisible()) await toggle.click();
  const links = page.getByRole('banner').getByRole('link').filter({ visible: true });
  const names = (await links.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  expect(names).toContain('Home');
  expect(names).toContain('Menu');
  expect(names).toContain('Story');
  expect(names).toContain('Hours');
  await page
    .getByRole('banner')
    .getByRole('link', { name: 'Hours' })
    .filter({ visible: true })
    .click();
  await expect(page).toHaveURL(/\/#hours$/);
  await expect(page.locator('#hours')).toContainText('Café Hours');
});

test('the styleguide is not part of the public site', async ({ page, request }) => {
  expect((await request.get('/styleguide/')).status()).toBe(404);
  await page.goto('/');
  await expect(page.locator('a[href^="/styleguide"]')).toHaveCount(0);
});
