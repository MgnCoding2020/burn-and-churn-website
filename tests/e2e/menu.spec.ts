import { expect, test } from '@playwright/test';
import seed from '../../seed/menu.json' with { type: 'json' };

const usd = (cents: number) => '$' + (cents / 100).toFixed(2);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A drink's row button: its accessible name is "<name> : sizes and details". */
const drink = (name: string) => new RegExp('^' + esc(name) + '\\s*:');

test.describe('menu page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/menu/');
  });

  test('shows the five coffee-only categories as headings, in order', async ({ page }) => {
    const headings = page.locator('.menu-category__header h2');
    await expect(headings).toHaveText(seed.categories.map((c) => c.label));
  });

  test('lists all 20 drinks with prices from the data', async ({ page }) => {
    const rows = page.locator('.menu-row');
    await expect(rows).toHaveCount(seed.items.length);
    for (const item of seed.items) {
      const row = rows.filter({
        has: page.getByRole('button', { name: drink(item.name) }),
      });
      await expect(row).toHaveCount(1);
      for (const cents of Object.values(item.prices)) await expect(row).toContainText(usd(cents));
    }
  });

  test('sells espresso only as a double shot at $3.00, with no ounce sizes', async ({ page }) => {
    const row = page.locator('.menu-row', {
      has: page.getByRole('button', { name: drink('Espresso') }),
    });
    await expect(row).toContainText('Double shot');
    await expect(row).toContainText('$3.00');
    await expect(row.locator('td')).toHaveCount(1);
    await expect(row).not.toContainText(/oz/);
  });

  test('no prices are hard-coded: every price on the page exists in the data', async ({ page }) => {
    const allowed = new Set(seed.items.flatMap((i) => Object.values(i.prices)).map(usd));
    const shown = await page.locator('.menu-board .price').allInnerTexts();
    for (const text of shown) {
      const price = text.match(/\$\d+\.\d{2}/)?.[0];
      expect(price && allowed.has(price), text).toBe(true);
    }
  });

  test('category links jump to their section, and Back returns', async ({ page }) => {
    await page
      .getByRole('navigation', { name: 'Menu categories' })
      .getByRole('link', { name: 'Cold Coffee' })
      .click();
    await expect(page).toHaveURL(/#cold-coffee$/);
    await expect(page.locator('#cold-coffee-title')).toBeInViewport();
    await page.goBack();
    await expect(page).toHaveURL(/\/menu\/$/);
  });

  test('a deep link opens at its category', async ({ page }) => {
    await page.goto('/menu/#signature-seasonal');
    await expect(page.locator('#signature-seasonal-title')).toBeInViewport();
  });

  test('the drink dialog opens, traps focus, closes on Escape and restores focus', async ({
    page,
  }) => {
    const trigger = page.getByRole('button', { name: drink('Caffè Latte') });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Caffè Latte' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('12 oz');
    await expect(dialog).toContainText('$5.25');
    await expect(dialog).toContainText('Available today');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('the close button closes the dialog', async ({ page }) => {
    await page.getByRole('button', { name: drink('Mocha') }).click();
    const dialog = page.getByRole('dialog', { name: 'Mocha' });
    await dialog.getByRole('button', { name: 'Close Mocha' }).click();
    await expect(dialog).toBeHidden();
  });

  test('each available size can be added to the order, with a spoken confirmation', async ({
    page,
  }) => {
    await page.getByRole('button', { name: drink('Cappuccino') }).click();
    const dialog = page.getByRole('dialog', { name: 'Cappuccino' });
    await dialog.getByRole('button', { name: 'Add Cappuccino, 16 oz, to your order' }).click();
    await expect(dialog.getByRole('status')).toHaveText(
      'Added Cappuccino, 16 oz. You have 1 in your order.',
    );
    await expect(dialog.getByRole('link', { name: 'View your order' })).toHaveAttribute(
      'href',
      '/order/',
    );
    expect(await page.locator('form').count()).toBe(0);
  });

  test('the spotlight takes its price from data and opens its dialog', async ({ page }) => {
    const spotlight = page.locator('.featured');
    const item = seed.items.find((i) => i.id === 'burn-churn-latte')!;
    await expect(spotlight).toContainText(item.name);
    await expect(spotlight).toContainText(`From ${usd(Math.min(...Object.values(item.prices)))}`);
    await spotlight.getByRole('button', { name: 'Sizes and prices' }).click();
    await expect(page.getByRole('dialog', { name: item.name })).toBeVisible();
  });

  test('says the products and prices are fictional', async ({ page }) => {
    await expect(page.locator('main')).toContainText('All products and prices are fictional');
  });

  test('prices line up (tabular figures)', async ({ page }) => {
    const style = await page
      .locator('.menu-row .price')
      .first()
      .evaluate((el) => getComputedStyle(el).fontVariantNumeric);
    expect(style).toContain('tabular-nums');
  });
});

test('on a phone, each price shows its size label', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto('/menu/');
  const cell = page
    .locator('.menu-row', { has: page.getByRole('button', { name: drink('Caffè Latte') }) })
    .locator('td')
    .first();
  const label = await cell.evaluate((el) => getComputedStyle(el, '::before').content);
  expect(label).toContain('12 oz');
});
