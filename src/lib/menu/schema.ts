import { z } from 'zod';

/**
 * Menu data rules (ADR-0014). The seed file (seed/menu.json) keeps the shape
 * it was designed in; this module validates it and turns each item's price
 * map into variants, the shape the site, the register and checkout share.
 */

export const CATEGORY_IDS = [
  'espresso-bar',
  'brewed-coffee',
  'milk-drinks',
  'cold-coffee',
  'signature-seasonal',
] as const;
export type CategoryId = (typeof CATEGORY_IDS)[number];

export const VARIANTS = {
  'double-shot': { label: 'Double shot', sizeOz: undefined },
  '12oz': { label: '12 oz', sizeOz: 12 },
  '16oz': { label: '16 oz', sizeOz: 16 },
  '20oz': { label: '20 oz', sizeOz: 20 },
} as const;
export type VariantId = keyof typeof VARIANTS;

const cents = z.number().int().nonnegative().max(100_00);
const id = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lowercase-hyphen id');
const text = (max: number) => z.string().trim().min(1).max(max);

const SeedItem = z.strictObject({
  id,
  category: z.enum(CATEGORY_IDS),
  name: text(60),
  description: text(160),
  prices: z.union([
    z.strictObject({ single: cents }),
    z.strictObject({ '12oz': cents, '16oz': cents, '20oz': cents }),
  ]),
  featured: z.boolean(),
  iced: z.boolean(),
  available: z.boolean(),
});

export const SeedMenu = z
  .object({
    currency: z.literal('USD'),
    fictional: z.literal(true),
    price_unit: z.literal('cents'),
    categories: z
      .array(z.strictObject({ id: z.enum(CATEGORY_IDS), label: text(40), tagline: text(80) }))
      .length(CATEGORY_IDS.length),
    items: z.array(SeedItem).min(1),
  })
  .superRefine((menu, ctx) => {
    const ids = new Set<string>();
    for (const item of menu.items) {
      if (ids.has(item.id))
        ctx.addIssue({ code: 'custom', message: `duplicate item id: ${item.id}` });
      ids.add(item.id);
    }
    const categories = new Set(menu.categories.map((c) => c.id));
    if (categories.size !== CATEGORY_IDS.length) {
      ctx.addIssue({ code: 'custom', message: 'each category must appear exactly once' });
    }
  });

export interface MenuVariant {
  id: VariantId;
  label: string;
  sizeOz?: number;
  priceCents: number;
  available: boolean;
}

export interface MenuItem {
  id: string;
  categoryId: CategoryId;
  name: string;
  description: string;
  featured: boolean;
  iced: boolean;
  available: boolean;
  variants: MenuVariant[];
}

export interface MenuCategory {
  id: CategoryId;
  label: string;
  tagline: string;
  items: MenuItem[];
}

export interface Menu {
  categories: MenuCategory[];
  items: MenuItem[];
}

/** Validates seed data and normalises it. Throws on invalid data; never returns a partial menu. */
export function parseMenu(input: unknown): Menu {
  const seed = SeedMenu.parse(input);
  const items: MenuItem[] = seed.items.map((item) => {
    const prices: Partial<Record<string, number>> = item.prices;
    const variantIds: VariantId[] =
      'single' in item.prices ? ['double-shot'] : ['12oz', '16oz', '20oz'];
    return {
      id: item.id,
      categoryId: item.category,
      name: item.name,
      description: item.description,
      featured: item.featured,
      iced: item.iced,
      available: item.available,
      variants: variantIds.map((v) => ({
        id: v,
        label: VARIANTS[v].label,
        ...(VARIANTS[v].sizeOz ? { sizeOz: VARIANTS[v].sizeOz } : {}),
        priceCents: (v === 'double-shot' ? prices.single : prices[v]) as number,
        available: item.available,
      })),
    };
  });
  const order = new Map(CATEGORY_IDS.map((c, i) => [c, i]));
  const categories = [...seed.categories]
    .sort((a, b) => order.get(a.id)! - order.get(b.id)!)
    .map((c) => ({ ...c, items: items.filter((i) => i.categoryId === c.id) }));
  return { categories, items };
}
