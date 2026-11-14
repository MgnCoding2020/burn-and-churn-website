// The cart in this browser (src/lib/cart.ts). Storage can be missing or
// blocked (private windows, blocked site data): every read and write is
// guarded, and the cart then simply starts empty.
import { CART_KEY, emptyCart, parseCart, type Cart } from '../lib/cart';

export const CART_EVENT = 'bc-cart-change';

export function loadCart(): Cart {
  try {
    const raw = localStorage.getItem(CART_KEY);
    return raw ? parseCart(JSON.parse(raw)) : emptyCart();
  } catch {
    return emptyCart();
  }
}

/** Saves the cart and tells the page (the header count listens). False if storage refused. */
export function saveCart(cart: Cart): boolean {
  let saved = true;
  try {
    if (cart.lines.length) localStorage.setItem(CART_KEY, JSON.stringify(cart));
    else localStorage.removeItem(CART_KEY);
  } catch {
    saved = false;
  }
  window.dispatchEvent(new CustomEvent(CART_EVENT));
  return saved;
}
