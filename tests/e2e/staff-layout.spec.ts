import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { STAFF_SCREENS } from '../../src/lib/staff-page';
import { seedStaffSession } from '../setup/e2e-db.mjs';

// Every staff screen, for the role that sees the most of it, at phone and
// tablet-landscape widths: no sideways scrolling and no serious axe findings
// (the accessibility statement's claims, applied to the staff portal).

test.describe.configure({ timeout: 180_000 });

const ROLES = ['Staff.Barista', 'Staff.Owner'] as const;
const EXTRA = ['/staff/', '/staff/restock-history/'];

for (const role of ROLES) {
  test(`${role}: staff screens fit at 360 and 1024 pixels and pass axe`, async ({ page }) => {
    const cookie = seedStaffSession({ idleMs: 3_600_000, role, name: 'Test Layout' });
    await page.setExtraHTTPHeaders({ Cookie: `__Host-bc_session=${cookie}` });
    const paths =
      role === 'Staff.Owner'
        ? [...EXTRA, ...STAFF_SCREENS.map((s) => s.href)]
        : ['/staff/', ...STAFF_SCREENS.filter((s) => s.min === 'Staff.Barista').map((s) => s.href)];
    for (const width of [360, 1024]) {
      await page.setViewportSize({ width, height: 800 });
      for (const path of paths) {
        const res = await page.goto(path);
        expect(res?.status(), `${path} status`).toBe(200);
        const over = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        );
        expect(over, `${path} scrolls sideways at ${width}px`).toBeLessThanOrEqual(0);
        await page.emulateMedia({ colorScheme: 'light' });
        const { violations } = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
          .analyze();
        const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
        expect(serious.map((v) => `${path} @${width}: ${v.id}`)).toEqual([]);
      }
    }
  });
}
