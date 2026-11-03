import { expect, test } from '@playwright/test';

test.describe('homepage', () => {
  test('hero headline, lede and the working menu link', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      /Freshly Roasted\.\s*Never Boring\./,
    );
    await expect(page.getByRole('link', { name: 'Explore the menu' })).toHaveAttribute(
      'href',
      '/menu/',
    );
  });

  test('features that do not exist yet are visibly unavailable, not links', async ({ page }) => {
    await page.goto('/');
    const demo = page.locator('[aria-disabled="true"]');
    expect(await demo.count()).toBeGreaterThan(0);
    for (const el of await demo.all()) {
      if (!(await el.isVisible())) continue;
      await expect(el).toContainText(/coming soon/i);
      expect(await el.evaluate((n) => n.tagName)).not.toBe('A');
    }
  });

  test('every internal link on the page resolves', async ({ page, request }) => {
    await page.goto('/');
    const hrefs = await page.$$eval('a[href^="/"]', (as) => [
      ...new Set(as.map((a) => a.getAttribute('href')!)),
    ]);
    expect(hrefs.length).toBeGreaterThan(3);
    for (const href of hrefs) {
      const [path, hash] = href.split('#');
      const res = await request.get(path || '/');
      expect(res.status(), href).toBe(200);
      if (hash) expect(await res.text(), href).toContain(`id="${hash}"`);
    }
  });

  test('the featured drink comes from menu data', async ({ page }) => {
    await page.goto('/');
    const card = page.getByRole('article', { name: 'Cream Churn Cold Brew' });
    await expect(card).toContainText('From $5.25');
    await expect(card).toContainText('Cold brew with a swirl of vanilla cream');
  });

  test('hours are labelled as fictional', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#hours')).toContainText('Fictional hours');
  });

  test('images declare their size, so the layout does not jump', async ({ page }) => {
    await page.goto('/');
    for (const img of await page.locator('img').all()) {
      expect(await img.getAttribute('width')).toBeTruthy();
      expect(await img.getAttribute('height')).toBeTruthy();
    }
  });

  test('JavaScript stays well under the 100 KB public budget', async ({ page }) => {
    let bytes = 0;
    page.on('response', async (res) => {
      if (res.request().resourceType() === 'script') bytes += (await res.body()).length;
    });
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    expect(bytes).toBeLessThan(100 * 1024);
  });
});

test.describe('hero video', () => {
  const videoRequests = (page: import('@playwright/test').Page) => {
    const urls: string[] = [];
    page.on('request', (r) => {
      if (r.url().endsWith('.mp4')) urls.push(r.url());
    });
    return urls;
  };

  test('never downloads on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const urls = videoRequests(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    expect(urls).toEqual([]);
    await expect(page.locator('.hero img')).toBeVisible();
  });

  test('never downloads with reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 1440, height: 900 });
    const urls = videoRequests(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    expect(urls).toEqual([]);
    await expect(page.locator('.hero__toggle')).toBeHidden();
  });

  test('is decorative and hidden from assistive technology', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.hero__video')).toHaveAttribute('aria-hidden', 'true');
    await expect(page.locator('.hero img')).toHaveAttribute('alt', '');
  });

  test('the pause button pauses and resumes the loop (desktop)', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    const video = page.locator('.hero__video');
    const playing = await video.evaluate(
      (v: HTMLVideoElement) =>
        new Promise<boolean>((res) => {
          if (!v.paused) return res(true);
          v.addEventListener('playing', () => res(true), { once: true });
          setTimeout(() => res(false), 5000);
        }),
    );
    // Playwright's Chromium can't decode H.264; when it can't play, the poster stays and no button shows.
    test.skip(!playing, 'this browser build cannot play H.264 video');
    const toggle = page.getByRole('button', { name: 'Pause animation' });
    await toggle.click();
    await expect(page.getByRole('button', { name: 'Play animation' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(await video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  });
});
