// The counter register (src/pages/staff/register.astro, ADR-0031). Builds the
// order on the tablet, then sends only what was ordered and how much cash was
// handed over: the server prices the order and records the sale. Bundled as an
// external file, so the strict CSP holds.

// A module, so its names stay private to this script.
export {};

interface Line {
  itemId: string;
  variantId: string;
  name: string;
  label: string;
  priceCents: number;
  qty: number;
}

const MAX_QTY = 20;
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const money = (cents: number) => usd.format(cents / 100);

const $ = <T extends Element>(sel: string, root: ParentNode = document) => {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`register: missing ${sel}`);
  return el;
};

const linesEl = $<HTMLUListElement>('[data-lines]');
const emptyEl = $<HTMLElement>('[data-empty]');
const totalEl = $<HTMLElement>('[data-total]');
const clearBtn = $<HTMLButtonElement>('[data-clear]');
const payBtn = $<HTMLButtonElement>('[data-pay]');
const statusEl = $<HTMLElement>('[data-status]');
const dialog = $<HTMLDialogElement>('#cash-dialog');
const form = $<HTMLFormElement>('[data-cash-form]');
const dueEl = $<HTMLElement>('[data-due]');
const tenderedInput = $<HTMLInputElement>('[data-tendered]');
const changeEl = $<HTMLElement>('[data-change]');
const quickEl = $<HTMLElement>('[data-quick]');
const errorEl = $<HTMLElement>('[data-cash-error]');
const completeBtn = $<HTMLButtonElement>('[data-complete]');

let lines: Line[] = [];
/** One key per sale attempt: a retry or double-tap can't record it twice. */
let saleKey = crypto.randomUUID();

const total = () => lines.reduce((sum, l) => sum + l.priceCents * l.qty, 0);

function render() {
  linesEl.replaceChildren(
    ...lines.map((l, i) => {
      const li = document.createElement('li');
      li.className = 'register__line';
      const text = document.createElement('span');
      text.textContent = `${l.qty} × ${l.name}, ${l.label}`;
      const price = document.createElement('span');
      price.className = 'price';
      price.textContent = money(l.priceCents * l.qty);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'register__remove';
      remove.textContent = '−';
      remove.setAttribute('aria-label', `Remove one ${l.name}, ${l.label}`);
      remove.addEventListener('click', () => {
        lines[i]!.qty -= 1;
        if (lines[i]!.qty === 0) lines.splice(i, 1);
        render();
      });
      li.replaceChildren(text, price, remove);
      return li;
    }),
  );
  emptyEl.hidden = lines.length > 0;
  totalEl.textContent = money(total());
  clearBtn.disabled = payBtn.disabled = lines.length === 0;
}

document.addEventListener('click', (event) => {
  const btn = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-add]');
  if (!btn || btn.disabled) return;
  const d = btn.dataset;
  const found = lines.find((l) => l.itemId === d.item && l.variantId === d.variant);
  if (found) {
    if (found.qty < MAX_QTY) found.qty += 1;
  } else {
    lines.push({
      itemId: d.item!,
      variantId: d.variant!,
      name: d.name!,
      label: d.label!,
      priceCents: Number(d.price),
      qty: 1,
    });
  }
  statusEl.textContent = '';
  render();
});

clearBtn.addEventListener('click', () => {
  lines = [];
  render();
});

/** "12.5" or "$12.50" → 1250; undefined if it isn't a sensible amount. */
function parseDollars(value: string): number | undefined {
  const m = /^\s*\$?\s*(\d{1,4})(?:\.(\d{1,2}))?\s*$/.exec(value);
  if (!m) return undefined;
  return Number(m[1]) * 100 + Number((m[2] ?? '0').padEnd(2, '0'));
}

function updateChange() {
  const tendered = parseDollars(tenderedInput.value);
  const due = total();
  changeEl.textContent = tendered !== undefined && tendered >= due ? money(tendered - due) : '—';
}

payBtn.addEventListener('click', () => {
  const due = total();
  dueEl.textContent = money(due);
  tenderedInput.value = '';
  errorEl.textContent = '';
  changeEl.textContent = '—';
  // Exact amount, then the next round notes above it.
  const quick = [due, ...[500, 1000, 2000, 5000].filter((n) => n > due).slice(0, 3)];
  quickEl.replaceChildren(
    ...quick.map((cents, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn--secondary';
      b.textContent = i === 0 ? `${money(cents)} exact` : money(cents);
      b.addEventListener('click', () => {
        tenderedInput.value = (cents / 100).toFixed(2);
        updateChange();
      });
      return b;
    }),
  );
  dialog.showModal();
  tenderedInput.focus();
});

tenderedInput.addEventListener('input', updateChange);
$<HTMLButtonElement>('[data-cash-cancel]').addEventListener('click', () => dialog.close());

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const tenderedCents = parseDollars(tenderedInput.value);
  if (tenderedCents === undefined || tenderedCents < total()) {
    errorEl.textContent = 'Enter at least the total due, in dollars (for example 20 or 12.50).';
    tenderedInput.focus();
    return;
  }
  completeBtn.disabled = true;
  errorEl.textContent = '';
  try {
    const res = await fetch('/api/v1/staff/orders', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        idempotencyKey: saleKey,
        tender: 'cash',
        tenderedCents,
        lines: lines.map(({ itemId, variantId, qty }) => ({ itemId, variantId, qty })),
      }),
    });
    if (res.status === 401) {
      location.assign('/staff/signed-out/');
      return;
    }
    const body = (await res.json()) as { number?: number; changeCents?: number; detail?: string };
    if (!res.ok) {
      errorEl.textContent = body.detail ?? 'The sale could not be recorded. Try again.';
      return;
    }
    dialog.close();
    statusEl.textContent = `Order #${body.number} paid. Change due: ${money(body.changeCents ?? 0)}.`;
    lines = [];
    saleKey = crypto.randomUUID();
    render();
  } catch {
    // Same key on retry: if the first attempt did reach the server, it isn't recorded twice.
    errorEl.textContent = "Couldn't reach the server. Check the connection and try again.";
  } finally {
    completeBtn.disabled = false;
  }
});

render();
