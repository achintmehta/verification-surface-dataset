import { fetchEvents, createEvent, updateEvent, deleteEvent } from './api.js';
import { computeLayout } from './layout.js';
import {
  startOfWeek,
  addDays,
  startOfDay,
  isSameDay,
  minutesFromDayStart,
  formatTimeRange,
  toDateInputValue,
  toTimeInputValue,
  fromDateAndTime,
  weekdayLabel,
  formatWeekRange,
  MINUTES_PER_DAY
} from './dates.js';

const HOUR_HEIGHT = 48; // px per hour
const DAY_HEIGHT = HOUR_HEIGHT * 24; // px for full day
const PX_PER_MIN = DAY_HEIGHT / MINUTES_PER_DAY;
const SNAP_MIN = 15; // snap drag selection to 15-minute increments

const state = {
  weekStart: startOfWeek(new Date()),
  events: []
};

// --- DOM refs ---
const calendarEl = document.getElementById('calendar');
const weekLabelEl = document.getElementById('weekLabel');
const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');
const todayBtn = document.getElementById('todayBtn');

const modalOverlay = document.getElementById('modalOverlay');
const modalTitle = document.getElementById('modalTitle');
const eventForm = document.getElementById('eventForm');
const fTitle = document.getElementById('fTitle');
const fDate = document.getElementById('fDate');
const fStart = document.getElementById('fStart');
const fEnd = document.getElementById('fEnd');
const formError = document.getElementById('formError');
const deleteBtn = document.getElementById('deleteBtn');
const cancelBtn = document.getElementById('cancelBtn');

let editingId = null;

// --- Data loading ---
async function loadWeek() {
  const rangeStart = state.weekStart;
  const rangeEnd = addDays(state.weekStart, 7);
  try {
    const events = await fetchEvents(rangeStart.toISOString(), rangeEnd.toISOString());
    state.events = events.map((e) => ({
      ...e,
      start: new Date(e.start_at),
      end: new Date(e.end_at)
    }));
  } catch (err) {
    console.error('Failed to load events', err);
    state.events = [];
  }
  render();
}

// --- Rendering ---
function render() {
  weekLabelEl.textContent = formatWeekRange(state.weekStart);
  calendarEl.innerHTML = '';

  const grid = document.createElement('div');
  grid.className = 'week-grid';

  // Corner + day headers
  const headerRow = document.createElement('div');
  headerRow.className = 'header-row';
  const corner = document.createElement('div');
  corner.className = 'time-gutter-header';
  headerRow.appendChild(corner);

  const today = new Date();
  for (let i = 0; i < 7; i++) {
    const dayDate = addDays(state.weekStart, i);
    const head = document.createElement('div');
    head.className = 'day-header';
    if (isSameDay(dayDate, today)) head.classList.add('today');
    head.innerHTML = `<span class="dow">${weekdayLabel(i)}</span><span class="dom">${dayDate.getDate()}</span>`;
    headerRow.appendChild(head);
  }
  grid.appendChild(headerRow);

  // Body: time gutter + 7 day columns
  const body = document.createElement('div');
  body.className = 'grid-body';

  const gutter = document.createElement('div');
  gutter.className = 'time-gutter';
  gutter.style.height = `${DAY_HEIGHT}px`;
  for (let h = 0; h <= 24; h++) {
    const label = document.createElement('div');
    label.className = 'hour-label';
    label.style.top = `${h * HOUR_HEIGHT}px`;
    label.textContent = h === 24 ? '24:00' : `${String(h).padStart(2, '0')}:00`;
    gutter.appendChild(label);
  }
  body.appendChild(gutter);

  for (let i = 0; i < 7; i++) {
    const dayDate = addDays(state.weekStart, i);
    const col = buildDayColumn(dayDate, i, today);
    body.appendChild(col);
  }

  grid.appendChild(body);
  calendarEl.appendChild(grid);
}

function buildDayColumn(dayDate, dayIndex, today) {
  const col = document.createElement('div');
  col.className = 'day-column';
  if (isSameDay(dayDate, today)) col.classList.add('today');
  col.style.height = `${DAY_HEIGHT}px`;
  col.dataset.dayIndex = String(dayIndex);

  // Hour grid lines
  for (let h = 1; h < 24; h++) {
    const line = document.createElement('div');
    line.className = 'hour-line';
    line.style.top = `${h * HOUR_HEIGHT}px`;
    col.appendChild(line);
  }

  // Events for this day
  const dayStart = startOfDay(dayDate);
  const dayEnd = addDays(dayStart, 1);
  const dayEvents = state.events
    .filter((e) => e.start < dayEnd && e.end > dayStart)
    .map((e) => ({
      ...e,
      startMin: minutesFromDayStart(e.start, dayStart),
      endMin: minutesFromDayStart(e.end, dayStart)
    }));

  const laid = computeLayout(dayEvents);
  for (const ev of laid) {
    col.appendChild(buildEventBlock(ev));
  }

  // Drag-to-create
  attachDragCreate(col, dayDate);

  return col;
}

function buildEventBlock(ev) {
  const top = ev.startMin * PX_PER_MIN;
  const height = Math.max((ev.endMin - ev.startMin) * PX_PER_MIN, 12);
  const widthPct = 100 / ev.colCount;
  const leftPct = ev.colIndex * widthPct;

  const block = document.createElement('div');
  block.className = 'event';
  block.style.top = `${top}px`;
  block.style.height = `${height}px`;
  block.style.left = `calc(${leftPct}% + 1px)`;
  block.style.width = `calc(${widthPct}% - 2px)`;

  const title = document.createElement('div');
  title.className = 'event-title';
  title.textContent = ev.title;

  const timeStr = document.createElement('div');
  timeStr.className = 'event-time';
  timeStr.textContent = formatTimeRange(ev.start, ev.end);

  block.appendChild(title);
  block.appendChild(timeStr);

  block.addEventListener('click', (e) => {
    e.stopPropagation();
    openEditForm(ev);
  });

  return block;
}

// --- Drag to create ---
function attachDragCreate(col, dayDate) {
  let dragging = false;
  let startY = 0;
  let selEl = null;

  function yToMin(y) {
    const rect = col.getBoundingClientRect();
    let min = ((y - rect.top) / rect.height) * MINUTES_PER_DAY;
    min = Math.max(0, Math.min(MINUTES_PER_DAY, min));
    return Math.round(min / SNAP_MIN) * SNAP_MIN;
  }

  col.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.event')) return;
    dragging = true;
    startY = e.clientY;
    selEl = document.createElement('div');
    selEl.className = 'selection';
    col.appendChild(selEl);
    updateSelection(e.clientY);
    e.preventDefault();
  });

  function updateSelection(curY) {
    const a = yToMin(startY);
    const b = yToMin(curY);
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    selEl.style.top = `${lo * PX_PER_MIN}px`;
    selEl.style.height = `${Math.max((hi - lo) * PX_PER_MIN, 2)}px`;
  }

  function onMove(e) {
    if (!dragging) return;
    updateSelection(e.clientY);
  }

  function onUp(e) {
    if (!dragging) return;
    dragging = false;
    const a = yToMin(startY);
    const b = yToMin(e.clientY);
    let lo = Math.min(a, b);
    let hi = Math.max(a, b);
    if (selEl) {
      selEl.remove();
      selEl = null;
    }
    // Treat a plain click as a default 60-minute slot.
    if (hi - lo < SNAP_MIN) {
      hi = Math.min(lo + 60, MINUTES_PER_DAY);
      if (hi === lo) lo = Math.max(0, hi - 60);
    }
    openCreateForm(dayDate, lo, hi);
  }

  col.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

// --- Modal form ---
function minToTime(min) {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function openCreateForm(dayDate, startMin, endMin) {
  editingId = null;
  modalTitle.textContent = 'New event';
  deleteBtn.hidden = true;
  fTitle.value = '';
  fDate.value = toDateInputValue(dayDate);
  fStart.value = minToTime(startMin);
  // 1440 (=24:00) maps to a time input value of 00:00, interpreted as end-of-day on submit.
  fEnd.value = endMin >= MINUTES_PER_DAY ? '00:00' : minToTime(endMin);
  showModal();
  fTitle.focus();
}

function openEditForm(ev) {
  editingId = ev.id;
  modalTitle.textContent = 'Edit event';
  deleteBtn.hidden = false;
  fTitle.value = ev.title;
  fDate.value = toDateInputValue(ev.start);
  fStart.value = toTimeInputValue(ev.start);
  fEnd.value = toTimeInputValue(ev.end);
  showModal();
  fTitle.focus();
}

function showModal() {
  formError.hidden = true;
  formError.textContent = '';
  modalOverlay.hidden = false;
}

function hideModal() {
  modalOverlay.hidden = true;
}

function showFormError(msg) {
  formError.textContent = msg;
  formError.hidden = false;
}

eventForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = fTitle.value.trim();
  const dateStr = fDate.value;
  const startStr = fStart.value;
  const endStr = fEnd.value;

  if (!title) return showFormError('Title is required.');
  if (!dateStr || !startStr || !endStr) return showFormError('Date, start and end are required.');

  const start = fromDateAndTime(dateStr, startStr);
  let end = fromDateAndTime(dateStr, endStr);
  // Allow an end of 00:00 to mean end-of-day (24:00).
  if (endStr === '00:00') {
    end = new Date(start);
    end.setHours(24, 0, 0, 0);
  }

  if (!(end.getTime() > start.getTime())) {
    return showFormError('End time must be after start time.');
  }

  const payload = {
    title,
    start_at: start.toISOString(),
    end_at: end.toISOString()
  };

  try {
    if (editingId == null) {
      await createEvent(payload);
    } else {
      await updateEvent(editingId, payload);
    }
    hideModal();
    await loadWeek();
  } catch (err) {
    showFormError(err.message || 'Failed to save event.');
  }
});

deleteBtn.addEventListener('click', async () => {
  if (editingId == null) return;
  try {
    await deleteEvent(editingId);
    hideModal();
    await loadWeek();
  } catch (err) {
    showFormError(err.message || 'Failed to delete event.');
  }
});

cancelBtn.addEventListener('click', hideModal);
modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) hideModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modalOverlay.hidden) hideModal();
});

// --- Navigation ---
prevBtn.addEventListener('click', () => {
  state.weekStart = addDays(state.weekStart, -7);
  loadWeek();
});
nextBtn.addEventListener('click', () => {
  state.weekStart = addDays(state.weekStart, 7);
  loadWeek();
});
todayBtn.addEventListener('click', () => {
  state.weekStart = startOfWeek(new Date());
  loadWeek();
});

// Initial load
loadWeek();
