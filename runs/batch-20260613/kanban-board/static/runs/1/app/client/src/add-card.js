/**
 * Add-card form handler.
 *
 * Uses event delegation on the board element to handle clicks on
 * "Add a card" buttons and form submissions.
 */

import { createCard } from './api.js';

/**
 * Attach add-card event listeners to the board container.
 * Must be called after the board has been rendered.
 */
export function initAddCard() {
  const board = document.getElementById('board');

  board.addEventListener('click', (e) => {
    /* ---- Open form -------------------------------------------- */
    const addBtn = e.target.closest('.add-card-btn');
    if (addBtn) {
      const columnId = addBtn.dataset.columnId;
      openForm(columnId);
      return;
    }

    /* ---- Submit form ------------------------------------------ */
    const submitBtn = e.target.closest('.btn-primary');
    if (submitBtn) {
      const form = submitBtn.closest('.add-card-form');
      if (form) {
        submitForm(form);
        return;
      }
    }

    /* ---- Cancel form ------------------------------------------ */
    const cancelBtn = e.target.closest('.btn-cancel');
    if (cancelBtn) {
      const form = cancelBtn.closest('.add-card-form');
      if (form) {
        closeForm(form);
        return;
      }
    }
  });

  // Allow Ctrl+Enter / Cmd+Enter to submit, Escape to cancel.
  board.addEventListener('keydown', (e) => {
    const textarea = e.target.closest('.add-card-textarea');
    if (!textarea) return;

    const form = textarea.closest('.add-card-form');
    if (!form) return;

    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      submitForm(form);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeForm(form);
    }
  });
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

/** @param {string} columnId */
function openForm(columnId) {
  // Close any other open forms first.
  document.querySelectorAll('.add-card-form.visible').forEach(closeForm);

  const form = document.querySelector(`.add-card-form[data-column-id="${columnId}"]`);
  const btn  = document.querySelector(`.add-card-btn[data-column-id="${columnId}"]`);
  if (!form || !btn) return;

  btn.style.display = 'none';
  form.classList.add('visible');

  const textarea = form.querySelector('.add-card-textarea');
  if (textarea) {
    textarea.value = '';
    textarea.focus();
  }
}

/** @param {HTMLElement} form */
function closeForm(form) {
  form.classList.remove('visible');
  const columnId = form.dataset.columnId;
  const btn = document.querySelector(`.add-card-btn[data-column-id="${columnId}"]`);
  if (btn) btn.style.display = '';
}

/** @param {HTMLElement} form */
async function submitForm(form) {
  const textarea = form.querySelector('.add-card-textarea');
  const text = textarea?.value?.trim();
  if (!text) return;

  const columnId = form.dataset.columnId;

  // Disable the form while the request is in flight.
  const submitBtn = form.querySelector('.btn-primary');
  if (submitBtn) submitBtn.disabled = true;

  try {
    await createCard(columnId, text);
    // The SSE event will add the card to the DOM; just close the form.
    closeForm(form);
  } catch (err) {
    console.error('[add-card] createCard failed:', err);
    alert(`Failed to create card: ${err.message}`);
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}
