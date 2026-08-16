/**
 * Week Calendar – main entry point.
 *
 * Responsibilities:
 *  - Render the week grid (time axis + 7 day columns)
 *  - Fetch events for the current week and render them with overlap layout
 *  - Handle drag-to-create on empty space
 *  - Handle click-to-edit on event blocks
 *  - Week navigation (prev / today / next)
 */

import {
  getWeekStart,
  getWeekEnd,
  computeWeekLayout,
  getDayIndex,
  minutesToPx,
  dateToMinutes,
  formatTime,
  HOUR_HEIGHT,
} from './layout.js';
import { fetchEvents, createEvent, updateEvent, deleteEvent } from './api.js';
import { showCreateModal, showEditModal } from './modal.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const TOTAL_MINUTES = 24 * 60; // 1440
const AXIS_HEIGHT   = HOUR_HEIGHT * 24; // 1536px

const DAY_NAMES   = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const COLOR_COUNT = 7;

// ── State ─────────────────────────────────────────────────────────────────────

let currentWeekStart = getWeekStart(new Date());
let events = [];

// ── DOM References ────────────────────────────────────────────────────────────

let dayHeaders;
let dayColumns; // array of 7 .day-col elements
let gridScroll;

// Per-column drag state (indexed 0–6)
const dragState = Array.from({ length: 7 }, () => ({
  active:      false,
  startMin:    0,
  selectionEl: null,
}));

// ── Initialise ────────────────────────────────────────────────────────────────

function init() {
  renderShell();
  bindNavigation();
  loadAndRender();
  scrollToHour(7);
}

// ── Shell Render ──────────────────────────────────────────────────────────────

function renderShell() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div id="toolbar">
      <h1>📅 Week Calendar</h1>
      <button class="btn btn-nav" id="btn-prev">&#8592; Prev</button>
      <button class="btn btn-today" id="btn-today">Today</button>
      <button class="btn btn-nav" id="btn-next">Next &#8594;</button>
      <span id="week-label"></span>
    </div>

    <div id="calendar-container">
      <div id="time-gutter">
        <div id="time-gutter-header"></div>
        <div id="time-gutter-body">
          <div id="time-axis"></div>
        </div>
      </div>

      <div id="days-wrapper">
        <div id="day-headers"></div>
        <div id="grid-scroll">
          <div id="days-grid"></div>
        </div>
      </div>
    </div>
  `;

  // Build time axis labels
  const timeAxis = document.getElementById('time-axis');
  for (let h = 0; h <= 24; h++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = `${minutesToPx(h * 60)}px`;
    label.textContent = h === 24 ? '' : `${String(h).padStart(2, '0')}:00`;
    timeAxis.appendChild(label);
  }

  // Build 7 day columns with hour/half-hour lines
  const daysGrid = document.getElementById('days-grid');
  dayColumns = [];

  for (let d = 0; d < 7; d++) {
    const col = document.createElement('div');
    col.className = 'day-col';
    col.dataset.dayIndex = String(d);

    for (let h = 0; h <= 24; h++) {
      const line = document.createElement('div');
      line.className = (h === 0 || h === 24) ? 'hour-line midnight' : 'hour-line';
      line.style.top = `${minutesToPx(h * 60)}px`;
      col.appendChild(line);

      if (h < 24) {
        const half = document.createElement('div');
        half.className = 'half-hour-line';
        half.style.top = `${minutesToPx(h * 60 + 30)}px`;
        col.appendChild(half);
      }
    }

    daysGrid.appendChild(col);
    dayColumns.push(col);
  }

  dayHeaders = document.getElementById('day-headers');
  gridScroll = document.getElementById('grid-scroll');

  // Sync time-gutter scroll with grid scroll
  gridScroll.addEventListener('scroll', () => {
    document.getElementById('time-gutter-body').scrollTop = gridScroll.scrollTop;
  });

  // Attach drag-to-create listeners once (they delegate via dayColumns array)
  attachGlobalDragListeners();
}

// ── Navigation ────────────────────────────────────────────────────────────────

function bindNavigation() {
  document.getElementById('btn-prev').addEventListener('click', () => {
    currentWeekStart = new Date(currentWeekStart);
    currentWeekStart.setDate(currentWeekStart.getDate() - 7);
    loadAndRender();
  });
  document.getElementById('btn-today').addEventListener('click', () => {
    currentWeekStart = getWeekStart(new Date());
    loadAndRender();
  });
  document.getElementById('btn-next').addEventListener('click', () => {
    currentWeekStart = new Date(currentWeekStart);
    currentWeekStart.setDate(currentWeekStart.getDate() + 7);
    loadAndRender();
  });
}

// ── Load & Render ─────────────────────────────────────────────────────────────

async function loadAndRender() {
  updateWeekLabel();
  updateDayHeaders();
  clearEventBlocks();

  const weekEnd = getWeekEnd(currentWeekStart);
  try {
    events = await fetchEvents(
      currentWeekStart.toISOString(),
      weekEnd.toISOString()
    );
  } catch (err) {
    showStatus(`Failed to load events: ${err.message}`, 'error');
    events = [];
  }

  renderEvents();
}

function updateWeekLabel() {
  const weekEnd = getWeekEnd(currentWeekStart);
  const sunday  = new Date(weekEnd);
  sunday.setDate(sunday.getDate() - 1);

  const fmt = (d) =>
    `${d.getDate()} ${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
  document.getElementById('week-label').textContent =
    `${fmt(currentWeekStart)} – ${fmt(sunday)}`;
}

function updateDayHeaders() {
  dayHeaders.innerHTML = '';
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let d = 0; d < 7; d++) {
    const date = new Date(currentWeekStart);
    date.setDate(date.getDate() + d);
    const isToday = date.getTime() === today.getTime();

    const header = document.createElement('div');
    header.className = 'day-header' + (isToday ? ' today' : '');

    const nameEl = document.createElement('div');
    nameEl.className = 'day-name';
    nameEl.textContent = DAY_NAMES[d];

    const dateEl = document.createElement('div');
    dateEl.className = 'day-date';
    dateEl.textContent = date.getDate();

    header.appendChild(nameEl);
    header.appendChild(dateEl);
    dayHeaders.appendChild(header);

    if (isToday) {
      dayColumns[d].classList.add('today');
    } else {
      dayColumns[d].classList.remove('today');
    }
  }
}

function clearEventBlocks() {
  for (const col of dayColumns) {
    col.querySelectorAll('.event-block, .drag-selection').forEach(el => el.remove());
  }
}

// ── Event Rendering ───────────────────────────────────────────────────────────

function renderEvents() {
  const layoutMap = computeWeekLayout(events, currentWeekStart);

  for (const ev of events) {
    const layout = layoutMap.get(ev.id);
    if (!layout) continue;

    const dayIdx = getDayIndex(new Date(ev.start_at), currentWeekStart);
    if (dayIdx < 0 || dayIdx >= 7) continue;

    const col   = dayColumns[dayIdx];
    const block = createEventBlock(ev, layout);
    col.appendChild(block);
  }
}

function createEventBlock(ev, layout) {
  const startDate = new Date(ev.start_at);
  const endDate   = new Date(ev.end_at);

  // Clamp to [0, 1440] minutes within the day
  const startMin = Math.max(0, Math.min(TOTAL_MINUTES, dateToMinutes(startDate)));
  const endMin   = Math.max(0, Math.min(TOTAL_MINUTES, dateToMinutes(endDate)));

  // Handle events ending at midnight (00:00 of next day = 1440 min of this day)
  // dateToMinutes returns 0 for midnight; detect by checking if end is next day
  const endDateMidnight =
    endDate.getHours() === 0 &&
    endDate.getMinutes() === 0 &&
    endDate.getTime() > startDate.getTime();
  const effectiveEndMin = endDateMidnight ? TOTAL_MINUTES : endMin;

  const top    = minutesToPx(startMin);
  const height = Math.max(minutesToPx(effectiveEndMin - startMin), 18);

  // Horizontal: percentage-based so it works regardless of column pixel width
  const leftPct  = (layout.colIndex / layout.colCount) * 100;
  const widthPct = (1 / layout.colCount) * 100;

  const block = document.createElement('div');
  block.className = `event-block event-color-${ev.id % COLOR_COUNT}`;
  block.style.top    = `${top}px`;
  block.style.height = `${height}px`;
  block.style.left   = `calc(${leftPct}% + 2px)`;
  block.style.width  = `calc(${widthPct}% - 4px)`;
  block.dataset.eventId = String(ev.id);

  const titleEl = document.createElement('div');
  titleEl.className = 'event-title';
  titleEl.textContent = ev.title;

  const timeEl = document.createElement('div');
  timeEl.className = 'event-time';
  timeEl.textContent = `${formatTime(startDate)} – ${formatTime(endDate)}`;

  block.appendChild(titleEl);
  block.appendChild(timeEl);

  block.addEventListener('click', (e) => {
    e.stopPropagation();
    openEditModal(ev);
  });

  return block;
}

// ── Edit Modal ────────────────────────────────────────────────────────────────

function openEditModal(ev) {
  showEditModal(
    ev,
    async (data) => {
      await updateEvent(ev.id, data);
      await loadAndRender();
      showStatus('Event updated.', 'success');
    },
    async () => {
      await deleteEvent(ev.id);
      await loadAndRender();
      showStatus('Event deleted.', 'success');
    }
  );
}

// ── Drag-to-Create ────────────────────────────────────────────────────────────
//
// We attach a single set of document-level mousemove/mouseup listeners once.
// Per-column mousedown sets the active drag state.

let activeDragColIdx = null; // which column is being dragged

function attachGlobalDragListeners() {
  // Mousedown on each day column
  for (let d = 0; d < 7; d++) {
    const col = dayColumns[d];
    col.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('.event-block')) return;
      e.preventDefault();

      const startMin = getMinutesFromEvent(e, col);
      dragState[d].active      = true;
      dragState[d].startMin    = startMin;
      dragState[d].selectionEl = null;
      activeDragColIdx = d;

      updateDragSelection(d, startMin, startMin + 60);
    });
  }

  // Global mousemove
  document.addEventListener('mousemove', (e) => {
    if (activeDragColIdx === null) return;
    const d   = activeDragColIdx;
    const col = dayColumns[d];
    const cur = getMinutesFromEvent(e, col);
    updateDragSelection(d, dragState[d].startMin, cur);
  });

  // Global mouseup
  document.addEventListener('mouseup', (e) => {
    if (activeDragColIdx === null) return;
    const d   = activeDragColIdx;
    const col = dayColumns[d];

    const endMin   = getMinutesFromEvent(e, col);
    const startMin = Math.min(dragState[d].startMin, endMin);
    const rawEnd   = Math.max(dragState[d].startMin, endMin);

    removeDragSelection(d);
    activeDragColIdx = null;
    dragState[d].active = false;

    // Minimum 15 minutes; default to 1 hour for a click
    const duration  = rawEnd - startMin;
    const actualEnd = duration < 15 ? startMin + 60 : rawEnd;
    const clampedEnd = Math.min(actualEnd, TOTAL_MINUTES);

    // Build Date objects
    const dayDate = new Date(currentWeekStart);
    dayDate.setDate(dayDate.getDate() + d);
    dayDate.setHours(0, 0, 0, 0);

    const startDate = new Date(dayDate);
    startDate.setHours(Math.floor(startMin / 60), startMin % 60, 0, 0);

    const endDate = new Date(dayDate);
    if (clampedEnd === TOTAL_MINUTES) {
      // Midnight = start of next day
      endDate.setDate(dayDate.getDate() + 1);
      endDate.setHours(0, 0, 0, 0);
    } else {
      endDate.setHours(Math.floor(clampedEnd / 60), clampedEnd % 60, 0, 0);
    }

    openCreateModal(startDate, endDate);
  });
}

function getMinutesFromEvent(mouseEvent, col) {
  const rect = col.getBoundingClientRect();
  const relY  = mouseEvent.clientY - rect.top + gridScroll.scrollTop;
  const raw   = (relY / AXIS_HEIGHT) * TOTAL_MINUTES;
  // Snap to 15-minute intervals
  return Math.max(0, Math.min(TOTAL_MINUTES, Math.round(raw / 15) * 15));
}

function updateDragSelection(d, startMin, endMin) {
  const col = dayColumns[d];
  if (!dragState[d].selectionEl) {
    const el = document.createElement('div');
    el.className = 'drag-selection';
    col.appendChild(el);
    dragState[d].selectionEl = el;
  }
  const el     = dragState[d].selectionEl;
  const top    = minutesToPx(Math.min(startMin, endMin));
  const height = Math.max(minutesToPx(Math.abs(endMin - startMin)), minutesToPx(15));
  el.style.top    = `${top}px`;
  el.style.height = `${height}px`;
}

function removeDragSelection(d) {
  if (dragState[d].selectionEl) {
    dragState[d].selectionEl.remove();
    dragState[d].selectionEl = null;
  }
}

function openCreateModal(startDate, endDate) {
  showCreateModal(
    { start: startDate, end: endDate },
    async (data) => {
      await createEvent(data);
      await loadAndRender();
      showStatus('Event created.', 'success');
    }
  );
}

// ── Scroll Helper ─────────────────────────────────────────────────────────────

function scrollToHour(hour) {
  requestAnimationFrame(() => {
    const targetY = minutesToPx(hour * 60) - 80;
    gridScroll.scrollTop = Math.max(0, targetY);
  });
}

// ── Status Toast ──────────────────────────────────────────────────────────────

let statusTimer = null;

function showStatus(message, type = 'success') {
  document.querySelectorAll('.status-message').forEach(el => el.remove());
  if (statusTimer) clearTimeout(statusTimer);

  const el = document.createElement('div');
  el.className = `status-message ${type}`;
  el.textContent = message;
  document.body.appendChild(el);

  statusTimer = setTimeout(() => el.remove(), 3000);
}

// ── Boot ──────────────────────────────────────────────────────────────────────

init();
