import { describe, expect, it } from 'vitest';
import { getMenuSnapshot } from '../../src/lib/menu';
import { defaultVariantId, isSingleServing, priceCells } from '../../src/lib/menu/display';

const menu = getMenuSnapshot();
const item = (id: string) => menu.items.find((i) => i.id === id)!;

describe('menu display helpers', () => {
  it('treats espresso as a single double-shot serving', () => {
    expect(isSingleServing(item('espresso'))).toBe(true);
    expect(isSingleServing(item('latte'))).toBe(false);
    expect(priceCells(item('espresso'))).toEqual([
      { variantId: 'double-shot', label: 'Double shot', text: '$3.00', available: true },
    ]);
  });

  it('gives three sized prices for other drinks, in order', () => {
    expect(priceCells(item('latte')).map((c) => `${c.label} ${c.text}`)).toEqual([
      '12 oz $4.75',
      '16 oz $5.25',
      '20 oz $5.75',
    ]);
  });

  it('says "Unavailable" in text for an unavailable size', () => {
    const latte = item('latte');
    const soldOut = {
      ...latte,
      variants: latte.variants.map((v) => ({ ...v, available: v.id !== '20oz' })),
    };
    const cells = priceCells(soldOut);
    expect(cells[2]).toMatchObject({ text: 'Unavailable', available: false });
  });

  it('defaults to 16 oz, then the first available size, then nothing', () => {
    const latte = item('latte');
    expect(defaultVariantId(latte)).toBe('16oz');
    expect(
      defaultVariantId({
        ...latte,
        variants: latte.variants.map((v) => ({ ...v, available: v.id === '20oz' })),
      }),
    ).toBe('20oz');
    expect(
      defaultVariantId({
        ...latte,
        variants: latte.variants.map((v) => ({ ...v, available: false })),
      }),
    ).toBeUndefined();
    expect(defaultVariantId(item('espresso'))).toBe('double-shot');
  });
});
