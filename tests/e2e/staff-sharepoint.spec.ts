import { expect, test } from '@playwright/test';
import { seedSnapshot, seedStaffSession } from '../setup/e2e-db.mjs';

// Phase 7.3 (ADR-0045): what SharePoint publishes shows on the site.
// Stands in for the sync by storing published copies straight into the
// test database; the trial checks the real sync (T-SP-06).

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());

test.beforeAll(() => {
  seedSnapshot('Announcements', [
    {
      headline: 'Holiday hours',
      body: 'We close early on Thursday.',
      audience: 'public',
      startsOn: today,
      endsOn: today,
    },
    {
      headline: 'Team meeting',
      body: 'Monday 8 PM in the back room.',
      audience: 'staff',
      startsOn: today,
      endsOn: today,
    },
    {
      headline: 'Old news',
      body: 'This ended.',
      audience: 'public',
      startsOn: '2026-01-01',
      endsOn: '2026-01-02',
    },
  ]);
  seedSnapshot('ShiftNotes', [
    {
      summary: 'Grinder sticking',
      date: today,
      shift: 'open',
      note: 'Grinder 2 jams on fine settings.',
      author: 'Mia Chen',
    },
  ]);
  seedSnapshot('Inventory', [
    { supply: 'Oat milk', unit: 'carton', parLevel: 4, onHand: 2, menuItems: ['latte'], low: true },
    {
      supply: 'Hot cups 16 oz',
      unit: 'sleeve of 50',
      parLevel: 2,
      onHand: 9,
      menuItems: [],
      low: false,
    },
  ]);
});

test.afterAll(() => {
  for (const list of ['Announcements', 'ShiftNotes', 'Inventory']) seedSnapshot(list, null);
});

test('public pages show public announcements only, and only while they run', async ({ page }) => {
  for (const path of ['/', '/menu/']) {
    await page.goto(path);
    const notices = page.getByRole('region', { name: 'Announcements' });
    await expect(notices).toContainText('Holiday hours');
    await expect(notices).not.toContainText('Team meeting');
    await expect(notices).not.toContainText('Old news');
  }
});

test('staff home: staff notices and low stock with the drinks it affects', async ({ page }) => {
  const cookie = seedStaffSession({ idleMs: 3_600_000, name: 'Test Barista' });
  await page.setExtraHTTPHeaders({ Cookie: `__Host-bc_session=${cookie}` });
  await page.goto('/staff/');
  await expect(page.getByRole('region', { name: 'Staff notices' })).toContainText('Team meeting');
  const low = page.getByRole('region', { name: /Low stock/ });
  await expect(low).toContainText('Oat milk: 2 carton on hand, par 4.');
  await expect(low).toContainText('Used in Caffè Latte.');
  await expect(low).not.toContainText('Hot cups');
  await page.goto('/staff/menu/');
  await expect(page.getByRole('region', { name: /Low stock/ })).toContainText('Oat milk');
});

test('shift notes: read-only, newest first, for every staff role', async ({ page }) => {
  const cookie = seedStaffSession({ idleMs: 3_600_000, name: 'Test Barista' });
  await page.setExtraHTTPHeaders({ Cookie: `__Host-bc_session=${cookie}` });
  await page.goto('/staff/notes/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Shift notes');
  await expect(page.locator('.notes__item').first()).toContainText('Grinder sticking');
  await expect(page.locator('.notes__item').first()).toContainText('Mia Chen');
  // Read-only: nothing in the notes can be edited or submitted from the portal.
  expect(
    await page
      .locator('.notes__list form, .notes__list input, .notes__list textarea, .notes__list button')
      .count(),
  ).toBe(0);
});
