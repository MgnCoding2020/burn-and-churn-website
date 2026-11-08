import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { seedStaffSession } from '../setup/e2e-db.mjs';

// The register and the order board on the real built Worker (ADR-0031), with a
// barista session seeded into the browser tests' own database.

test.describe.configure({ mode: 'serial', timeout: 90_000 });
test.skip(({ isMobile }) => isMobile, 'runs once, on the desktop project (one database writer)');

async function signedIn(page: Page) {
  await page.setExtraHTTPHeaders({
    Cookie: `__Host-bc_session=${seedStaffSession({ idleMs: 3_600_000 })}`,
  });
}

function watchCsp(page: Page) {
  const violations: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && /Content Security Policy/i.test(msg.text()))
      violations.push(msg.text());
  });
  return violations;
}

async function noSeriousAxe(page: Page) {
  await page.emulateMedia({ colorScheme: 'light' });
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

test('the portal home links to the register and the order board', async ({ page }) => {
  await signedIn(page);
  await page.goto('/staff/');
  const main = page.getByRole('main');
  await expect(main.getByRole('link', { name: /Register/ }).first()).toBeVisible();
  await expect(main.getByRole('link', { name: /Orders/ }).first()).toBeVisible();
});

test('ring up a cash sale, then move it across the board', async ({ page }) => {
  const csp = watchCsp(page);
  await signedIn(page);
  await page.goto('/staff/register/');
  await noSeriousAxe(page);

  // Build the order: two Americanos (16 oz) and one espresso.
  const americano16 = page.getByRole('button', { name: /^Add Americano, 16 oz/ });
  await americano16.click();
  await americano16.click();
  await page.getByRole('button', { name: /^Add Espresso, Double shot/ }).click();
  const order = page.getByRole('complementary', { name: 'Current order' });
  await expect(order).toContainText('2 × Americano, 16 oz');
  await expect(order).toContainText('$11.00');

  // Pay cash: $20 handed over, $9.00 change.
  await page.getByRole('button', { name: 'Pay cash' }).click();
  const dialog = page.getByRole('dialog', { name: 'Cash payment' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Amount handed over ($)').fill('20');
  await expect(dialog).toContainText('$9.00');
  const recorded = page.waitForResponse('**/api/v1/staff/orders');
  await dialog.getByRole('button', { name: 'Complete sale' }).click();
  expect((await recorded).status()).toBe(201);
  const status = page.getByRole('status').filter({ hasText: 'paid' });
  await expect(status).toContainText('Change due: $9.00');
  const number = Number(/Order #(\d+)/.exec((await status.textContent()) ?? '')![1]);
  await expect(order).toContainText('Tap a size to add a drink.');

  // The board shows it under New; Start → In progress → Ready → Picked up.
  await page.goto('/staff/orders/');
  await noSeriousAxe(page);
  const ticketIn = (column: string) =>
    page
      .getByRole('region', { name: new RegExp(`^${column}`) })
      .getByRole('listitem')
      .filter({ hasText: `#${String(number).padStart(4, '0')}` });
  await expect(ticketIn('New')).toContainText('COUNTER');
  await ticketIn('New')
    .getByRole('button', { name: `Start: order ${number}` })
    .click();
  await expect(ticketIn('In progress')).toBeVisible();
  await ticketIn('In progress')
    .getByRole('button', { name: `Ready: order ${number}` })
    .click();
  await expect(ticketIn('Ready')).toBeVisible();
  await ticketIn('Ready')
    .getByRole('button', { name: `Picked up: order ${number}` })
    .click();
  await expect(ticketIn('Ready')).toHaveCount(0);

  expect(csp).toEqual([]);
});

test('too little cash is refused in the dialog, and nothing is recorded', async ({ page }) => {
  await signedIn(page);
  await page.goto('/staff/register/');
  await page.getByRole('button', { name: /^Add Americano, 12 oz/ }).click();
  await page.getByRole('button', { name: 'Pay cash' }).click();
  const dialog = page.getByRole('dialog', { name: 'Cash payment' });
  await dialog.getByLabel('Amount handed over ($)').fill('1');
  let posted = false;
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/api/v1/staff/orders')) posted = true;
  });
  await dialog.getByRole('button', { name: 'Complete sale' }).click();
  await expect(dialog.getByRole('alert')).toContainText('at least the total due');
  expect(posted).toBe(false);
});
