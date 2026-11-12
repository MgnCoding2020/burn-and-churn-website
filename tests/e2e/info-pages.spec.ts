import { expect, test } from '@playwright/test';

const pages = [
  { path: '/about/', heading: 'Small batch. Big character.' },
  { path: '/privacy/', heading: 'What this site knows about you' },
  { path: '/security/', heading: 'How this site is built and secured' },
  { path: '/accessibility/', heading: 'Accessibility statement' },
  { path: '/careers/', heading: 'Work behind the counter' },
  { path: '/contact/', heading: 'Get in touch' },
];

for (const p of pages) {
  test(`${p.path} renders its heading and is linked from the footer`, async ({ page }) => {
    await page.goto(p.path);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(p.heading);
    await page.goto('/');
    await expect(page.getByRole('contentinfo').locator(`a[href="${p.path}"]`)).toHaveCount(1);
  });
}

test('privacy page states the log retention and that nothing else is collected', async ({
  page,
}) => {
  await page.goto('/privacy/');
  await expect(page.locator('main')).toContainText('3 days');
  await expect(page.locator('main')).toContainText('No cookies');
  await expect(page.locator('main')).toContainText('Query strings are removed');
});

test('the site really sets no cookies (as the privacy page says)', async ({ page, context }) => {
  for (const path of ['/', '/menu/', '/privacy/']) await page.goto(path);
  expect(await context.cookies()).toEqual([]);
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
});

test('the site makes no third-party requests (as the privacy page says)', async ({
  page,
  baseURL,
}) => {
  const external: string[] = [];
  page.on('request', (r) => {
    if (!r.url().startsWith(baseURL!) && !r.url().startsWith('data:')) external.push(r.url());
  });
  for (const path of ['/', '/menu/', '/about/', '/privacy/', '/security/', '/accessibility/']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
  }
  expect(external).toEqual([]);
});

test('security page: built controls in place, unbuilt ones still planned', async ({ page }) => {
  await page.goto('/security/');
  for (const area of [/^Staff sign-in/, /^Refunds and cash/, /^Card payments at the counter/]) {
    await expect(page.getByRole('row', { name: area })).toContainText('In place');
  }
  for (const area of [/^Customer sign-in/, /^Online payments/]) {
    await expect(page.getByRole('row', { name: area })).toContainText('Planned');
  }
});

test('the Story link in the header goes to the about page', async ({ page }) => {
  await page.goto('/');
  // On phones the links are inside the collapsed "Navigation" disclosure.
  const toggle = page.getByText('Navigation', { exact: true });
  if (await toggle.isVisible()) await toggle.click();
  await page
    .getByRole('banner')
    .getByRole('link', { name: 'Story', exact: true })
    .filter({ visible: true })
    .click();
  await expect(page).toHaveURL(/\/about\/$/);
});

test('footer groups: Visit, Company, Staff, Trust', async ({ page }) => {
  await page.goto('/');
  const footer = page.getByRole('contentinfo');
  await expect(footer.getByRole('heading', { level: 2 })).toHaveText([
    'Visit',
    'Company',
    'Staff',
    'Trust',
  ]);
});

test('employee sign-in links to the staff portal', async ({ page }) => {
  await page.goto('/');
  const footer = page.getByRole('contentinfo');
  await expect(footer.getByRole('link', { name: 'Employee sign-in' })).toHaveAttribute(
    'href',
    '/staff/',
  );
});

test('careers and contact collect nothing: no forms anywhere', async ({ page }) => {
  for (const path of ['/careers/', '/contact/']) {
    await page.goto(path);
    expect(await page.locator('form, input, textarea').count()).toBe(0);
  }
});
