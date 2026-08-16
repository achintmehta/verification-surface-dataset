import { toDatetimeLocal, fromDatetimeLocal, formatTime } from './dates.js';
import { createEvent, updateEvent, deleteEvent } from './api.js';
import { showToast } from './toast.js';

let backdrop = null;

function closeModal() {
  if (backdrop) {
    backdrop.remove();
    backdrop = null;
  }
}

function createBackdrop() {
  const el = document.createElement('div');
  el.className = 'modal-backdrop';
  el.addEventListener('click', e => {
    if (e.target === el) closeModal();
  });
  document.body.appendChild(el);
  return el;
}

function createModalEl(title) {
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `<h2>${title}</h2>`;
  return modal;
}

function addFormGroup(form, id, label, type, value) {
  const group = document.createElement('div');
  group.className = 'form-group';
  group.innerHTML = `
    <label for="${id}">${label}</label>
    <input type="${type}" id="${id}" name="${id}" value="${value ?? ''}" />
  `;
  form.appendChild(group);
  return group.querySelector('input');
}

function showError(input, msg) {
  input.classList.add('error');
  let errEl = input.parentElement.querySelector('.error-msg');
  if (!errEl) {
    errEl = document.createElement('div');
    errEl.className = 'error-msg';
    input.parentElement.appendChild(errEl);
  }
  errEl.textContent = msg;
}

function clearError(input) {
  input.classList.remove('error');
  const errEl = input.parentElement.querySelector('.error-msg');
  if (errEl) errEl.remove();
}

/**
 * Open the "Create Event" modal.
 *
 * @param {{ start: Date, end: Date }} prefill
 * @param {function} onSaved  — called with the new event object after save
 */
export function openCreateModal({ start, end }, onSaved) {
  closeModal();
  backdrop = createBackdrop();

  const modal = createModalEl('New Event');
  const form  = document.createElement('form');
  form.addEventListener('submit', e => e.preventDefault());

  const titleInput = addFormGroup(form, 'title', 'Title', 'text', '');
  titleInput.placeholder = 'Event title';
  titleInput.autofocus = true;

  const startInput = addFormGroup(form, 'start_at', 'Start', 'datetime-local', toDatetimeLocal(start));
  const endInput   = addFormGroup(form, 'end_at',   'End',   'datetime-local', toDatetimeLocal(end));

  const actions = document.createElement('div');
  actions.className = 'modal-actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.type = 'button';
  cancelBtn.addEventListener('click', closeModal);

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn btn-primary';
  saveBtn.textContent = 'Create';
  saveBtn.type = 'submit';

  actions.append(cancelBtn, saveBtn);
  modal.append(form, actions);
  backdrop.appendChild(modal);

  // Focus title
  setTimeout(() => titleInput.focus(), 50);

  async function handleSave() {
    let valid = true;

    clearError(titleInput);
    clearError(startInput);
    clearError(endInput);

    const title    = titleInput.value.trim();
    const startVal = startInput.value;
    const endVal   = endInput.value;

    if (!title) {
      showError(titleInput, 'Title is required');
      valid = false;
    }
    if (!startVal) {
      showError(startInput, 'Start time is required');
      valid = false;
    }
    if (!endVal) {
      showError(endInput, 'End time is required');
      valid = false;
    }
    if (valid && new Date(endVal) <= new Date(startVal)) {
      showError(endInput, 'End must be after start');
      valid = false;
    }
    if (!valid) return;

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';

    try {
      const event = await createEvent({
        title,
        start_at: fromDatetimeLocal(startVal).toISOString(),
        end_at:   fromDatetimeLocal(endVal).toISOString(),
      });
      closeModal();
      onSaved(event);
      showToast('Event created');
    } catch (err) {
      showToast(err.message || 'Failed to create event', 'error');
      saveBtn.disabled = false;
      saveBtn.textContent = 'Create';
    }
  }

  saveBtn.addEventListener('click', handleSave);
  form.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleSave();
    if (e.key === 'Escape') closeModal();
  });
}

/**
 * Open the "Edit Event" modal.
 *
 * @param {object} event      — the event to edit
 * @param {function} onSaved  — called with the updated event after save
 * @param {function} onDeleted — called with the event id after delete
 */
export function openEditModal(event, onSaved, onDeleted) {
  closeModal();
  backdrop = createBackdrop();

  const modal = createModalEl('Edit Event');
  const form  = document.createElement('form');
  form.addEventListener('submit', e => e.preventDefault());

  const titleInput = addFormGroup(form, 'title', 'Title', 'text', event.title);
  const startInput = addFormGroup(form, 'start_at', 'Start', 'datetime-local',
    toDatetimeLocal(new Date(event.start_at)));
  const endInput   = addFormGroup(form, 'end_at',   'End',   'datetime-local',
    toDatetimeLocal(new Date(event.end_at)));

  const actions = document.createElement('div');
  actions.className = 'modal-actions-split';

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn btn-danger';
  deleteBtn.textContent = 'Delete';
  deleteBtn.type = 'button';

  const rightBtns = document.createElement('div');
  rightBtns.style.display = 'flex';
  rightBtns.style.gap = '8px';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.type = 'button';
  cancelBtn.addEventListener('click', closeModal);

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn btn-primary';
  saveBtn.textContent = 'Save';
  saveBtn.type = 'submit';

  rightBtns.append(cancelBtn, saveBtn);
  actions.append(deleteBtn, rightBtns);
  modal.append(form, actions);
  backdrop.appendChild(modal);

  setTimeout(() => titleInput.focus(), 50);

  async function handleSave() {
    let valid = true;

    clearError(titleInput);
    clearError(startInput);
    clearError(endInput);

    const title    = titleInput.value.trim();
    const startVal = startInput.value;
    const endVal   = endInput.value;

    if (!title) {
      showError(titleInput, 'Title is required');
      valid = false;
    }
    if (!startVal) {
      showError(startInput, 'Start time is required');
      valid = false;
    }
    if (!endVal) {
      showError(endInput, 'End time is required');
      valid = false;
    }
    if (valid && new Date(endVal) <= new Date(startVal)) {
      showError(endInput, 'End must be after start');
      valid = false;
    }
    if (!valid) return;

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';

    try {
      const updated = await updateEvent(event.id, {
        title,
        start_at: fromDatetimeLocal(startVal).toISOString(),
        end_at:   fromDatetimeLocal(endVal).toISOString(),
      });
      closeModal();
      onSaved(updated);
      showToast('Event updated');
    } catch (err) {
      showToast(err.message || 'Failed to update event', 'error');
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete "${event.title}"?`)) return;
    deleteBtn.disabled = true;
    deleteBtn.textContent = 'Deleting…';
    try {
      await deleteEvent(event.id);
      closeModal();
      onDeleted(event.id);
      showToast('Event deleted');
    } catch (err) {
      showToast(err.message || 'Failed to delete event', 'error');
      deleteBtn.disabled = false;
      deleteBtn.textContent = 'Delete';
    }
  }

  saveBtn.addEventListener('click', handleSave);
  deleteBtn.addEventListener('click', handleDelete);
  form.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleSave();
    if (e.key === 'Escape') closeModal();
  });
}
