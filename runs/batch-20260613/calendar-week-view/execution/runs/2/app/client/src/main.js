import './style.css';
import { api } from './api.js';
import { computeLayout, timeToPixel, endTimeToPixel, pixelToTime } from './layout.js';
import {
  getWeekStart, getWeekDays, addWeeks,
  toDatetimeLocal, formatTime, formatWeekLabel,
  getDayParts, isSameDay, dayStart, dayEnd,
} from './week.js';

// ─── Constants ───────────────────────────────────────────────────────────────
const HOUR_HEIGHT = 60; // px — must match CSS --hour-height
const TOTAL_HEIGHT = HOUR_HEIGHT * 24;
const HOURS = Array.from({ length: 25 }, (_, i) => i); // 0..24

// ─── State ───────────────────────────────────────────────────────────────────
let currentMonday = getWeekStart(new Date());
let events = []; // all events for the current week

// ─── DOM refs ────────────────────────────────────────────────────────────────
const weekLabel       = document.getElementById('week-label');
const dayHeaders      = document.getElementById('day-headers');
const dayColumns      = document.getElementById('day-columns');
const timeLabels      = document.getElementById('time-labels');
const modalOverlay    = document.getElementById('modal-overlay');
const modalTitle      = document.getElementById('modal-title');
const eventForm       = document.getElementById('event-form');
const fTitle          = document.getElementById('f-title');
const fStart          = document.getElementById('f-start');
const fEnd            = document.getElementById('f-end');
const formError       = document.getElementById('form-error');
const btnSave         = document.getElementById('btn-save');
const btnDelete       = document.getElementById('btn-delete');
const btnCancel       = document.getElementById('btn-cancel');
const btnPrev         = document.getElementById('btn-prev');
const btnToday        = document.getElementById('btn-today');
const btnNext         = document.getElementById('btn-next');
const scrollContainer = document.getElementById('day-columns-scroll');

// ─── Modal state ─────────────────────────────────────────────────────────────
let editingEventId = null; // null = create mode

// ─── Initialization ───────────────────────────────────────────────────────────
buildTimeGutter();
await loadAndRender();
scrollToHour(7); // scroll to 07:00 on load

// ─── Navigation ──────────────────────────────────────────────────────────────
btnPrev.addEventListener('click', async () => {
  currentMonday = addWeeks(currentMonday, -1);
  await loadAndRender();
});
btnNext.addEventListener('click', async () => {
  currentMonday = addWeeks(currentMonday, 1);
  await loadAndRender();
});
btnToday.addEventListener('click', async () => {
  currentMonday = getWeekStart(new Date());
  await loadAndRender();
});

// ─── Load & Render ────────────────────────────────────────────────────────────
async function loadAndRender() {
  const weekDays = getWeekDays(currentMonday);
  const rangeStart = dayStart(weekDays[0]);
  const rangeEnd   = dayEnd(weekDays[6]);

  try {
    events = await api.getEvents(rangeStart, rangeEnd);
  } catch (err) {
    console.error('Failed to load events:', err);
    events = [];
  }

  renderWeek(weekDays);
}

// ─── Build time gutter (once) ─────────────────────────────────────────────────
function buildTimeGutter() {
  timeLabels.style.height = `${TOTAL_HEIGHT}px`;
  for (const h of HOURS) {
    if (h === 0) continue; // skip midnight label at top
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = `${h * HOUR_HEIGHT}px`;
    label.textContent = `${String(h).padStart(2, '0')}:00`;
    timeLabels.appendChild(label);
  }
}

// ─── Render the full week ─────────────────────────────────────────────────────
function renderWeek(weekDays) {
  weekLabel.textContent = formatWeekLabel(currentMonday);

  // Clear previous
  dayHeaders.innerHTML = '';
  dayColumns.innerHTML = '';

  const today = new Date();

  weekDays.forEach((day, dayIndex) => {
    const isToday = isSameDay(day, today);
    const { dayName, dayNum } = getDayParts(day);

    // ── Header cell ──────────────────────────────────────────────────────────
    const header = document.createElement('div');
    header.className = 'day-header' + (isToday ? ' today' : '');
    header.innerHTML = `
      <span class="day-name">${dayName}</span>
      <span class="day-date">${dayNum}</span>
    `;
    dayHeaders.appendChild(header);

    // ── Day column ───────────────────────────────────────────────────────────
    const col = document.createElement('div');
    col.className = 'day-col' + (isToday ? ' today' : '');
    col.dataset.dayIndex = dayIndex;

    // Hour & half-hour lines
    for (let h = 0; h < 24; h++) {
      const fullLine = document.createElement('div');
      fullLine.className = 'hour-line full-hour';
      fullLine.style.top = `${h * HOUR_HEIGHT}px`;
      col.appendChild(fullLine);

      const halfLine = document.createElement('div');
      halfLine.className = 'hour-line half-hour';
      halfLine.style.top = `${h * HOUR_HEIGHT + HOUR_HEIGHT / 2}px`;
      col.appendChild(halfLine);
    }
    // Bottom border line (24:00)
    const bottomLine = document.createElement('div');
    bottomLine.className = 'hour-line full-hour';
    bottomLine.style.top = `${24 * HOUR_HEIGHT}px`;
    col.appendChild(bottomLine);

    // Events for this day
    const dayEvents = events.filter(ev => {
      const evStart = new Date(ev.start_at);
      return isSameDay(evStart, day);
    });

    const laid = computeLayout(dayEvents);
    laid.forEach(({ event, colIndex, colCount }) => {
      const block = buildEventBlock(event, colIndex, colCount, day);
      col.appendChild(block);
    });

    // Drag-to-create interaction
    attachDragCreate(col, day);

    dayColumns.appendChild(col);
  });
}

// ─── Build an event block element ─────────────────────────────────────────────
function buildEventBlock(event, colIndex, colCount, day) {
  const startDate = new Date(event.start_at);
  const endDate   = new Date(event.end_at);

  // Day boundaries
  const dayMidnight = new Date(day);
  dayMidnight.setHours(0, 0, 0, 0);
  // dayEnd24 is next-day midnight (JS normalises setHours(24) → next day 00:00)
  const dayEnd24 = new Date(day);
  dayEnd24.setHours(24, 0, 0, 0);

  // Clamp start to [dayMidnight, dayEnd24)
  const clampedStart = startDate < dayMidnight ? dayMidnight : startDate;

  // Use endTimeToPixel which computes from dayMidnight offset, handling 24:00 correctly
  const top    = timeToPixel(clampedStart, HOUR_HEIGHT);
  // For end: compute pixel from dayMidnight offset (handles 24:00 roll-over)
  const rawEndPx = endTimeToPixel(endDate, dayMidnight, HOUR_HEIGHT);
  // Clamp end to [top, TOTAL_HEIGHT]
  const bottom = Math.min(rawEndPx, TOTAL_HEIGHT);
  const height = Math.max(bottom - top, 18); // minimum 18px so text is readable

  // Horizontal layout: percentage-based within the column
  const widthPct  = 100 / colCount;
  const leftPct   = (colIndex / colCount) * 100;

  // Small gap between adjacent event columns (2px each side, except outer edges)
  const GAP = 2;
  const leftOffset  = colIndex === 0 ? 0 : GAP;
  const rightOffset = colIndex === colCount - 1 ? 0 : GAP;

  const block = document.createElement('div');
  block.className = 'event-block';
  block.style.top    = `${top}px`;
  block.style.height = `${height}px`;
  block.style.left   = `calc(${leftPct}% + ${leftOffset}px)`;
  block.style.width  = `calc(${widthPct}% - ${leftOffset + rightOffset}px)`;

  // Vary hue slightly by event id for visual distinction
  const hue = (event.id * 47 + 200) % 360;
  block.style.background = `hsl(${hue}, 65%, 48%)`;
  block.style.borderLeftColor = `hsl(${hue}, 65%, 35%)`;

  block.innerHTML = `
    <div class="ev-title">${escapeHtml(event.title)}</div>
    <div class="ev-time">${formatTime(startDate)} – ${formatTime(endDate)}</div>
  `;

  block.addEventListener('click', (e) => {
    e.stopPropagation();
    openEditModal(event);
  });

  return block;
}

// ─── Drag-to-create ───────────────────────────────────────────────────────────
// We use a single global drag state so that mousemove/mouseup work even when
// the pointer leaves the originating column.
let _dragState = null; // { col, day, startY, ghost }

document.addEventListener('mousemove', (e) => {
  if (!_dragState) return;
  const { col, startY, ghost } = _dragState;
  const rect = col.getBoundingClientRect();
  const y = clampY(e.clientY - rect.top + scrollContainer.scrollTop);
  updateGhost(ghost, startY, y);
});

document.addEventListener('mouseup', (e) => {
  if (!_dragState) return;
  const { col, day, startY, ghost } = _dragState;
  _dragState = null;

  const rect = col.getBoundingClientRect();
  const y = clampY(e.clientY - rect.top + scrollContainer.scrollTop);
  ghost.remove();

  const yStart = Math.min(startY, y);
  const yEnd   = Math.max(startY, y);

  // Snap to 15-minute intervals
  const startTime = snapToMinutes(pixelToTime(yStart, HOUR_HEIGHT, day), 15);
  let   endTime   = snapToMinutes(pixelToTime(yEnd,   HOUR_HEIGHT, day), 15);

  // Minimum 15 minutes
  if (endTime <= startTime) {
    endTime = new Date(startTime.getTime() + 15 * 60 * 1000);
  }

  openCreateModal(startTime, endTime);
});

function attachDragCreate(col, day) {
  col.addEventListener('mousedown', (e) => {
    // Only left-click on the column background (not on event blocks)
    if (e.button !== 0) return;
    if (e.target.closest('.event-block')) return;

    e.preventDefault();
    const rect = col.getBoundingClientRect();
    const y = clampY(e.clientY - rect.top + scrollContainer.scrollTop);

    const ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    updateGhost(ghost, y, y);
    col.appendChild(ghost);

    _dragState = { col, day, startY: y, ghost };
  });
}

function clampY(y) {
  return Math.max(0, Math.min(y, TOTAL_HEIGHT));
}

function updateGhost(ghost, y1, y2) {
  const top    = Math.min(y1, y2);
  const height = Math.max(Math.abs(y2 - y1), 4);
  ghost.style.top    = `${top}px`;
  ghost.style.height = `${height}px`;
  ghost.style.left   = '2px';
  ghost.style.right  = '2px';
}

function snapToMinutes(date, minutes) {
  const d = new Date(date);
  const m = d.getMinutes();
  const snapped = Math.round(m / minutes) * minutes;
  d.setMinutes(snapped, 0, 0);
  return d;
}

// ─── Modal ────────────────────────────────────────────────────────────────────
function openCreateModal(startTime, endTime) {
  editingEventId = null;
  modalTitle.textContent = 'New Event';
  fTitle.value = '';
  fStart.value = toDatetimeLocal(startTime);
  fEnd.value   = toDatetimeLocal(endTime);
  btnDelete.classList.add('hidden');
  showError('');
  modalOverlay.classList.remove('hidden');
  fTitle.focus();
}

function openEditModal(event) {
  editingEventId = event.id;
  modalTitle.textContent = 'Edit Event';
  fTitle.value = event.title;
  fStart.value = toDatetimeLocal(new Date(event.start_at));
  fEnd.value   = toDatetimeLocal(new Date(event.end_at));
  btnDelete.classList.remove('hidden');
  showError('');
  modalOverlay.classList.remove('hidden');
  fTitle.focus();
}

function closeModal() {
  modalOverlay.classList.add('hidden');
  editingEventId = null;
}

function showError(msg) {
  if (msg) {
    formError.textContent = msg;
    formError.classList.remove('hidden');
  } else {
    formError.textContent = '';
    formError.classList.add('hidden');
  }
}

btnCancel.addEventListener('click', closeModal);
modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeModal();
});

// Keyboard: Escape closes modal
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modalOverlay.classList.contains('hidden')) {
    closeModal();
  }
});

// ─── Form submission ──────────────────────────────────────────────────────────
eventForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  showError('');

  const title    = fTitle.value.trim();
  const startVal = fStart.value;
  const endVal   = fEnd.value;

  if (!title) { showError('Title is required.'); return; }
  if (!startVal) { showError('Start time is required.'); return; }
  if (!endVal)   { showError('End time is required.'); return; }

  const startISO = new Date(startVal).toISOString();
  const endISO   = new Date(endVal).toISOString();

  if (new Date(endISO) <= new Date(startISO)) {
    showError('End time must be after start time.');
    return;
  }

  btnSave.disabled = true;
  try {
    if (editingEventId === null) {
      await api.createEvent({ title, start_at: startISO, end_at: endISO });
    } else {
      await api.updateEvent(editingEventId, { title, start_at: startISO, end_at: endISO });
    }
    closeModal();
    await loadAndRender();
  } catch (err) {
    showError(err.data?.error || err.message || 'Failed to save event.');
  } finally {
    btnSave.disabled = false;
  }
});

// ─── Delete ───────────────────────────────────────────────────────────────────
btnDelete.addEventListener('click', async () => {
  if (editingEventId === null) return;
  if (!confirm('Delete this event?')) return;

  btnDelete.disabled = true;
  try {
    await api.deleteEvent(editingEventId);
    closeModal();
    await loadAndRender();
  } catch (err) {
    showError(err.data?.error || err.message || 'Failed to delete event.');
  } finally {
    btnDelete.disabled = false;
  }
});

// ─── Scroll to hour ───────────────────────────────────────────────────────────
function scrollToHour(hour) {
  scrollContainer.scrollTop = hour * HOUR_HEIGHT;
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
