import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { seedStaffSession, setSessionIdle } from '../setup/e2e-db.mjs';

// The staff session timeout warning (WCAG 2.2.1, ADR-0028), on the real built
// Worker with a session seeded into its test database.

// One writer at a time: the seeding commands and the server share the database
// file, so these tests run in order, once, with time for the seeding commands (the dialog's layout is the menu
// dialog's, already checked at phone width).
test.describe.configure({ mode: 'serial', timeout: 90_000 });
test.skip(({ isMobile }) => isMobile, 'runs once, on the desktop project');

const signedIn = async (page: Page, token: string) => {
  await page.setExtraHTTPHeaders({ Cookie: `__Host-bc_session=${token}` });
  await page.goto('/staff/');
};

const warning = (page: Page) => page.getByRole('dialog', { name: 'Signing out soon' });

test('the signed-in portal: no warning while plenty of time is left, and accessible', async ({
  page,
}) => {
  await signedIn(page, seedStaffSession({ idleMs: 3_600_000 }));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Hello, Test Barista');
  await expect(warning(page)).toBeHidden();

  // The whole signed-in page, not just the dialog (tests/a11y covers signed-out pages).
  await page.emulateMedia({ colorScheme: 'light' });
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  // Staff targets are at least 48px tall for the counter tablet (plan §10).
  const signOut = page.getByRole('button', { name: 'Sign out', exact: true });
  expect((await signOut.boundingBox())!.height).toBeGreaterThanOrEqual(48);
});

test('warns before sign-out for inactivity, and "Stay signed in" extends it', async ({ page }) => {
  // 90 seconds idle: inside the 2-minute warning window as soon as the page loads.
  const token = seedStaffSession({ idleMs: 90_000 });
  await signedIn(page, token);
  const dialog = warning(page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("because the portal hasn't been used");
  await expect(dialog.getByRole('button', { name: 'Stay signed in' })).toBeFocused();

  const { violations } = await new AxeBuilder({ page })
    .include('#session-timeout')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  // From now on each request slides the idle limit a full hour ahead.
  setSessionIdle(token, 3_600_000);
  const extended = page.waitForResponse('**/api/v1/staff/session/extend');
  await dialog.getByRole('button', { name: 'Stay signed in' }).click();
  expect((await extended).status()).toBe(200);
  await expect(dialog).toBeHidden();
});

test('Escape also keeps the person signed in', async ({ page }) => {
  const token = seedStaffSession({ idleMs: 90_000 });
  await signedIn(page, token);
  await expect(warning(page)).toBeVisible();
  setSessionIdle(token, 3_600_000);
  const extended = page.waitForResponse('**/api/v1/staff/session/extend');
  await page.keyboard.press('Escape');
  expect((await extended).status()).toBe(200);
  await expect(warning(page)).toBeHidden();
});

test('at the 8-hour limit there is nothing to extend: it offers a fresh sign-in', async ({
  page,
}) => {
  await signedIn(page, seedStaffSession({ idleMs: 3_600_000, absoluteMs: 90_000 }));
  const dialog = warning(page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Staff sessions last 8 hours');
  await expect(dialog.getByRole('button', { name: 'Stay signed in' })).toBeHidden();
  await expect(dialog.getByRole('link', { name: 'Sign in again' })).toHaveAttribute(
    'href',
    '/api/v1/auth/staff/login',
  );
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
});

test('when time runs out, the page leaves for the signed-out page', async ({ page }) => {
  await signedIn(page, seedStaffSession({ idleMs: 4_000 }));
  await expect(warning(page)).toBeVisible();
  await page.waitForURL('**/staff/signed-out/', { timeout: 15_000 });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText("You're signed out");
});
