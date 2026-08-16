/**
 * New-card dialog module.
 *
 * Manages the <dialog> element for creating cards.
 * On submit, calls the API and applies an optimistic update.
 */

import { createCard } from './api.js';

const dialog  = /** @type {HTMLDialogElement} */ (document.getElementById('new-card-dialog'));
const form    = /** @type {HTMLFormElement}   */ (document.getElementById('new-card-form'));
const textarea = /** @type {HTMLTextAreaElement} */ (document.getElementById('card-text'));
const cancelBtn = document.getElementById('dialog-cancel');

let activeColumnId = null;

/* ── Open / close ───────────────────────────────────────────────────── */

export function openNewCardDialog(columnId) {
  activeColumnId = columnId;
  textarea.value = '';
  dialog.showModal();
  textarea.focus();
}

cancelBtn.addEventListener('click', () => {
  dialog.close();
});

// Close on backdrop click
dialog.addEventListener('click', (e) => {
  if (e.target === dialog) dialog.close();
});

/* ── Submit ─────────────────────────────────────────────────────────── */

form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const text = textarea.value.trim();
  if (!text || !activeColumnId) return;

  const submitBtn = document.getElementById('dialog-submit');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Adding…';

  dialog.close();

  try {
    // The server will broadcast the card via SSE; we don't need to
    // manually upsert here — the SSE handler will do it.
    // However, for a snappier feel we could do an optimistic insert.
    // We'll let the SSE event drive the UI to keep things simple and
    // avoid duplicate-card edge cases.
    await createCard(activeColumnId, text);
  } catch (err) {
    console.error('[dialog] createCard failed:', err);
    alert(`Failed to create card: ${err.message}`);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Add Card';
  }
});
