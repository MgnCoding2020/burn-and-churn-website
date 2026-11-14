/**
 * The online order's cart (plan §6.1, Phase 5). It lives in the customer's
 * browser and holds only what was chosen: drink, size and quantity. Never a
 * price: what anything costs is always the server's menu (GET /api/v1/menu
 * to show it, the server's own pricing again at checkout).
 *
 * Pure functions with no imports, so the browser bundle stays tiny and the
 * same rules are unit-tested.
 */

export const CART_KEY = 'bc-cart-v1';
export const MAX_LINES = 20;
export const MAX_QTY = 20;

export interface CartLine {
  itemId: string;
  variantId: string;
  qty: number;
}

export interface Cart {
  lines: CartLine[];
}

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VARIANT = /^(double-shot|12oz|16oz|20oz)$/;

export const emptyCart = (): Cart => ({ lines: [] });

/**
 * A cart from whatever was stored. Anything malformed is dropped, the same
 * drink and size on two lines are merged, quantities are capped: a tampered
 * or outdated value can never break the page.
 */
export function parseCart(raw: unknown): Cart {
  const lines: CartLine[] = [];
  const list = (raw as { lines?: unknown })?.lines;
  if (!Array.isArray(list)) return emptyCart();
  for (const l of list) {
    const { itemId, variantId, qty } = (l ?? {}) as Record<string, unknown>;
    if (typeof itemId !== 'string' || !ID.test(itemId) || itemId.length > 60) continue;
    if (typeof variantId !== 'string' || !VARIANT.test(variantId)) continue;
    if (typeof qty !== 'number' || !Number.isInteger(qty) || qty < 1) continue;
    const same = lines.find((x) => x.itemId === itemId && x.variantId === variantId);
    if (same) same.qty = Math.min(MAX_QTY, same.qty + qty);
    else if (lines.length < MAX_LINES)
      lines.push({ itemId, variantId, qty: Math.min(MAX_QTY, qty) });
  }
  return { lines };
}

export type AddResult =
  { ok: true; cart: Cart } | { ok: false; reason: 'too_many_lines' | 'max_qty' };

/** Adds one of a drink and size. */
export function addToCart(cart: Cart, itemId: string, variantId: string): AddResult {
  const lines = cart.lines.map((l) => ({ ...l }));
  const same = lines.find((l) => l.itemId === itemId && l.variantId === variantId);
  if (same) {
    if (same.qty >= MAX_QTY) return { ok: false, reason: 'max_qty' };
    same.qty += 1;
  } else {
    if (lines.length >= MAX_LINES) return { ok: false, reason: 'too_many_lines' };
    lines.push({ itemId, variantId, qty: 1 });
  }
  return { ok: true, cart: { lines } };
}

/** Sets a line's quantity (1 to MAX_QTY); 0 or less removes it. */
export function setQty(cart: Cart, index: number, qty: number): Cart {
  if (qty <= 0) return removeLine(cart, index);
  return {
    lines: cart.lines.map((l, i) => (i === index ? { ...l, qty: Math.min(MAX_QTY, qty) } : l)),
  };
}

export function removeLine(cart: Cart, index: number): Cart {
  return { lines: cart.lines.filter((_, i) => i !== index) };
}

export const itemCount = (cart: Cart) => cart.lines.reduce((n, l) => n + l.qty, 0);

/** The menu as GET /api/v1/menu returns it. */
export interface PricingVariant {
  id: string;
  label: string;
  priceCents: number;
  available: boolean;
}
export interface PricingItem {
  id: string;
  name: string;
  available: boolean;
  variants: PricingVariant[];
}

export interface ShownLine extends CartLine {
  name: string;
  variantLabel: string;
  unitPriceCents: number;
  lineCents: number;
  /** False when the drink or size is sold out or gone from the menu: shown, not charged. */
  available: boolean;
}

/** The cart as the customer sees it, priced from the server's menu. Unavailable lines don't count. */
export function showCart(
  cart: Cart,
  items: PricingItem[],
): { lines: ShownLine[]; totalCents: number; unavailable: number } {
  const lines = cart.lines.map((l): ShownLine => {
    const item = items.find((i) => i.id === l.itemId);
    const variant = item?.variants.find((v) => v.id === l.variantId);
    const available = Boolean(item?.available && variant?.available);
    const unit = variant?.priceCents ?? 0;
    return {
      ...l,
      name: item?.name ?? 'No longer on the menu',
      variantLabel: variant?.label ?? '',
      unitPriceCents: unit,
      lineCents: available ? unit * l.qty : 0,
      available,
    };
  });
  return {
    lines,
    totalCents: lines.reduce((s, l) => s + l.lineCents, 0),
    unavailable: lines.filter((l) => !l.available).length,
  };
}
