// Publish from SharePoint (src/pages/staff/publish.astro, ADR-0039): run the sync
// now, then reload to show the result. Bundled as an external file (strict CSP).

const statusEl = document.querySelector<HTMLElement>('[data-publish-status]')!;
const form = document.querySelector<HTMLFormElement>('[data-publish]');
const button = form?.querySelector<HTMLButtonElement>('button');

if (form && button) {
  button.disabled = false;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    button.disabled = true;
    statusEl.textContent = 'Publishing…';
    void (async () => {
      try {
        const res = await fetch('/api/v1/staff/sharepoint/publish', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { Accept: 'application/json' },
        });
        if (res.status === 401) {
          location.assign('/staff/signed-out/');
          return;
        }
        if (!res.ok) {
          const problem = (await res.json().catch(() => ({}))) as { detail?: string };
          statusEl.textContent = problem.detail ?? 'Publishing failed. Try again.';
          button.disabled = false;
          return;
        }
        location.reload();
      } catch {
        statusEl.textContent = "Couldn't reach the server. Check the connection and try again.";
        button.disabled = false;
      }
    })();
  });
}

export {};
