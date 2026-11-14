// The order page (src/pages/order.astro): the cart from this browser, priced
// from the server's menu. Prices here are for showing only; checkout prices
// the order again on the server, then sends the customer to Stripe's own
// payment page (ADR-0044).
import { MAX_QTY, removeLine, setQty, showCart, type Cart, type PricingItem } from '../lib/cart';
import { CART_EVENT, loadCart, saveCart } from './cart-store';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const money = (cents: number) => usd.format(cents / 100);

const $ = <T extends Element>(sel: string) => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`order: missing ${sel}`);
  return el;
};
const states = ['loading', 'empty', 'error', 'cart'] as const;
const linesEl = $<HTMLUListElement>('[data-lines]');
const totalEl = $<HTMLElement>('[data-total]');
const unavailableEl = $<HTMLElement>('[data-unavailable]');
const announce = $<HTMLElement>('[data-announce]');
const payBtn = $<HTMLButtonElement>('[data-pay-button]');
const signInLink = $<HTMLAnchorElement>('[data-pay-signin]');
const staffNote = $<HTMLElement>('[data-pay-staff]');
const payError = $<HTMLElement>('[data-pay-error]');

let items: PricingItem[] | undefined;
/** Who is here: a customer may pay; anyone else is shown why not. */
let who: 'customer' | 'signed-out' | 'staff' | 'unknown' = 'unknown';
let paying = false;

function show(state: (typeof states)[number]) {
  for (const s of states) {
    for (const el of document.querySelectorAll<HTMLElement>(`[data-state="${s}"]`)) {
      el.hidden = s !== state;
    }
  }
}

function button(text: string, label: string, onClick: () => void) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn btn--secondary';
  b.textContent = text;
  b.setAttribute('aria-label', label);
  b.addEventListener('click', onClick);
  return b;
}

/** Saves a change, re-renders, and says what happened; focus stays sensible. */
function change(next: Cart, message: string, focusIndex?: number) {
  saveCart(next);
  render();
  announce.textContent = message;
  if (focusIndex !== undefined) {
    const rows = linesEl.querySelectorAll<HTMLElement>('.order-line');
    const row = rows[Math.min(focusIndex, rows.length - 1)];
    (row?.querySelector<HTMLButtonElement>('[data-focus]') ?? $<HTMLElement>('h1')).focus();
  }
}

function render() {
  const cart = loadCart();
  if (!cart.lines.length) return show('empty');
  if (!items) return;
  const shown = showCart(cart, items);
  linesEl.replaceChildren(
    ...shown.lines.map((l, i) => {
      const li = document.createElement('li');
      li.className = l.available ? 'order-line' : 'order-line order-line--na';
      const name = document.createElement('span');
      name.className = 'order-line__name';
      name.textContent = l.variantLabel ? `${l.name}, ${l.variantLabel}` : l.name;
      const price = document.createElement('span');
      price.className = 'price';
      price.textContent = l.available ? money(l.lineCents) : 'Unavailable';
      const what = l.variantLabel ? `${l.name}, ${l.variantLabel}` : l.name;

      const controls = document.createElement('div');
      controls.className = 'order-line__controls';
      if (l.available) {
        const qty = document.createElement('span');
        qty.className = 'order-line__qty';
        qty.textContent = String(l.qty);
        const less = button('−', `One fewer ${what}`, () =>
          change(
            setQty(loadCart(), i, l.qty - 1),
            l.qty > 1 ? `${what}: ${l.qty - 1}` : `Removed ${what}`,
            i,
          ),
        );
        const more = button('+', `One more ${what}`, () =>
          change(setQty(loadCart(), i, l.qty + 1), `${what}: ${Math.min(MAX_QTY, l.qty + 1)}`),
        );
        more.disabled = l.qty >= MAX_QTY;
        controls.replaceChildren(less, qty, more);
      }
      const remove = button('Remove', `Remove ${what}`, () =>
        change(removeLine(loadCart(), i), `Removed ${what}`, i),
      );
      remove.dataset.focus = '';
      controls.appendChild(remove);
      li.replaceChildren(name, price, controls);
      return li;
    }),
  );
  totalEl.textContent = money(shown.totalCents);
  unavailableEl.hidden = shown.unavailable === 0;
  payBtn.hidden = who !== 'customer';
  signInLink.hidden = who !== 'signed-out';
  staffNote.hidden = who !== 'staff';
  // Sold-out lines must go first: what's paid is exactly what's shown.
  payBtn.disabled = paying || shown.unavailable > 0 || shown.totalCents === 0;
  show('cart');
}

async function whoIsHere() {
  try {
    const res = await fetch('/api/v1/account/me', { headers: { Accept: 'application/json' } });
    who = res.ok
      ? 'customer'
      : res.status === 401
        ? 'signed-out'
        : res.status === 403
          ? 'staff'
          : 'unknown';
  } catch {
    who = 'unknown';
  }
}

async function pay() {
  paying = true;
  payError.hidden = true;
  render();
  announce.textContent = 'Starting your payment…';
  try {
    const res = await fetch('/api/v1/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      // One key per attempt: a double-click can't start two payments.
      body: JSON.stringify({ key: crypto.randomUUID(), lines: loadCart().lines }),
    });
    const body = (await res.json().catch(() => ({}))) as { url?: string; detail?: string };
    if (res.status === 201 && body.url?.startsWith('https://checkout.stripe.com/')) {
      window.location.assign(body.url);
      return;
    }
    if (res.status === 401) {
      who = 'signed-out';
    } else if (res.status === 409) {
      // Something sold out meanwhile: refresh prices and availability.
      await start();
    }
    payError.textContent = body.detail ?? "We couldn't start the payment. Please try again.";
  } catch {
    payError.textContent = "We couldn't reach the site. Please try again.";
  }
  payError.hidden = false;
  paying = false;
  render();
}

payBtn.addEventListener('click', () => {
  if (!paying) void pay();
});

async function start() {
  if (!loadCart().lines.length) return show('empty');
  try {
    const res = await fetch('/api/v1/menu', { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(String(res.status));
    items = ((await res.json()) as { items: PricingItem[] }).items;
    render();
  } catch {
    show('error');
  }
}

window.addEventListener(CART_EVENT, () => {
  if (items) render();
});
window.addEventListener('storage', () => {
  if (items) render();
});
void whoIsHere().then(start);
