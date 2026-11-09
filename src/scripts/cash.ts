// The cash drawer (src/pages/staff/cash.astro, ADR-0034): open with a float,
// close with a blind count (confirm first; it can't be redone), explain a
// difference, review a count. Bundled as an external file (strict CSP).
import { reasonFrom } from './reason';

const statusEl = document.querySelector<HTMLElement>('[data-cash-status]')!;
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

async function post(url: string, body?: unknown): Promise<unknown> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.status === 401) {
      location.assign('/staff/signed-out/');
      return undefined;
    }
    if (!res.ok) {
      const problem = (await res.json().catch(() => ({}))) as { detail?: string };
      statusEl.textContent = problem.detail ?? 'That change could not be saved. Try again.';
      document.querySelectorAll<HTMLButtonElement>('.cash button').forEach((b) => {
        b.disabled = false;
      });
      return undefined;
    }
    return await res.json();
  } catch {
    statusEl.textContent = "Couldn't reach the server. Check the connection and try again.";
    return undefined;
  }
}

/** "$150.00" or "150" to cents; undefined if it isn't an amount. */
function toCents(text: string): number | undefined {
  const m = /^\$?\s*(\d{1,4})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!m) return undefined;
  return Number(m[1]) * 100 + Number((m[2] ?? '0').padEnd(2, '0'));
}

// Open the drawer.
document.querySelector<HTMLFormElement>('[data-open]')?.addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const floatCents = toCents(String(new FormData(form).get('float') ?? ''));
  if (floatCents === undefined || floatCents > 100_000) {
    statusEl.textContent = 'Enter the float in dollars, for example 150.00.';
    return;
  }
  form.querySelector('button')!.disabled = true;
  void post('/api/v1/staff/cash/open', { floatCents }).then((ok) => ok && location.reload());
});

// Close the drawer: total the count, confirm, then save.
const closeForm = document.querySelector<HTMLFormElement>('[data-close]');
if (closeForm) {
  const inputs = [...closeForm.querySelectorAll<HTMLInputElement>('input[data-cents]')];
  const countedEl = closeForm.querySelector<HTMLElement>('[data-cash-counted]')!;
  const confirmBox = closeForm.querySelector<HTMLElement>('[data-cash-confirm]')!;
  const question = closeForm.querySelector<HTMLElement>('[data-cash-question]')!;
  const reviewButton = closeForm.querySelector<HTMLButtonElement>('[data-cash-review]')!;
  const count = () => {
    const counts: Record<string, number> = {};
    for (const i of inputs) {
      const n = Number(i.value || '0');
      counts[i.name] = Number.isInteger(n) && n >= 0 && n <= 5000 ? n : NaN;
    }
    return counts;
  };
  const total = (counts: Record<string, number>) =>
    inputs.reduce((sum, i) => sum + Number(i.dataset.cents) * (counts[i.name] ?? 0), 0);
  const hide = () => {
    confirmBox.hidden = true;
    reviewButton.disabled = false;
  };

  closeForm.addEventListener('input', () => {
    const t = total(count());
    countedEl.textContent = Number.isNaN(t) ? '—' : usd.format(t / 100);
    hide();
  });

  closeForm.addEventListener('submit', (event) => {
    event.preventDefault();
    statusEl.textContent = '';
    const counts = count();
    if (Object.values(counts).some(Number.isNaN)) {
      statusEl.textContent = 'Each count must be a whole number from 0 to 5,000.';
      return;
    }
    question.textContent = `Save a count of ${usd.format(total(counts) / 100)}? It can’t be redone.`;
    confirmBox.hidden = false;
    reviewButton.disabled = true;
    question.focus();
  });

  closeForm.querySelector('[data-cash-no]')!.addEventListener('click', () => {
    hide();
    inputs[0]?.focus();
  });

  closeForm.querySelector('[data-cash-yes]')!.addEventListener('click', (event) => {
    (event.currentTarget as HTMLButtonElement).disabled = true;
    void post(`/api/v1/staff/cash/${closeForm.dataset.close}/close`, { counts: count() }).then(
      (ok) => ok && location.reload(),
    );
  });
}

// Explain a difference.
document.addEventListener('submit', (event) => {
  const form = (event.target as Element | null)?.closest<HTMLFormElement>('[data-explain]');
  if (!form) return;
  event.preventDefault();
  const reason = reasonFrom(form);
  if (!reason.code || (reason.code === 'other' && !reason.note)) {
    statusEl.textContent = 'Choose a reason (and add a note for Other).';
    return;
  }
  form.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled = true;
  void post(`/api/v1/staff/cash/${form.dataset.explain}/explain`, { reason }).then(
    (ok) => ok && location.reload(),
  );
});

// Review a count.
document.addEventListener('click', (event) => {
  const button = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-review]');
  if (!button) return;
  button.disabled = true;
  void post(`/api/v1/staff/cash/${button.dataset.review}/review`).then(
    (ok) => ok && location.reload(),
  );
});

// Ready: the buttons start disabled so nothing submits before this script runs.
document.querySelectorAll<HTMLButtonElement>('[data-needs-script]').forEach((b) => {
  b.disabled = false;
});
