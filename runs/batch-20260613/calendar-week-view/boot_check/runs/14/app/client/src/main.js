import './style.css';
import * as api from './api.js';
import { layoutDayEvents } from './layout.js';
import {
  startOfWeek,
  addDays,
  addWeeks,
  isSameDay,
  minutesIntoDay,
  clamp,
  weekdayLabel,
  formatHour,
  formatTimeRange,
  formatClock,
  toDatetimeLocal,
  fromDatetimeLocal,
  formatWeekRange,
} from './dates.js';

// --- Geometry constants ----------------------------------------------------
const HOUR_HEIGHT = 48; // px per hour
const TOTAL_MINUTES = 24 * 60;
const GRID_HEIGHT = HOUR_HEIGHT * 24; // px for full day

const minToPx = (min) => (min / 60) * HOUR_HEIGHT;

// --- App state -------------------------------------------------------------
const state = {
  weekStart: startOfWeek(new Date()),
  events: [], // raw events from API: {id, title, start_at, end_at}
};

const app = document.getElementById('app');

// =========================================================================
// Rendering
// =========================================================================

function render() {
  app.innerHTML = '';
  app.appendChild(renderToolbar());
  app.appendChild(renderGrid());
}

function renderToolbar() {
  const bar = el('div', 'toolbar');

  const nav = el('div', 'nav');
  const prev = button('\u2039 Prev', () => navigate(-1));
  const today = button('Today', () => {
    state.weekStart = startOfWeek(new Date());
    loadAndRender();
  });
  const next = button('Next \u203a', () => navigate(1));
  nav.append(prev, today, next);

  const title = el('div', 'week-range');
  title.textContent = formatWeekRange(state.weekStart);

  bar.append(nav, title);
  return bar;
}

function navigate(delta) {
  state.weekStart = addWeeks(state.weekStart, delta);
  loadAndRender();
}

function renderGrid() {
  const wrap = el('div', 'calendar');

  // Header row: empty corner + 7 day headers
  const header = el('div', 'grid-header');
  header.appendChild(el('div', 'corner'));
  const today = new Date();
  for (let i = 0; i < 7; i++) {
    const day = addDays(state.weekStart, i);
    const h = el('div', 'day-header');
    if (isSameDay(day, today)) h.classList.add('today');
    const name = el('span', 'dh-name');
    name.textContent = weekdayLabel(i);
    const date = el('span', 'dh-date');
    date.textContent = day.getDate();
    h.append(name, date);
    header.appendChild(h);
  }
  wrap.appendChild(header);

  // Scroll body: time axis + 7 day columns
  const body = el('div', 'grid-body');

  const axis = el('div', 'time-axis');
  axis.style.height = `${GRID_HEIGHT}px`;
  for (let h = 0; h <= 24; h++) {
    const label = el('div', 'hour-label');
    label.style.top = `${h * HOUR_HEIGHT}px`;
    label.textContent = h === 24 ? '24:00' : formatHour(h);
    axis.appendChild(label);
  }
  body.appendChild(axis);

  const cols = el('div', 'day-columns');
  for (let i = 0; i < 7; i++) {
    const dayStart = addDays(state.weekStart, i);
    cols.appendChild(renderDayColumn(dayStart, i));
  }
  body.appendChild(cols);

  wrap.appendChild(body);
  return wrap;
}

function renderDayColumn(dayStart, dayIndex) {
  const col = el('div', 'day-column');
  col.style.height = `${GRID_HEIGHT}px`;
  const today = new Date();
  if (isSameDay(dayStart, today)) col.classList.add('today-col');

  // Hour gridlines
  for (let h = 0; h <= 24; h++) {
    const line = el('div', 'hour-line');
    line.style.top = `${h * HOUR_HEIGHT}px`;
    col.appendChild(line);
  }

  // Events for this day
  const dayEnd = addDays(dayStart, 1);
  const dayEvents = [];
  for (const ev of state.events) {
    const s = new Date(ev.start_at);
    const e = new Date(ev.end_at);
    // include events overlapping this day
    if (s < dayEnd && e > dayStart) {
      const startMin = clamp(minutesIntoDay(s, dayStart), 0, TOTAL_MINUTES);
      const endMin = clamp(minutesIntoDay(e, dayStart), 0, TOTAL_MINUTES);
      dayEvents.push({
        id: ev.id,
        title: ev.title,
        raw: ev,
        startMin,
        endMin,
      });
    }
  }

  const laid = layoutDayEvents(dayEvents);
  for (const ev of laid) {
    col.appendChild(renderEventBlock(ev));
  }

  // Drag-to-create interaction
  attachDragCreate(col, dayStart);

  return col;
}

function renderEventBlock(ev) {
  const top = minToPx(ev.startMin);
  const height = Math.max(minToPx(ev.endMin - ev.startMin), 1);

  const block = el('div', 'event');
  block.style.top = `${top}px`;
  block.style.height = `${height}px`;
  block.style.left = `calc(${ev.left * 100}% + 1px)`;
  block.style.width = `calc(${ev.width * 100}% - 2px)`;

  const titleEl = el('div', 'event-title');
  titleEl.textContent = ev.title;
  const timeEl = el('div', 'event-time');
  timeEl.textContent = formatTimeRange(
    new Date(ev.raw.start_at),
    new Date(ev.raw.end_at)
  );
  block.append(titleEl, timeEl);

  block.addEventListener('mousedown', (e) => e.stopPropagation());
  block.addEventListener('click', (e) => {
    e.stopPropagation();
    openEditForm(ev.raw);
  });

  return block;
}

// =========================================================================
// Drag-to-create
// =========================================================================

function attachDragCreate(col, dayStart) {
  let dragging = false;
  let startY = 0;
  let ghost = null;

  const snapMinutes = (y) => {
    const min = (y / GRID_HEIGHT) * TOTAL_MINUTES;
    return clamp(Math.round(min / 15) * 15, 0, TOTAL_MINUTES);
  };

  const localY = (e) => {
    const rect = col.getBoundingClientRect();
    return clamp(e.clientY - rect.top, 0, GRID_HEIGHT);
  };

  col.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    startY = localY(e);
    ghost = el('div', 'event ghost');
    ghost.style.top = `${startY}px`;
    ghost.style.height = '0px';
    ghost.style.left = '1px';
    ghost.style.right = '1px';
    col.appendChild(ghost);
    e.preventDefault();
  });

  const onMove = (e) => {
    if (!dragging) return;
    const y = localY(e);
    const top = Math.min(startY, y);
    const height = Math.abs(y - startY);
    ghost.style.top = `${top}px`;
    ghost.style.height = `${height}px`;
  };

  const onUp = (e) => {
    if (!dragging) return;
    dragging = false;
    const y = localY(e);
    let m1 = snapMinutes(Math.min(startY, y));
    let m2 = snapMinutes(Math.max(startY, y));
    if (ghost) {
      ghost.remove();
      ghost = null;
    }
    // A plain click (no real drag) -> default 1-hour slot.
    if (m2 - m1 < 15) {
      m2 = clamp(m1 + 60, 0, TOTAL_MINUTES);
      if (m2 === m1) m1 = clamp(m2 - 60, 0, TOTAL_MINUTES);
    }
    const start = new Date(dayStart);
    start.setMinutes(m1);
    const end = new Date(dayStart);
    end.setMinutes(m2);
    openCreateForm(start, end);
  };

  col.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

// =========================================================================
// Forms (modal)
// =========================================================================

function openCreateForm(start, end) {
  openForm({
    mode: 'create',
    title: '',
    start,
    end,
  });
}

function openEditForm(rawEvent) {
  openForm({
    mode: 'edit',
    id: rawEvent.id,
    title: rawEvent.title,
    start: new Date(rawEvent.start_at),
    end: new Date(rawEvent.end_at),
  });
}

function openForm(opts) {
  closeModal();

  const overlay = el('div', 'modal-overlay');
  const modal = el('div', 'modal');

  const heading = el('h2', 'modal-title');
  heading.textContent = opts.mode === 'create' ? 'New event' : 'Edit event';

  const errorBox = el('div', 'form-error');
  errorBox.style.display = 'none';

  const form = el('form', 'event-form');

  const titleInput = inputField(form, 'Title', 'text', opts.title);
  const startInput = inputField(
    form,
    'Start',
    'datetime-local',
    toDatetimeLocal(opts.start)
  );
  const endInput = inputField(
    form,
    'End',
    'datetime-local',
    toDatetimeLocal(opts.end)
  );

  const actions = el('div', 'form-actions');
  const saveBtn = el('button', 'btn primary');
  saveBtn.type = 'submit';
  saveBtn.textContent = 'Save';
  const cancelBtn = el('button', 'btn');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', closeModal);
  actions.append(saveBtn, cancelBtn);

  if (opts.mode === 'edit') {
    const delBtn = el('button', 'btn danger');
    delBtn.type = 'button';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', async () => {
      try {
        await api.deleteEvent(opts.id);
        closeModal();
        await loadAndRender();
      } catch (err) {
        showError(errorBox, err.message);
      }
    });
    actions.appendChild(delBtn);
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = titleInput.value.trim();
    const start = fromDatetimeLocal(startInput.value);
    const end = fromDatetimeLocal(endInput.value);

    if (title === '') {
      return showError(errorBox, 'Title must not be empty.');
    }
    if (!start || !end) {
      return showError(errorBox, 'Start and end must be valid date-times.');
    }
    if (!(end.getTime() > start.getTime())) {
      return showError(errorBox, 'End must be after start.');
    }

    const payload = {
      title,
      start_at: start.toISOString(),
      end_at: end.toISOString(),
    };

    try {
      if (opts.mode === 'create') {
        await api.createEvent(payload);
      } else {
        await api.updateEvent(opts.id, payload);
      }
      closeModal();
      await loadAndRender();
    } catch (err) {
      showError(errorBox, err.message);
    }
  });

  modal.append(heading, errorBox, form);
  form.appendChild(actions);
  overlay.appendChild(modal);
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) closeModal();
  });
  document.body.appendChild(overlay);
  titleInput.focus();
}

function showError(box, msg) {
  box.textContent = msg;
  box.style.display = 'block';
}

function closeModal() {
  const existing = document.querySelector('.modal-overlay');
  if (existing) existing.remove();
}

// =========================================================================
// Helpers
// =========================================================================

function inputField(form, labelText, type, value) {
  const wrap = el('label', 'field');
  const span = el('span', 'field-label');
  span.textContent = labelText;
  const input = document.createElement('input');
  input.type = type;
  input.value = value;
  if (type === 'datetime-local') input.step = '60';
  wrap.append(span, input);
  form.appendChild(wrap);
  return input;
}

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function button(label, onClick) {
  const b = el('button', 'btn');
  b.type = 'button';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

// =========================================================================
// Data loading
// =========================================================================

async function loadAndRender() {
  render(); // render grid immediately (with current events)
  try {
    const weekEnd = addDays(state.weekStart, 7);
    const events = await api.fetchEvents(
      state.weekStart.toISOString(),
      weekEnd.toISOString()
    );
    state.events = events;
    render();
  } catch (err) {
    console.error('Failed to load events:', err);
    state.events = [];
    render();
    const banner = el('div', 'error-banner');
    banner.textContent = `Could not load events: ${err.message}`;
    app.prepend(banner);
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});

loadAndRender();
