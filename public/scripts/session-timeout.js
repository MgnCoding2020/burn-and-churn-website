// Staff session timeout warning (src/components/staff/SessionTimeout.astro, ADR-0028).
// Times come from the server as milliseconds left and are tracked with
// performance.now(), so a wrong device clock can't shift them. The server stays
// the authority: before warning or leaving, the page asks it again, because
// another tab may have kept the session alive. External file so the CSP holds.

(() => {
  const dialog = document.getElementById('session-timeout');
  if (!(dialog instanceof HTMLDialogElement) || typeof dialog.showModal !== 'function') return;

  const WARN_MS = 2 * 60 * 1000;
  const STATUS_URL = '/api/v1/staff/session';
  const EXTEND_URL = '/api/v1/staff/session/extend';
  const LOGOUT_URL = '/api/v1/auth/staff/logout';
  const SIGNED_OUT_URL = '/staff/signed-out/';

  const status = dialog.querySelector('[data-timeout-status]');
  const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

  let endsAt = 0; // performance.now() value when the session ends
  let ending = 'idle'; // which limit ends it first: 'idle' or 'absolute'
  let timer = 0;

  function set(times) {
    ending = times.absoluteMsLeft <= times.idleMsLeft ? 'absolute' : 'idle';
    endsAt = performance.now() + Math.min(times.idleMsLeft, times.absoluteMsLeft);
  }

  /** The server's view: times, 'signed-out', or null if it couldn't be reached. */
  async function ask(url, method = 'GET') {
    try {
      const res = await fetch(url, {
        method,
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      if (res.status === 401 || res.status === 403) return 'signed-out';
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  }

  async function leave() {
    clearTimeout(timer);
    // Best effort: clears the cookie. The session has already ended on the server.
    try {
      await fetch(LOGOUT_URL, { method: 'POST', credentials: 'same-origin', redirect: 'manual' });
    } catch {
      /* the server already treats the session as ended */
    }
    location.assign(SIGNED_OUT_URL);
  }

  function show() {
    for (const part of dialog.querySelectorAll('[data-timeout-variant]')) {
      part.hidden = part.dataset.timeoutVariant !== ending;
    }
    dialog.setAttribute('aria-describedby', `session-timeout-${ending}`);
    const at = clock.format(new Date(Date.now() + Math.max(0, endsAt - performance.now())));
    for (const el of dialog.querySelectorAll('[data-timeout-at]')) el.textContent = at;
    if (!dialog.open) {
      status.textContent = '';
      dialog.showModal();
    }
  }

  function plan() {
    clearTimeout(timer);
    const left = endsAt - performance.now();
    if (left <= 0) {
      expire();
    } else if (left > WARN_MS) {
      if (dialog.open) dialog.close();
      timer = setTimeout(refresh, left - WARN_MS);
    } else {
      show();
      timer = setTimeout(expire, left);
    }
  }

  // Before warning: has another tab kept the session alive?
  async function refresh() {
    const times = await ask(STATUS_URL);
    if (times === 'signed-out') return leave();
    if (times) set(times);
    plan();
  }

  // At the deadline: leave, unless the server says there's time left.
  async function expire() {
    const times = await ask(STATUS_URL);
    if (times && times !== 'signed-out' && Math.min(times.idleMsLeft, times.absoluteMsLeft) > 0) {
      set(times);
      return plan();
    }
    leave();
  }

  async function stay() {
    const times = await ask(EXTEND_URL, 'POST');
    if (times === 'signed-out') return leave();
    if (!times) {
      status.textContent = "Couldn't reach the server. Check the connection and try again.";
      return;
    }
    set(times);
    plan();
  }

  dialog.querySelector('[data-timeout-stay]').addEventListener('click', stay);
  dialog.querySelector('[data-timeout-close]').addEventListener('click', () => dialog.close());
  // Escape is a sign the person is there: it keeps them signed in. At the
  // 8-hour limit there's nothing to extend, so it just closes the notice.
  dialog.addEventListener('cancel', (event) => {
    if (ending === 'idle') {
      event.preventDefault();
      stay();
    }
  });
  // Timers are slowed in background tabs; check again when the tab comes back.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });

  const initial = {
    idleMsLeft: Number(dialog.dataset.idleMsLeft),
    absoluteMsLeft: Number(dialog.dataset.absoluteMsLeft),
  };
  if (!Number.isFinite(initial.idleMsLeft) || !Number.isFinite(initial.absoluteMsLeft)) return;
  set(initial);
  plan();
})();
