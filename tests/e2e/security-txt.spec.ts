import { expect, test } from '@playwright/test';

// RFC 9116: Contact and Expires are required, and Expires must be in the future
// (and no more than a year ahead). This test fails when it's time to renew.
test('security.txt is served, complete and not expired', async ({ request }) => {
  const res = await request.get('/.well-known/security.txt');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('text/plain');

  const text = await res.text();
  expect(text).toMatch(/^Contact: https:\/\//m);
  expect(text).toMatch(/^Policy: https:\/\//m);

  const expires = text.match(/^Expires: (.+)$/m)?.[1];
  expect(expires).toBeTruthy();
  const days = (Date.parse(expires!) - Date.now()) / 86_400_000;
  expect(days).toBeGreaterThan(30);
  expect(days).toBeLessThanOrEqual(366);
});
