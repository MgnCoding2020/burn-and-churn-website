// Fallback for browsers without invoker commands (command / commandfor on
// <button>). Current browsers open and close the menu dialogs natively and
// never run the code below. External file so the CSP (script-src 'self') holds.

if (!('commandForElement' in HTMLButtonElement.prototype)) {
  document.addEventListener('click', (event) => {
    const button =
      event.target instanceof Element ? event.target.closest('button[commandfor]') : null;
    if (!button) return;
    const dialog = document.getElementById(button.getAttribute('commandfor'));
    if (!(dialog instanceof HTMLDialogElement)) return;
    const command = button.getAttribute('command');
    if (command === 'show-modal' && !dialog.open) dialog.showModal();
    if (command === 'close' && dialog.open) dialog.close();
  });
}
