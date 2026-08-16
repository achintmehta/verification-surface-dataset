import { layoutDay } from './layout.js';
import {
  fetchEvents,
  createEvent,
  updateEvent,
  deleteEvent,
} from './api.js';
import {
  MINUTES_PER_DAY,
  startOfWeek,
  addDays,
  addWeeks,
  isSameDay,
  minutesFromDayStart,
  dayName,
  formatDayHeader,
  formatWeekRange,
  formatMinutes,
  dateFromDayMinutes,
  toDatetimeLocalValue,
  fromDatetimeLocalValue,
} from './time.js';

// --- Geometry constants -----------------------------------------------------
// A single hour-row height in pixels. The entire day axis height is derived
// from this single constant so minute-precision placement is consistent.
const HOUR_HEIGHT = 48; // px per hour
const AXIS_HEIGHT = HOUR_HEIGHT * 24; // px for 00:00 -> 24:00
const PX_PER_MIN = AXIS_HEIGHT / MINUTES_PER_DAY;
// Snap drag selection to this many minutes.
const SNAP_MIN = 15;

const state = {
  weekStart: startOfWeek(new Date()),
  events: [], // raw events from API: {id, title, start_at, end_at}
};

const root = document.getElementById('app');

// ---------------------------------------------------------------------------
// Top-level render
// ---------------------------------------------------------------------------
function render() {
  root.innerHTML = '';
  root.appendChild(buildToolbar());
  root.appendChild(buildCalendar());
}

function buildToolbar() {
  const bar = el('header', 'toolbar');

  const nav = el('div', 'toolbar-nav');
  const prev = button('‹ Prev', () => navigate(-1));
  const today = button('Today', goToday);
  const next = button('Next ›', () => navigate(1));
  prev.classList.add('btn');
  today.classList.add('btn');
  next.classList.add('btn');
  nav.append(prev, today, next);

  const title = el('h1', 'toolbar-title');
  title.textContent = formatWeekRange(state.weekStart);

  const spacer = el('div', 'toolbar-spacer');

  bar.append(nav, title, spacer);
  return bar;
}

function navigate(delta) {
  state.weekStart = addWeeks(state.weekStart, delta);
  loadAndRender();
}

function goToday() {
  state.weekStart = startOfWeek(new Date());
  loadAndRender();
}

// ---------------------------------------------------------------------------
// Calendar grid
// ---------------------------------------------------------------------------
function buildCalendar() {
  const calendar = el('div', 'calendar');

  // Header row: empty corner + 7 day headers.
  const header = el('div', 'cal-header');
  header.appendChild(el('div', 'time-gutter-head'));
  const today = new Date();
  for (let i = 0; i < 7; i++) {
    const date = addDays(state.weekStart, i);
    const cell = el('div', 'day-head');
    if (isSameDay(date, today)) cell.classList.add('is-today');
    const name = el('span', 'day-head-name');
    name.textContent = dayName(i);
    const dnum = el('span', 'day-head-date');
    dnum.textContent = formatDayHeader(date);
    cell.append(name, dnum);
    header.appendChild(cell);
  }
  calendar.appendChild(header);

  // Body: scrollable area containing the time gutter + 7 day columns.
  const body = el('div', 'cal-body');

  const gutter = el('div', 'time-gutter');
  gutter.style.height = `${AXIS_HEIGHT}px`;
  for (let h = 0; h <= 24; h++) {
    const label = el('div', 'hour-label');
    label.style.top = `${h * HOUR_HEIGHT}px`;
    label.textContent = `${String(h).padStart(2, '0')}:00`;
    gutter.appendChild(label);
  }
  body.appendChild(gutter);

  const grid = el('div', 'days-grid');
  grid.style.height = `${AXIS_HEIGHT}px`;
  for (let i = 0; i < 7; i++) {
    grid.appendChild(buildDayColumn(i, today));
  }
  body.appendChild(grid);

  calendar.appendChild(body);
  return calendar;
}

function buildDayColumn(dayIndex, today) {
  const dayStart = addDays(state.weekStart, dayIndex);
  const col = el('div', 'day-col');
  col.style.height = `${AXIS_HEIGHT}px`;
  if (isSameDay(dayStart, today)) col.classList.add('is-today');

  // Hour grid lines.
  for (let h = 1; h < 24; h++) {
    const line = el('div', 'hour-line');
    line.style.top = `${h * HOUR_HEIGHT}px`;
    col.appendChild(line);
  }

  // Events for this day.
  const dayEvents = eventsForDay(dayStart);
  const placements = layoutDay(
    dayEvents.map((e) => ({ id: e.id, startMin: e._startMin, endMin: e._endMin }))
  );
  const byId = new Map(dayEvents.map((e) => [e.id, e]));

  for (const p of placements) {
    const ev = byId.get(p.id);
    col.appendChild(buildEventBlock(ev, p));
  }

  // Drag-to-create interaction on empty space.
  attachDragCreate(col, dayStart);

  return col;
}

/**
 * Returns events overlapping [dayStart, dayStart+1day), each annotated with
 * clamped minute offsets _startMin / _endMin within the day.
 */
function eventsForDay(dayStart) {
  const dayEnd = addDays(dayStart, 1);
  const out = [];
  for (const e of state.events) {
    const s = new Date(e.start_at);
    const en = new Date(e.end_at);
    // Overlaps this day?
    if (s < dayEnd && en > dayStart) {
      const startMin = clampMin(minutesFromDayStart(s, dayStart));
      const endMin = clampMin(minutesFromDayStart(en, dayStart));
      if (endMin > startMin) {
        out.push({ ...e, _startMin: startMin, _endMin: endMin });
      }
    }
  }
  return out;
}

function clampMin(m) {
  return Math.max(0, Math.min(MINUTES_PER_DAY, m));
}

function buildEventBlock(ev, placement) {
  const block = el('div', 'event-block');
  const top = placement.startMin * PX_PER_MIN;
  const height = (placement.endMin - placement.startMin) * PX_PER_MIN;

  block.style.top = `${top}px`;
  block.style.height = `${Math.max(height, 1)}px`;
  // Horizontal placement as fractions of the day column width. Widths within a
  // cluster sum to exactly 100% so the blocks together fill the column; a 1px
  // border between adjacent columns is provided by the block borders only.
  block.style.left = `${placement.left * 100}%`;
  block.style.width = `${placement.width * 100}%`;

  const title = el('div', 'event-title');
  title.textContent = ev.title;
  const time = el('div', 'event-time');
  time.textContent = `${formatMinutes(ev._startMin)} – ${formatMinutes(ev._endMin)}`;

  block.append(title, time);
  block.title = `${ev.title}\n${formatMinutes(ev._startMin)} – ${formatMinutes(ev._endMin)}`;

  block.addEventListener('click', (e) => {
    e.stopPropagation();
    openEditForm(ev);
  });

  return block;
}

// ---------------------------------------------------------------------------
// Drag-to-create
// ---------------------------------------------------------------------------
function attachDragCreate(col, dayStart) {
  let dragging = false;
  let startMin = 0;
  let ghost = null;

  const minutesAt = (clientY) => {
    const rect = col.getBoundingClientRect();
    const y = clientY - rect.top;
    let m = (y / PX_PER_MIN);
    m = Math.round(m / SNAP_MIN) * SNAP_MIN;
    return Math.max(0, Math.min(MINUTES_PER_DAY, m));
  };

  col.addEventListener('mousedown', (e) => {
    // Only start on empty area (not on an event block).
    if (e.target.closest('.event-block')) return;
    if (e.button !== 0) return;
    dragging = true;
    startMin = minutesAt(e.clientY);
    ghost = el('div', 'event-ghost');
    col.appendChild(ghost);
    updateGhost(ghost, startMin, startMin);
    e.preventDefault();
  });

  const onMove = (e) => {
    if (!dragging) return;
    const cur = minutesAt(e.clientY);
    updateGhost(ghost, Math.min(startMin, cur), Math.max(startMin, cur));
  };

  const onUp = (e) => {
    if (!dragging) return;
    dragging = false;
    const cur = minutesAt(e.clientY);
    let a = Math.min(startMin, cur);
    let b = Math.max(startMin, cur);
    if (ghost) {
      ghost.remove();
      ghost = null;
    }
    // A pure click (no real drag) defaults to a 60-minute event.
    if (b - a < SNAP_MIN) {
      b = Math.min(MINUTES_PER_DAY, a + 60);
      if (b === a) a = Math.max(0, b - 60);
    }
    const start = dateFromDayMinutes(dayStart, a);
    const end = dateFromDayMinutes(dayStart, b);
    openCreateForm(start, end);
  };

  col.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

function updateGhost(ghost, aMin, bMin) {
  ghost.style.top = `${aMin * PX_PER_MIN}px`;
  ghost.style.height = `${Math.max((bMin - aMin) * PX_PER_MIN, 2)}px`;
  ghost.textContent = `${formatMinutes(aMin)} – ${formatMinutes(bMin)}`;
}

// ---------------------------------------------------------------------------
// Create / edit modal form
// ---------------------------------------------------------------------------
function openCreateForm(start, end) {
  openForm({
    mode: 'create',
    title: '',
    start,
    end,
  });
}

function openEditForm(ev) {
  openForm({
    mode: 'edit',
    id: ev.id,
    title: ev.title,
    start: new Date(ev.start_at),
    end: new Date(ev.end_at),
  });
}

function openForm(opts) {
  closeForm();

  const overlay = el('div', 'modal-overlay');
  overlay.id = 'modal-overlay';

  const modal = el('div', 'modal');
  const h = el('h2', 'modal-title');
  h.textContent = opts.mode === 'create' ? 'New event' : 'Edit event';

  const form = el('form', 'event-form');

  const titleField = labeledInput('Title', 'text', opts.title);
  titleField.input.required = true;
  titleField.input.placeholder = 'Event title';

  const startField = labeledInput('Start', 'datetime-local', toDatetimeLocalValue(opts.start));
  const endField = labeledInput('End', 'datetime-local', toDatetimeLocalValue(opts.end));

  const errorBox = el('div', 'form-error');
  errorBox.style.display = 'none';

  const actions = el('div', 'form-actions');
  const saveBtn = el('button', 'btn btn-primary');
  saveBtn.type = 'submit';
  saveBtn.textContent = 'Save';

  const cancelBtn = el('button', 'btn');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', closeForm);

  actions.append(saveBtn);

  if (opts.mode === 'edit') {
    const delBtn = el('button', 'btn btn-danger');
    delBtn.type = 'button';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', async () => {
      try {
        await deleteEvent(opts.id);
        closeForm();
        await loadAndRender();
      } catch (err) {
        showError(errorBox, err.message);
      }
    });
    actions.append(delBtn);
  }
  actions.append(cancelBtn);

  form.append(
    titleField.wrap,
    startField.wrap,
    endField.wrap,
    errorBox,
    actions
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = titleField.input.value.trim();
    const start = fromDatetimeLocalValue(startField.input.value);
    const end = fromDatetimeLocalValue(endField.input.value);

    if (!title) return showError(errorBox, 'Title must not be empty.');
    if (!start || !end) return showError(errorBox, 'Start and end must be valid.');
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
        await createEvent(payload);
      } else {
        await updateEvent(opts.id, payload);
      }
      closeForm();
      await loadAndRender();
    } catch (err) {
      showError(errorBox, err.message);
    }
  });

  modal.append(h, form);
  overlay.appendChild(modal);
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) closeForm();
  });
  document.body.appendChild(overlay);
  titleField.input.focus();

  const onKey = (e) => {
    if (e.key === 'Escape') closeForm();
  };
  document.addEventListener('keydown', onKey);
  overlay._onKey = onKey;
}

function closeForm() {
  const existing = document.getElementById('modal-overlay');
  if (existing) {
    if (existing._onKey) document.removeEventListener('keydown', existing._onKey);
    existing.remove();
  }
}

function showError(box, msg) {
  box.textContent = msg;
  box.style.display = 'block';
}

function labeledInput(labelText, type, value) {
  const wrap = el('label', 'field');
  const span = el('span', 'field-label');
  span.textContent = labelText;
  const input = document.createElement('input');
  input.type = type;
  input.className = 'field-input';
  if (value != null) input.value = value;
  wrap.append(span, input);
  return { wrap, input };
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
async function loadAndRender() {
  render(); // render immediately for snappy navigation
  try {
    const weekEnd = addDays(state.weekStart, 7);
    const events = await fetchEvents(
      state.weekStart.toISOString(),
      weekEnd.toISOString()
    );
    state.events = Array.isArray(events) ? events : [];
  } catch (err) {
    console.error('Failed to load events:', err);
    state.events = [];
  }
  render();
}

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------
function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function button(text, onClick) {
  const b = document.createElement('button');
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

// Boot.
loadAndRender();
