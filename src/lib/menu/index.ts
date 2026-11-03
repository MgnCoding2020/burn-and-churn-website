import seed from '../../../seed/menu.json';
import { parseMenu, type Menu, type MenuItem } from './schema';

export type { Menu, MenuCategory, MenuItem, MenuVariant } from './schema';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/** Integer cents to "$4.75". */
export function formatCents(cents: number): string {
  return usd.format(cents / 100);
}

/** Lowest available price, or undefined if nothing is available. */
export function startingPrice(item: MenuItem): number | undefined {
  const prices = item.variants.filter((v) => v.available).map((v) => v.priceCents);
  return prices.length ? Math.min(...prices) : undefined;
}

/**
 * The published menu. Phase 1 reads the validated seed file at build time;
 * later this reads the snapshot synced from SharePoint into D1 (plan §5).
 */
export function getMenuSnapshot(): Menu {
  return parseMenu(seed);
}
