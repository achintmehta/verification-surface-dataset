/**
 * Calendar Week View – main entry point.
 *
 * Responsibilities:
 *  - Render the week grid (time axis + 7 day columns).
 *  - Fetch and render events with the cluster overlap layout.
 *  - Handle week navigation (prev / today / next).
 *  - Handle event creation via click-drag on the grid.
 *  - Handle event editing/deletion via clicking an event block.
 */

import { computeDayLayout, minutesFromMidnight } from './layout.js';
import { fetchEvents, createEvent, updateEvent, deleteEvent } from './api.js';
import {
  getWeekStart, getWeekEnd, getWeekDays, shiftWeek,
  formatWeekLabel, formatTime, toDatetimeLocal, isToday,
} from './week.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Pixels per hour. Must match --hour-height in style.css */
const HOUR_HEIGHT = 60;
/** Total height of the day body in pixels */
const TOTAL_HEIGHT = HOUR_HEIGHT * 24;
/** Minimum drag distance in pixels to open the create form */
const MIN_DRAG_PX = 4;
/** Minimum event duration in minutes when clicking (not dragging) */
const DEFAULT_DURATION_MIN = 60;

// ─── State ────────────────────────────────────────────────────────────────────

let currentWeekStart = getWeekStart(new Date());
let events = [];

// Modal state
let editingEventId = null;

// Drag state
let dragState = null;

// ─── DOM References ───────────────────────────────────────────────────────────

const weekLabel    = document.getElementById('week-label');
const daysGrid     = document.getElementById('days-grid');
const timeAxisLabels = document.getElementById('time-axis-labels');
const modalOverlay = document.getElementById('modal-overlay');
const modalTitle   = document.getElementById('modal-title');
const eventForm    = document.getElementById('event-form');
const fieldTitle   = document.getElementById('field-title');
const fieldStart   = document.getElementById('field-start');
const fieldEnd     = document.getElementById('field-end');
const formError    = document.getElementById('form-error');
const btnSave      = document.getElementById('btn-save');
const btnDelete    = document.getElementById('btn-delete');
const btnCancel    = document.getElementById('btn-cancel');

// ─── Time Axis ────────────────────────────────────────────────────────────────

function renderTimeAxis() {
  timeAxisLabels.innerHTML = '';
  for (let h = 0; h <= 24; h++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = `${h * HOUR_HEIGHT}px`;
    label.textContent = h === 24 ? '' : `${String(h).padStart(2, '0')}:00`;
    timeAxisLabels.appendChild(label);
  }
}

// ─── Grid Lines ───────────────────────────────────────────────────────────────

function renderGridLines(dayBody) {
  for (let h = 0; h < 24; h++) {
    // Hour line
    const hourLine = document.createElement('div');
    hourLine.className = 'hour-line';
    hourLine.style.top = `${h * HOUR_HEIGHT}px`;
    dayBody.appendChild(hourLine);

    // Half-hour line
    const halfLine = document.createElement('div');
    halfLine.className = 'half-hour-line';
    halfLine.style.top = `${h * HOUR_HEIGHT + HOUR_HEIGHT / 2}px`;
    dayBody.appendChild(halfLine);
  }
  // Bottom border at 24:00
  const bottomLine = document.createElement('div');
  bottomLine.className = 'hour-line';
  bottomLine.style.top = `${24 * HOUR_HEIGHT}px`;
  dayBody.appendChild(bottomLine);
}

// ─── Event Rendering ──────────────────────────────────────────────────────────

/**
 * Convert minutes-from-midnight to a pixel offset.
 * Clamped to [0, TOTAL_HEIGHT].
 */
function minutesToPx(minutes) {
  return Math.max(0, Math.min(TOTAL_HEIGHT, (minutes / 60) * HOUR_HEIGHT));
}

/**
 * Render all events for a single day column.
 * @param {HTMLElement} dayBody
 * @param {Array} dayEvents  Events belonging to this day
 */
function renderDayEvents(dayBody, dayEvents) {
  // Remove existing event blocks (keep grid lines)
  dayBody.querySelectorAll('.event-block').forEach(el => el.remove());

  if (dayEvents.length === 0) return;

  const layoutItems = computeDayLayout(dayEvents);

  // The day string for clamping end times that cross midnight
  const dayStr = dayBody.dataset.date; // "YYYY-MM-DD"

  for (const { event, colIndex, colCount } of layoutItems) {
    const startMin = minutesFromMidnight(event.start_at, dayStr);
    const endMin   = minutesFromMidnight(event.end_at,   dayStr);

    // Clamp to [0, 1440] minutes
    const clampedStart = Math.max(0, Math.min(1440, startMin));
    const clampedEnd   = Math.max(0, Math.min(1440, endMin));

    const top    = minutesToPx(clampedStart);
    const height = Math.max(minutesToPx(clampedEnd) - top, 4); // min 4px so it's always visible

    // Width and left offset as percentages of the day column
    const widthPct = 100 / colCount;
    const leftPct  = (colIndex / colCount) * 100;

    const block = document.createElement('div');
    block.className = 'event-block';
    block.style.top    = `${top}px`;
    block.style.height = `${height}px`;
    block.style.left   = `${leftPct}%`;
    block.style.width  = `${widthPct}%`;

    const titleEl = document.createElement('div');
    titleEl.className = 'event-title';
    titleEl.textContent = event.title;

    const timeEl = document.createElement('div');
    timeEl.className = 'event-time';
    timeEl.textContent = `${formatTime(event.start_at)} – ${formatTime(event.end_at)}`;

    block.appendChild(titleEl);
    block.appendChild(timeEl);

    // Click to edit
    block.addEventListener('click', (e) => {
      e.stopPropagation();
      openEditModal(event);
    });

    dayBody.appendChild(block);
  }
}

// ─── Week Rendering ───────────────────────────────────────────────────────────

function renderWeek() {
  weekLabel.textContent = formatWeekLabel(currentWeekStart);
  daysGrid.innerHTML = '';

  const weekDays = getWeekDays(currentWeekStart);

  weekDays.forEach((day, dayIndex) => {
    const col = document.createElement('div');
    col.className = 'day-column';
    col.dataset.dayIndex = dayIndex;
    if (isToday(day)) col.classList.add('today');

    // Header
    const header = document.createElement('div');
    header.className = 'day-header';

    const dayName = document.createElement('div');
    dayName.className = 'day-name';
    dayName.textContent = day.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();

    const dayNumber = document.createElement('div');
    dayNumber.className = 'day-number';
    dayNumber.textContent = day.getDate();

    header.appendChild(dayName);
    header.appendChild(dayNumber);

    // Body
    const body = document.createElement('div');
    body.className = 'day-body';
    body.dataset.dayIndex = dayIndex;
    body.dataset.date = day.toISOString().slice(0, 10); // "YYYY-MM-DD"

    renderGridLines(body);

    // Drag-to-create listeners
    body.addEventListener('mousedown', onDayBodyMouseDown);

    col.appendChild(header);
    col.appendChild(body);
    daysGrid.appendChild(col);
  });

  renderEvents();
}

/**
 * Re-render events on the current week grid (without rebuilding the grid).
 */
function renderEvents() {
  const weekDays = getWeekDays(currentWeekStart);

  weekDays.forEach((day, dayIndex) => {
    const body = daysGrid.querySelector(`.day-body[data-day-index="${dayIndex}"]`);
    if (!body) return;

    // Filter events that belong to this day (by start_at date)
    const dayStr = day.toISOString().slice(0, 10);
    const dayEvents = events.filter(ev => ev.start_at.slice(0, 10) === dayStr);

    renderDayEvents(body, dayEvents);
  });
}

// ─── Data Loading ─────────────────────────────────────────────────────────────

async function loadWeek() {
  const start = currentWeekStart.toISOString();
  const end   = getWeekEnd(currentWeekStart).toISOString();

  try {
    events = await fetchEvents(start, end);
    renderEvents();
  } catch (err) {
    console.error('Failed to load events:', err);
  }
}

// ─── Navigation ───────────────────────────────────────────────────────────────

document.getElementById('btn-prev').addEventListener('click', () => {
  currentWeekStart = shiftWeek(currentWeekStart, -1);
  renderWeek();
  loadWeek();
});

document.getElementById('btn-today').addEventListener('click', () => {
  currentWeekStart = getWeekStart(new Date());
  renderWeek();
  loadWeek();
});

document.getElementById('btn-next').addEventListener('click', () => {
  currentWeekStart = shiftWeek(currentWeekStart, 1);
  renderWeek();
  loadWeek();
});

// ─── Drag-to-Create ───────────────────────────────────────────────────────────

/**
 * Convert a Y offset within a day body to minutes from midnight.
 * Clamped to [0, 1440].
 */
function yToMinutes(y) {
  const minutes = (y / HOUR_HEIGHT) * 60;
  return Math.max(0, Math.min(1440, minutes));
}

/**
 * Snap minutes to the nearest 15-minute interval.
 */
function snapMinutes(minutes) {
  return Math.round(minutes / 15) * 15;
}

/**
 * Build a datetime-local string for a given day and minutes-from-midnight.
 * @param {string} dateStr  "YYYY-MM-DD"
 * @param {number} minutes  [0, 1440]
 * @returns {string}  "YYYY-MM-DDTHH:MM"
 */
function buildDatetimeLocal(dateStr, minutes) {
  const clampedMin = Math.max(0, Math.min(1440, minutes));
  // Handle 24:00 → next day 00:00
  if (clampedMin >= 1440) {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + 1);
    return toDatetimeLocal(d);
  }
  const h = Math.floor(clampedMin / 60);
  const m = clampedMin % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${dateStr}T${pad(h)}:${pad(m)}`;
}

function onDayBodyMouseDown(e) {
  // Only left button, not on event blocks
  if (e.button !== 0) return;
  if (e.target.closest('.event-block')) return;

  const body = e.currentTarget;
  const rect = body.getBoundingClientRect();
  const startY = e.clientY - rect.top;

  // Create ghost element
  const ghost = document.createElement('div');
  ghost.className = 'drag-ghost';
  ghost.style.top    = `${startY}px`;
  ghost.style.height = '0px';
  ghost.style.left   = '0';
  ghost.style.right  = '0';
  body.appendChild(ghost);

  dragState = {
    body,
    startY,
    currentY: startY,
    ghost,
    date: body.dataset.date,
  };

  // Prevent text selection during drag
  e.preventDefault();
}

function onMouseMove(e) {
  if (!dragState) return;

  const rect = dragState.body.getBoundingClientRect();
  const currentY = Math.max(0, Math.min(TOTAL_HEIGHT, e.clientY - rect.top));
  dragState.currentY = currentY;

  const top    = Math.min(dragState.startY, currentY);
  const height = Math.abs(currentY - dragState.startY);

  dragState.ghost.style.top    = `${top}px`;
  dragState.ghost.style.height = `${height}px`;
}

function onMouseUp(e) {
  if (!dragState) return;

  const { body, startY, ghost, date } = dragState;
  dragState = null;
  ghost.remove();

  const rect = body.getBoundingClientRect();
  const endY = Math.max(0, Math.min(TOTAL_HEIGHT, e.clientY - rect.top));
  const dragDistance = Math.abs(endY - startY);

  let startMin, endMin;

  if (dragDistance < MIN_DRAG_PX) {
    // Treat as a click: snap to nearest 15 min, default 1-hour duration
    startMin = snapMinutes(yToMinutes(startY));
    endMin   = Math.min(1440, startMin + DEFAULT_DURATION_MIN);
  } else {
    // Drag: snap both ends
    const rawStart = yToMinutes(Math.min(startY, endY));
    const rawEnd   = yToMinutes(Math.max(startY, endY));
    startMin = snapMinutes(rawStart);
    endMin   = snapMinutes(rawEnd);
    if (endMin <= startMin) endMin = startMin + 15;
  }

  const startValue = buildDatetimeLocal(date, startMin);
  const endValue   = buildDatetimeLocal(date, endMin);

  openCreateModal(startValue, endValue);
}

document.addEventListener('mousemove', onMouseMove);
document.addEventListener('mouseup', onMouseUp);

// ─── Modal ────────────────────────────────────────────────────────────────────

function showError(msg) {
  formError.textContent = msg;
  formError.classList.remove('hidden');
}

function hideError() {
  formError.classList.add('hidden');
  formError.textContent = '';
}

function openCreateModal(startValue, endValue) {
  editingEventId = null;
  modalTitle.textContent = 'New Event';
  fieldTitle.value = '';
  fieldStart.value = startValue;
  fieldEnd.value   = endValue;
  btnDelete.classList.add('hidden');
  hideError();
  modalOverlay.classList.remove('hidden');
  fieldTitle.focus();
}

function openEditModal(event) {
  editingEventId = event.id;
  modalTitle.textContent = 'Edit Event';
  fieldTitle.value = event.title;
  // Slice to "YYYY-MM-DDTHH:MM" for datetime-local input
  fieldStart.value = event.start_at.slice(0, 16);
  fieldEnd.value   = event.end_at.slice(0, 16);
  btnDelete.classList.remove('hidden');
  hideError();
  modalOverlay.classList.remove('hidden');
  fieldTitle.focus();
}

function closeModal() {
  modalOverlay.classList.add('hidden');
  editingEventId = null;
  hideError();
}

btnCancel.addEventListener('click', closeModal);

modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeModal();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});

// ─── Form Submission ──────────────────────────────────────────────────────────

eventForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError();

  const title    = fieldTitle.value.trim();
  const startVal = fieldStart.value;
  const endVal   = fieldEnd.value;

  if (!title) {
    showError('Title is required.');
    fieldTitle.focus();
    return;
  }

  if (!startVal || !endVal) {
    showError('Start and end times are required.');
    return;
  }

  const startDate = new Date(startVal);
  const endDate   = new Date(endVal);

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    showError('Invalid date/time values.');
    return;
  }

  if (endDate <= startDate) {
    showError('End time must be after start time.');
    return;
  }

  const payload = {
    title,
    start_at: startDate.toISOString(),
    end_at:   endDate.toISOString(),
  };

  btnSave.disabled    = true;
  btnSave.textContent = 'Saving…';

  try {
    if (editingEventId !== null) {
      const updated = await updateEvent(editingEventId, payload);
      // Replace in local array
      const idx = events.findIndex(ev => ev.id === editingEventId);
      if (idx !== -1) events[idx] = updated;
      else events.push(updated);
    } else {
      const created = await createEvent(payload);
      events.push(created);
    }

    closeModal();
    renderEvents();
  } catch (err) {
    showError(err.message || 'Failed to save event.');
  } finally {
    btnSave.disabled    = false;
    btnSave.textContent = 'Save';
  }
});

// ─── Delete ───────────────────────────────────────────────────────────────────

btnDelete.addEventListener('click', async () => {
  if (editingEventId === null) return;

  if (!confirm('Delete this event?')) return;

  btnDelete.disabled    = true;
  btnDelete.textContent = 'Deleting…';

  try {
    await deleteEvent(editingEventId);
    events = events.filter(ev => ev.id !== editingEventId);
    closeModal();
    renderEvents();
  } catch (err) {
    showError(err.message || 'Failed to delete event.');
  } finally {
    btnDelete.disabled    = false;
    btnDelete.textContent = 'Delete';
  }
});

// ─── Initial Render ───────────────────────────────────────────────────────────

renderTimeAxis();
renderWeek();
loadWeek();
