import { describe, expect, it } from 'vitest';
import {
  addToCart,
  emptyCart,
  itemCount,
  MAX_LINES,
  MAX_QTY,
  parseCart,
  removeLine,
  setQty,
  showCart,
  type PricingItem,
} from '../../src/lib/cart';

const items: PricingItem[] = [
  {
    id: 'latte',
    name: 'Latte',
    available: true,
    variants: [
      { id: '12oz', label: '12 oz', priceCents: 450, available: true },
      { id: '16oz', label: '16 oz', priceCents: 525, available: true },
    ],
  },
  {
    id: 'mocha',
    name: 'Mocha',
    available: false,
    variants: [{ id: '16oz', label: '16 oz', priceCents: 575, available: false }],
  },
];

describe('parseCart: whatever was stored, never trusted', () => {
  it.each([null, undefined, 'x', 42, {}, { lines: 'no' }])('treats %j as empty', (raw) => {
    expect(parseCart(raw)).toEqual(emptyCart());
  });

  it('drops malformed lines, merges duplicates and caps quantities', () => {
    const cart = parseCart({
      lines: [
        { itemId: 'latte', variantId: '16oz', qty: 2 },
        { itemId: 'latte', variantId: '16oz', qty: 30 },
        { itemId: 'Latte<script>', variantId: '16oz', qty: 1 },
        { itemId: 'latte', variantId: '64oz', qty: 1 },
        { itemId: 'latte', variantId: '12oz', qty: 0 },
        { itemId: 'latte', variantId: '12oz', qty: 1.5 },
        { itemId: 'mocha', variantId: '12oz', qty: 1, priceCents: 1 },
      ],
    });
    expect(cart).toEqual({
      lines: [
        { itemId: 'latte', variantId: '16oz', qty: MAX_QTY },
        { itemId: 'mocha', variantId: '12oz', qty: 1 },
      ],
    });
  });

  it('keeps at most MAX_LINES lines', () => {
    const lines = Array.from({ length: MAX_LINES + 5 }, (_, i) => ({
      itemId: `drink-${i}`,
      variantId: '12oz',
      qty: 1,
    }));
    expect(parseCart({ lines }).lines).toHaveLength(MAX_LINES);
  });
});

describe('changing the cart', () => {
  it('adds a new line, then counts up the same drink and size', () => {
    let r = addToCart(emptyCart(), 'latte', '16oz');
    expect(r).toEqual({
      ok: true,
      cart: { lines: [{ itemId: 'latte', variantId: '16oz', qty: 1 }] },
    });
    r = addToCart(r.ok ? r.cart : emptyCart(), 'latte', '16oz');
    expect(r.ok && r.cart.lines).toEqual([{ itemId: 'latte', variantId: '16oz', qty: 2 }]);
    expect(r.ok && itemCount(r.cart)).toBe(2);
  });

  it('refuses past the caps instead of growing silently', () => {
    const full = { lines: [{ itemId: 'latte', variantId: '16oz', qty: MAX_QTY }] };
    expect(addToCart(full, 'latte', '16oz')).toEqual({ ok: false, reason: 'max_qty' });
    const many = {
      lines: Array.from({ length: MAX_LINES }, (_, i) => ({
        itemId: `d-${i}`,
        variantId: '12oz',
        qty: 1,
      })),
    };
    expect(addToCart(many, 'latte', '16oz')).toEqual({ ok: false, reason: 'too_many_lines' });
  });

  it('sets a quantity within bounds, and removes at zero', () => {
    const cart = { lines: [{ itemId: 'latte', variantId: '16oz', qty: 2 }] };
    expect(setQty(cart, 0, 99).lines[0]!.qty).toBe(MAX_QTY);
    expect(setQty(cart, 0, 0)).toEqual(emptyCart());
    expect(removeLine(cart, 0)).toEqual(emptyCart());
  });
});

describe('showCart', () => {
  it("prices from the server's menu and leaves out what can't be sold today", () => {
    const shown = showCart(
      {
        lines: [
          { itemId: 'latte', variantId: '16oz', qty: 2 },
          { itemId: 'mocha', variantId: '16oz', qty: 1 },
          { itemId: 'gone', variantId: '12oz', qty: 1 },
        ],
      },
      items,
    );
    expect(shown.totalCents).toBe(1050);
    expect(shown.unavailable).toBe(2);
    expect(shown.lines.map((l) => [l.name, l.available, l.lineCents])).toEqual([
      ['Latte', true, 1050],
      ['Mocha', false, 0],
      ['No longer on the menu', false, 0],
    ]);
  });
});
