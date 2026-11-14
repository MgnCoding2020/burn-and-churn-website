import { expect, test } from '@playwright/test';

// The cart (Phase 5): kept in the browser, priced from GET /api/v1/menu.

const drink = (name: string) => new RegExp('^' + name + '\\s*:');

test('an empty order points back to the menu', async ({ page }) => {
  await page.goto('/order/');
  await expect(page.getByText('Your order is empty.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Browse the menu' })).toHaveAttribute(
    'href',
    '/menu/',
  );
});

test('add from the menu, change it on the order page, and it is remembered', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/menu/');
  await page
    .getByRole('button', { name: drink('Caffè Latte') })
    .first()
    .click();
  const dialog = page.getByRole('dialog', { name: 'Caffè Latte' });
  await dialog.getByRole('button', { name: 'Add Caffè Latte, 16 oz, to your order' }).click();
  await dialog.getByRole('button', { name: 'Add Caffè Latte, 16 oz, to your order' }).click();
  await expect(page.getByRole('banner').getByRole('link', { name: 'Order (2)' })).toBeVisible();

  await dialog.getByRole('link', { name: 'View your order' }).click();
  await expect(page).toHaveURL(/\/order\/$/);
  const line = page.locator('.order-line').first();
  await expect(line).toContainText('Caffè Latte, 16 oz');
  await expect(line.locator('.order-line__qty')).toHaveText('2');
  const total = page.locator('[data-total]');
  const two = await total.textContent();

  await page.getByRole('button', { name: 'One more Caffè Latte, 16 oz' }).click();
  await expect(line.locator('.order-line__qty')).toHaveText('3');
  await expect(total).not.toHaveText(two!);
  await expect(page.getByRole('status')).toHaveText('Caffè Latte, 16 oz: 3');

  await page.reload();
  await expect(page.locator('.order-line__qty').first()).toHaveText('3');

  await page.getByRole('button', { name: 'Remove Caffè Latte, 16 oz' }).click();
  await expect(page.getByText('Your order is empty.')).toBeVisible();
  await expect(
    page.getByRole('banner').getByRole('link', { name: 'Order', exact: true }),
  ).toBeVisible();
});

test('a tampered cart is cleaned up, never trusted', async ({ page }) => {
  await page.goto('/order/');
  await page.evaluate(() =>
    localStorage.setItem(
      'bc-cart-v1',
      JSON.stringify({
        lines: [{ itemId: '<img src=x>', variantId: '16oz', qty: 1, priceCents: 1 }],
      }),
    ),
  );
  await page.reload();
  await expect(page.getByText('Your order is empty.')).toBeVisible();
});

test('signed out, paying asks you to sign in and come back here', async ({ page }) => {
  await page.goto('/order/');
  await page.evaluate(() =>
    localStorage.setItem(
      'bc-cart-v1',
      JSON.stringify({ lines: [{ itemId: 'latte', variantId: '16oz', qty: 1 }] }),
    ),
  );
  await page.reload();
  await expect(page.getByRole('link', { name: 'Sign in to pay' })).toHaveAttribute(
    'href',
    '/api/v1/auth/customer/login?next=order',
  );
  await expect(page.getByRole('button', { name: 'Pay with card (test mode)' })).toBeHidden();
});

test('the status page asks a signed-out visitor to sign in', async ({ page }) => {
  await page.goto('/order/status/?id=00000000-0000-4000-8000-000000000000');
  await expect(page.getByText('Sign in to see your order.')).toBeVisible();
});
