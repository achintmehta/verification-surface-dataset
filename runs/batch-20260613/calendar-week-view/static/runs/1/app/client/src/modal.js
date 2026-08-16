/**
 * Modal dialog for creating and editing events.
 *
 * Usage:
 *   openCreateModal({ start_at, end_at }, onSave)
 *   openEditModal(event, onSave, onDelete)
 */

import { toDatetimeLocal, fromDatetimeLocal } from './week.js';

let activeModal = null;

/**
 * Open the "create event" modal.
 * @param {{ start_at: string, end_at: string }} defaults
 * @param {(payload: object) => Promise<void>} onSave
 */
export function openCreateModal(defaults, onSave) {
  closeModal();
  const modal = buildModal({
    title:    'New Event',
    event:    { title: '', start_at: defaults.start_at, end_at: defaults.end_at },
    saveLabel: 'Create',
    showDelete: false,
    onSave,
    onDelete: null,
  });
  document.body.appendChild(modal);
  activeModal = modal;
  modal.querySelector('input[name="title"]').focus();
}

/**
 * Open the "edit event" modal.
 * @param {object} event
 * @param {(payload: object) => Promise<void>} onSave
 * @param {() => Promise<void>} onDelete
 */
export function openEditModal(event, onSave, onDelete) {
  closeModal();
  const modal = buildModal({
    title:     'Edit Event',
    event,
    saveLabel: 'Save',
    showDelete: true,
    onSave,
    onDelete,
  });
  document.body.appendChild(modal);
  activeModal = modal;
  modal.querySelector('input[name="title"]').focus();
}

export function closeModal() {
  if (activeModal) {
    activeModal.remove();
    activeModal = null;
  }
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function buildModal({ title, event, saveLabel, showDelete, onSave, onDelete }) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';

  const startDate = new Date(event.start_at);
  const endDate   = new Date(event.end_at);

  backdrop.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-label="${title}">
      <h2>${title}</h2>
      <div class="form-group">
        <label for="ev-title">Title</label>
        <input id="ev-title" name="title" type="text" value="${escHtml(event.title)}"
               placeholder="Event title" autocomplete="off" />
      </div>
      <div class="form-group">
        <label for="ev-start">Start</label>
        <input id="ev-start" name="start_at" type="datetime-local"
               value="${toDatetimeLocal(startDate)}" step="60" />
      </div>
      <div class="form-group">
        <label for="ev-end">End</label>
        <input id="ev-end" name="end_at" type="datetime-local"
               value="${toDatetimeLocal(endDate)}" step="60" />
      </div>
      <div class="form-error" role="alert"></div>
      <div class="modal-actions">
        ${showDelete ? '<button type="button" class="btn-danger-outline js-delete">Delete</button>' : ''}
        <button type="button" class="btn js-cancel">Cancel</button>
        <button type="button" class="btn btn-primary js-save">${saveLabel}</button>
      </div>
    </div>
  `;

  const modal     = backdrop.querySelector('.modal');
  const errorEl   = backdrop.querySelector('.form-error');
  const titleInput = backdrop.querySelector('input[name="title"]');
  const startInput = backdrop.querySelector('input[name="start_at"]');
  const endInput   = backdrop.querySelector('input[name="end_at"]');

  // Close on backdrop click (outside modal)
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeModal();
  });

  // Cancel
  backdrop.querySelector('.js-cancel').addEventListener('click', closeModal);

  // Escape key
  const onKeyDown = (e) => {
    if (e.key === 'Escape') closeModal();
  };
  document.addEventListener('keydown', onKeyDown);
  // Clean up listener when modal is removed
  const observer = new MutationObserver(() => {
    if (!document.body.contains(backdrop)) {
      document.removeEventListener('keydown', onKeyDown);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true });

  // Save
  backdrop.querySelector('.js-save').addEventListener('click', async () => {
    const titleVal = titleInput.value.trim();
    const startVal = startInput.value;
    const endVal   = endInput.value;

    // Client-side validation
    if (!titleVal) {
      showError(errorEl, 'Title is required.');
      titleInput.focus();
      return;
    }
    if (!startVal || !endVal) {
      showError(errorEl, 'Start and end times are required.');
      return;
    }
    const startDt = fromDatetimeLocal(startVal);
    const endDt   = fromDatetimeLocal(endVal);
    if (isNaN(startDt.getTime()) || isNaN(endDt.getTime())) {
      showError(errorEl, 'Invalid date/time.');
      return;
    }
    if (endDt <= startDt) {
      showError(errorEl, 'End time must be after start time.');
      endInput.focus();
      return;
    }

    const saveBtn = backdrop.querySelector('.js-save');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    clearError(errorEl);

    try {
      await onSave({
        title:    titleVal,
        start_at: startDt.toISOString(),
        end_at:   endDt.toISOString(),
      });
      closeModal();
    } catch (err) {
      showError(errorEl, err.message ?? 'Failed to save event.');
      saveBtn.disabled = false;
      saveBtn.textContent = saveLabel;
    }
  });

  // Delete
  if (showDelete) {
    backdrop.querySelector('.js-delete').addEventListener('click', async () => {
      const deleteBtn = backdrop.querySelector('.js-delete');
      deleteBtn.disabled = true;
      deleteBtn.textContent = 'Deleting…';
      clearError(errorEl);
      try {
        await onDelete();
        closeModal();
      } catch (err) {
        showError(errorEl, err.message ?? 'Failed to delete event.');
        deleteBtn.disabled = false;
        deleteBtn.textContent = 'Delete';
      }
    });
  }

  return backdrop;
}

function showError(el, msg) {
  el.textContent = msg;
}

function clearError(el) {
  el.textContent = '';
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
