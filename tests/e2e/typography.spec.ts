import { expect, test } from '@playwright/test';

/**
 * Astro drops the line break between a word and an inline element on the
 * next line, so "updated <strong>before</strong>" can render as
 * "updatedbefore". This fails if any link, bold, emphasis or code text
 * touches a neighbouring word with no space (fix with an explicit {' '}).
 */
const pages = [
  '/',
  '/menu/',
  '/order/',
  '/about/',
  '/privacy/',
  '/security/',
  '/accessibility/',
  '/careers/',
  '/contact/',
  '/staff/sign-in-problem/',
  '/staff/signed-out/',
  '/account/',
  '/account/sign-in-problem/',
  '/account/signed-out/',
  '/account/deleted/',
  '/account/delete-problem/',
  '/500',
  '/maintenance/',
  '/a-page-that-does-not-exist',
];

for (const path of pages) {
  test(`no words run into links or bold text on ${path}`, async ({ page }) => {
    await page.goto(path);
    const joins = await page.evaluate(() => {
      const found: string[] = [];
      const word = /[\p{L}\p{N}]/u;
      // A word also may not follow closing punctuation directly ("PM.Fictional").
      const end = /[\p{L}\p{N}.,;:!?)]/u;
      const selector =
        'main a, main strong, main em, main code, footer a, footer strong, .fiction-banner strong';
      for (const el of document.querySelectorAll(selector)) {
        const text = el.textContent?.trim() ?? '';
        const prev = el.previousSibling;
        const next = el.nextSibling;
        if (
          prev?.nodeType === Node.TEXT_NODE &&
          word.test(prev.textContent?.slice(-1) ?? '') &&
          word.test(text[0] ?? '')
        ) {
          found.push(`…${prev.textContent?.slice(-15)}|${text.slice(0, 25)}`);
        }
        if (
          next?.nodeType === Node.TEXT_NODE &&
          word.test(next.textContent?.[0] ?? '') &&
          end.test(text.slice(-1))
        ) {
          found.push(`${text.slice(-25)}|${next.textContent?.slice(0, 15)}…`);
        }
      }
      return found;
    });
    expect(joins).toEqual([]);
  });
}
