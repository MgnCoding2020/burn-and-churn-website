// The order status page (src/pages/order/status.astro): asks the server for
// this customer's own checkout every 5 seconds until the order is collected
// or the payment ended. Once paid, the browser's cart is cleared.
import { saveCart } from './cart-store';

export {};

interface View {
  status: 'starting' | 'open' | 'paid' | 'expired' | 'failed';
  orderNumber: number | null;
  stage: 'new' | 'in_progress' | 'ready' | 'collected' | null;
  payment: 'paid' | 'refunded' | null;
  totalCents: number;
  lines: { name: string; variantLabel: string; qty: number }[];
}

const POLL_MS = 5_000;
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const states = ['loading', 'signin', 'missing', 'order'] as const;
const $ = <T extends Element>(sel: string) => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`order-status: missing ${sel}`);
  return el;
};
const heading = $<HTMLElement>('[data-heading]');
const stageEl = $<HTMLElement>('[data-stage]');
const detailEl = $<HTMLElement>('[data-detail]');
const linesEl = $<HTMLUListElement>('[data-lines]');
const totalEl = $<HTMLElement>('[data-total]');

const id = new URLSearchParams(location.search).get('id') ?? '';
let cleared = false;

function show(state: (typeof states)[number]) {
  for (const s of states) {
    for (const el of document.querySelectorAll<HTMLElement>(`[data-state="${s}"]`)) {
      el.hidden = s !== state;
    }
  }
}

const STAGE_TEXT: Record<NonNullable<View['stage']>, [string, string]> = {
  new: ['Paid: the café has your order.', 'It will be started shortly.'],
  in_progress: ['Being made.', "We'll show it here when it's ready."],
  ready: ['Ready at the counter.', 'Show your order number when you collect it.'],
  collected: ['Collected. Enjoy!', ''],
};

/** What to say, and whether to keep checking. */
function describe(v: View): { stage: string; detail: string; done: boolean } {
  if (v.status === 'expired') {
    return {
      stage: 'This payment expired.',
      detail: 'Nothing was charged. Your order is still in your cart.',
      done: true,
    };
  }
  if (v.status === 'failed') {
    return {
      stage: "This payment couldn't start.",
      detail: 'Nothing was charged. Please try again from your order.',
      done: true,
    };
  }
  if (v.status !== 'paid' || !v.stage) {
    return {
      stage: 'Waiting for Stripe to confirm your payment…',
      detail: 'This usually takes a few seconds.',
      done: false,
    };
  }
  if (v.payment === 'refunded') {
    return {
      stage: 'Refunded.',
      detail: 'The café refunded this order to your card (test mode).',
      done: true,
    };
  }
  const [stage, detail] = STAGE_TEXT[v.stage];
  return { stage, detail, done: v.stage === 'collected' };
}

function render(v: View) {
  heading.textContent = v.orderNumber ? `Order #${v.orderNumber}` : 'Your order';
  const d = describe(v);
  stageEl.textContent = d.stage;
  detailEl.textContent = d.detail;
  linesEl.replaceChildren(
    ...v.lines.map((l) => {
      const li = document.createElement('li');
      li.className = 'order-status__line';
      li.textContent = `${l.qty} × ${l.name}, ${l.variantLabel}`;
      return li;
    }),
  );
  totalEl.textContent = usd.format(v.totalCents / 100);
  show('order');
  return d.done;
}

async function check() {
  let res: Response;
  try {
    res = await fetch(`/api/v1/checkout/${encodeURIComponent(id)}`, {
      headers: { Accept: 'application/json' },
    });
  } catch {
    setTimeout(check, POLL_MS);
    return;
  }
  if (res.status === 401) return show('signin');
  if (!res.ok) return show('missing');
  const view = (await res.json()) as View;
  // Paid: this browser's cart has become the order.
  if (view.status === 'paid' && !cleared) {
    cleared = true;
    saveCart({ lines: [] });
  }
  if (!render(view)) setTimeout(check, POLL_MS);
}

void check();
