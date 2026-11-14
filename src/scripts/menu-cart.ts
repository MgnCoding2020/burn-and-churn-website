// "Add" on the menu's drink details (src/components/menu/DrinkDialog.astro).
// The buttons start disabled and are enabled here, so nothing can be clicked
// before this script has loaded.
import { addToCart } from '../lib/cart';
import { loadCart, saveCart } from './cart-store';

for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-cart-add]')) {
  btn.disabled = false;
  btn.addEventListener('click', () => {
    const { item, variant, name, label } = btn.dataset;
    if (!item || !variant) return;
    const status = btn.closest('dialog')?.querySelector<HTMLElement>('[data-cart-status]');
    const result = addToCart(loadCart(), item, variant);
    let message: string;
    if (!result.ok) {
      message =
        result.reason === 'max_qty'
          ? `You already have the most of ${name}, ${label} we take in one order.`
          : 'Your order is full: finish it before adding more.';
    } else if (!saveCart(result.cart)) {
      message =
        "This browser won't let the site remember your order (private mode or blocked site data).";
    } else {
      const qty =
        result.cart.lines.find((l) => l.itemId === item && l.variantId === variant)?.qty ?? 1;
      message = `Added ${name}, ${label}. You have ${qty} in your order.`;
    }
    if (status) status.textContent = message;
  });
}
