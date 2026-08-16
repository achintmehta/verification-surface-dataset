import './style.css';
import {
  fetchEvents,
  createEvent,
  updateEvent,
  deleteEvent,
} from './api.js';
import { layoutDay } from './layout.js';
import {
  startOfWeek,
  startOfDay,
  addDays,
  addWeeks,
  isSameDay,
  dayName,
  formatDateHeader,
  formatWeekRange,
  formatTime,
  dateFromDayMinutes,
  toDatetimeLocalValue,
  fromDatetimeLocalValue,
} from './dates.js';

const HOUR_HEIGHT = 48; // px per hour
const AXIS_HEIGHT = HOUR_HEIGHT * 24; // total vertical height of the day axis
const SNAP_MINUTES = 15; // drag snapping granularity

const state = {
  weekStart: startOfWeek(new Date()),
  events: [], // [{id, title, start: Date, end: Date}]
};

const app = document.getElementById('app');

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function loadWeek() {
  const weekStart = state.weekStart;
  const weekEnd = addDays(weekStart, 7);
  const raw = await fetchEvents(weekStart.toISOString(), weekEnd.toISOString());
  state.events = raw.map((e) => ({
    id: e.id,
    title: e.title,
    start: new Date(e.start_at),
    end: new Date(e.end_at),
  }));
  render();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  app.innerHTML = '';
  app.appendChild(renderToolbar());

  const calendar = document.createElement('div');
  calendar.className = 'calendar';

  calendar.appendChild(renderHeaderRow());

  const body = document.createElement('div');
  body.className = 'calendar-body';
  body.appendChild(renderTimeGutter());

  const grid = document.createElement('div');
  grid.className = 'days-grid';
  for (let i = 0; i < 7; i++) {
    grid.appendChild(renderDayColumn(i));
  }
  body.appendChild(grid);
  calendar.appendChild(body);

  app.appendChild(calendar);
}

function renderToolbar() {
  const bar = document.createElement('div');
  bar.className = 'toolbar';

  const nav = document.createElement('div');
  nav.className = 'nav';

  const prev = button('‹ Prev', () => {
    state.weekStart = addWeeks(state.weekStart, -1);
    loadWeek();
  });
  const today = button('Today', () => {
    state.weekStart = startOfWeek(new Date());
    loadWeek();
  });
  const next = button('Next ›', () => {
    state.weekStart = addWeeks(state.weekStart, 1);
    loadWeek();
  });
  nav.append(prev, today, next);

  const title = document.createElement('h1');
  title.className = 'week-title';
  title.textContent = formatWeekRange(state.weekStart);

  const newBtn = button('+ New event', () => {
    const day = startOfDay(new Date());
    // Default to current week's first day if "today" not in this week.
    const base = isInWeek(day) ? day : state.weekStart;
    const start = dateFromDayMinutes(base, 9 * 60);
    const end = dateFromDayMinutes(base, 10 * 60);
    openForm({ mode: 'create', start, end });
  });
  newBtn.classList.add('primary');

  bar.append(nav, title, newBtn);
  return bar;
}

function isInWeek(date) {
  const ws = state.weekStart;
  const we = addDays(ws, 7);
  return date >= ws && date < we;
}

function button(label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function renderHeaderRow() {
  const row = document.createElement('div');
  row.className = 'header-row';

  const corner = document.createElement('div');
  corner.className = 'gutter-corner';
  row.appendChild(corner);

  const today = startOfDay(new Date());
  for (let i = 0; i < 7; i++) {
    const date = addDays(state.weekStart, i);
    const cell = document.createElement('div');
    cell.className = 'day-header';
    if (isSameDay(date, today)) cell.classList.add('is-today');

    const name = document.createElement('div');
    name.className = 'day-name';
    name.textContent = dayName(i);

    const num = document.createElement('div');
    num.className = 'day-date';
    num.textContent = formatDateHeader(date);

    cell.append(name, num);
    row.appendChild(cell);
  }
  return row;
}

function renderTimeGutter() {
  const gutter = document.createElement('div');
  gutter.className = 'time-gutter';
  gutter.style.height = `${AXIS_HEIGHT}px`;

  for (let h = 0; h <= 24; h++) {
    const label = document.createElement('div');
    label.className = 'hour-label';
    label.style.top = `${h * HOUR_HEIGHT}px`;
    label.textContent = h === 24 ? '24:00' : `${String(h).padStart(2, '0')}:00`;
    gutter.appendChild(label);
  }
  return gutter;
}

function renderDayColumn(dayIndex) {
  const dayStart = addDays(state.weekStart, dayIndex);
  const col = document.createElement('div');
  col.className = 'day-column';
  col.style.height = `${AXIS_HEIGHT}px`;

  const today = startOfDay(new Date());
  if (isSameDay(dayStart, today)) col.classList.add('is-today');

  // Hour grid lines.
  for (let h = 0; h <= 24; h++) {
    const line = document.createElement('div');
    line.className = 'hour-line';
    if (h === 24) line.classList.add('last');
    line.style.top = `${h * HOUR_HEIGHT}px`;
    col.appendChild(line);
  }

  // Event blocks via the layout engine.
  const dayEvents = state.events.filter((ev) =>
    overlapsDay(ev, dayStart)
  );
  const placed = layoutDay(dayEvents, dayStart);

  for (const block of placed) {
    col.appendChild(renderEventBlock(block, dayStart));
  }

  attachDragCreate(col, dayStart);

  return col;
}

function overlapsDay(ev, dayStart) {
  const dayEnd = addDays(dayStart, 1);
  return ev.start < dayEnd && ev.end > dayStart;
}

function renderEventBlock(block, dayStart) {
  const { event, topFrac, heightFrac, leftFrac, widthFrac } = block;

  const el = document.createElement('div');
  el.className = 'event';

  // Vertical geometry: exact, to the minute, against the axis height.
  el.style.top = `${topFrac * AXIS_HEIGHT}px`;
  el.style.height = `${heightFrac * AXIS_HEIGHT}px`;

  // Horizontal geometry: fraction of the day-column width, with a tiny gutter.
  const GUTTER = 2; // px
  el.style.left = `calc(${leftFrac * 100}% + ${GUTTER}px)`;
  el.style.width = `calc(${widthFrac * 100}% - ${GUTTER * 2}px)`;

  const titleEl = document.createElement('div');
  titleEl.className = 'event-title';
  titleEl.textContent = event.title;

  const timeEl = document.createElement('div');
  timeEl.className = 'event-time';
  timeEl.textContent = `${formatTime(event.start)} – ${formatTime(event.end)}`;

  el.append(titleEl, timeEl);
  el.title = `${event.title}\n${formatTime(event.start)} – ${formatTime(event.end)}`;

  el.addEventListener('click', (e) => {
    e.stopPropagation();
    openForm({ mode: 'edit', event });
  });

  return el;
}

// ---------------------------------------------------------------------------
// Drag-to-create
// ---------------------------------------------------------------------------

function attachDragCreate(col, dayStart) {
  let dragging = false;
  let startMin = 0;
  let ghost = null;
  let moved = false;

  function minutesAt(clientY) {
    const rect = col.getBoundingClientRect();
    let y = clientY - rect.top;
    y = Math.max(0, Math.min(AXIS_HEIGHT, y));
    const minutes = (y / AXIS_HEIGHT) * 24 * 60;
    return Math.round(minutes / SNAP_MINUTES) * SNAP_MINUTES;
  }

  col.addEventListener('mousedown', (e) => {
    // Only start a drag on empty space (not on an event block).
    if (e.target.closest('.event')) return;
    if (e.button !== 0) return;
    dragging = true;
    moved = false;
    startMin = minutesAt(e.clientY);

    ghost = document.createElement('div');
    ghost.className = 'event ghost';
    col.appendChild(ghost);
    updateGhost(startMin, startMin);
    e.preventDefault();
  });

  function updateGhost(a, b) {
    const top = Math.min(a, b);
    const bottom = Math.max(a, b);
    ghost.style.top = `${(top / (24 * 60)) * AXIS_HEIGHT}px`;
    ghost.style.height = `${((bottom - top) / (24 * 60)) * AXIS_HEIGHT}px`;
    ghost.style.left = '2px';
    ghost.style.right = '2px';
    ghost.style.width = 'auto';
  }

  function onMove(e) {
    if (!dragging) return;
    moved = true;
    const cur = minutesAt(e.clientY);
    updateGhost(startMin, cur);
  }

  function onUp(e) {
    if (!dragging) return;
    dragging = false;
    const endMin = minutesAt(e.clientY);
    if (ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost);
    ghost = null;

    let a = Math.min(startMin, endMin);
    let b = Math.max(startMin, endMin);

    // A plain click (no real drag) becomes a default 1-hour event.
    if (!moved || b - a < SNAP_MINUTES) {
      a = startMin;
      b = Math.min(24 * 60, a + 60);
      if (b <= a) {
        a = b - 60;
      }
    }

    const start = dateFromDayMinutes(dayStart, a);
    const end = dateFromDayMinutes(dayStart, b);
    openForm({ mode: 'create', start, end });
  }

  col.addEventListener('mousemove', onMove);
  // Use window for mouseup so releasing outside the column still works.
  window.addEventListener('mouseup', onUp);
}

// ---------------------------------------------------------------------------
// Create / Edit form (modal)
// ---------------------------------------------------------------------------

function openForm(opts) {
  const { mode } = opts;
  const isEdit = mode === 'edit';
  const event = opts.event;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'modal';

  const h = document.createElement('h2');
  h.textContent = isEdit ? 'Edit event' : 'New event';

  const form = document.createElement('form');

  const titleField = labeledInput('Title', 'text');
  titleField.input.value = isEdit ? event.title : '';
  titleField.input.required = true;

  const startField = labeledInput('Start', 'datetime-local');
  const endField = labeledInput('End', 'datetime-local');
  startField.input.value = toDatetimeLocalValue(
    isEdit ? event.start : opts.start
  );
  endField.input.value = toDatetimeLocalValue(isEdit ? event.end : opts.end);

  const errorEl = document.createElement('div');
  errorEl.className = 'form-error';
  errorEl.style.display = 'none';

  const actions = document.createElement('div');
  actions.className = 'modal-actions';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.className = 'primary';
  saveBtn.textContent = 'Save';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', close);

  actions.append(saveBtn, cancelBtn);

  if (isEdit) {
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'danger';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', async () => {
      try {
        await deleteEvent(event.id);
        close();
        await loadWeek();
      } catch (err) {
        showError(err.message);
      }
    });
    actions.appendChild(delBtn);
  }

  form.append(
    titleField.wrapper,
    startField.wrapper,
    endField.wrapper,
    errorEl,
    actions
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = titleField.input.value.trim();
    const start = fromDatetimeLocalValue(startField.input.value);
    const end = fromDatetimeLocalValue(endField.input.value);

    // Client-side guardrails (server still validates and may return 400).
    if (!title) return showError('Title must not be empty.');
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return showError('Please provide valid start and end times.');
    }
    if (end.getTime() <= start.getTime()) {
      return showError('End time must be after start time.');
    }

    const payload = {
      title,
      start_at: start.toISOString(),
      end_at: end.toISOString(),
    };

    try {
      if (isEdit) {
        await updateEvent(event.id, payload);
      } else {
        await createEvent(payload);
      }
      close();
      await loadWeek();
    } catch (err) {
      showError(err.message);
    }
  });

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.style.display = 'block';
  }

  function close() {
    document.body.removeChild(overlay);
    document.removeEventListener('keydown', onKey);
  }

  function onKey(e) {
    if (e.key === 'Escape') close();
  }

  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', onKey);

  modal.append(h, form);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  titleField.input.focus();
}

function labeledInput(labelText, type) {
  const wrapper = document.createElement('label');
  wrapper.className = 'field';
  const span = document.createElement('span');
  span.textContent = labelText;
  const input = document.createElement('input');
  input.type = type;
  wrapper.append(span, input);
  return { wrapper, input };
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

loadWeek().catch((err) => {
  app.innerHTML = `<div class="fatal">Failed to load calendar: ${err.message}</div>`;
});
