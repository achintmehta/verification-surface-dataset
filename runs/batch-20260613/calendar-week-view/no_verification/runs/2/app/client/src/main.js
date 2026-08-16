import { api } from './api.js';
import { computeLayout, minutesToPx, toMinutes } from './layout.js';
import {
  getWeekStart, getWeekDays, weekStartISO, weekEndISO,
  localISO, formatTime, formatWeekLabel, dayName, isSameDay,
  pxToMinutes, dayMinutesToISO,
} from './week.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const HOUR_HEIGHT = 64;   // px per hour — single source of truth; matches CSS --hour-height
const HOURS       = 24;
const NUM_COLORS  = 6;
const MIN_BLOCK_H = 18;   // minimum event block height in px

// ── State ─────────────────────────────────────────────────────────────────────
let weekStart = getWeekStart(new Date()); // Monday of current week (local midnight)
let events    = [];                        // raw events from API for current week
let editingId = null;                      // null = create mode, number = edit mode

// Drag-to-create state
let dragState = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const weekLabel    = document.getElementById('week-label');
const dayHeaders   = document.getElementById('day-headers');
const timeGutter   = document.getElementById('time-gutter');
const hourLines    = document.getElementById('hour-lines');
const dayColumns   = document.getElementById('day-columns');
const gridScroll   = document.getElementById('grid-scroll');

const modalOverlay = document.getElementById('modal-overlay');
const modalTitle   = document.getElementById('modal-title');
const eventForm    = document.getElementById('event-form');
const fTitle       = document.getElementById('f-title');
const fStart       = document.getElementById('f-start');
const fEnd         = document.getElementById('f-end');
const formError    = document.getElementById('form-error');
const btnSave      = document.getElementById('btn-save');
const btnDelete    = document.getElementById('btn-delete');
const btnCancel    = document.getElementById('btn-cancel');

// ── Bootstrap ─────────────────────────────────────────────────────────────────
buildStaticGrid();
loadAndRender();
scrollToHour(7);

// ── Navigation ────────────────────────────────────────────────────────────────
document.getElementById('btn-prev').addEventListener('click', () => {
  weekStart = new Date(weekStart);
  weekStart.setDate(weekStart.getDate() - 7);
  loadAndRender();
});
document.getElementById('btn-today').addEventListener('click', () => {
  weekStart = getWeekStart(new Date());
  loadAndRender();
});
document.getElementById('btn-next').addEventListener('click', () => {
  weekStart = new Date(weekStart);
  weekStart.setDate(weekStart.getDate() + 7);
  loadAndRender();
});

// ── Static grid (time gutter + hour/half-hour lines) ──────────────────────────
function buildStaticGrid() {
  // Time gutter: one label per hour
  timeGutter.innerHTML = '';
  for (let h = 0; h < HOURS; h++) {
    const div = document.createElement('div');
    div.className = 'gutter-hour';
    div.style.height = `${HOUR_HEIGHT}px`;
    // Hide the 00:00 label — it sits at the very top edge and looks odd
    div.textContent = h === 0 ? '' : `${String(h).padStart(2, '0')}:00`;
    timeGutter.appendChild(div);
  }

  // Hour lines and half-hour lines
  hourLines.innerHTML = '';
  for (let h = 0; h <= HOURS; h++) {
    const line = document.createElement('div');
    line.className = 'hour-line';
    line.style.top = `${h * HOUR_HEIGHT}px`;
    hourLines.appendChild(line);

    if (h < HOURS) {
      const half = document.createElement('div');
      half.className = 'half-hour-line';
      half.style.top = `${h * HOUR_HEIGHT + HOUR_HEIGHT / 2}px`;
      hourLines.appendChild(half);
    }
  }
}

// ── Load events from API and re-render ────────────────────────────────────────
async function loadAndRender() {
  const days = getWeekDays(weekStart);
  weekLabel.textContent = formatWeekLabel(days);
  renderDayHeaders(days);
  renderDayColumns(days, []);   // show empty grid immediately

  try {
    events = await api.getEvents(weekStartISO(weekStart), weekEndISO(weekStart));
  } catch (err) {
    console.error('Failed to load events:', err);
    events = [];
  }

  renderDayColumns(days, events);
  scheduleNowLine(days);
}

// ── Day headers ───────────────────────────────────────────────────────────────
function renderDayHeaders(days) {
  dayHeaders.innerHTML = '';
  const today = new Date();
  days.forEach(day => {
    const div = document.createElement('div');
    div.className = 'day-header' + (isSameDay(day, today) ? ' today' : '');
    div.innerHTML =
      `<span class="day-name">${dayName(day)}</span>` +
      `<span class="day-num">${day.getDate()}</span>`;
    dayHeaders.appendChild(div);
  });
}

// ── Day columns with events ───────────────────────────────────────────────────
function renderDayColumns(days, allEvents) {
  dayColumns.innerHTML = '';
  const today = new Date();

  days.forEach((day, dayIndex) => {
    const col = document.createElement('div');
    col.className = 'day-col' + (isSameDay(day, today) ? ' today-col' : '');
    col.dataset.dayIndex = String(dayIndex);

    // Day boundaries in ms
    const dayStartMs = new Date(day).setHours(0, 0, 0, 0);
    const dayEndMs   = new Date(day).setHours(24, 0, 0, 0);

    // Filter events that overlap this day
    const dayEvents = allEvents.filter(ev => {
      const s = new Date(ev.start_at).getTime();
      const e = new Date(ev.end_at).getTime();
      return s < dayEndMs && e > dayStartMs;
    });

    // Compute overlap layout
    const laid = computeLayout(dayEvents);

    // Render event blocks
    laid.forEach(ev => {
      const block = buildEventBlock(ev, dayStartMs, dayEndMs);
      col.appendChild(block);
    });

    // Drag-to-create
    col.addEventListener('mousedown', onDayMouseDown);

    dayColumns.appendChild(col);
  });
}

// ── Build a single event block element ───────────────────────────────────────
function buildEventBlock(ev, dayStartMs, dayEndMs) {
  const startMs = new Date(ev.start_at).getTime();
  const endMs   = new Date(ev.end_at).getTime();

  // Clamp to day boundaries (in ms)
  const clampedStartMs = Math.max(startMs, dayStartMs);
  const clampedEndMs   = Math.min(endMs,   dayEndMs);

  // Convert to minutes-since-midnight for this day
  // dayStartMs is midnight; each ms = 1/60000 minutes
  const startMin = (clampedStartMs - dayStartMs) / 60000;
  const endMin   = (clampedEndMs   - dayStartMs) / 60000;

  const topPx    = minutesToPx(startMin, HOUR_HEIGHT);
  const heightPx = Math.max(minutesToPx(endMin - startMin, HOUR_HEIGHT), MIN_BLOCK_H);

  // Horizontal layout from cluster algorithm
  const col     = ev._col;
  const numCols = ev._numCols;
  // Use calc() to leave 1px gap between adjacent columns
  const leftPct  = (col / numCols) * 100;
  const widthPct = (1 / numCols) * 100;

  const block = document.createElement('div');
  block.className = `event-block ev-color-${ev.id % NUM_COLORS}`;
  block.style.top    = `${topPx}px`;
  block.style.height = `${heightPx}px`;
  block.style.left   = `calc(${leftPct}% + 1px)`;
  block.style.width  = `calc(${widthPct}% - 2px)`;

  // Display times using the original (unclamped) start/end
  const timeStr = `${formatTime(new Date(ev.start_at))} – ${formatTime(new Date(ev.end_at))}`;

  block.innerHTML =
    `<div class="ev-title">${escapeHtml(ev.title)}</div>` +
    `<div class="ev-time">${timeStr}</div>`;

  block.addEventListener('click', e => {
    e.stopPropagation();
    openEditModal(ev);
  });

  return block;
}

// ── Now-line ──────────────────────────────────────────────────────────────────
let nowLineTimer = null;

function scheduleNowLine(days) {
  if (nowLineTimer) clearTimeout(nowLineTimer);
  renderNowLine(days);
  // Refresh every minute
  nowLineTimer = setTimeout(() => scheduleNowLine(days), 60_000);
}

function renderNowLine(days) {
  // Remove any existing now-lines
  dayColumns.querySelectorAll('.now-line').forEach(el => el.remove());

  const now = new Date();
  const todayIndex = days.findIndex(d => isSameDay(d, now));
  if (todayIndex === -1) return;

  const cols = dayColumns.querySelectorAll('.day-col');
  const col  = cols[todayIndex];
  if (!col) return;

  const nowMin = toMinutes(now);
  const topPx  = minutesToPx(nowMin, HOUR_HEIGHT);

  const line = document.createElement('div');
  line.className = 'now-line';
  line.style.top = `${topPx}px`;
  col.appendChild(line);
}

// ── Drag-to-create ────────────────────────────────────────────────────────────
function onDayMouseDown(e) {
  if (e.button !== 0) return;
  if (e.target.closest('.event-block')) return;

  const col      = e.currentTarget;
  const dayIndex = parseInt(col.dataset.dayIndex, 10);
  const rect     = col.getBoundingClientRect();
  const relY     = e.clientY - rect.top;
  const startMin = snapMinutes(pxToMinutes(Math.max(0, relY), HOUR_HEIGHT));

  // Visual selection indicator
  const selEl = document.createElement('div');
  selEl.className = 'drag-selection';
  selEl.style.top    = `${minutesToPx(startMin, HOUR_HEIGHT)}px`;
  selEl.style.height = `${minutesToPx(15, HOUR_HEIGHT)}px`;
  col.appendChild(selEl);

  dragState = { dayIndex, col, startMin, selEl, curMin: startMin + 60, moved: false };

  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('mouseup',   onDragEnd);
  e.preventDefault();
}

function onDragMove(e) {
  if (!dragState) return;
  const { col, startMin, selEl } = dragState;
  const rect   = col.getBoundingClientRect();
  const relY   = e.clientY - rect.top;
  const curMin = snapMinutes(pxToMinutes(Math.max(0, relY), HOUR_HEIGHT));

  const minStart = Math.min(startMin, curMin);
  const minEnd   = Math.max(startMin, curMin);
  const duration = Math.max(minEnd - minStart, 15);

  selEl.style.top    = `${minutesToPx(minStart, HOUR_HEIGHT)}px`;
  selEl.style.height = `${minutesToPx(duration, HOUR_HEIGHT)}px`;

  dragState.moved  = true;
  dragState.curMin = curMin;
}

function onDragEnd(e) {
  document.removeEventListener('mousemove', onDragMove);
  document.removeEventListener('mouseup',   onDragEnd);

  if (!dragState) return;
  const { dayIndex, col, startMin, selEl, moved, curMin } = dragState;
  dragState = null;

  selEl.remove();

  const days = getWeekDays(weekStart);
  const day  = days[dayIndex];

  let minStart, minEnd;
  if (!moved) {
    // Simple click → default 1-hour block
    minStart = startMin;
    minEnd   = Math.min(startMin + 60, 1440);
  } else {
    minStart = Math.min(startMin, curMin);
    minEnd   = Math.max(startMin, curMin);
    if (minEnd - minStart < 15) minEnd = minStart + 15;
    minEnd = Math.min(minEnd, 1440);
  }

  // Ensure end > start (edge case: drag to very top)
  if (minEnd <= minStart) minEnd = Math.min(minStart + 15, 1440);

  const startISO = dayMinutesToISO(day, minStart);
  const endISO   = dayMinutesToISO(day, minEnd);
  openCreateModal(startISO, endISO);
}

/** Snap minutes to nearest 15-minute interval */
function snapMinutes(min) {
  return Math.round(min / 15) * 15;
}

// ── Modal ─────────────────────────────────────────────────────────────────────
function openCreateModal(startISO, endISO) {
  editingId = null;
  modalTitle.textContent = 'New Event';
  fTitle.value = '';
  // datetime-local input expects "YYYY-MM-DDTHH:MM"
  fStart.value = startISO.slice(0, 16);
  fEnd.value   = endISO.slice(0, 16);
  btnDelete.classList.add('hidden');
  hideFormError();
  showModal();
  fTitle.focus();
}

function openEditModal(ev) {
  editingId = ev.id;
  modalTitle.textContent = 'Edit Event';
  fTitle.value = ev.title;
  fStart.value = localISO(new Date(ev.start_at)).slice(0, 16);
  fEnd.value   = localISO(new Date(ev.end_at)).slice(0, 16);
  btnDelete.classList.remove('hidden');
  hideFormError();
  showModal();
  fTitle.focus();
}

function showModal()  { modalOverlay.classList.remove('hidden'); }
function hideModal()  { modalOverlay.classList.add('hidden'); editingId = null; }

function showFormError(msg) {
  formError.textContent = msg;
  formError.classList.remove('hidden');
}
function hideFormError() { formError.classList.add('hidden'); }

// ── Form events ───────────────────────────────────────────────────────────────
eventForm.addEventListener('submit', async e => {
  e.preventDefault();
  hideFormError();

  const title    = fTitle.value.trim();
  const startVal = fStart.value;
  const endVal   = fEnd.value;

  if (!title) {
    showFormError('Title is required.');
    fTitle.focus();
    return;
  }
  if (!startVal || !endVal) {
    showFormError('Start and end times are required.');
    return;
  }

  // Convert datetime-local values to UTC ISO strings for the API
  const startDate = new Date(startVal);
  const endDate   = new Date(endVal);

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    showFormError('Invalid date/time values.');
    return;
  }
  if (endDate <= startDate) {
    showFormError('End time must be after start time.');
    return;
  }

  btnSave.disabled = true;
  try {
    if (editingId === null) {
      await api.createEvent(title, startDate.toISOString(), endDate.toISOString());
    } else {
      await api.updateEvent(editingId, title, startDate.toISOString(), endDate.toISOString());
    }
    hideModal();
    await loadAndRender();
  } catch (err) {
    showFormError(err.data?.error || err.message || 'Failed to save event.');
  } finally {
    btnSave.disabled = false;
  }
});

btnDelete.addEventListener('click', async () => {
  if (editingId === null) return;
  if (!confirm('Delete this event?')) return;

  btnDelete.disabled = true;
  try {
    await api.deleteEvent(editingId);
    hideModal();
    await loadAndRender();
  } catch (err) {
    showFormError(err.data?.error || err.message || 'Failed to delete event.');
  } finally {
    btnDelete.disabled = false;
  }
});

btnCancel.addEventListener('click', hideModal);

modalOverlay.addEventListener('click', e => {
  if (e.target === modalOverlay) hideModal();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !modalOverlay.classList.contains('hidden')) {
    hideModal();
  }
});

// ── Utilities ─────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function scrollToHour(hour) {
  // Scroll so that the given hour is near the top of the viewport
  gridScroll.scrollTop = Math.max(0, hour * HOUR_HEIGHT - HOUR_HEIGHT / 2);
}
