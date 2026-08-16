// modal.js — create/edit event form.
import {
  toDatetimeLocalValue,
  fromDatetimeLocalValue,
} from './dates.js';

/**
 * Open the event modal.
 *
 * @param {object} opts
 * @param {'create'|'edit'} opts.mode
 * @param {object} [opts.event]  existing event { id, title, start_at, end_at }
 * @param {Date}   [opts.start]  default start (create mode)
 * @param {Date}   [opts.end]    default end (create mode)
 * @param {(data)=>Promise} opts.onSave  receives { title, start_at, end_at }
 * @param {(id)=>Promise} [opts.onDelete]
 */
export function openModal(opts) {
  const { mode, event, start, end, onSave, onDelete } = opts;

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';

  const initialStart = event ? new Date(event.start_at) : start;
  const initialEnd = event ? new Date(event.end_at) : end;
  const initialTitle = event ? event.title : '';

  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `
    <h2>${mode === 'create' ? 'New event' : 'Edit event'}</h2>
    <label for="ev-title">Title</label>
    <input id="ev-title" type="text" autocomplete="off" />
    <label for="ev-start">Start</label>
    <input id="ev-start" type="datetime-local" />
    <label for="ev-end">End</label>
    <input id="ev-end" type="datetime-local" />
    <div class="error" id="ev-error"></div>
    <div class="actions">
      ${mode === 'edit' ? '<button type="button" class="danger" id="ev-delete">Delete</button>' : ''}
      <span class="spacer"></span>
      <button type="button" id="ev-cancel">Cancel</button>
      <button type="button" class="primary" id="ev-save">Save</button>
    </div>
  `;

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  const titleInput = modal.querySelector('#ev-title');
  const startInput = modal.querySelector('#ev-start');
  const endInput = modal.querySelector('#ev-end');
  const errorEl = modal.querySelector('#ev-error');

  titleInput.value = initialTitle;
  startInput.value = toDatetimeLocalValue(initialStart);
  endInput.value = toDatetimeLocalValue(initialEnd);

  titleInput.focus();
  titleInput.select();

  function close() {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  }

  function onKey(e) {
    if (e.key === 'Escape') close();
  }
  document.addEventListener('keydown', onKey);

  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });

  async function save() {
    errorEl.textContent = '';
    const title = titleInput.value.trim();
    const startDate = fromDatetimeLocalValue(startInput.value);
    const endDate = fromDatetimeLocalValue(endInput.value);

    if (!title) {
      errorEl.textContent = 'Title must not be empty.';
      return;
    }
    if (!startDate || !endDate) {
      errorEl.textContent = 'Please provide valid start and end times.';
      return;
    }
    if (!(endDate.getTime() > startDate.getTime())) {
      errorEl.textContent = 'End time must be after start time.';
      return;
    }

    try {
      await onSave({
        title,
        start_at: startDate.toISOString(),
        end_at: endDate.toISOString(),
      });
      close();
    } catch (err) {
      errorEl.textContent = err.message || 'Failed to save event.';
    }
  }

  modal.querySelector('#ev-save').addEventListener('click', save);
  modal.querySelector('#ev-cancel').addEventListener('click', close);

  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
      e.preventDefault();
      save();
    }
  });

  const deleteBtn = modal.querySelector('#ev-delete');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', async () => {
      errorEl.textContent = '';
      try {
        await onDelete(event.id);
        close();
      } catch (err) {
        errorEl.textContent = err.message || 'Failed to delete event.';
      }
    });
  }
}
