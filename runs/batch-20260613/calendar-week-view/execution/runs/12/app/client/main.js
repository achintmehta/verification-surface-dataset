import { layoutEvents } from './layout.js';
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
  startOfDay,
  sameDay,
  minutesFromDayStart,
  formatMinutes,
  dateFromDayMinutes,
  toLocalInputValue,
  fromLocalInputValue,
  weekdayName,
} from './time.js';

// ---- Geometry constants ----
const HOUR_HEIGHT = 48; // px per hour
const AXIS_HEIGHT = HOUR_HEIGHT * 24; // total px height of the day column
const SNAP_MINUTES = 15; // drag/click snapping granularity

// ---- State ----
const state = {
  weekStart: startOfWeek(new Date()),
  events: [], // raw events from server (with parsed Date objects)
  loadError: null,
};

const app = document.getElementById('app');

function minutesToPx(mins) {
  return (mins / MINUTES_PER_DAY) * AXIS_HEIGHT;
}

function pxToMinutes(px) {
  return (px / AXIS_HEIGHT) * MINUTES_PER_DAY;
}

function snap(mins) {
  return Math.round(mins / SNAP_MINUTES) * SNAP_MINUTES;
}

function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
}

// ---- Data loading ----
async function loadWeek() {
  const start = state.weekStart;
  const end = addDays(start, 7);
  try {
    const rows = await fetchEvents(start.toISOString(), end.toISOString());
    state.events = rows.map((r) => ({
      id: r.id,
      title: r.title,
      start: new Date(r.start_at),
      end: new Date(r.end_at),
    }));
    state.loadError = null;
  } catch (err) {
    state.loadError = err.message || 'Failed to load events';
    state.events = [];
  }
  render();
}

// Compute per-day layout: for each of the 7 days, produce visible event blocks
// clamped to that day's [0, 1440] range, then run the cluster layout.
function computeDayBlocks(dayIndex) {
  const dayStart = addDays(state.weekStart, dayIndex);
  const dayStartMidnight = startOfDay(dayStart);
  const nextDayMidnight = startOfDay(addDays(dayStart, 1));

  const segments = [];
  for (const ev of state.events) {
    // Skip events not touching this day.
    if (ev.end <= dayStartMidnight || ev.start >= nextDayMidnight) continue;
    let startMin = minutesFromDayStart(dayStartMidnight, ev.start);
    let endMin = minutesFromDayStart(dayStartMidnight, ev.end);
    // Clamp to the visible day range.
    const visibleStart = clamp(startMin, 0, MINUTES_PER_DAY);
    const visibleEnd = clamp(endMin, 0, MINUTES_PER_DAY);
    if (visibleEnd <= visibleStart) continue;
    segments.push({
      id: ev.id,
      title: ev.title,
      event: ev,
      start: visibleStart,
      end: visibleEnd,
    });
  }
  return layoutEvents(segments);
}

// ---- Rendering ----
function render() {
  app.innerHTML = '';
  app.appendChild(renderHeader());
  if (state.loadError) {
    const banner = document.createElement('div');
    banner.className = 'error-banner';
    banner.textContent = state.loadError;
    app.appendChild(banner);
  }
  app.appendChild(renderGrid());
}

function renderHeader() {
  const header = document.createElement('header');
  header.className = 'app-header';

  const title = document.createElement('h1');
  title.textContent = 'Week Calendar';

  const nav = document.createElement('div');
  nav.className = 'nav';

  const prev = button('‹ Prev', () => {
    state.weekStart = addDays(state.weekStart, -7);
    loadWeek();
  });
  const today = button('Today', () => {
    state.weekStart = startOfWeek(new Date());
    loadWeek();
  });
  const next = button('Next ›', () => {
    state.weekStart = addDays(state.weekStart, 7);
    loadWeek();
  });

  const label = document.createElement('span');
  label.className = 'week-label';
  const weekEnd = addDays(state.weekStart, 6);
  label.textContent = formatWeekLabel(state.weekStart, weekEnd);

  nav.append(prev, today, next, label);
  header.append(title, nav);
  return header;
}

function formatWeekLabel(start, end) {
  const opts = { month: 'short', day: 'numeric' };
  const startStr = start.toLocaleDateString(undefined, opts);
  const endStr = end.toLocaleDateString(undefined, {
    ...opts,
    year: 'numeric',
  });
  return `${startStr} – ${endStr}`;
}

function button(text, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

function renderGrid() {
  const grid = document.createElement('div');
  grid.className = 'calendar';

  // Column headers row
  const headerRow = document.createElement('div');
  headerRow.className = 'grid-header';
  const corner = document.createElement('div');
  corner.className = 'time-gutter-header';
  headerRow.appendChild(corner);

  const todayMidnight = startOfDay(new Date());
  for (let d = 0; d < 7; d++) {
    const dayDate = addDays(state.weekStart, d);
    const cell = document.createElement('div');
    cell.className = 'day-header';
    if (sameDay(dayDate, todayMidnight)) cell.classList.add('today');
    const name = document.createElement('div');
    name.className = 'day-name';
    name.textContent = weekdayName(d);
    const num = document.createElement('div');
    num.className = 'day-date';
    num.textContent = dayDate.getDate();
    cell.append(name, num);
    headerRow.appendChild(cell);
  }
  grid.appendChild(headerRow);

  // Body: time gutter + 7 day columns
  const body = document.createElement('div');
  body.className = 'grid-body';

  const gutter = document.createElement('div');
  gutter.className = 'time-gutter';
  gutter.style.height = `${AXIS_HEIGHT}px`;
  for (let h = 0; h <= 24; h++) {
    const label = document.createElement('div');
    label.className = 'hour-label';
    label.style.top = `${minutesToPx(h * 60)}px`;
    label.textContent = formatMinutes(h * 60);
    gutter.appendChild(label);
  }
  body.appendChild(gutter);

  const columns = document.createElement('div');
  columns.className = 'day-columns';
  for (let d = 0; d < 7; d++) {
    columns.appendChild(renderDayColumn(d, todayMidnight));
  }
  body.appendChild(columns);
  grid.appendChild(body);
  return grid;
}

function renderDayColumn(dayIndex, todayMidnight) {
  const dayDate = addDays(state.weekStart, dayIndex);
  const col = document.createElement('div');
  col.className = 'day-column';
  if (sameDay(dayDate, todayMidnight)) col.classList.add('today');
  col.style.height = `${AXIS_HEIGHT}px`;

  // Hour grid lines
  for (let h = 0; h <= 24; h++) {
    const line = document.createElement('div');
    line.className = 'hour-line';
    if (h === 24) line.classList.add('last');
    line.style.top = `${minutesToPx(h * 60)}px`;
    col.appendChild(line);
  }

  // Event blocks
  const blocks = computeDayBlocks(dayIndex);
  for (const block of blocks) {
    col.appendChild(renderEventBlock(block));
  }

  // Drag-to-create interaction layer
  attachCreateInteraction(col, dayIndex);

  return col;
}

function renderEventBlock(block) {
  const el = document.createElement('div');
  el.className = 'event-block';
  const top = minutesToPx(block.start);
  const height = minutesToPx(block.end) - top;
  el.style.top = `${top}px`;
  el.style.height = `${Math.max(height, 1)}px`;
  const widthPct = 100 / block.columnCount;
  el.style.left = `${block.columnIndex * widthPct}%`;
  el.style.width = `calc(${widthPct}% - 2px)`;

  const titleEl = document.createElement('div');
  titleEl.className = 'event-title';
  titleEl.textContent = block.title;

  const timeEl = document.createElement('div');
  timeEl.className = 'event-time';
  timeEl.textContent = `${formatMinutes(block.start)}–${formatMinutes(block.end)}`;

  el.append(titleEl, timeEl);
  el.title = `${block.title}\n${timeEl.textContent}`;

  el.addEventListener('mousedown', (e) => e.stopPropagation());
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    openEditForm(block.event);
  });
  return el;
}

// ---- Drag-to-create ----
function attachCreateInteraction(col, dayIndex) {
  let dragging = false;
  let startY = 0;
  let ghost = null;

  const getY = (clientY) => {
    const rect = col.getBoundingClientRect();
    return clamp(clientY - rect.top, 0, AXIS_HEIGHT);
  };

  col.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    startY = getY(e.clientY);
    ghost = document.createElement('div');
    ghost.className = 'event-ghost';
    ghost.style.top = `${startY}px`;
    ghost.style.height = '0px';
    col.appendChild(ghost);
    e.preventDefault();
  });

  const onMove = (e) => {
    if (!dragging) return;
    const curY = getY(e.clientY);
    const top = Math.min(startY, curY);
    const height = Math.abs(curY - startY);
    ghost.style.top = `${top}px`;
    ghost.style.height = `${height}px`;
  };

  const onUp = (e) => {
    if (!dragging) return;
    dragging = false;
    const curY = getY(e.clientY);
    if (ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost);
    ghost = null;

    let startMin = snap(pxToMinutes(Math.min(startY, curY)));
    let endMin = snap(pxToMinutes(Math.max(startY, curY)));

    // A pure click (no meaningful drag): default to a 1-hour block.
    if (endMin - startMin < SNAP_MINUTES) {
      startMin = snap(pxToMinutes(startY));
      endMin = startMin + 60;
    }
    startMin = clamp(startMin, 0, MINUTES_PER_DAY - SNAP_MINUTES);
    endMin = clamp(endMin, startMin + SNAP_MINUTES, MINUTES_PER_DAY);

    const dayMidnight = startOfDay(addDays(state.weekStart, dayIndex));
    const startDate = dateFromDayMinutes(dayMidnight, startMin);
    const endDate = dateFromDayMinutes(dayMidnight, endMin);
    openCreateForm(startDate, endDate);
  };

  col.addEventListener('mousemove', onMove);
  // Listen on window so a drag released outside the column still finalizes.
  window.addEventListener('mouseup', onUp);
}

// ---- Forms (modal) ----
function openCreateForm(startDate, endDate) {
  openForm({
    mode: 'create',
    title: '',
    start: startDate,
    end: endDate,
  });
}

function openEditForm(event) {
  openForm({
    mode: 'edit',
    id: event.id,
    title: event.title,
    start: event.start,
    end: event.end,
  });
}

function openForm(opts) {
  closeForm();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) closeForm();
  });

  const form = document.createElement('form');
  form.className = 'modal';

  const heading = document.createElement('h2');
  heading.textContent = opts.mode === 'create' ? 'New event' : 'Edit event';

  const titleField = field('Title', () => {
    const input = document.createElement('input');
    input.type = 'text';
    input.name = 'title';
    input.value = opts.title;
    input.required = true;
    input.placeholder = 'Event title';
    return input;
  });

  const startField = field('Start', () => {
    const input = document.createElement('input');
    input.type = 'datetime-local';
    input.name = 'start';
    input.value = toLocalInputValue(opts.start);
    input.required = true;
    return input;
  });

  const endField = field('End', () => {
    const input = document.createElement('input');
    input.type = 'datetime-local';
    input.name = 'end';
    input.value = toLocalInputValue(opts.end);
    input.required = true;
    return input;
  });

  const errorEl = document.createElement('div');
  errorEl.className = 'modal-error';
  errorEl.style.display = 'none';

  const actions = document.createElement('div');
  actions.className = 'modal-actions';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.className = 'primary';
  saveBtn.textContent = 'Save';

  const cancelBtn = button('Cancel', closeForm);
  cancelBtn.className = 'secondary';

  actions.append(cancelBtn, saveBtn);

  if (opts.mode === 'edit') {
    const deleteBtn = button('Delete', async () => {
      try {
        await deleteEvent(opts.id);
        closeForm();
        await loadWeek();
      } catch (err) {
        showError(errorEl, err.message);
      }
    });
    deleteBtn.className = 'danger';
    actions.prepend(deleteBtn);
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const titleVal = form.title.value.trim();
    const startVal = fromLocalInputValue(form.start.value);
    const endVal = fromLocalInputValue(form.end.value);
    if (!titleVal) return showError(errorEl, 'Title must not be empty');
    if (!startVal || !endVal) return showError(errorEl, 'Invalid date/time');
    if (endVal.getTime() <= startVal.getTime()) {
      return showError(errorEl, 'End must be after start');
    }
    const payload = {
      title: titleVal,
      start_at: startVal.toISOString(),
      end_at: endVal.toISOString(),
    };
    try {
      if (opts.mode === 'create') {
        await createEvent(payload);
      } else {
        await updateEvent(opts.id, payload);
      }
      closeForm();
      await loadWeek();
    } catch (err) {
      showError(errorEl, err.message);
    }
  });

  form.append(heading, titleField, startField, endField, errorEl, actions);
  overlay.appendChild(form);
  document.body.appendChild(overlay);
  const titleInput = form.querySelector('input[name="title"]');
  if (titleInput) titleInput.focus();

  // Escape to close.
  const onKey = (e) => {
    if (e.key === 'Escape') closeForm();
  };
  document.addEventListener('keydown', onKey);
  overlay._onKey = onKey;
}

function showError(el, message) {
  el.textContent = message;
  el.style.display = 'block';
}

function field(labelText, buildInput) {
  const wrap = document.createElement('label');
  wrap.className = 'field';
  const span = document.createElement('span');
  span.textContent = labelText;
  wrap.append(span, buildInput());
  return wrap;
}

function closeForm() {
  const overlay = document.querySelector('.modal-overlay');
  if (overlay) {
    if (overlay._onKey) document.removeEventListener('keydown', overlay._onKey);
    overlay.remove();
  }
}

// ---- Boot ----
loadWeek();
