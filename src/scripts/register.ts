// The counter register (src/pages/staff/register.astro, ADR-0031). Builds the
// order on the tablet, then sends only what was ordered and how much cash was
// handed over (or, for a card, starts the payment on the reader): the server
// prices the order and records the sale. Bundled as an external file, so the
// strict CSP holds.

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
// Present only where card payments are set up (ADR-0036).
const cardBtn = document.querySelector<HTMLButtonElement>('[data-card]');

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
  if (cardBtn) cardBtn.disabled = lines.length === 0;
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

// Card payments (ADR-0036): start on the reader, then check every 1.5 s until
// Stripe says paid, declined or canceled. The order exists only once paid.
const cardDialog = document.querySelector<HTMLDialogElement>('#card-dialog');
if (cardBtn && cardDialog) {
  const stateEl = $<HTMLElement>('[data-card-state]');
  const cardDueEl = $<HTMLElement>('[data-card-due]');
  const testBox = $<HTMLElement>('[data-card-test]');
  const retryBtn = $<HTMLButtonElement>('[data-card-retry]');
  const cancelBtn = $<HTMLButtonElement>('[data-card-cancel]');
  const closeBtn = $<HTMLButtonElement>('[data-card-close]');
  const tapBtns = [...cardDialog.querySelectorAll<HTMLButtonElement>('[data-tap]')];
  let cardKey = crypto.randomUUID();
  let paymentId: string | undefined;
  let timer: number | undefined;
  let finished = false;

  interface CardView {
    id: string;
    status: 'starting' | 'waiting' | 'declined' | 'succeeded' | 'canceled' | 'failed';
    totalCents: number;
    failureCode: string | null;
    orderNumber: number | null;
  }

  const api = async (path: string, body?: unknown) => {
    const res = await fetch(`/api/v1/staff/card-payments${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.status === 401) {
      location.assign('/staff/signed-out/');
      throw new Error('signed out');
    }
    const json = (await res.json().catch(() => ({}))) as Partial<CardView> & { detail?: string };
    return { ok: res.ok, json };
  };

  const show = (
    text: string,
    parts: { test?: boolean; retry?: boolean; cancel?: boolean; close?: boolean },
  ) => {
    stateEl.textContent = text;
    testBox.hidden = !parts.test;
    retryBtn.hidden = !parts.retry;
    cancelBtn.hidden = !parts.cancel;
    closeBtn.hidden = !parts.close;
  };

  const stop = () => {
    if (timer !== undefined) window.clearInterval(timer);
    timer = undefined;
  };

  const finish = (message: string, clearOrder: boolean) => {
    stop();
    finished = true;
    paymentId = undefined;
    cardKey = crypto.randomUUID();
    cardDialog.close();
    statusEl.textContent = message;
    if (clearOrder) {
      lines = [];
      saleKey = crypto.randomUUID();
      render();
    }
  };

  const apply = (p: Partial<CardView>) => {
    switch (p.status) {
      case 'succeeded':
        finish(`Order #${p.orderNumber ?? '?'} paid by card.`, true);
        break;
      case 'canceled':
        finish('Card payment canceled. The order is still here: take cash or try again.', false);
        break;
      case 'declined':
        show(
          `Card declined (${p.failureCode ?? 'declined'}). Ask for another card, or cancel and take cash.`,
          {
            retry: true,
            cancel: true,
          },
        );
        break;
      case 'failed':
        stop();
        show(
          `The payment couldn’t start (${p.failureCode ?? 'error'}). Close, then try again or take cash.`,
          {
            close: true,
          },
        );
        cardKey = crypto.randomUUID();
        break;
      case 'waiting':
        show('Ask the customer to tap their card on the reader.', { test: true, cancel: true });
        break;
      default:
        show('Sending the payment to the card reader…', { cancel: true });
    }
  };

  const poll = async () => {
    if (!paymentId) return;
    try {
      const { ok, json } = await api(`/${paymentId}`);
      if (ok) apply(json);
    } catch {
      // A missed check is fine: the next one tries again.
    }
  };

  cardBtn.addEventListener('click', async () => {
    finished = false;
    cardDueEl.textContent = money(total());
    show('Sending the payment to the card reader…', {});
    cardDialog.showModal();
    try {
      const { ok, json } = await api('', {
        idempotencyKey: cardKey,
        lines: lines.map(({ itemId, variantId, qty }) => ({ itemId, variantId, qty })),
      });
      if (!ok || !json.id) {
        show(json.detail ?? 'The payment couldn’t start. Close, then try again or take cash.', {
          close: true,
        });
        cardKey = crypto.randomUUID();
        return;
      }
      paymentId = json.id;
      apply(json);
      if (!finished) timer = window.setInterval(() => void poll(), 1500);
    } catch {
      show("Couldn't reach the server. Close, then try again.", { close: true });
    }
  });

  const act = async (path: string, body: unknown, buttons: HTMLButtonElement[]) => {
    if (!paymentId) return;
    buttons.forEach((b) => (b.disabled = true));
    try {
      const { ok, json } = await api(`/${paymentId}${path}`, body);
      if (!ok) stateEl.textContent = json.detail ?? 'That didn’t work. Try again.';
      else await poll();
    } catch {
      stateEl.textContent = "Couldn't reach the server. Try again.";
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  };

  for (const b of tapBtns) {
    b.addEventListener('click', () => void act('/simulate-tap', { card: b.dataset.tap }, tapBtns));
  }
  retryBtn.addEventListener('click', () => void act('/retry', {}, [retryBtn]));
  cancelBtn.addEventListener('click', () => void act('/cancel', {}, [cancelBtn]));
  closeBtn.addEventListener('click', () => {
    stop();
    paymentId = undefined;
    cardDialog.close();
  });
  // Escape doesn't abandon a payment in progress: cancel it with the button.
  cardDialog.addEventListener('cancel', (event) => {
    if (paymentId) event.preventDefault();
  });
}

render();
