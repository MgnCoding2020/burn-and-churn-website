// Refund one sale (src/pages/staff/refund.astro, ADR-0034): pick quantities
// and a reason, review the total, then confirm. The server prices the refund
// from the sale and checks who may issue it. Bundled as an external file (strict CSP).
import { reasonFrom } from './reason';

const form = document.querySelector<HTMLFormElement>('[data-refund]');
const statusEl = document.querySelector<HTMLElement>('[data-refund-status]')!;

if (form) {
  const orderId = form.dataset.refund!;
  // One key per page: a retry or double-tap can't refund twice.
  const idempotencyKey = crypto.randomUUID();
  const selects = [...form.querySelectorAll('select')].filter((s) => s.dataset.line);
  const totalEl = form.querySelector<HTMLElement>('[data-refund-total]')!;
  const confirmBox = form.querySelector<HTMLElement>('[data-refund-confirm]')!;
  const question = form.querySelector<HTMLElement>('[data-refund-question]')!;
  const reviewButton = form.querySelector<HTMLButtonElement>('[data-refund-review]')!;
  const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

  const chosen = () =>
    selects
      .map((s) => ({
        line: Number(s.dataset.line),
        qty: Number(s.value),
        unit: Number(s.dataset.unit),
      }))
      .filter((l) => l.qty > 0);
  const total = () => chosen().reduce((sum, l) => sum + l.qty * l.unit, 0);
  const showTotal = () => {
    totalEl.textContent = usd.format(total() / 100);
  };
  const closeConfirm = () => {
    confirmBox.hidden = true;
    reviewButton.disabled = false;
  };

  form.addEventListener('change', () => {
    showTotal();
    closeConfirm();
  });

  form.querySelector('[data-refund-all]')!.addEventListener('click', () => {
    for (const s of selects) s.value = s.dataset.max ?? '0';
    showTotal();
    closeConfirm();
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    statusEl.textContent = '';
    if (!chosen().length) {
      statusEl.textContent = 'Choose at least one drink to refund.';
      return;
    }
    const reason = reasonFrom(form);
    if (!reason.code || (reason.code === 'other' && !reason.note)) {
      statusEl.textContent = 'Choose a reason (and add a note for Other).';
      return;
    }
    question.textContent = `Refund ${usd.format(total() / 100)} in cash to the customer?`;
    confirmBox.hidden = false;
    reviewButton.disabled = true;
    question.focus();
  });

  form.querySelector('[data-refund-no]')!.addEventListener('click', () => {
    closeConfirm();
    reviewButton.focus();
  });

  form.querySelector('[data-refund-yes]')!.addEventListener('click', async (event) => {
    const yes = event.currentTarget as HTMLButtonElement;
    yes.disabled = true;
    try {
      const res = await fetch(`/api/v1/staff/orders/${orderId}/refunds`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          idempotencyKey,
          lines: chosen().map(({ line, qty }) => ({ line, qty })),
          reason: reasonFrom(form),
        }),
      });
      if (res.status === 401) return location.assign('/staff/signed-out/');
      if (!res.ok) {
        const problem = (await res.json().catch(() => ({}))) as { detail?: string };
        statusEl.textContent = problem.detail ?? 'The refund could not be saved. Try again.';
        yes.disabled = false;
        return;
      }
      const { amountCents } = (await res.json()) as { amountCents: number };
      form.hidden = true;
      statusEl.textContent = `Refunded ${usd.format(amountCents / 100)}. Give ${usd.format(amountCents / 100)} in cash back to the customer.`;
    } catch {
      statusEl.textContent = "Couldn't reach the server. Check the connection and try again.";
      yes.disabled = false;
    }
  });
}

// Ready: the buttons start disabled so nothing submits before this script runs.
document.querySelectorAll<HTMLButtonElement>('[data-needs-script]').forEach((b) => {
  b.disabled = false;
});
