// The staff Menu screen (src/pages/staff/menu.astro, ADR-0033): mark sold out,
// undo or override, and move a restock through request, approval and receipt.
// Each change goes to the API, then the page reloads to show the server's
// view. Bundled as an external file (strict CSP).

// A module, so its names stay private to this script.
export {};

const statusEl = document.querySelector<HTMLElement>('[data-menu-status]')!;

async function post(url: string, body?: unknown): Promise<void> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.status === 401) return location.assign('/staff/signed-out/');
    if (!res.ok) {
      const problem = (await res.json().catch(() => ({}))) as { detail?: string };
      statusEl.textContent = problem.detail ?? 'That change could not be saved. Try again.';
      document.querySelectorAll<HTMLButtonElement>('.staff-menu button').forEach((b) => {
        b.disabled = false;
      });
      return;
    }
    location.reload();
  } catch {
    statusEl.textContent = "Couldn't reach the server. Check the connection and try again.";
  }
}

const field = (form: HTMLFormElement, name: string) =>
  String(new FormData(form).get(name) ?? '').trim();

document.addEventListener('click', (event) => {
  const button = (event.target as Element | null)?.closest<HTMLButtonElement>('button');
  if (!button || button.type === 'submit') return;
  const { toggle, soldOut, approve, received } = button.dataset;
  let request: [string, unknown?] | undefined;
  if (toggle)
    request = [`/api/v1/staff/menu/${toggle}/availability`, { soldOut: soldOut === 'true' }];
  else if (approve) request = [`/api/v1/staff/restock/${approve}/approve`];
  else if (received) request = [`/api/v1/staff/restock/${received}/received`];
  if (!request) return;
  button.disabled = true;
  void post(...request);
});

document.addEventListener('submit', (event) => {
  const form = (event.target as Element | null)?.closest<HTMLFormElement>('form');
  if (!form) return;
  const { restock, override, reject } = form.dataset;
  let request: [string, unknown] | undefined;
  if (restock) {
    const note = field(form, 'note');
    request = [
      '/api/v1/staff/restock',
      { itemId: restock, quantity: field(form, 'quantity'), ...(note ? { note } : {}) },
    ];
  } else if (override) {
    request = [
      `/api/v1/staff/menu/${override}/availability`,
      { soldOut: false, reason: field(form, 'reason') },
    ];
  } else if (reject) {
    request = [`/api/v1/staff/restock/${reject}/reject`, { reason: field(form, 'reason') }];
  }
  if (!request) return;
  event.preventDefault();
  form.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled = true;
  void post(...request);
});
