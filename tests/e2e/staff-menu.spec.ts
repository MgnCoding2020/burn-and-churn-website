import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { seedStaffSession } from '../setup/e2e-db.mjs';

// Sold out, the restock chain and the activity feed in a real browser
// (ADR-0032, ADR-0033). Serial: each test picks up where the last left Mocha.

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

test('a barista marks a Cappuccino sold out by mistake and undoes it; no restock controls', async ({
  page,
}) => {
  await as(page, 'Staff.Barista', 'Test Barista');
  await page.goto('/staff/menu/');
  await noSeriousAxe(page);
  await expect(page.getByRole('heading', { name: 'Restock requests' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Mark Cappuccino sold out' }).click();
  await page.getByRole('button', { name: 'Undo sold out: Cappuccino' }).click();
  await expect(page.getByRole('button', { name: 'Mark Cappuccino sold out' })).toBeVisible();
});

// Checked without following the redirect: Chromium drops the test's extra
// Cookie header on redirects, so a followed redirect would arrive signed out.
test("a barista or shift lead can't open the restock history", async ({ request }) => {
  for (const role of ['Staff.Barista', 'Staff.ShiftLead']) {
    const token = seedStaffSession({ idleMs: 3_600_000, role, name: 'Test Person' });
    const refused = await request.get('/staff/restock-history/', {
      headers: { Cookie: `__Host-bc_session=${token}` },
      maxRedirects: 0,
    });
    expect(refused.status()).toBe(303);
    expect(refused.headers()['location']).toBe('/staff/');
  }
});

test('a barista marks Mocha sold out; the register greys it out; activity records it', async ({
  page,
}) => {
  await as(page, 'Staff.Barista', 'Test Barista');
  await page.goto('/staff/menu/');
  await page.getByRole('button', { name: 'Mark Mocha sold out' }).click();
  await expect(page.getByRole('button', { name: 'Undo sold out: Mocha' })).toBeVisible();

  await page.goto('/staff/register/');
  await expect(page.getByRole('button', { name: /^Add Mocha, 12 oz/ })).toBeDisabled();

  await page.goto('/staff/activity/');
  await noSeriousAxe(page);
  await expect(page.getByRole('cell', { name: 'Marked Mocha sold out' }).first()).toBeVisible();
});

test("a shift lead requests a Mocha restock but can't approve it", async ({ page }) => {
  await as(page, 'Staff.ShiftLead', 'Test Lead');
  await page.goto('/staff/menu/');
  // Not their mark, and not a manager: no way to bring Mocha back directly.
  await expect(page.getByRole('button', { name: 'Undo sold out: Mocha' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Override: back on sale/ })).toHaveCount(0);

  await page.getByLabel('Quantity').first().fill('2 bags');
  await page.getByRole('button', { name: 'Request restock: Mocha' }).click();
  const requests = page.getByRole('region', { name: 'Restock requests' });
  await expect(requests).toContainText('Mocha: 2 bags');
  await expect(requests).toContainText('Waiting for a manager to approve');
  await expect(requests.getByRole('button', { name: /Approve/ })).toHaveCount(0);
  await noSeriousAxe(page);
});

test('a manager approves; a shift lead receives it and Mocha is back on sale', async ({ page }) => {
  await as(page, 'Staff.Manager', 'Test Manager');
  await page.goto('/staff/menu/');
  await noSeriousAxe(page);
  const requests = page.getByRole('region', { name: 'Restock requests' });
  await requests.getByRole('button', { name: 'Approve the Mocha restock' }).click();
  await expect(requests).toContainText('Approved by Test Manager, waiting for delivery');

  await as(page, 'Staff.ShiftLead', 'Test Lead');
  await page.goto('/staff/menu/');
  await page.getByRole('button', { name: 'Received, back on sale: Mocha' }).click();
  await expect(page.getByRole('button', { name: 'Mark Mocha sold out' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Restock requests' })).toContainText(
    'None waiting.',
  );
});

test('the owner reviews the restock history', async ({ page }) => {
  await as(page, 'Staff.Owner', 'Test Owner');
  await page.goto('/staff/restock-history/');
  await noSeriousAxe(page);
  const row = page.getByRole('row').filter({ hasText: 'Mocha' }).first();
  await expect(row).toContainText('Test Lead');
  await expect(row).toContainText('Test Manager');
  await expect(row).toContainText('Received');
});
