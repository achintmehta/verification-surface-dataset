import './style.css';
import { computeLayout } from './layout.js';
import {
  fetchEvents,
  createEvent,
  updateEvent,
  deleteEvent,
} from './api.js';
import {
  startOfWeek,
  addDays,
  startOfDay,
  isSameDay,
  minutesFromDayStart,
  MINUTES_PER_DAY,
  formatTime,
  toDatetimeLocal,
  fromDatetimeLocal,
  weekdayLabel,
  formatWeekRange,
  formatDayHeaderDate,
} from './dates.js';

const HOUR_HEIGHT = 48; // px per hour
const AXIS_HEIGHT = HOUR_HEIGHT * 24; // total grid height (1px per 1.25min)
const PX_PER_MINUTE = AXIS_HEIGHT / MINUTES_PER_DAY;
const SNAP_MINUTES = 15;

const state = {
  weekStart: startOfWeek(new Date()),
  events: [],
};

const app = document.getElementById('app');

function minuteToPx(min) {
  return min * PX_PER_MINUTE;
}

function snap(min) {
  return Math.round(min / SNAP_MINUTES) * SNAP_MINUTES;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  app.innerHTML = '';

  const header = buildHeader();
  app.appendChild(header);

  const grid = buildGrid();
  app.appendChild(grid);
}

function buildHeader() {
  const bar = document.createElement('div');
  bar.className = 'toolbar';

  const nav = document.createElement('div');
  nav.className = 'nav';

  const prev = button('‹ Prev', () => {
    state.weekStart = addDays(state.weekStart, -7);
    load();
  });
  const today = button('Today', () => {
    state.weekStart = startOfWeek(new Date());
    load();
  });
  const next = button('Next ›', () => {
    state.weekStart = addDays(state.weekStart, 7);
    load();
  });

  nav.append(prev, today, next);

  const title = document.createElement('h1');
  title.className = 'week-title';
  title.textContent = formatWeekRange(state.weekStart);

  bar.append(nav, title);
  return bar;
}

function button(label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function buildGrid() {
  const wrapper = document.createElement('div');
  wrapper.className = 'calendar';

  // Column headers row
  const headRow = document.createElement('div');
  headRow.className = 'grid-head';

  const corner = document.createElement('div');
  corner.className = 'corner';
  headRow.appendChild(corner);

  const now = new Date();
  for (let i = 0; i < 7; i++) {
    const day = addDays(state.weekStart, i);
    const cell = document.createElement('div');
    cell.className = 'day-head';
    if (isSameDay(day, now)) cell.classList.add('today');
    cell.innerHTML = `
      <div class="day-name">${weekdayLabel(i)}</div>
      <div class="day-date">${formatDayHeaderDate(day)}</div>
    `;
    headRow.appendChild(cell);
  }
  wrapper.appendChild(headRow);

  // Scrollable body
  const body = document.createElement('div');
  body.className = 'grid-body';

  // Time axis (left gutter)
  const axis = document.createElement('div');
  axis.className = 'time-axis';
  axis.style.height = `${AXIS_HEIGHT}px`;
  for (let h = 0; h <= 24; h++) {
    const label = document.createElement('div');
    label.className = 'hour-label';
    label.style.top = `${minuteToPx(h * 60)}px`;
    label.textContent = `${String(h).padStart(2, '0')}:00`;
    axis.appendChild(label);
  }
  body.appendChild(axis);

  // Day columns
  const columns = document.createElement('div');
  columns.className = 'day-columns';

  for (let i = 0; i < 7; i++) {
    const day = addDays(state.weekStart, i);
    const col = buildDayColumn(day);
    if (isSameDay(day, now)) col.classList.add('today-col');
    columns.appendChild(col);
  }
  body.appendChild(columns);
  wrapper.appendChild(body);

  return wrapper;
}

function buildDayColumn(day) {
  const dayStart = startOfDay(day);
  const dayEnd = addDays(dayStart, 1);

  const col = document.createElement('div');
  col.className = 'day-col';
  col.style.height = `${AXIS_HEIGHT}px`;

  // Hour grid lines
  for (let h = 0; h <= 24; h++) {
    const line = document.createElement('div');
    line.className = 'hour-line';
    line.style.top = `${minuteToPx(h * 60)}px`;
    col.appendChild(line);
  }

  // Events whose span intersects this day.
  const dayEvents = state.events
    .map((ev) => {
      const start = new Date(ev.start_at);
      const end = new Date(ev.end_at);
      return { ev, start, end };
    })
    .filter(({ start, end }) => start < dayEnd && end > dayStart)
    .map(({ ev, start, end }) => ({
      ev,
      start,
      end,
      // minutes clamped to this day for geometry & overlap
      startMin: minutesFromDayStart(start, dayStart),
      endMin: minutesFromDayStart(end, dayStart),
    }));

  const layoutInput = dayEvents.map((d) => ({
    start: d.startMin,
    end: d.endMin,
    ref: d,
  }));
  const layout = computeLayout(layoutInput);

  for (const item of layoutInput) {
    const { columnIndex, columnCount } = layout.get(item);
    const d = item.ref;
    const block = buildEventBlock(d, columnIndex, columnCount);
    col.appendChild(block);
  }

  enableRangeSelection(col, dayStart);

  return col;
}

function buildEventBlock(d, columnIndex, columnCount) {
  const top = minuteToPx(d.startMin);
  const height = Math.max(minuteToPx(d.endMin - d.startMin), 12);
  const widthPct = 100 / columnCount;
  const leftPct = columnIndex * widthPct;

  const block = document.createElement('div');
  block.className = 'event';
  block.style.top = `${top}px`;
  block.style.height = `${height}px`;
  block.style.left = `${leftPct}%`;
  block.style.width = `calc(${widthPct}% - 2px)`;

  const timeLabel = `${formatTime(d.start)}–${formatTime(d.end)}`;
  block.innerHTML = `
    <div class="event-title">${escapeHtml(d.ev.title)}</div>
    <div class="event-time">${timeLabel}</div>
  `;
  block.title = `${d.ev.title}\n${timeLabel}`;

  block.addEventListener('click', (e) => {
    e.stopPropagation();
    openEditForm(d.ev);
  });

  return block;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Range selection (create)
// ---------------------------------------------------------------------------

function enableRangeSelection(col, dayStart) {
  let dragging = false;
  let startY = 0;
  let selEl = null;

  function yToMinutes(clientY) {
    const rect = col.getBoundingClientRect();
    const y = clientY - rect.top + col.scrollTop;
    const min = (y / AXIS_HEIGHT) * MINUTES_PER_DAY;
    return Math.max(0, Math.min(MINUTES_PER_DAY, min));
  }

  col.addEventListener('mousedown', (e) => {
    if (e.target !== col && !e.target.classList.contains('hour-line')) return;
    dragging = true;
    startY = yToMinutes(e.clientY);
    selEl = document.createElement('div');
    selEl.className = 'selection';
    col.appendChild(selEl);
    updateSelection(startY, startY);
    e.preventDefault();
  });

  function updateSelection(a, b) {
    const top = Math.min(a, b);
    const bottom = Math.max(a, b);
    selEl.style.top = `${minuteToPx(top)}px`;
    selEl.style.height = `${minuteToPx(bottom - top)}px`;
  }

  function onMove(e) {
    if (!dragging) return;
    updateSelection(startY, yToMinutes(e.clientY));
  }

  function onUp(e) {
    if (!dragging) return;
    dragging = false;
    const endY = yToMinutes(e.clientY);
    if (selEl) {
      selEl.remove();
      selEl = null;
    }
    let a = snap(Math.min(startY, endY));
    let b = snap(Math.max(startY, endY));
    if (b - a < SNAP_MINUTES) {
      // Treat as a click: default 1-hour slot.
      b = Math.min(a + 60, MINUTES_PER_DAY);
      if (b - a < SNAP_MINUTES) a = Math.max(0, b - 60);
    }
    const start = new Date(dayStart.getTime() + a * 60000);
    const end = new Date(dayStart.getTime() + b * 60000);
    openCreateForm(start, end);
  }

  col.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

// ---------------------------------------------------------------------------
// Forms (modal)
// ---------------------------------------------------------------------------

function openCreateForm(start, end) {
  showModal({
    heading: 'New event',
    title: '',
    start,
    end,
    onSave: async (payload) => {
      await createEvent(payload);
      await load();
    },
  });
}

function openEditForm(ev) {
  showModal({
    heading: 'Edit event',
    title: ev.title,
    start: new Date(ev.start_at),
    end: new Date(ev.end_at),
    onSave: async (payload) => {
      await updateEvent(ev.id, payload);
      await load();
    },
    onDelete: async () => {
      await deleteEvent(ev.id);
      await load();
    },
  });
}

function showModal({ heading, title, start, end, onSave, onDelete }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `
    <h2>${heading}</h2>
    <label>Title
      <input type="text" name="title" value="${escapeHtml(title)}" />
    </label>
    <label>Start
      <input type="datetime-local" name="start" value="${toDatetimeLocal(start)}" />
    </label>
    <label>End
      <input type="datetime-local" name="end" value="${toDatetimeLocal(end)}" />
    </label>
    <div class="form-error" role="alert"></div>
    <div class="modal-actions">
      ${onDelete ? '<button type="button" class="danger" data-act="delete">Delete</button>' : '<span></span>'}
      <div>
        <button type="button" data-act="cancel">Cancel</button>
        <button type="button" class="primary" data-act="save">Save</button>
      </div>
    </div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const titleInput = modal.querySelector('input[name="title"]');
  const startInput = modal.querySelector('input[name="start"]');
  const endInput = modal.querySelector('input[name="end"]');
  const errorBox = modal.querySelector('.form-error');

  titleInput.focus();

  function close() {
    overlay.remove();
  }

  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close();
  });

  modal.querySelector('[data-act="cancel"]').addEventListener('click', close);

  modal.querySelector('[data-act="save"]').addEventListener('click', async () => {
    errorBox.textContent = '';
    const t = titleInput.value.trim();
    const s = fromDatetimeLocal(startInput.value);
    const en = fromDatetimeLocal(endInput.value);
    if (!t) {
      errorBox.textContent = 'Title must not be empty.';
      return;
    }
    if (isNaN(s.getTime()) || isNaN(en.getTime())) {
      errorBox.textContent = 'Please provide valid start and end times.';
      return;
    }
    if (!(en.getTime() > s.getTime())) {
      errorBox.textContent = 'End time must be after start time.';
      return;
    }
    try {
      await onSave({
        title: t,
        start_at: s.toISOString(),
        end_at: en.toISOString(),
      });
      close();
    } catch (err) {
      errorBox.textContent = err.message || 'Failed to save event.';
    }
  });

  if (onDelete) {
    modal.querySelector('[data-act="delete"]').addEventListener('click', async () => {
      try {
        await onDelete();
        close();
      } catch (err) {
        errorBox.textContent = err.message || 'Failed to delete event.';
      }
    });
  }

  window.addEventListener(
    'keydown',
    function onKey(e) {
      if (e.key === 'Escape') {
        close();
        window.removeEventListener('keydown', onKey);
      }
    }
  );
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function load() {
  render(); // render grid immediately (shows nav/headers)
  const weekEnd = addDays(state.weekStart, 7);
  try {
    state.events = await fetchEvents(
      state.weekStart.toISOString(),
      weekEnd.toISOString()
    );
  } catch (err) {
    console.error('Failed to load events', err);
    state.events = [];
  }
  render();
}

load();
