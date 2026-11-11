import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { seedStaffSession } from '../setup/e2e-db.mjs';

// Refunds and the cash drawer in a real browser (ADR-0034).

test.describe.configure({ mode: 'serial', timeout: 120_000 });
test.skip(({ isMobile }) => isMobile, 'runs once, on the desktop project (one database writer)');

const session = (role: string, name: string) =>
  `__Host-bc_session=${seedStaffSession({ idleMs: 3_600_000, role, name })}`;

async function as(page: Page, role: string, name: string) {
  await page.setExtraHTTPHeaders({ Cookie: session(role, name) });
}

async function noSeriousAxe(page: Page) {
  await page.emulateMedia({ colorScheme: 'light' });
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

/** A cash sale of one Americano 16 oz ($4.00) and one House Brew 12 oz, taken by `cookie`. */
async function sale(request: APIRequestContext, baseURL: string, cookie: string) {
  const res = await request.post('/api/v1/staff/orders', {
    headers: { Cookie: cookie, Origin: baseURL },
    data: {
      idempotencyKey: crypto.randomUUID(),
      tender: 'cash',
      tenderedCents: 2000,
      lines: [
        { itemId: 'americano', variantId: '16oz', qty: 1 },
        { itemId: 'house-brew', variantId: '12oz', qty: 1 },
      ],
    },
  });
  expect(res.status()).toBe(201);
  return (await res.json()) as { id: string; number: number };
}

// Checked without following redirects: Chromium drops the test's extra Cookie
// header on redirects, so a followed redirect would arrive signed out.
test('baristas get neither screen; shift leads get Cash but not Refunds', async ({
  page,
  request,
}) => {
  const barista = session('Staff.Barista', 'Test Barista');
  for (const path of ['/staff/cash/', '/staff/refunds/', '/staff/refund/']) {
    const res = await request.get(path, { headers: { Cookie: barista }, maxRedirects: 0 });
    expect(res.status()).toBe(303);
  }
  const lead = session('Staff.ShiftLead', 'Test Lead');
  const refunds = await request.get('/staff/refunds/', {
    headers: { Cookie: lead },
    maxRedirects: 0,
  });
  expect(refunds.status()).toBe(303);

  await page.setExtraHTTPHeaders({ Cookie: lead });
  await page.goto('/staff/');
  const nav = page.getByRole('navigation', { name: 'Staff portal' });
  await expect(nav.getByRole('link', { name: 'Cash' })).toBeVisible();
  await expect(nav).not.toContainText('Refunds');
});

test("a manager refunds one drink of a barista's sale, with a reason and a confirmation", async ({
  page,
  request,
  baseURL,
}) => {
  const { number } = await sale(request, baseURL!, session('Staff.Barista', 'Test Barista R'));
  await as(page, 'Staff.Manager', 'Test Manager R');
  await page.goto('/staff/refunds/');
  await noSeriousAxe(page);
  await page.getByRole('link', { name: `Refund sale #${number}`, exact: true }).click();

  await expect(page.getByRole('heading', { name: `Refund sale #${number}` })).toBeVisible();
  await page.getByLabel(/^Americano, 16 oz/).selectOption('1');
  await page.getByLabel('Reason', { exact: true }).selectOption({ label: 'Quality issue' });
  await page.getByRole('button', { name: 'Review refund' }).click();
  await expect(page.getByText('Refund $4.00 in cash to the customer?')).toBeVisible();
  await noSeriousAxe(page);
  await page.getByRole('button', { name: 'Confirm refund' }).click();
  await expect(page.locator('[data-refund-status]')).toContainText(
    'Refunded $4.00. Give $4.00 in cash back',
  );
  // The form is gone: nothing left to press twice.
  await expect(page.getByRole('button', { name: 'Confirm refund' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Review refund' })).toBeHidden();
});

test("a manager can't refund a sale they took; the attempt is in the owner's activity", async ({
  page,
  request,
  baseURL,
}) => {
  const cookie = session('Staff.Manager', 'Test Manager S');
  const { number } = await sale(request, baseURL!, cookie);
  await page.setExtraHTTPHeaders({ Cookie: cookie });
  await page.goto('/staff/refunds/');
  const row = page
    .getByRole('row')
    .filter({ hasText: `#${number}` })
    .first();
  await expect(row).toContainText('Your sale');
  await row.getByRole('link', { name: `Refund sale #${number}`, exact: true }).click();
  await expect(page.getByText('You took this payment, so you can’t refund it.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review refund' })).toHaveCount(0);

  // AC-5: the refused attempt is recorded.
  await as(page, 'Staff.Owner', 'Test Owner S');
  await page.goto('/staff/activity/');
  await expect(
    page.getByRole('cell', { name: `Refused: refunding sale #${number}, which they took` }).first(),
  ).toBeVisible();
});

test('a shift lead opens the drawer, closes it short with a blind count, and explains why', async ({
  page,
}) => {
  await as(page, 'Staff.ShiftLead', 'Test Lead C');
  await page.goto('/staff/cash/');
  await noSeriousAxe(page);
  await expect(page.getByLabel('Opening float ($)')).toHaveValue('150.00');
  await page.getByRole('button', { name: 'Open the drawer' }).click();

  await expect(page.getByRole('heading', { name: 'Close the drawer' })).toBeVisible();
  await page.getByLabel('$100 bills').fill('1');
  await expect(page.getByText('Counted: $100.00')).toBeVisible();
  await page.getByRole('button', { name: 'Close the drawer' }).click();
  await expect(page.getByText('Save a count of $100.00? It can’t be redone.')).toBeVisible();
  await noSeriousAxe(page);
  await page.getByRole('button', { name: 'Save the count' }).click();

  // At least $50 short (the $150 float alone), so a reason is needed.
  await expect(page.getByRole('heading', { name: 'Open the drawer' })).toBeVisible();
  await page.getByLabel('Why was the count off?').selectOption({ label: 'Wrong change given' });
  await page.getByRole('button', { name: 'Save reason' }).click();
  await expect(page.getByText('Wrong change given').first()).toBeVisible();
  await expect(page.getByText('Waiting for a manager’s review.').first()).toBeVisible();
});

test('a manager reviews the count', async ({ page }) => {
  await as(page, 'Staff.Manager', 'Test Manager C');
  await page.goto('/staff/cash/');
  await page
    .getByRole('button', { name: /^Mark reviewed/ })
    .first()
    .click();
  await expect(page.getByText(/^Test Manager C, /).first()).toBeVisible();
  await noSeriousAxe(page);
});
