import { toDatetimeLocal } from './dates.js';

/**
 * Open the event form modal.
 *
 * mode: 'create' | 'edit'
 * initial: { id?, title, start (Date), end (Date) }
 * handlers: { onSave({title, start, end}), onDelete(id) }
 */
export function openEventModal(mode, initial, handlers) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';

  const modal = document.createElement('div');
  modal.className = 'modal';

  const errorEl = document.createElement('div');
  errorEl.className = 'error';

  modal.innerHTML = `
    <h2>${mode === 'create' ? 'New event' : 'Edit event'}</h2>
    <div class="field">
      <label for="ev-title">Title</label>
      <input id="ev-title" type="text" autocomplete="off" />
    </div>
    <div class="field">
      <label for="ev-start">Start</label>
      <input id="ev-start" type="datetime-local" />
    </div>
    <div class="field">
      <label for="ev-end">End</label>
      <input id="ev-end" type="datetime-local" />
    </div>
  `;
  modal.appendChild(errorEl);

  const actions = document.createElement('div');
  actions.className = 'actions';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'primary';
  saveBtn.textContent = 'Save';

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';

  actions.appendChild(saveBtn);

  if (mode === 'edit') {
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'danger';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', async () => {
      try {
        await handlers.onDelete(initial.id);
        close();
      } catch (err) {
        showError(err.message);
      }
    });
    actions.appendChild(deleteBtn);
  }

  const spacer = document.createElement('div');
  spacer.className = 'spacer';
  actions.appendChild(spacer);
  actions.appendChild(cancelBtn);

  modal.appendChild(actions);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  const titleInput = modal.querySelector('#ev-title');
  const startInput = modal.querySelector('#ev-start');
  const endInput = modal.querySelector('#ev-end');

  titleInput.value = initial.title || '';
  startInput.value = toDatetimeLocal(initial.start);
  endInput.value = toDatetimeLocal(initial.end);

  function showError(msg) {
    errorEl.textContent = msg;
  }

  function close() {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  }

  function onKey(e) {
    if (e.key === 'Escape') close();
  }

  async function save() {
    showError('');
    const title = titleInput.value.trim();
    const start = new Date(startInput.value);
    const end = new Date(endInput.value);
    if (!title) {
      return showError('Title is required.');
    }
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return showError('Start and end times are required.');
    }
    if (!(end.getTime() > start.getTime())) {
      return showError('End must be after start.');
    }
    try {
      await handlers.onSave({ id: initial.id, title, start, end });
      close();
    } catch (err) {
      showError(err.message);
    }
  }

  saveBtn.addEventListener('click', save);
  cancelBtn.addEventListener('click', close);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener('keydown', onKey);

  setTimeout(() => titleInput.focus(), 0);
}
