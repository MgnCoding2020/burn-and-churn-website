import { describe, expect, it } from 'vitest';
import seed from '../../seed/menu.json';
import { formatCents, getMenuSnapshot, startingPrice } from '../../src/lib/menu';
import { CATEGORY_IDS, parseMenu } from '../../src/lib/menu/schema';

const clone = () =>
  structuredClone(seed) as unknown as Record<string, unknown> & {
    items: Array<Record<string, unknown>>;
    categories: Array<Record<string, unknown>>;
  };

describe('menu seed data', () => {
  const menu = getMenuSnapshot();

  it('has the five coffee-only categories, in order', () => {
    expect(menu.categories.map((c) => c.id)).toEqual([...CATEGORY_IDS]);
  });

  it('has 20 drinks, each in a category', () => {
    expect(menu.items).toHaveLength(20);
    expect(menu.categories.flatMap((c) => c.items)).toHaveLength(20);
  });

  it('sells espresso as exactly one double shot at $3.00', () => {
    const espresso = menu.items.find((i) => i.id === 'espresso')!;
    expect(espresso.variants).toEqual([
      { id: 'double-shot', label: 'Double shot', priceCents: 300, available: true },
    ]);
  });

  it('sells every other drink in 12, 16 and 20 oz with rising whole-cent prices', () => {
    for (const item of menu.items.filter((i) => i.id !== 'espresso')) {
      expect(item.variants.map((v) => v.id)).toEqual(['12oz', '16oz', '20oz']);
      const prices = item.variants.map((v) => v.priceCents);
      expect(prices.every(Number.isInteger)).toBe(true);
      expect(prices[0]).toBeLessThan(prices[1]);
      expect(prices[1]).toBeLessThan(prices[2]);
    }
  });
});

describe('menu validation', () => {
  it('rejects a duplicate item id', () => {
    const bad = clone();
    bad.items.push({ ...bad.items[0] });
    expect(() => parseMenu(bad)).toThrow(/duplicate item id/);
  });

  it('rejects a non-coffee category', () => {
    const bad = clone();
    bad.items[0].category = 'pastries';
    expect(() => parseMenu(bad)).toThrow();
  });

  it('rejects a fractional price', () => {
    const bad = clone();
    bad.items[1].prices = { '12oz': 3.5, '16oz': 400, '20oz': 450 };
    expect(() => parseMenu(bad)).toThrow();
  });

  it('rejects an unsupported size', () => {
    const bad = clone();
    bad.items[1].prices = { '12oz': 350, '16oz': 400, '24oz': 500 };
    expect(() => parseMenu(bad)).toThrow();
  });

  it('rejects data not marked fictional', () => {
    const bad = clone();
    bad.fictional = false;
    expect(() => parseMenu(bad)).toThrow();
  });
});

describe('pricing helpers', () => {
  it('formats integer cents as US dollars', () => {
    expect(formatCents(300)).toBe('$3.00');
    expect(formatCents(525)).toBe('$5.25');
  });

  it('gives the lowest available price, or none', () => {
    const item = getMenuSnapshot().items.find((i) => i.id === 'cream-cold-brew')!;
    expect(startingPrice(item)).toBe(525);
    expect(
      startingPrice({ ...item, variants: item.variants.map((v) => ({ ...v, available: false })) }),
    ).toBeUndefined();
  });
});
