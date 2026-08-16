import './styles.css';
import { layoutDayEvents } from './layout.js';
import { fetchEvents, createEvent, updateEvent, deleteEvent } from './api.js';
import {
  startOfWeek,
  addDays,
  addWeeks,
  minutesFromMidnight,
  dateFromMinutes,
  isSameDay,
  formatTime,
  formatMinutes,
  toDatetimeLocalValue,
  fromDatetimeLocalValue,
  weekdayLabel,
  dayDateLabel,
  weekRangeLabel,
} from './time.js';

// --- Geometry constants ------------------------------------------------------
const HOUR_HEIGHT = 48; // px per hour
const DAY_MINUTES = 24 * 60;
const AXIS_HEIGHT = HOUR_HEIGHT * 24; // total height of a day column body

// --- State -------------------------------------------------------------------
let weekStart = startOfWeek(new Date());
let events = []; // raw events from API (with Date objects)

const app = document.getElementById('app');

// =============================================================================
// Top-level render
// =============================================================================
function render() {
  app.innerHTML = '';

  const header = buildHeader();
  app.appendChild(header);

  const grid = buildGrid();
  app.appendChild(grid);
}

function buildHeader() {
  const header = document.createElement('div');
  header.className = 'toolbar';

  const nav = document.createElement('div');
  nav.className = 'nav';

  const prev = button('‹ Prev', () => changeWeek(-1));
  const today = button('Today', () => goToToday());
  const next = button('Next ›', () => changeWeek(1));
  prev.classList.add('btn-nav');
  next.classList.add('btn-nav');
  today.classList.add('btn-today');

  nav.append(prev, today, next);

  const label = document.createElement('div');
  label.className = 'week-label';
  label.textContent = weekRangeLabel(weekStart);

  header.append(nav, label);
  return header;
}

function button(text, onClick, cls) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  if (cls) b.className = cls;
  b.addEventListener('click', onClick);
  return b;
}

// =============================================================================
// Grid
// =============================================================================
function buildGrid() {
  const wrapper = document.createElement('div');
  wrapper.className = 'calendar';

  // Column headers row (Mon..Sun)
  const headRow = document.createElement('div');
  headRow.className = 'cal-head';

  const corner = document.createElement('div');
  corner.className = 'cal-corner';
  headRow.appendChild(corner);

  const now = new Date();
  for (let i = 0; i < 7; i++) {
    const dayDate = addDays(weekStart, i);
    const cell = document.createElement('div');
    cell.className = 'day-head';
    if (isSameDay(dayDate, now)) cell.classList.add('is-today');
    cell.innerHTML = `<span class="dh-weekday">${weekdayLabel(i)}</span> <span class="dh-date">${dayDateLabel(dayDate)}</span>`;
    headRow.appendChild(cell);
  }
  wrapper.appendChild(headRow);

  // Scrollable body
  const body = document.createElement('div');
  body.className = 'cal-body';

  // Time axis (hour labels)
  const axis = document.createElement('div');
  axis.className = 'time-axis';
  axis.style.height = `${AXIS_HEIGHT}px`;
  for (let h = 0; h <= 24; h++) {
    const lbl = document.createElement('div');
    lbl.className = 'hour-label';
    lbl.style.top = `${h * HOUR_HEIGHT}px`;
    lbl.textContent = h === 24 ? '24:00' : `${String(h).padStart(2, '0')}:00`;
    axis.appendChild(lbl);
  }
  body.appendChild(axis);

  // Day columns
  for (let i = 0; i < 7; i++) {
    const dayDate = addDays(weekStart, i);
    const col = buildDayColumn(dayDate, now);
    body.appendChild(col);
  }

  wrapper.appendChild(body);
  return wrapper;
}

function buildDayColumn(dayDate, now) {
  const col = document.createElement('div');
  col.className = 'day-col';
  col.style.height = `${AXIS_HEIGHT}px`;
  if (isSameDay(dayDate, now)) col.classList.add('is-today');

  // Hour grid lines
  for (let h = 0; h <= 24; h++) {
    const line = document.createElement('div');
    line.className = 'hour-line';
    line.style.top = `${h * HOUR_HEIGHT}px`;
    col.appendChild(line);
  }

  // Layer that holds event blocks
  const layer = document.createElement('div');
  layer.className = 'event-layer';
  col.appendChild(layer);

  // Current-time indicator on today's column
  if (isSameDay(dayDate, now)) {
    const mins = minutesFromMidnight(now, dayStartOf(dayDate));
    const nowLine = document.createElement('div');
    nowLine.className = 'now-line';
    nowLine.style.top = `${(mins / DAY_MINUTES) * AXIS_HEIGHT}px`;
    col.appendChild(nowLine);
  }

  // --- Events for this day ---------------------------------------------------
  const dayStart = dayStartOf(dayDate);
  const dayEnd = addDays(dayStart, 1);

  const dayEvents = [];
  for (const ev of events) {
    // Overlap with this day?
    if (ev.start_at < dayEnd && ev.end_at > dayStart) {
      // Clamp to [0, DAY_MINUTES] within this day column.
      const rawStart = minutesFromMidnight(ev.start_at, dayStart);
      const rawEnd = minutesFromMidnight(ev.end_at, dayStart);
      const start = Math.max(0, rawStart);
      const end = Math.min(DAY_MINUTES, rawEnd);
      dayEvents.push({ ...ev, start, end });
    }
  }

  const laidOut = layoutDayEvents(dayEvents);
  for (const ev of laidOut) {
    layer.appendChild(buildEventBlock(ev));
  }

  // --- Click / drag to create ------------------------------------------------
  attachCreateInteraction(col, dayStart);

  return col;
}

function dayStartOf(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function buildEventBlock(ev) {
  const block = document.createElement('div');
  block.className = 'event-block';

  const top = (ev.start / DAY_MINUTES) * AXIS_HEIGHT;
  const height = ((ev.end - ev.start) / DAY_MINUTES) * AXIS_HEIGHT;
  block.style.top = `${top}px`;
  block.style.height = `${Math.max(height, 1)}px`;

  // Horizontal placement from cluster columns.
  const cols = ev._cols || 1;
  const colIndex = ev._col || 0;
  const widthPct = 100 / cols;
  block.style.left = `${colIndex * widthPct}%`;
  block.style.width = `${widthPct}%`;

  const title = document.createElement('div');
  title.className = 'ev-title';
  title.textContent = ev.title;

  const time = document.createElement('div');
  time.className = 'ev-time';
  time.textContent = `${formatTime(ev.start_at)}–${formatTime(ev.end_at)}`;

  block.append(title, time);
  block.title = `${ev.title}\n${formatTime(ev.start_at)}–${formatTime(ev.end_at)}`;

  block.addEventListener('click', (e) => {
    e.stopPropagation();
    openEditForm(ev);
  });

  return block;
}

// =============================================================================
// Create interaction (click / click-drag on empty space)
// =============================================================================
function attachCreateInteraction(col, dayStart) {
  let dragging = false;
  let startY = 0;
  let ghost = null;

  const snap = (mins) => Math.round(mins / 15) * 15; // snap to 15 min

  function minutesAt(clientY) {
    const rect = col.getBoundingClientRect();
    const y = clientY - rect.top + col.scrollTop;
    let mins = (y / AXIS_HEIGHT) * DAY_MINUTES;
    return Math.max(0, Math.min(DAY_MINUTES, mins));
  }

  col.addEventListener('mousedown', (e) => {
    // Ignore clicks that land on an event block.
    if (e.target.closest('.event-block')) return;
    if (e.button !== 0) return;
    dragging = true;
    startY = minutesAt(e.clientY);

    ghost = document.createElement('div');
    ghost.className = 'event-ghost';
    col.querySelector('.event-layer').appendChild(ghost);
    updateGhost(startY, startY);
    e.preventDefault();
  });

  function updateGhost(a, b) {
    if (!ghost) return;
    const top = (Math.min(a, b) / DAY_MINUTES) * AXIS_HEIGHT;
    const height = (Math.abs(b - a) / DAY_MINUTES) * AXIS_HEIGHT;
    ghost.style.top = `${top}px`;
    ghost.style.height = `${Math.max(height, 2)}px`;
  }

  function onMove(e) {
    if (!dragging) return;
    const cur = minutesAt(e.clientY);
    updateGhost(startY, cur);
  }

  function onUp(e) {
    if (!dragging) return;
    dragging = false;
    const endMins = minutesAt(e.clientY);
    if (ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost);
    ghost = null;

    let a = snap(startY);
    let b = snap(endMins);
    let lo = Math.min(a, b);
    let hi = Math.max(a, b);
    // A plain click (no real drag) defaults to a 1-hour block.
    if (hi - lo < 15) {
      lo = snap(startY);
      hi = Math.min(DAY_MINUTES, lo + 60);
      if (hi === lo) lo = hi - 60;
    }

    const startDate = dateFromMinutes(dayStart, lo);
    const endDate = dateFromMinutes(dayStart, hi);
    openCreateForm(startDate, endDate);
  }

  col.addEventListener('mousemove', onMove);
  // Listen on window for mouseup so a drag that ends outside still resolves.
  window.addEventListener('mouseup', onUp);
}

// =============================================================================
// Forms (modal)
// =============================================================================
function openCreateForm(startDate, endDate) {
  showModal({
    heading: 'New event',
    title: '',
    start: startDate,
    end: endDate,
    onSubmit: async (data) => {
      await createEvent({
        title: data.title,
        start_at: data.start.toISOString(),
        end_at: data.end.toISOString(),
      });
      await reload();
    },
  });
}

function openEditForm(ev) {
  showModal({
    heading: 'Edit event',
    title: ev.title,
    start: ev.start_at,
    end: ev.end_at,
    eventId: ev.id,
    onSubmit: async (data) => {
      await updateEvent(ev.id, {
        title: data.title,
        start_at: data.start.toISOString(),
        end_at: data.end.toISOString(),
      });
      await reload();
    },
    onDelete: async () => {
      await deleteEvent(ev.id);
      await reload();
    },
  });
}

function showModal({ heading, title, start, end, eventId, onSubmit, onDelete }) {
  closeModal();

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) closeModal();
  });

  const modal = document.createElement('div');
  modal.className = 'modal';

  const h = document.createElement('h2');
  h.textContent = heading;

  const form = document.createElement('form');

  const titleField = field('Title', 'text', title);
  const startField = field('Start', 'datetime-local', toDatetimeLocalValue(start));
  const endField = field('End', 'datetime-local', toDatetimeLocalValue(end));

  const error = document.createElement('div');
  error.className = 'form-error';

  const actions = document.createElement('div');
  actions.className = 'modal-actions';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.className = 'btn-primary';
  saveBtn.textContent = 'Save';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', closeModal);

  actions.append(saveBtn, cancelBtn);

  if (onDelete) {
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn-danger';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', async () => {
      try {
        await onDelete();
        closeModal();
      } catch (err) {
        error.textContent = err.message;
      }
    });
    actions.appendChild(delBtn);
  }

  form.append(titleField.wrap, startField.wrap, endField.wrap, error, actions);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.textContent = '';
    const titleVal = titleField.input.value.trim();
    const startVal = fromDatetimeLocalValue(startField.input.value);
    const endVal = fromDatetimeLocalValue(endField.input.value);

    if (!titleVal) {
      error.textContent = 'Title is required.';
      return;
    }
    if (Number.isNaN(startVal.getTime()) || Number.isNaN(endVal.getTime())) {
      error.textContent = 'Start and end must be valid times.';
      return;
    }
    if (endVal.getTime() <= startVal.getTime()) {
      error.textContent = 'End must be after start.';
      return;
    }

    saveBtn.disabled = true;
    try {
      await onSubmit({ title: titleVal, start: startVal, end: endVal });
      closeModal();
    } catch (err) {
      error.textContent = err.message;
      saveBtn.disabled = false;
    }
  });

  modal.append(h, form);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  titleField.input.focus();

  const escHandler = (e) => {
    if (e.key === 'Escape') closeModal();
  };
  document.addEventListener('keydown', escHandler);
  overlay._escHandler = escHandler;
}

function field(labelText, type, value) {
  const wrap = document.createElement('label');
  wrap.className = 'field';
  const span = document.createElement('span');
  span.textContent = labelText;
  const input = document.createElement('input');
  input.type = type;
  input.value = value ?? '';
  wrap.append(span, input);
  return { wrap, input };
}

function closeModal() {
  const existing = document.querySelector('.modal-overlay');
  if (existing) {
    if (existing._escHandler) document.removeEventListener('keydown', existing._escHandler);
    existing.remove();
  }
}

// =============================================================================
// Navigation & data loading
// =============================================================================
function changeWeek(delta) {
  weekStart = addWeeks(weekStart, delta);
  reload();
}

function goToToday() {
  weekStart = startOfWeek(new Date());
  reload();
}

async function reload() {
  const rangeStart = dayStartOf(weekStart);
  const rangeEnd = addDays(rangeStart, 7);
  try {
    const raw = await fetchEvents(rangeStart.toISOString(), rangeEnd.toISOString());
    events = raw.map((e) => ({
      ...e,
      start_at: new Date(e.start_at),
      end_at: new Date(e.end_at),
    }));
  } catch (err) {
    console.error('Failed to load events', err);
    events = [];
  }
  render();
}

// Initial load
reload();
