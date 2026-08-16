import {
  fetchEvents,
  createEvent,
  updateEvent,
  deleteEvent,
} from './api.js';
import { layoutDay, clampToDay, MINUTES_PER_DAY } from './layout.js';
import {
  startOfWeek,
  startOfDay,
  addDays,
  sameDay,
  DAY_LABELS,
  monthLabel,
  toLocalInputValue,
  fromLocalInputValue,
  formatTimeRange,
} from './dates.js';

// --- Geometry constants ------------------------------------------------------
const HOUR_HEIGHT = 48; // px per hour
const AXIS_HEIGHT = HOUR_HEIGHT * 24; // total height of the time axis
const PX_PER_MIN = AXIS_HEIGHT / MINUTES_PER_DAY;
const SNAP_MIN = 15; // snap drag selection to 15-minute increments

// --- State -------------------------------------------------------------------
const state = {
  weekStart: startOfWeek(new Date()),
  events: [],
};

const app = document.getElementById('app');

// =============================================================================
// Top-level render
// =============================================================================
function render() {
  app.innerHTML = '';
  app.appendChild(renderHeader());
  app.appendChild(renderGrid());
}

function weekRangeLabel() {
  const end = addDays(state.weekStart, 6);
  const startStr = `${monthLabel(state.weekStart.getMonth())} ${state.weekStart.getDate()}`;
  const endStr =
    state.weekStart.getMonth() === end.getMonth()
      ? `${end.getDate()}`
      : `${monthLabel(end.getMonth())} ${end.getDate()}`;
  return `${startStr} – ${endStr}, ${end.getFullYear()}`;
}

function renderHeader() {
  const header = document.createElement('div');
  header.className = 'toolbar';

  const title = document.createElement('h1');
  title.className = 'toolbar__title';
  title.textContent = 'Week Calendar';

  const range = document.createElement('div');
  range.className = 'toolbar__range';
  range.textContent = weekRangeLabel();

  const nav = document.createElement('div');
  nav.className = 'toolbar__nav';

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

  header.append(title, range, nav);
  return header;
}

function button(label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

// =============================================================================
// Grid
// =============================================================================
function renderGrid() {
  const grid = document.createElement('div');
  grid.className = 'calendar';

  // Header row: corner + 7 day headers
  const headRow = document.createElement('div');
  headRow.className = 'calendar__head';

  const corner = document.createElement('div');
  corner.className = 'calendar__corner';
  headRow.appendChild(corner);

  const today = new Date();
  for (let i = 0; i < 7; i++) {
    const day = addDays(state.weekStart, i);
    const cell = document.createElement('div');
    cell.className = 'dayhead';
    if (sameDay(day, today)) cell.classList.add('dayhead--today');
    cell.innerHTML =
      `<span class="dayhead__name">${DAY_LABELS[i]}</span>` +
      `<span class="dayhead__date">${day.getDate()}</span>`;
    headRow.appendChild(cell);
  }
  grid.appendChild(headRow);

  // Body: scrollable area with time axis + day columns
  const body = document.createElement('div');
  body.className = 'calendar__body';

  // Time axis (hour labels)
  const axis = document.createElement('div');
  axis.className = 'axis';
  axis.style.height = `${AXIS_HEIGHT}px`;
  for (let h = 0; h <= 24; h++) {
    const label = document.createElement('div');
    label.className = 'axis__hour';
    label.style.top = `${h * HOUR_HEIGHT}px`;
    label.textContent = h === 24 ? '24:00' : `${String(h).padStart(2, '0')}:00`;
    axis.appendChild(label);
  }
  body.appendChild(axis);

  // Day columns
  const columns = document.createElement('div');
  columns.className = 'columns';
  columns.style.height = `${AXIS_HEIGHT}px`;

  for (let i = 0; i < 7; i++) {
    const dayStart = addDays(state.weekStart, i);
    columns.appendChild(renderDayColumn(dayStart, sameDay(dayStart, today)));
  }
  body.appendChild(columns);

  grid.appendChild(body);
  return grid;
}

function renderDayColumn(dayStart, isToday) {
  const col = document.createElement('div');
  col.className = 'col';
  if (isToday) col.classList.add('col--today');
  col.style.height = `${AXIS_HEIGHT}px`;

  // Hour grid lines
  for (let h = 1; h < 24; h++) {
    const line = document.createElement('div');
    line.className = 'col__hourline';
    line.style.top = `${h * HOUR_HEIGHT}px`;
    col.appendChild(line);
  }

  // Build clamped items for this day, then layout.
  const items = [];
  for (const ev of state.events) {
    const clamped = clampToDay(ev, dayStart);
    if (clamped) {
      items.push({ event: ev, topMin: clamped.topMin, bottomMin: clamped.bottomMin });
    }
  }
  const placements = layoutDay(items);

  // Gap between side-by-side events, in fraction of column width.
  for (const p of placements) {
    col.appendChild(renderEventBlock(p));
  }

  // Interaction: click/drag on empty space to create.
  attachCreateInteraction(col, dayStart);

  return col;
}

function renderEventBlock(p) {
  const block = document.createElement('div');
  block.className = 'event';
  const top = p.topMin * PX_PER_MIN;
  const height = (p.bottomMin - p.topMin) * PX_PER_MIN;
  block.style.top = `${top}px`;
  block.style.height = `${height}px`;

  // Horizontal: leave a small inner gap between adjacent columns.
  const GAP_PCT = 1; // percent gap on the right
  const leftPct = p.leftFrac * 100;
  const widthPct = p.widthFrac * 100;
  block.style.left = `${leftPct}%`;
  block.style.width = `calc(${widthPct}% - ${GAP_PCT}px)`;

  const start = new Date(p.event.start_at);
  const end = new Date(p.event.end_at);

  const titleEl = document.createElement('div');
  titleEl.className = 'event__title';
  titleEl.textContent = p.event.title;

  const timeEl = document.createElement('div');
  timeEl.className = 'event__time';
  timeEl.textContent = formatTimeRange(start, end);

  block.append(titleEl, timeEl);
  block.title = `${p.event.title}\n${formatTimeRange(start, end)}`;

  block.addEventListener('mousedown', (e) => e.stopPropagation());
  block.addEventListener('click', (e) => {
    e.stopPropagation();
    openEditForm(p.event);
  });

  return block;
}

// =============================================================================
// Create interaction (click-drag on empty space)
// =============================================================================
function snap(minutes) {
  return Math.round(minutes / SNAP_MIN) * SNAP_MIN;
}

function attachCreateInteraction(col, dayStart) {
  let dragging = false;
  let startMin = 0;
  let ghost = null;

  function minutesAt(clientY) {
    // rect is viewport-relative, so it already accounts for body scrolling.
    const rect = col.getBoundingClientRect();
    const y = clientY - rect.top;
    let min = (y / AXIS_HEIGHT) * MINUTES_PER_DAY;
    min = Math.max(0, Math.min(MINUTES_PER_DAY, min));
    return min;
  }

  col.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    startMin = snap(minutesAt(e.clientY));
    ghost = document.createElement('div');
    ghost.className = 'event event--ghost';
    col.appendChild(ghost);
    updateGhost(startMin, startMin);
    e.preventDefault();
  });

  function updateGhost(a, b) {
    const top = Math.min(a, b);
    const bottom = Math.max(a, b);
    ghost.style.top = `${top * PX_PER_MIN}px`;
    ghost.style.height = `${Math.max(1, (bottom - top)) * PX_PER_MIN}px`;
  }

  function onMove(e) {
    if (!dragging) return;
    const cur = snap(minutesAt(e.clientY));
    updateGhost(startMin, cur);
  }

  function onUp(e) {
    if (!dragging) return;
    dragging = false;
    const endMin = snap(minutesAt(e.clientY));
    if (ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost);
    ghost = null;

    let a = Math.min(startMin, endMin);
    let b = Math.max(startMin, endMin);
    // A plain click (no real drag) defaults to a 1-hour event.
    if (b - a < SNAP_MIN) {
      b = Math.min(MINUTES_PER_DAY, a + 60);
      if (b === a) a = Math.max(0, b - 60);
    }
    const start = new Date(dayStart.getTime() + a * 60000);
    const end = new Date(dayStart.getTime() + b * 60000);
    openCreateForm(start, end);
  }

  col.addEventListener('mousemove', onMove);
  // Use window for up so a drag that ends outside still resolves.
  window.addEventListener('mouseup', onUp);

  // Stash listeners so they could be removed; here lifetime == column lifetime
  // which is recreated each render so leak is bounded. We clean up on render.
  cleanupFns.push(() => window.removeEventListener('mouseup', onUp));
}

let cleanupFns = [];

// =============================================================================
// Modal form (create / edit)
// =============================================================================
function closeModal() {
  const existing = document.querySelector('.modal-backdrop');
  if (existing) existing.remove();
}

function openCreateForm(start, end) {
  openForm({
    mode: 'create',
    title: '',
    start,
    end,
  });
}

function openEditForm(event) {
  openForm({
    mode: 'edit',
    id: event.id,
    title: event.title,
    start: new Date(event.start_at),
    end: new Date(event.end_at),
  });
}

function openForm({ mode, id, title, start, end }) {
  closeModal();

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) closeModal();
  });

  const modal = document.createElement('div');
  modal.className = 'modal';

  const h = document.createElement('h2');
  h.textContent = mode === 'create' ? 'New event' : 'Edit event';

  const form = document.createElement('form');
  form.className = 'form';

  const titleField = field('Title', 'text', title);
  const startField = field('Start', 'datetime-local', toLocalInputValue(start));
  const endField = field('End', 'datetime-local', toLocalInputValue(end));

  const error = document.createElement('div');
  error.className = 'form__error';
  error.hidden = true;

  const actions = document.createElement('div');
  actions.className = 'form__actions';

  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'btn btn--primary';
  save.textContent = 'Save';

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', closeModal);

  actions.append(save, cancel);

  if (mode === 'edit') {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn--danger';
    del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      try {
        await deleteEvent(id);
        closeModal();
        await load();
      } catch (err) {
        showError(error, err.message);
      }
    });
    actions.appendChild(del);
  }

  form.append(titleField.wrap, startField.wrap, endField.wrap, error, actions);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const titleVal = titleField.input.value.trim();
    const startDate = fromLocalInputValue(startField.input.value);
    const endDate = fromLocalInputValue(endField.input.value);

    if (!titleVal) return showError(error, 'Title must not be empty.');
    if (!startDate || !endDate) return showError(error, 'Invalid date/time.');
    if (!(endDate.getTime() > startDate.getTime())) {
      return showError(error, 'End must be after start.');
    }

    const payload = {
      title: titleVal,
      start_at: startDate.toISOString(),
      end_at: endDate.toISOString(),
    };
    try {
      if (mode === 'create') {
        await createEvent(payload);
      } else {
        await updateEvent(id, payload);
      }
      closeModal();
      await load();
    } catch (err) {
      showError(error, err.message);
    }
  });

  modal.append(h, form);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  titleField.input.focus();
}

function showError(el, msg) {
  el.textContent = msg;
  el.hidden = false;
}

function field(label, type, value) {
  const wrap = document.createElement('label');
  wrap.className = 'form__field';
  const span = document.createElement('span');
  span.textContent = label;
  const input = document.createElement('input');
  input.type = type;
  input.value = value ?? '';
  if (type === 'datetime-local') input.step = 60;
  wrap.append(span, input);
  return { wrap, input };
}

// =============================================================================
// Data loading
// =============================================================================
async function load() {
  // Remove stale window-level listeners from previous render.
  cleanupFns.forEach((fn) => fn());
  cleanupFns = [];

  const rangeStart = startOfDay(state.weekStart);
  const rangeEnd = addDays(rangeStart, 7);
  try {
    state.events = await fetchEvents(
      rangeStart.toISOString(),
      rangeEnd.toISOString()
    );
  } catch (err) {
    console.error('Failed to load events', err);
    state.events = [];
  }
  render();
  scrollToMorning();
}

function scrollToMorning() {
  const body = document.querySelector('.calendar__body');
  if (body) body.scrollTop = 8 * HOUR_HEIGHT;
}

load();
