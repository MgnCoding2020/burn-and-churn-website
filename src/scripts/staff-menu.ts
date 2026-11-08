// The staff Menu screen (src/pages/staff/menu.astro, ADR-0032): 86 an item,
// request or close a restock. Each change goes to the API, then the page
// reloads to show the server's view. Bundled as an external file (strict CSP).

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
      return;
    }
    location.reload();
  } catch {
    statusEl.textContent = "Couldn't reach the server. Check the connection and try again.";
  }
}

document.addEventListener('click', (event) => {
  const target = event.target as Element | null;
  const toggle = target?.closest<HTMLButtonElement>('[data-toggle]');
  if (toggle) {
    toggle.disabled = true;
    void post(`/api/v1/staff/menu/${toggle.dataset.toggle}/availability`, {
      soldOut: toggle.dataset.soldOut === 'true',
    });
    return;
  }
  const done = target?.closest<HTMLButtonElement>('[data-restock-done]');
  if (done) {
    done.disabled = true;
    void post(`/api/v1/staff/restock/${done.dataset.restockDone}/done`);
  }
});

document.addEventListener('submit', (event) => {
  const form = (event.target as Element | null)?.closest<HTMLFormElement>('[data-restock]');
  if (!form) return;
  event.preventDefault();
  const data = new FormData(form);
  const note = String(data.get('note') ?? '').trim();
  void post('/api/v1/staff/restock', {
    itemId: form.dataset.restock,
    quantity: String(data.get('quantity') ?? '').trim(),
    ...(note ? { note } : {}),
  });
});
