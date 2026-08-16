/**
 * Week Calendar — main entry point.
 *
 * Responsibilities:
 *  - Render the week grid (time axis, day headers, hour lines, day columns).
 *  - Fetch events from the API and render them with the overlap layout engine.
 *  - Handle drag-to-create on empty space.
 *  - Handle click-to-edit on existing events.
 *  - Week navigation (prev / today / next).
 *  - Modal form for create / edit / delete.
 */

import { computeDayLayout, isoToMinutes } from './layout.js';
import { fetchEvents, createEvent, updateEvent, deleteEvent } from './api.js';
import {
  getWeekStart, getWeekDays, formatDayHeader, formatWeekLabel,
  isToday, toDatetimeLocal, formatTime, dayPlusMinutes,
} from './dates.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Must match --hour-height CSS variable */
const HOUR_HEIGHT = 60; // px per hour
const TOTAL_MINUTES = 24 * 60; // 1440
const GRID_HEIGHT = HOUR_HEIGHT * 24; // 1440px

/** Snap interval for drag-create (minutes) */
const SNAP_MINUTES = 15;

// ─── State ────────────────────────────────────────────────────────────────────

let currentWeekStart = getWeekStart(new Date());
let events = []; // all events for the current week

// Drag state
let dragState = null; // { dayIndex, startMin, endMin, ghost }

// Modal state
let modalMode = null; // 'create' | 'edit'
let editingEventId = null;

// ─── DOM References ───────────────────────────────────────────────────────────

const weekLabel    = document.getElementById('week-label');
const dayHeaders   = document.getElementById('day-headers');
const timeAxis     = document.getElementById('time-axis');
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

document.getElementById('btn-prev').addEventListener('click', () => navigateWeek(-1));
document.getElementById('btn-today').addEventListener('click', () => navigateToday());
document.getElementById('btn-next').addEventListener('click', () => navigateWeek(1));

btnCancel.addEventListener('click', closeModal);
btnDelete.addEventListener('click', handleDelete);
eventForm.addEventListener('submit', handleFormSubmit);

// Close modal on overlay click
modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeModal();
});

// ─── Initialization ───────────────────────────────────────────────────────────

buildStaticGrid();
loadAndRender();

// Scroll to 07:00 on load
gridScroll.scrollTop = HOUR_HEIGHT * 7;

// ─── Grid Construction ────────────────────────────────────────────────────────

/**
 * Build the static parts of the grid that don't change between weeks:
 * time axis labels and hour lines.
 */
function buildStaticGrid() {
  // Time axis labels (00:00 – 23:00, one per hour)
  timeAxis.innerHTML = '';
  for (let h = 0; h <= 23; h++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.textContent = `${String(h).padStart(2, '0')}:00`;
    timeAxis.appendChild(label);
  }

  // Hour lines
  hourLines.innerHTML = '';
  for (let h = 0; h <= 24; h++) {
    const line = document.createElement('div');
    line.className = `hour-line${h % 1 === 0 ? ' major' : ''}`;
    line.style.top = `${h * HOUR_HEIGHT}px`;
    hourLines.appendChild(line);

    // Half-hour line (except after 24:00)
    if (h < 24) {
      const half = document.createElement('div');
      half.className = 'half-hour-line';
      half.style.top = `${h * HOUR_HEIGHT + HOUR_HEIGHT / 2}px`;
      hourLines.appendChild(half);
    }
  }
}

// ─── Week Rendering ───────────────────────────────────────────────────────────

/**
 * Render the week header and day columns for the current week.
 */
function renderWeekChrome() {
  const days = getWeekDays(currentWeekStart);

  // Week label
  weekLabel.textContent = formatWeekLabel(currentWeekStart);

  // Day headers
  dayHeaders.innerHTML = '';
  days.forEach((day) => {
    const { dayName, dayNum } = formatDayHeader(day);
    const header = document.createElement('div');
    header.className = `day-header${isToday(day) ? ' today' : ''}`;
    header.innerHTML = `
      <span class="day-name">${dayName}</span>
      <span class="day-date">${dayNum}</span>
    `;
    dayHeaders.appendChild(header);
  });

  // Day columns (empty — events rendered separately)
  dayColumns.innerHTML = '';
  days.forEach((day, dayIndex) => {
    const col = document.createElement('div');
    col.className = `day-col${isToday(day) ? ' today' : ''}`;
    col.dataset.dayIndex = dayIndex;

    // Drag-to-create listeners
    col.addEventListener('mousedown', (e) => onDayMouseDown(e, dayIndex, day));

    dayColumns.appendChild(col);
  });
}

/**
 * Render all events for the current week into their day columns.
 */
function renderEvents() {
  const days = getWeekDays(currentWeekStart);

  // Clear existing event blocks from all columns
  dayColumns.querySelectorAll('.event-block').forEach(el => el.remove());

  // Group events by day index
  const eventsByDay = Array.from({ length: 7 }, () => []);

  for (const ev of events) {
    const evStart = new Date(ev.start_at);
    for (let i = 0; i < 7; i++) {
      if (isSameDayLocal(evStart, days[i])) {
        eventsByDay[i].push(ev);
        break;
      }
    }
  }

  // Render each day
  const cols = dayColumns.querySelectorAll('.day-col');
  days.forEach((day, dayIndex) => {
    const col = cols[dayIndex];
    const dayEvents = eventsByDay[dayIndex];
    const layout = computeDayLayout(dayEvents);

    for (const { event: ev, colIndex, colTotal } of layout) {
      renderEventBlock(col, ev, colIndex, colTotal);
    }
  });
}

/**
 * Render a single event block into a day column.
 * @param {HTMLElement} col
 * @param {Object} ev
 * @param {number} colIndex
 * @param {number} colTotal
 */
function renderEventBlock(col, ev, colIndex, colTotal) {
  const startMin = isoToMinutes(ev.start_at);
  // Compute end minutes relative to the same day as start.
  // An event ending at 24:00 is stored as next-day 00:00, so we detect that
  // and treat it as 1440 minutes.
  const endMin = isoToMinutesRelative(ev.start_at, ev.end_at);
  const durationMin = Math.max(1, endMin - startMin); // at least 1 minute visible

  const topPx    = minutesToPx(startMin);
  const heightPx = minutesToPx(durationMin);

  // Width and left offset as percentages of the column
  const widthPct  = 100 / colTotal;
  const leftPct   = (colIndex / colTotal) * 100;

  // Small gap between adjacent event columns for visual separation
  const GAP = 2; // px
  const gapLeft  = colIndex === 0 ? 0 : GAP / 2;
  const gapRight = colIndex === colTotal - 1 ? 0 : GAP / 2;

  const block = document.createElement('div');
  block.className = 'event-block';
  block.dataset.eventId = ev.id;

  block.style.top    = `${topPx}px`;
  block.style.height = `${heightPx}px`;
  block.style.left   = `calc(${leftPct}% + ${gapLeft}px)`;
  block.style.width  = `calc(${widthPct}% - ${gapLeft + gapRight}px)`;

  // Color variation based on id for visual distinction
  const hue = (ev.id * 47 + 200) % 360;
  block.style.background = `hsl(${hue}, 65%, 48%)`;

  block.innerHTML = `
    <div class="ev-title">${escapeHtml(ev.title)}</div>
    <div class="ev-time">${formatTime(ev.start_at)} – ${formatTime(ev.end_at)}</div>
  `;

  block.addEventListener('click', (e) => {
    e.stopPropagation();
    openEditModal(ev);
  });

  col.appendChild(block);
}

// ─── Time ↔ Pixel Helpers ─────────────────────────────────────────────────────

/** Convert minutes-from-midnight to pixels. */
function minutesToPx(minutes) {
  return (minutes / 60) * HOUR_HEIGHT;
}

/** Convert a Y offset (px) within a day column to minutes-from-midnight. */
function pxToMinutes(px) {
  return (px / HOUR_HEIGHT) * 60;
}

/** Snap minutes to the nearest SNAP_MINUTES interval. */
function snapMinutes(minutes) {
  return Math.round(minutes / SNAP_MINUTES) * SNAP_MINUTES;
}

// ─── Drag-to-Create ───────────────────────────────────────────────────────────

function onDayMouseDown(e, dayIndex, day) {
  // Only left button; ignore clicks on event blocks
  if (e.button !== 0) return;
  if (e.target.closest('.event-block')) return;

  e.preventDefault();

  const col = dayColumns.querySelectorAll('.day-col')[dayIndex];

  // Y position relative to the top of the scrollable grid body.
  // col is absolutely positioned inside #grid-body which is inside #grid-scroll.
  // getBoundingClientRect().top gives viewport-relative top of the column.
  // Adding scrollTop converts to the grid-body coordinate space.
  const colRect = col.getBoundingClientRect();
  const yInColumn = e.clientY - colRect.top + gridScroll.scrollTop;

  // Clamp to grid
  const rawMinutes = pxToMinutes(Math.max(0, Math.min(GRID_HEIGHT, yInColumn)));
  const startMin = Math.max(0, Math.min(TOTAL_MINUTES - SNAP_MINUTES, snapMinutes(rawMinutes)));
  const endMin   = Math.min(TOTAL_MINUTES, startMin + SNAP_MINUTES);

  // Create ghost element
  const ghost = document.createElement('div');
  ghost.className = 'drag-ghost';
  ghost.style.top    = `${minutesToPx(startMin)}px`;
  ghost.style.height = `${minutesToPx(endMin - startMin)}px`;
  ghost.style.left   = '0';
  ghost.style.right  = '0';
  col.appendChild(ghost);

  dragState = { dayIndex, day, startMin, endMin, ghost, col };

  const onMouseMove = (e2) => {
    if (!dragState) return;
    // Re-read colRect in case of scroll
    const currentColRect = dragState.col.getBoundingClientRect();
    const yNow = e2.clientY - currentColRect.top + gridScroll.scrollTop;
    const rawEnd = pxToMinutes(Math.max(0, Math.min(GRID_HEIGHT, yNow)));
    const snappedEnd = snapMinutes(rawEnd);

    // Ensure at least one snap interval
    const newEnd = Math.max(dragState.startMin + SNAP_MINUTES, Math.min(TOTAL_MINUTES, snappedEnd));
    dragState.endMin = newEnd;

    ghost.style.top    = `${minutesToPx(dragState.startMin)}px`;
    ghost.style.height = `${minutesToPx(newEnd - dragState.startMin)}px`;
  };

  const onMouseUp = () => {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);

    if (!dragState) return;
    const { day: d, startMin: s, endMin: en, ghost: g } = dragState;
    g.remove();
    dragState = null;

    // Open create modal with pre-filled times
    openCreateModal(d, s, en);
  };

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
}

// ─── Modal ────────────────────────────────────────────────────────────────────

function openCreateModal(day, startMin, endMin) {
  modalMode = 'create';
  editingEventId = null;
  modalTitle.textContent = 'New Event';
  btnDelete.classList.add('hidden');
  formError.classList.add('hidden');
  formError.textContent = '';

  fTitle.value = '';
  fStart.value = toDatetimeLocal(dayPlusMinutes(day, startMin));
  fEnd.value   = toDatetimeLocal(dayPlusMinutes(day, endMin));

  modalOverlay.classList.remove('hidden');
  fTitle.focus();
}

function openEditModal(ev) {
  modalMode = 'edit';
  editingEventId = ev.id;
  modalTitle.textContent = 'Edit Event';
  btnDelete.classList.remove('hidden');
  formError.classList.add('hidden');
  formError.textContent = '';

  fTitle.value = ev.title;
  fStart.value = toDatetimeLocal(new Date(ev.start_at));
  fEnd.value   = toDatetimeLocal(new Date(ev.end_at));

  modalOverlay.classList.remove('hidden');
  fTitle.focus();
}

function closeModal() {
  modalOverlay.classList.add('hidden');
  modalMode = null;
  editingEventId = null;
}

function showFormError(msg) {
  formError.textContent = msg;
  formError.classList.remove('hidden');
}

async function handleFormSubmit(e) {
  e.preventDefault();
  formError.classList.add('hidden');

  const title    = fTitle.value.trim();
  const startVal = fStart.value;
  const endVal   = fEnd.value;

  if (!title) {
    showFormError('Title is required.');
    return;
  }
  if (!startVal || !endVal) {
    showFormError('Start and end times are required.');
    return;
  }

  const startDate = new Date(startVal);
  const endDate   = new Date(endVal);

  if (isNaN(startDate) || isNaN(endDate)) {
    showFormError('Invalid date/time values.');
    return;
  }
  if (endDate <= startDate) {
    showFormError('End time must be after start time.');
    return;
  }

  const payload = {
    title,
    start_at: toLocalISOString(startDate),
    end_at:   toLocalISOString(endDate),
  };

  btnSave.disabled = true;
  try {
    if (modalMode === 'create') {
      await createEvent(payload);
    } else {
      await updateEvent(editingEventId, payload);
    }
    closeModal();
    await loadAndRender();
  } catch (err) {
    showFormError(err.message || 'Failed to save event.');
  } finally {
    btnSave.disabled = false;
  }
}

async function handleDelete() {
  if (!editingEventId) return;
  btnDelete.disabled = true;
  try {
    await deleteEvent(editingEventId);
    closeModal();
    await loadAndRender();
  } catch (err) {
    showFormError(err.message || 'Failed to delete event.');
  } finally {
    btnDelete.disabled = false;
  }
}

// ─── Navigation ───────────────────────────────────────────────────────────────

function navigateWeek(delta) {
  const d = new Date(currentWeekStart);
  d.setDate(d.getDate() + delta * 7);
  currentWeekStart = d;
  loadAndRender();
}

function navigateToday() {
  currentWeekStart = getWeekStart(new Date());
  loadAndRender();
}

// ─── Data Loading ─────────────────────────────────────────────────────────────

async function loadAndRender() {
  // Week range: Monday 00:00 to Sunday+1 00:00 (local time)
  const weekEnd = new Date(currentWeekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);

  try {
    events = await fetchEvents(
      toLocalISOString(currentWeekStart),
      toLocalISOString(weekEnd)
    );
  } catch (err) {
    console.error('Failed to load events:', err);
    events = [];
  }

  renderWeekChrome();
  renderEvents();
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function isSameDayLocal(a, b) {
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth()    === b.getMonth()    &&
         a.getDate()     === b.getDate();
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Format a Date as a local ISO string "YYYY-MM-DDTHH:MM:SS" (no timezone suffix).
 * This ensures the server stores and retrieves times in local time.
 * @param {Date} date
 * @returns {string}
 */
function toLocalISOString(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
         `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Compute end minutes relative to the start day.
 * Handles the case where an event ends at 24:00 (stored as next-day 00:00).
 * Returns a value in [0, 1440].
 * @param {string} startIso
 * @param {string} endIso
 * @returns {number}
 */
function isoToMinutesRelative(startIso, endIso) {
  const startDate = new Date(startIso);
  const endDate   = new Date(endIso);

  // Minutes from midnight of the start day to the end time
  const startDayMidnight = new Date(startDate);
  startDayMidnight.setHours(0, 0, 0, 0);

  const msFromMidnight = endDate.getTime() - startDayMidnight.getTime();
  const minutes = msFromMidnight / 60000;

  // Clamp to [0, 1440]
  return Math.min(1440, Math.max(0, minutes));
}
