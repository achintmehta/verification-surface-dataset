import { fetchEvents, createEvent, updateEvent, deleteEvent } from './api.js';
import { computeLayout } from './layout.js';
import {
  getMondayOf, getWeekDays, offsetWeek, formatWeekLabel,
  toDatetimeLocal, formatTime, getWeekBounds, midnight, minutesFromMidnight
} from './week.js';

// ── Constants ──────────────────────────────────────────────────────────────
const HOUR_HEIGHT    = 60;        // px per hour — must match CSS --hour-height
const TOTAL_MINUTES  = 24 * 60;   // 1440
const TOTAL_HEIGHT   = HOUR_HEIGHT * 24; // 1440px

// ── State ──────────────────────────────────────────────────────────────────
let currentMonday = getMondayOf(new Date());
let events = [];  // raw events from server for the current week

// ── DOM refs ───────────────────────────────────────────────────────────────
const weekLabel    = document.getElementById('week-label');
const dayHeaders   = document.getElementById('day-headers');
const hourLines    = document.getElementById('hour-lines');
const dayColumns   = document.getElementById('day-columns');
const timeAxis     = document.getElementById('time-axis');
const gridBody     = document.getElementById('grid-body');
const gridScroll   = document.getElementById('grid-scroll');
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
const btnPrev      = document.getElementById('btn-prev');
const btnToday     = document.getElementById('btn-today');
const btnNext      = document.getElementById('btn-next');

// ── Modal state ────────────────────────────────────────────────────────────
let editingEventId = null;  // null = create mode, number = edit mode

// ═══════════════════════════════════════════════════════════════════════════
// Geometry helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Convert minutes-from-midnight to pixels from top of grid. */
function minutesToPx(minutes) {
  return (minutes / TOTAL_MINUTES) * TOTAL_HEIGHT;
}

/** Convert a Y pixel offset within the grid body to minutes-from-midnight. */
function pxToMinutes(px) {
  return Math.round((px / TOTAL_HEIGHT) * TOTAL_MINUTES);
}

/** Snap minutes to nearest 15-minute boundary. */
function snapMinutes(minutes) {
  return Math.round(minutes / 15) * 15;
}

/** Clamp a value between min and max (inclusive). */
function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

// ═══════════════════════════════════════════════════════════════════════════
// Static grid construction (called once on init)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build the time-axis labels (00:00–23:00), absolutely positioned.
 */
function buildTimeAxis() {
  timeAxis.innerHTML = '';
  for (let h = 0; h < 24; h++) {
    const label = document.createElement('div');
    label.className = 'time-label' + (h === 0 ? ' first' : '');
    label.textContent = `${String(h).padStart(2, '0')}:00`;
    label.style.top = `${minutesToPx(h * 60)}px`;
    timeAxis.appendChild(label);
  }
}

/**
 * Build the hour and half-hour lines that span all day columns.
 */
function buildHourLines() {
  hourLines.innerHTML = '';
  for (let h = 0; h <= 24; h++) {
    const line = document.createElement('div');
    line.className = 'hour-line';
    line.style.top = `${minutesToPx(h * 60)}px`;
    hourLines.appendChild(line);

    if (h < 24) {
      const half = document.createElement('div');
      half.className = 'hour-line half';
      half.style.top = `${minutesToPx(h * 60 + 30)}px`;
      hourLines.appendChild(half);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Dynamic grid construction (called on each week navigation)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build the day-header cells for the current week.
 */
function buildDayHeaders(weekDays) {
  dayHeaders.innerHTML = '';
  const todayMidnight = midnight(new Date());

  weekDays.forEach(day => {
    const isToday = day.getTime() === todayMidnight.getTime();
    const header = document.createElement('div');
    header.className = 'day-header' + (isToday ? ' today' : '');

    const nameEl = document.createElement('span');
    nameEl.className = 'day-name';
    nameEl.textContent = day.toLocaleDateString(undefined, { weekday: 'short' });

    const dateEl = document.createElement('span');
    dateEl.className = 'day-date';
    dateEl.textContent = day.getDate();

    header.appendChild(nameEl);
    header.appendChild(dateEl);
    dayHeaders.appendChild(header);
  });
}

/**
 * Build the 7 day-column divs (removing any previous ones, keeping #hour-lines).
 */
function buildDayColumns(weekDays) {
  // Remove old day columns but keep #hour-lines
  dayColumns.querySelectorAll('.day-col').forEach(el => el.remove());

  const todayMidnight = midnight(new Date());

  weekDays.forEach((day, i) => {
    const isToday = day.getTime() === todayMidnight.getTime();
    const col = document.createElement('div');
    col.className = 'day-col' + (isToday ? ' today' : '');
    col.dataset.dayIndex = String(i);
    col.dataset.date = localDateKey(day);

    setupDragCreate(col, day);
    dayColumns.appendChild(col);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Event rendering
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Format a Date as "YYYY-MM-DD" in local time.
 */
function localDateKey(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Group events by the local date of their start_at.
 * Returns Map<"YYYY-MM-DD", event[]>.
 */
function groupEventsByDay(evs) {
  const map = new Map();
  for (const ev of evs) {
    // ev.start_at is "YYYY-MM-DDTHH:MM:SS" (local time from server)
    const key = ev.start_at.slice(0, 10);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(ev);
  }
  return map;
}

/**
 * Render a single event block inside a day column element.
 *
 * @param {Object}      ev        - event data (id, title, start_at, end_at)
 * @param {number}      colIndex  - 0-based column index within the cluster
 * @param {number}      colCount  - total columns in the cluster
 * @param {HTMLElement} colEl     - the day column DOM element
 * @param {Date}        day       - midnight of the day this column represents
 */
function renderEventBlock(ev, colIndex, colCount, colEl, day) {
  const startDate = new Date(ev.start_at);
  const endDate   = new Date(ev.end_at);

  // Day boundaries in ms
  const dayStart = day.getTime();                    // midnight
  const dayEnd   = dayStart + 24 * 60 * 60 * 1000;  // next midnight

  // Minutes from midnight, clamped to [0, 1440]
  const startMin = clamp((startDate.getTime() - dayStart) / 60000, 0, TOTAL_MINUTES);
  const endMin   = clamp((endDate.getTime()   - dayStart) / 60000, 0, TOTAL_MINUTES);

  const top    = minutesToPx(startMin);
  const height = Math.max(minutesToPx(endMin) - top, 4); // minimum 4px so it's always visible

  // ── Horizontal layout ──────────────────────────────────────────────────
  // Divide the column width equally among colCount sub-columns.
  // Use a 2px outer margin and 1px gap between adjacent event sub-columns.
  const OUTER = 2; // px margin on the outer edges of the day column
  const GAP   = 2; // px gap between adjacent event sub-columns

  const leftPct  = colIndex / colCount;
  const rightPct = (colCount - colIndex - 1) / colCount;

  // Pixel nudge: outer edge gets OUTER px, inner edge gets GAP/2 px
  const leftPx  = colIndex === 0            ? OUTER : GAP / 2;
  const rightPx = colIndex === colCount - 1 ? OUTER : GAP / 2;

  const block = document.createElement('div');
  block.className = 'event-block';
  block.dataset.id = String(ev.id);
  block.style.top    = `${top}px`;
  block.style.height = `${height}px`;
  block.style.left   = `calc(${leftPct  * 100}% + ${leftPx}px)`;
  block.style.right  = `calc(${rightPct * 100}% + ${rightPx}px)`;

  const titleEl = document.createElement('div');
  titleEl.className = 'event-title';
  titleEl.textContent = ev.title;

  const timeEl = document.createElement('div');
  timeEl.className = 'event-time';
  timeEl.textContent = `${formatTime(startDate)} – ${formatTime(endDate)}`;

  block.appendChild(titleEl);
  block.appendChild(timeEl);

  block.addEventListener('click', e => {
    e.stopPropagation();
    openEditModal(ev);
  });

  colEl.appendChild(block);
}

/**
 * Render all events for the current week into their day columns.
 */
function renderEvents(weekDays) {
  // Clear existing event blocks
  document.querySelectorAll('.event-block').forEach(b => b.remove());

  const byDay  = groupEventsByDay(events);
  const colEls = document.querySelectorAll('.day-col');

  weekDays.forEach((day, i) => {
    const key       = localDateKey(day);
    const dayEvents = byDay.get(key) || [];
    const colEl     = colEls[i];
    if (!colEl || dayEvents.length === 0) return;

    const laid = computeLayout(dayEvents);
    for (const ev of laid) {
      renderEventBlock(ev, ev.colIndex, ev.colCount, colEl, day);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Drag-to-create interaction
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Attach mousedown/mousemove/mouseup handlers to a day column for drag-to-create.
 * @param {HTMLElement} colEl - the day column element
 * @param {Date}        day   - midnight of the day this column represents
 */
function setupDragCreate(colEl, day) {
  let dragStartY  = null;
  let dragEl      = null;
  let isDragging  = false;

  /**
   * Get Y position relative to the top of the grid body, accounting for scroll.
   * This matches the coordinate system used for event top/height positioning.
   */
  function getGridY(e) {
    const gridTop = gridBody.getBoundingClientRect().top;
    return e.clientY - gridTop + gridScroll.scrollTop;
  }

  colEl.addEventListener('mousedown', e => {
    if (e.button !== 0) return;                    // left button only
    if (e.target.closest('.event-block')) return;  // don't intercept event clicks

    e.preventDefault();
    isDragging  = false;
    dragStartY  = getGridY(e);

    // Create the visual drag-selection highlight
    dragEl = document.createElement('div');
    dragEl.className = 'drag-selection';
    dragEl.style.top    = `${clamp(dragStartY, 0, TOTAL_HEIGHT)}px`;
    dragEl.style.height = '0px';
    colEl.appendChild(dragEl);
  });

  // mousemove and mouseup are on window so the drag works even if the cursor
  // leaves the column during the gesture.
  function onMouseMove(e) {
    if (dragStartY === null || !dragEl) return;
    isDragging = true;

    const currentY    = getGridY(e);
    const top         = clamp(Math.min(dragStartY, currentY), 0, TOTAL_HEIGHT);
    const rawHeight   = Math.abs(currentY - dragStartY);
    const height      = Math.min(rawHeight, TOTAL_HEIGHT - top);

    dragEl.style.top    = `${top}px`;
    dragEl.style.height = `${height}px`;
  }

  function onMouseUp(e) {
    if (dragStartY === null) return;

    const endY     = getGridY(e);
    const startY   = dragStartY;
    const wasDrag  = isDragging && Math.abs(endY - startY) >= 8;

    // Clean up
    if (dragEl) { dragEl.remove(); dragEl = null; }
    dragStartY = null;
    isDragging = false;

    if (!wasDrag) {
      // Single click — open create modal at the clicked time
      const clickMin = snapMinutes(clamp(pxToMinutes(startY), 0, TOTAL_MINUTES - 30));
      openCreateModal(day, clickMin, Math.min(clickMin + 60, TOTAL_MINUTES));
    } else {
      // Drag — use the selected range
      const topY     = Math.min(startY, endY);
      const bottomY  = Math.max(startY, endY);
      const startMin = snapMinutes(clamp(pxToMinutes(topY),    0, TOTAL_MINUTES));
      const endMin   = snapMinutes(clamp(pxToMinutes(bottomY), 0, TOTAL_MINUTES));

      if (endMin <= startMin) {
        openCreateModal(day, startMin, Math.min(startMin + 60, TOTAL_MINUTES));
      } else {
        openCreateModal(day, startMin, endMin);
      }
    }
  }

  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup',   onMouseUp);
}

// ═══════════════════════════════════════════════════════════════════════════
// Modal
// ═══════════════════════════════════════════════════════════════════════════

function showError(msg) {
  formError.textContent = msg;
  formError.classList.remove('hidden');
}

function hideError() {
  formError.classList.add('hidden');
}

/**
 * Open the create-event modal, pre-filled with the given time range.
 * @param {Date}   day      - midnight of the target day
 * @param {number} startMin - start time in minutes from midnight
 * @param {number} endMin   - end time in minutes from midnight
 */
function openCreateModal(day, startMin, endMin) {
  editingEventId = null;
  modalTitle.textContent = 'New Event';
  btnDelete.classList.add('hidden');
  hideError();
  fieldTitle.value = '';

  const startDate = new Date(day);
  startDate.setHours(Math.floor(startMin / 60), startMin % 60, 0, 0);

  const endDate = new Date(day);
  endDate.setHours(Math.floor(endMin / 60), endMin % 60, 0, 0);

  fieldStart.value = toDatetimeLocal(startDate);
  fieldEnd.value   = toDatetimeLocal(endDate);

  modalOverlay.classList.remove('hidden');
  setTimeout(() => fieldTitle.focus(), 50);
}

/**
 * Open the edit-event modal for an existing event.
 * @param {Object} ev - event data
 */
function openEditModal(ev) {
  editingEventId = ev.id;
  modalTitle.textContent = 'Edit Event';
  btnDelete.classList.remove('hidden');
  hideError();

  fieldTitle.value = ev.title;
  fieldStart.value = toDatetimeLocal(new Date(ev.start_at));
  fieldEnd.value   = toDatetimeLocal(new Date(ev.end_at));

  modalOverlay.classList.remove('hidden');
  setTimeout(() => fieldTitle.focus(), 50);
}

function closeModal() {
  modalOverlay.classList.add('hidden');
  editingEventId = null;
}

// ── Form submission ────────────────────────────────────────────────────────
eventForm.addEventListener('submit', async e => {
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
    showError('Invalid date/time.');
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

  try {
    btnSave.disabled = true;
    if (editingEventId === null) {
      await createEvent(payload);
    } else {
      await updateEvent(editingEventId, payload);
    }
    closeModal();
    await loadAndRender();
  } catch (err) {
    showError(err.message || 'An error occurred.');
  } finally {
    btnSave.disabled = false;
  }
});

// ── Delete button ──────────────────────────────────────────────────────────
btnDelete.addEventListener('click', async () => {
  if (editingEventId === null) return;
  if (!confirm('Delete this event?')) return;

  try {
    btnDelete.disabled = true;
    await deleteEvent(editingEventId);
    closeModal();
    await loadAndRender();
  } catch (err) {
    showError(err.message || 'Failed to delete event.');
  } finally {
    btnDelete.disabled = false;
  }
});

// ── Cancel / close ─────────────────────────────────────────────────────────
btnCancel.addEventListener('click', closeModal);

modalOverlay.addEventListener('click', e => {
  if (e.target === modalOverlay) closeModal();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !modalOverlay.classList.contains('hidden')) {
    closeModal();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Navigation
// ═══════════════════════════════════════════════════════════════════════════

btnPrev.addEventListener('click', async () => {
  currentMonday = offsetWeek(currentMonday, -1);
  await loadAndRender();
});

btnToday.addEventListener('click', async () => {
  currentMonday = getMondayOf(new Date());
  await loadAndRender();
});

btnNext.addEventListener('click', async () => {
  currentMonday = offsetWeek(currentMonday, 1);
  await loadAndRender();
});

// ═══════════════════════════════════════════════════════════════════════════
// Load & render
// ═══════════════════════════════════════════════════════════════════════════

async function loadAndRender() {
  const weekDays = getWeekDays(currentMonday);
  const sunday   = weekDays[6];

  weekLabel.textContent = formatWeekLabel(currentMonday, sunday);
  buildDayHeaders(weekDays);
  buildDayColumns(weekDays);

  const { weekStart, weekEnd } = getWeekBounds(currentMonday);
  try {
    events = await fetchEvents(weekStart, weekEnd);
  } catch (err) {
    console.error('Failed to load events:', err);
    events = [];
  }

  renderEvents(weekDays);
}

// ═══════════════════════════════════════════════════════════════════════════
// Initialisation
// ═══════════════════════════════════════════════════════════════════════════

function init() {
  buildTimeAxis();
  buildHourLines();
  loadAndRender();

  // Scroll to 07:00 on initial load so working hours are visible
  requestAnimationFrame(() => {
    gridScroll.scrollTop = minutesToPx(7 * 60);
  });
}

init();
