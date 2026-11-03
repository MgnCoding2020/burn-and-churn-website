import { formatCents } from './index';
import type { MenuItem } from './schema';

/** One cell in a price row: the size label and either a price or "Unavailable". */
export interface PriceCell {
  variantId: string;
  label: string;
  text: string;
  available: boolean;
}

export const SIZE_COLUMNS = ['12oz', '16oz', '20oz'] as const;

/** True for items sold as a single serving (espresso's double shot). */
export function isSingleServing(item: MenuItem): boolean {
  return item.variants.length === 1 && item.variants[0].id === 'double-shot';
}

/** Price cells in display order. Unavailable variants say so in text, not colour. */
export function priceCells(item: MenuItem): PriceCell[] {
  return item.variants.map((v) => ({
    variantId: v.id,
    label: v.label,
    text: v.available ? formatCents(v.priceCents) : 'Unavailable',
    available: v.available,
  }));
}

/** The size a detail view highlights first: 16 oz if available, else the first available. */
export function defaultVariantId(item: MenuItem): string | undefined {
  const available = item.variants.filter((v) => v.available);
  return (available.find((v) => v.id === '16oz') ?? available[0])?.id;
}
