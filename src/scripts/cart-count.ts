// The header's "Order (n)": how many drinks are in this browser's cart.
// Updates on this page's changes and on other tabs' (the storage event).
import { CART_KEY, itemCount } from '../lib/cart';
import { CART_EVENT, loadCart } from './cart-store';

function show() {
  const n = itemCount(loadCart());
  for (const el of document.querySelectorAll<HTMLElement>('[data-cart-count]')) {
    el.textContent = n ? ` (${n})` : '';
  }
}

show();
window.addEventListener(CART_EVENT, show);
window.addEventListener('storage', (e) => {
  if (e.key === CART_KEY || e.key === null) show();
});
