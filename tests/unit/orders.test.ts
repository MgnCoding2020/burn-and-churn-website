import { describe, expect, it } from 'vitest';
import { getMenuSnapshot } from '../../src/lib/menu';
import { businessDay, canMove, priceOrder } from '../../src/lib/orders';

describe('business day (store time zone, ADR-0031)', () => {
  it('uses the store time zone, not UTC: 03:00 UTC is still the previous day in New York', () => {
    expect(businessDay(Date.UTC(2026, 10, 8, 3, 0))).toBe('2026-11-07');
    expect(businessDay(Date.UTC(2026, 10, 8, 15, 0))).toBe('2026-11-08');
  });
});

describe('pricing (server-side, ADR-0031)', () => {
  const menu = getMenuSnapshot();

  it('prices from the menu and merges repeated lines', () => {
    const result = priceOrder([
      { itemId: 'americano', variantId: '16oz', qty: 1 },
      { itemId: 'espresso', variantId: 'double-shot', qty: 2 },
      { itemId: 'americano', variantId: '16oz', qty: 1 },
    ]);
    expect(result).toMatchObject({
      ok: true,
      totalCents: 400 * 2 + 300 * 2,
      lines: [
        { itemId: 'americano', variantId: '16oz', qty: 2, unitPriceCents: 400, name: 'Americano' },
        { itemId: 'espresso', variantId: 'double-shot', qty: 2, unitPriceCents: 300 },
      ],
    });
  });

  it('refuses items and sizes that are not on the menu', () => {
    expect(priceOrder([{ itemId: 'free-coffee', variantId: '16oz', qty: 1 }])).toMatchObject({
      ok: false,
      error: 'unknown_item',
    });
    expect(priceOrder([{ itemId: 'espresso', variantId: '20oz', qty: 1 }])).toMatchObject({
      ok: false,
      error: 'unknown_variant',
    });
  });

  it('refuses a sold-out item', () => {
    const soldOut = {
      ...menu,
      items: menu.items.map((i) =>
        i.id === 'americano'
          ? { ...i, variants: i.variants.map((v) => ({ ...v, available: false })) }
          : i,
      ),
    };
    expect(priceOrder([{ itemId: 'americano', variantId: '12oz', qty: 1 }], soldOut)).toMatchObject(
      { ok: false, error: 'unavailable' },
    );
  });
});

describe('board moves', () => {
  it('only one step forward', () => {
    expect(canMove('new', 'in_progress')).toBe(true);
    expect(canMove('in_progress', 'ready')).toBe(true);
    expect(canMove('ready', 'collected')).toBe(true);
    expect(canMove('new', 'ready')).toBe(false);
    expect(canMove('ready', 'new')).toBe(false);
    expect(canMove('collected', 'new')).toBe(false);
  });
});
