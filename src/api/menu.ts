import { currentMenu } from '../lib/availability';
import { getMenuSnapshot } from '../lib/menu';
import type { Define } from './app';

/**
 * The menu as the cart needs it (Phase 5): names, sizes, prices and what's
 * sold out today. Public, read-only, nothing written. Prices shown in the
 * cart come from here; the server prices the order again at checkout.
 */
export function registerMenu(define: Define) {
  define({ method: 'GET', path: '/menu', principal: 'public' }, async (c) => {
    const db = (c.env as unknown as { DB?: D1Database } | undefined)?.DB;
    const menu = db ? await currentMenu(db) : getMenuSnapshot();
    return c.json({
      items: menu.items.map((i) => ({
        id: i.id,
        name: i.name,
        available: i.available,
        variants: i.variants.map((v) => ({
          id: v.id,
          label: v.label,
          priceCents: v.priceCents,
          available: v.available,
        })),
      })),
    });
  });
}
