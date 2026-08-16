// Modal form for creating / editing events.

import {
  toDatetimeLocalValue,
  fromDatetimeLocalValue,
} from './dates.js';

/**
 * Open an event editor modal.
 *
 * @param {object} opts
 * @param {'create'|'edit'} opts.mode
 * @param {{title?:string,start:Date,end:Date}} opts.initial
 * @param {(data:{title:string,start:Date,end:Date}) => Promise<void>} opts.onSubmit
 * @param {() => Promise<void>} [opts.onDelete]
 */
export function openEventModal({ mode, initial, onSubmit, onDelete }) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';

  const modal = document.createElement('div');
  modal.className = 'modal';
  backdrop.appendChild(modal);

  modal.innerHTML = `
    <h2>${mode === 'create' ? 'New event' : 'Edit event'}</h2>
    <form>
      <div class="field">
        <label for="ev-title">Title</label>
        <input id="ev-title" name="title" type="text" autocomplete="off" />
      </div>
      <div class="field">
        <label for="ev-start">Start</label>
        <input id="ev-start" name="start" type="datetime-local" />
      </div>
      <div class="field">
        <label for="ev-end">End</label>
        <input id="ev-end" name="end" type="datetime-local" />
      </div>
      <p class="error" data-role="error"></p>
      <div class="actions">
        ${mode === 'edit' ? '<button type="button" class="danger" data-role="delete">Delete</button>' : ''}
        <span class="spacer"></span>
        <button type="button" data-role="cancel">Cancel</button>
        <button type="submit" class="primary">${mode === 'create' ? 'Create' : 'Save'}</button>
      </div>
    </form>
  `;

  const form = modal.querySelector('form');
  const titleInput = modal.querySelector('#ev-title');
  const startInput = modal.querySelector('#ev-start');
  const endInput = modal.querySelector('#ev-end');
  const errorEl = modal.querySelector('[data-role="error"]');

  titleInput.value = initial.title || '';
  startInput.value = toDatetimeLocalValue(initial.start);
  endInput.value = toDatetimeLocalValue(initial.end);

  const close = () => {
    document.body.removeChild(backdrop);
    document.removeEventListener('keydown', onKey);
  };

  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);

  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });

  modal.querySelector('[data-role="cancel"]').addEventListener('click', close);

  const deleteBtn = modal.querySelector('[data-role="delete"]');
  if (deleteBtn && onDelete) {
    deleteBtn.addEventListener('click', async () => {
      deleteBtn.disabled = true;
      try {
        await onDelete();
        close();
      } catch (err) {
        errorEl.textContent = err.message || 'Failed to delete';
        deleteBtn.disabled = false;
      }
    });
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.textContent = '';
    const title = titleInput.value.trim();
    if (!title) {
      errorEl.textContent = 'Title is required.';
      return;
    }
    let start, end;
    try {
      start = fromDatetimeLocalValue(startInput.value);
      end = fromDatetimeLocalValue(endInput.value);
    } catch {
      errorEl.textContent = 'Please enter valid start and end times.';
      return;
    }
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      errorEl.textContent = 'Please enter valid start and end times.';
      return;
    }
    if (!(end.getTime() > start.getTime())) {
      errorEl.textContent = 'End time must be after start time.';
      return;
    }
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      await onSubmit({ title, start, end });
      close();
    } catch (err) {
      errorEl.textContent = err.message || 'Failed to save event.';
      submitBtn.disabled = false;
    }
  });

  document.body.appendChild(backdrop);
  titleInput.focus();
  titleInput.select();
}
