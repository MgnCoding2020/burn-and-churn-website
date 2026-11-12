// The order board (src/pages/staff/orders.astro, ADR-0031). Fetches the board
// every 5 seconds; moving an order sends the stage it was in, so two people
// tapping at once can't skip a step. Bundled as an external file (strict CSP).

// A module, so its names stay private to this script.
export {};

interface BoardOrder {
  id: string;
  number: number;
  channel: 'counter' | 'online';
  tender: 'cash' | 'card';
  stage: 'new' | 'in_progress' | 'ready';
  createdAt: number;
  items: { name: string; variantLabel: string; qty: number }[];
}

const POLL_MS = 5000;

const lists = [...document.querySelectorAll<HTMLOListElement>('ol[data-stage]')];
const updatedEl = document.querySelector<HTMLElement>('[data-updated]')!;
const statusEl = document.querySelector<HTMLElement>('[data-board-status]')!;
let lastOk = 0;
let timer = 0;

const minutesAgo = (ms: number) => {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  return m === 0 ? 'just now' : `${m} min`;
};

function ticket(order: BoardOrder, list: HTMLOListElement): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'ticket';

  const head = document.createElement('p');
  head.className = 'ticket__head';
  const num = document.createElement('span');
  num.textContent = `#${String(order.number).padStart(4, '0')}`;
  const tag = document.createElement('span');
  tag.className = 'ticket__tag';
  tag.textContent = `${order.channel === 'counter' ? 'COUNTER' : 'ONLINE'} · ${order.tender.toUpperCase()}`;
  const age = document.createElement('span');
  age.textContent = minutesAgo(order.createdAt);
  head.replaceChildren(num, tag, age);

  const items = document.createElement('ul');
  items.className = 'ticket__items';
  for (const i of order.items) {
    const item = document.createElement('li');
    item.textContent = `${i.qty} × ${i.name}, ${i.variantLabel}`;
    items.appendChild(item);
  }

  const move = document.createElement('button');
  move.type = 'button';
  move.className = 'btn btn--primary';
  move.textContent = list.dataset.action!;
  move.setAttribute('aria-label', `${list.dataset.action}: order ${order.number}`);
  move.addEventListener('click', () => moveOrder(order, list.dataset.next!, move));

  li.replaceChildren(head, items, move);
  return li;
}

function render(orders: BoardOrder[]) {
  for (const list of lists) {
    const inStage = orders.filter((o) => o.stage === list.dataset.stage);
    list.replaceChildren(...inStage.map((o) => ticket(o, list)));
    const count = document.querySelector(`[data-count="${list.dataset.stage}"]`);
    if (count) count.textContent = `(${inStage.length})`;
  }
}

async function refresh() {
  clearTimeout(timer);
  try {
    const res = await fetch('/api/v1/staff/orders', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    if (res.status === 401) return location.assign('/staff/signed-out/');
    if (res.ok) {
      const body = (await res.json()) as { orders: BoardOrder[] };
      render(body.orders);
      lastOk = Date.now();
    }
  } catch {
    // Keep showing the last board; the "updated" line shows it's going stale.
  }
  updatedEl.textContent = lastOk
    ? `Updated ${new Date(lastOk).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`
    : 'Not updated yet: checking the connection…';
  timer = window.setTimeout(refresh, POLL_MS);
}

async function moveOrder(order: BoardOrder, to: string, button: HTMLButtonElement) {
  button.disabled = true;
  try {
    const res = await fetch(`/api/v1/staff/orders/${order.id}/stage`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ from: order.stage, to }),
    });
    if (res.status === 401) return location.assign('/staff/signed-out/');
    statusEl.textContent =
      res.status === 409
        ? `Order ${order.number} was already moved by someone else.`
        : res.ok
          ? ''
          : `Order ${order.number} couldn't be moved. Try again.`;
  } catch {
    statusEl.textContent = "Couldn't reach the server. Check the connection and try again.";
  }
  await refresh();
}

// Background tabs slow their timers: refresh straight away on return.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh();
});

refresh();
