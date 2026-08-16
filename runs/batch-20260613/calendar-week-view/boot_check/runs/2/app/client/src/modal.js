/**
 * Modal dialog for creating and editing events.
 */

import { toDatetimeLocal } from './layout.js';

/**
 * Show a modal for creating a new event.
 * @param {{ start: Date, end: Date }} prefill
 * @param {function(data): Promise<void>} onSave
 */
export function showCreateModal(prefill, onSave) {
  const modal = buildModal({
    title: 'New Event',
    initialTitle: '',
    initialStart: prefill.start,
    initialEnd:   prefill.end,
    showDelete: false,
    onSave,
    onDelete: null,
  });
  document.body.appendChild(modal);
  modal.querySelector('#modal-title-input').focus();
}

/**
 * Show a modal for editing an existing event.
 * @param {{ id: number, title: string, start_at: string, end_at: string }} event
 * @param {function(data): Promise<void>} onSave
 * @param {function(): Promise<void>} onDelete
 */
export function showEditModal(event, onSave, onDelete) {
  const modal = buildModal({
    title: 'Edit Event',
    initialTitle: event.title,
    initialStart: new Date(event.start_at),
    initialEnd:   new Date(event.end_at),
    showDelete: true,
    onSave,
    onDelete,
  });
  document.body.appendChild(modal);
  modal.querySelector('#modal-title-input').focus();
}

function buildModal({ title, initialTitle, initialStart, initialEnd, showDelete, onSave, onDelete }) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';

  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');

  modal.innerHTML = `
    <h2>${escHtml(title)}</h2>
    <div class="form-group">
      <label for="modal-title-input">Title</label>
      <input id="modal-title-input" type="text" placeholder="Event title" value="${escHtml(initialTitle)}" autocomplete="off" />
    </div>
    <div class="form-group">
      <label for="modal-start-input">Start</label>
      <input id="modal-start-input" type="datetime-local" value="${toDatetimeLocal(initialStart)}" />
    </div>
    <div class="form-group">
      <label for="modal-end-input">End</label>
      <input id="modal-end-input" type="datetime-local" value="${toDatetimeLocal(initialEnd)}" />
    </div>
    <div class="form-error" id="modal-error"></div>
    <div class="modal-actions">
      ${showDelete ? '<button class="btn-danger" id="modal-delete-btn">Delete</button>' : ''}
      <button class="btn-secondary" id="modal-cancel-btn">Cancel</button>
      <button class="btn-primary" id="modal-save-btn">Save</button>
    </div>
  `;

  backdrop.appendChild(modal);

  const titleInput = modal.querySelector('#modal-title-input');
  const startInput = modal.querySelector('#modal-start-input');
  const endInput   = modal.querySelector('#modal-end-input');
  const errorEl    = modal.querySelector('#modal-error');
  const saveBtn    = modal.querySelector('#modal-save-btn');
  const cancelBtn  = modal.querySelector('#modal-cancel-btn');
  const deleteBtn  = modal.querySelector('#modal-delete-btn');

  function close() {
    backdrop.remove();
  }

  function showError(msg) {
    errorEl.textContent = msg;
  }

  function clearError() {
    errorEl.textContent = '';
  }

  async function handleSave() {
    clearError();
    const titleVal = titleInput.value.trim();
    const startVal = startInput.value;
    const endVal   = endInput.value;

    if (!titleVal) {
      showError('Title is required.');
      titleInput.focus();
      return;
    }
    if (!startVal) {
      showError('Start time is required.');
      return;
    }
    if (!endVal) {
      showError('End time is required.');
      return;
    }

    const startDate = new Date(startVal);
    const endDate   = new Date(endVal);

    if (isNaN(startDate.getTime())) {
      showError('Invalid start time.');
      return;
    }
    if (isNaN(endDate.getTime())) {
      showError('Invalid end time.');
      return;
    }
    if (endDate <= startDate) {
      showError('End time must be after start time.');
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';

    try {
      await onSave({
        title:    titleVal,
        start_at: startDate.toISOString(),
        end_at:   endDate.toISOString(),
      });
      close();
    } catch (err) {
      showError(err.message || 'Failed to save event.');
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
    }
  }

  async function handleDelete() {
    if (!confirm('Delete this event?')) return;
    deleteBtn.disabled = true;
    try {
      await onDelete();
      close();
    } catch (err) {
      showError(err.message || 'Failed to delete event.');
      deleteBtn.disabled = false;
    }
  }

  saveBtn.addEventListener('click', handleSave);
  cancelBtn.addEventListener('click', close);
  if (deleteBtn) deleteBtn.addEventListener('click', handleDelete);

  // Close on backdrop click
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });

  // Close on Escape
  function onKeyDown(e) {
    if (e.key === 'Escape') {
      close();
      document.removeEventListener('keydown', onKeyDown);
    }
  }
  document.addEventListener('keydown', onKeyDown);

  // Submit on Enter in title field
  titleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleSave();
  });

  return backdrop;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
