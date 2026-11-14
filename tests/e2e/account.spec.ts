import { expect, test } from '@playwright/test';

// Customer accounts (plan §4.2, ADR-0042). Signing in needs the real customer
// directory, so the flow itself is covered by tests/api/customer-auth.test.ts;
// these check what a signed-out visitor sees.

test('the header links to the account page', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await page.getByRole('banner').getByRole('link', { name: 'Account' }).click();
  await expect(page).toHaveURL(/\/account\/$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in or create an account');
});

test('a signed-out visitor is offered email sign-in, and the page is never cached', async ({
  page,
  request,
}) => {
  const res = await request.get('/account/');
  expect(res.status()).toBe(200);
  expect(res.headers()['cache-control']).toBe('no-store');
  await page.goto('/account/');
  await expect(page.getByRole('link', { name: 'Continue with email' })).toHaveAttribute(
    'href',
    '/api/v1/auth/customer/login',
  );
  await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
});

test('the account link is in the narrow menu too', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/');
  await page.getByText('Navigation').click();
  await expect(page.getByRole('link', { name: 'Account' })).toBeVisible();
});
