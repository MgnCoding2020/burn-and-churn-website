// Reads a ReasonPicker's fields (src/components/staff/ReasonPicker.astro) and
// makes the note required while Other is chosen. The server checks the same.

/** The reason in a form, shaped for the API: `{ code, note? }`. */
export function reasonFrom(form: HTMLFormElement): { code: string; note?: string } {
  const data = new FormData(form);
  const code = String(data.get('reasonCode') ?? '');
  const note = String(data.get('reasonNote') ?? '').trim();
  return note ? { code, note } : { code };
}

document.addEventListener('change', (event) => {
  const select = event.target as HTMLSelectElement | null;
  if (select?.name !== 'reasonCode') return;
  const note = select
    .closest('[data-reason]')
    ?.querySelector<HTMLInputElement>('[name="reasonNote"]');
  if (note) note.required = select.value === 'other';
});
