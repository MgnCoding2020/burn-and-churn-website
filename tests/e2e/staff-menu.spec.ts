import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { seedStaffSession } from '../setup/e2e-db.mjs';

// 86, restock requests and the activity feed in a real browser (ADR-0032).

test.describe.configure({ mode: 'serial', timeout: 120_000 });
test.skip(({ isMobile }) => isMobile, 'runs once, on the desktop project (one database writer)');

async function as(page: Page, role: string, name: string) {
  await page.setExtraHTTPHeaders({
    Cookie: `__Host-bc_session=${seedStaffSession({ idleMs: 3_600_000, role, name })}`,
  });
}

async function noSeriousAxe(page: Page) {
  await page.emulateMedia({ colorScheme: 'light' });
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

// Checked without following the redirect: Chromium drops the test's extra
// Cookie header on redirects, so a followed redirect would arrive signed out.
test("a barista can't open the Menu screen and doesn't see it in the navigation", async ({
  page,
  request,
}) => {
  const token = seedStaffSession({
    idleMs: 3_600_000,
    role: 'Staff.Barista',
    name: 'Test Barista',
  });
  const headers = { Cookie: `__Host-bc_session=${token}` };
  const refused = await request.get('/staff/menu/', { headers, maxRedirects: 0 });
  expect(refused.status()).toBe(303);
  expect(refused.headers()['location']).toBe('/staff/');

  await page.setExtraHTTPHeaders(headers);
  await page.goto('/staff/');
  await expect(page.getByRole('navigation', { name: 'Staff portal' })).not.toContainText('Menu');
});

test('a shift lead 86s Mocha; the register shows it sold out; the activity feed records it', async ({
  page,
}) => {
  await as(page, 'Staff.ShiftLead', 'Test Lead');
  await page.goto('/staff/menu/');
  await noSeriousAxe(page);
  // Shift leads can 86 but not request restocks.
  await expect(page.getByRole('heading', { name: 'Open restock requests' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Mark Mocha sold out today' }).click();
  await expect(page.getByRole('button', { name: 'Mark Mocha available again' })).toBeVisible();

  await page.goto('/staff/register/');
  await expect(page.getByRole('button', { name: /^Add Mocha, 12 oz/ })).toBeDisabled();

  await page.goto('/staff/activity/');
  await noSeriousAxe(page);
  await expect(
    page.getByRole('cell', { name: 'Marked Mocha sold out today' }).first(),
  ).toBeVisible();
});

test('a manager requests a restock for Mocha, then marks it done and brings Mocha back', async ({
  page,
}) => {
  await as(page, 'Staff.Manager', 'Test Manager');
  await page.goto('/staff/menu/');
  await page.getByLabel('Quantity').first().fill('2 bags');
  await page.getByRole('button', { name: 'Request restock' }).first().click();
  const requests = page.getByRole('region', { name: 'Open restock requests' });
  await expect(requests).toContainText('Mocha: 2 bags');
  await requests.getByRole('button', { name: 'Mark the Mocha restock done' }).click();
  await expect(requests).toContainText('None open.');
  await page.getByRole('button', { name: 'Mark Mocha available again' }).click();
  await expect(page.getByRole('button', { name: 'Mark Mocha sold out today' })).toBeVisible();
});
