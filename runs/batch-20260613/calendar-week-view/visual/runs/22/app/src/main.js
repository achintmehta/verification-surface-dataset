import { fetchEvents, createEvent, updateEvent, deleteEvent } from './api.js';
import { computeDayLayout } from './layout.js';

// Constants
const HOUR_HEIGHT = 60; // px per hour
const TOTAL_MINUTES = 24 * 60;
const AXIS_HEIGHT = HOUR_HEIGHT * 24; // 1440px

const DAY_NAMES = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// State
let currentWeekStart = getMonday(new Date());
let events = [];

// DOM elements
const weekTitle = document.getElementById('week-title');
const timeGutter = document.getElementById('time-gutter');
const daysGrid = document.getElementById('days-grid');
const modalOverlay = document.getElementById('modal-overlay');
const modalTitle = document.getElementById('modal-title');
const eventForm = document.getElementById('event-form');
const formEventId = document.getElementById('form-event-id');
const formTitle = document.getElementById('form-title');
const formDate = document.getElementById('form-date');
const formStart = document.getElementById('form-start');
const formEnd = document.getElementById('form-end');
const formError = document.getElementById('form-error');
const btnSave = document.getElementById('btn-save');
const btnCancel = document.getElementById('btn-cancel');
const btnDelete = document.getElementById('btn-delete');

// ===== Date Helpers =====

/**
 * Get the Monday of the week containing date d (local time).
 */
function getMonday(d) {
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  const day = date.getDay();
  // getDay(): 0=Sun, 1=Mon, ... 6=Sat
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  return date;
}

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function formatTime(hours, minutes) {
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/**
 * Format a local Date as YYYY-MM-DD (for <input type="date">).
 */
function formatDateLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function isSameDay(d1, d2) {
  return d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate();
}

/**
 * Minutes from local midnight for a Date.
 */
function minutesFromMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

function minutesToPixels(minutes) {
  return (minutes / 60) * HOUR_HEIGHT;
}

/**
 * Build a local Date from a YYYY-MM-DD and HH:MM string.
 * This creates a date in the browser's local timezone.
 */
function localDateTime(dateStr, timeStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [h, min] = timeStr.split(':').map(Number);
  return new Date(y, m - 1, d, h, min, 0, 0);
}

/**
 * Get local midnight for a Date.
 */
function localMidnight(d) {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}

// ===== Time Gutter =====

function buildTimeGutter() {
  timeGutter.innerHTML = '';
  const spacer = document.createElement('div');
  spacer.className = 'time-gutter-header';
  timeGutter.appendChild(spacer);

  const body = document.createElement('div');
  body.style.position = 'relative';
  body.style.height = `${AXIS_HEIGHT}px`;
  timeGutter.appendChild(body);

  for (let h = 0; h <= 24; h++) {
    const label = document.createElement('div');
    label.className = 'hour-label';
    label.style.top = `${h * HOUR_HEIGHT}px`;
    if (h > 0 && h < 24) {
      label.textContent = formatTime(h, 0);
    }
    body.appendChild(label);
  }
}

// ===== Day Columns =====

function buildDayColumns() {
  daysGrid.innerHTML = '';
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 0; i < 7; i++) {
    const dayDate = addDays(currentWeekStart, i);
    const col = document.createElement('div');
    col.className = 'day-column';
    col.dataset.dayIndex = i;

    if (isSameDay(dayDate, today)) {
      col.classList.add('today');
    }

    // Header
    const header = document.createElement('div');
    header.className = 'day-column-header';

    const dayName = document.createElement('span');
    dayName.className = 'day-name';
    dayName.textContent = DAY_NAMES[i];

    const dayNumber = document.createElement('span');
    dayNumber.className = 'day-number';
    dayNumber.textContent = dayDate.getDate();

    header.appendChild(dayName);
    header.appendChild(dayNumber);
    col.appendChild(header);

    // Body
    const body = document.createElement('div');
    body.className = 'day-column-body';
    body.dataset.date = formatDateLocal(dayDate);

    // Hour lines
    for (let h = 0; h <= 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${h * HOUR_HEIGHT}px`;
      body.appendChild(line);
    }

    // Click/drag for creating events
    setupDragCreate(body, dayDate);

    col.appendChild(body);
    daysGrid.appendChild(col);
  }
}

// ===== Drag-to-Create =====

function setupDragCreate(bodyEl, dayDate) {
  let dragging = false;
  let selectionEl = null;

  function getMinutesFromY(y) {
    const rect = bodyEl.getBoundingClientRect();
    const relY = Math.max(0, Math.min(y - rect.top, AXIS_HEIGHT));
    const rawMinutes = (relY / AXIS_HEIGHT) * TOTAL_MINUTES;
    return Math.round(rawMinutes / 15) * 15; // snap to 15 min
  }

  bodyEl.addEventListener('mousedown', (e) => {
    if (e.target.closest('.event-block')) return;
    if (e.button !== 0) return;
    dragging = true;

    selectionEl = document.createElement('div');
    selectionEl.className = 'drag-selection';
    bodyEl.appendChild(selectionEl);

    const minutes = getMinutesFromY(e.clientY);
    selectionEl.style.top = `${minutesToPixels(minutes)}px`;
    selectionEl.style.height = '0px';
    selectionEl._startMinutes = minutes;
    selectionEl._endMinutes = minutes;

    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging || !selectionEl) return;
    const currentMinutes = getMinutesFromY(e.clientY);
    const startMin = selectionEl._startMinutes;

    const topMin = Math.min(startMin, currentMinutes);
    const bottomMin = Math.max(startMin, currentMinutes);

    selectionEl.style.top = `${minutesToPixels(topMin)}px`;
    selectionEl.style.height = `${minutesToPixels(bottomMin - topMin)}px`;
    selectionEl._endMinutes = currentMinutes;
  });

  document.addEventListener('mouseup', () => {
    if (!dragging || !selectionEl) return;
    dragging = false;

    let startMin = selectionEl._startMinutes;
    let endMin = selectionEl._endMinutes != null ? selectionEl._endMinutes : startMin;

    if (startMin > endMin) [startMin, endMin] = [endMin, startMin];

    // Minimum 15 minutes; default to 60 if just clicked
    if (endMin - startMin < 15) {
      endMin = Math.min(startMin + 60, TOTAL_MINUTES);
    }
    endMin = Math.min(endMin, TOTAL_MINUTES);

    selectionEl.remove();
    selectionEl = null;

    openCreateForm(dayDate, startMin, endMin);
  });
}

// ===== Modal =====

function openCreateForm(dayDate, startMinutes, endMinutes) {
  modalTitle.textContent = 'Create Event';
  formEventId.value = '';
  formTitle.value = '';
  formDate.value = formatDateLocal(dayDate);
  formStart.value = formatTime(Math.floor(startMinutes / 60), startMinutes % 60);
  formEnd.value = formatTime(Math.floor(endMinutes / 60), endMinutes % 60);
  formError.style.display = 'none';
  btnDelete.style.display = 'none';
  btnSave.textContent = 'Create';
  modalOverlay.style.display = 'flex';
  formTitle.focus();
}

function openEditForm(event) {
  const startDt = new Date(event.start_at);
  const endDt = new Date(event.end_at);

  modalTitle.textContent = 'Edit Event';
  formEventId.value = event.id;
  formTitle.value = event.title;
  formDate.value = formatDateLocal(startDt);
  formStart.value = formatTime(startDt.getHours(), startDt.getMinutes());

  // If end time is midnight of next day, show "00:00" but keep the date as start date
  const endMinutes = minutesFromMidnight(endDt);
  if (endMinutes === 0 && endDt.getTime() !== startDt.getTime()) {
    formEnd.value = '00:00';
  } else {
    formEnd.value = formatTime(endDt.getHours(), endDt.getMinutes());
  }

  formError.style.display = 'none';
  btnDelete.style.display = 'inline-block';
  btnSave.textContent = 'Save';
  modalOverlay.style.display = 'flex';
  formTitle.focus();
}

function closeModal() {
  modalOverlay.style.display = 'none';
  formError.style.display = 'none';
}

function showFormError(msg) {
  formError.textContent = msg;
  formError.style.display = 'block';
}

// ===== Form Submit =====

eventForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const id = formEventId.value;
  const title = formTitle.value.trim();
  const dateStr = formDate.value;
  const startTimeStr = formStart.value;
  const endTimeStr = formEnd.value;

  if (!title) {
    showFormError('Title is required');
    return;
  }
  if (!dateStr || !startTimeStr || !endTimeStr) {
    showFormError('All fields are required');
    return;
  }

  // Build local Date objects
  const start_at = localDateTime(dateStr, startTimeStr);
  let end_at;
  if (endTimeStr === '00:00') {
    // End at midnight = start of next day
    end_at = localDateTime(dateStr, '00:00');
    end_at.setDate(end_at.getDate() + 1);
  } else {
    end_at = localDateTime(dateStr, endTimeStr);
  }

  if (isNaN(start_at.getTime()) || isNaN(end_at.getTime())) {
    showFormError('Invalid date/time');
    return;
  }

  if (end_at <= start_at) {
    showFormError('End time must be after start time');
    return;
  }

  try {
    if (id) {
      await updateEvent(id, {
        title,
        start_at: start_at.toISOString(),
        end_at: end_at.toISOString()
      });
    } else {
      await createEvent({
        title,
        start_at: start_at.toISOString(),
        end_at: end_at.toISOString()
      });
    }
    closeModal();
    await loadEvents();
  } catch (err) {
    showFormError(err.message);
  }
});

btnCancel.addEventListener('click', closeModal);

modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeModal();
});

btnDelete.addEventListener('click', async () => {
  const id = formEventId.value;
  if (!id) return;
  if (!confirm('Delete this event?')) return;

  try {
    await deleteEvent(id);
    closeModal();
    await loadEvents();
  } catch (err) {
    showFormError(err.message);
  }
});

// ===== Render Events =====

function renderEvents() {
  // Clear all event blocks
  document.querySelectorAll('.event-block').forEach(el => el.remove());

  // Group events by day column index
  const dayBuckets = new Map(); // dayIndex -> array of layout-ready event data

  for (const ev of events) {
    const startDt = new Date(ev.start_at);
    const endDt = new Date(ev.end_at);

    // Check each day column to see if this event overlaps it
    for (let i = 0; i < 7; i++) {
      const dayDate = addDays(currentWeekStart, i);
      const dayStart = localMidnight(dayDate);
      const dayEnd = addDays(dayStart, 1);

      // Event overlaps this day if event.start < dayEnd AND event.end > dayStart
      if (startDt < dayEnd && endDt > dayStart) {
        // Clamp to this day's bounds
        const clampedStart = startDt < dayStart ? dayStart : startDt;
        const clampedEnd = endDt > dayEnd ? dayEnd : endDt;

        let startMin = minutesFromMidnight(clampedStart);
        let endMin;

        // If clamped end is exactly the next day midnight, treat as 1440
        if (clampedEnd.getTime() === dayEnd.getTime()) {
          endMin = TOTAL_MINUTES;
        } else {
          endMin = minutesFromMidnight(clampedEnd);
        }

        // Edge case: if endMin is 0 and startMin > 0 on the same day,
        // the event ends at midnight
        if (endMin === 0 && startMin > 0) {
          endMin = TOTAL_MINUTES;
        }

        if (endMin > startMin) {
          if (!dayBuckets.has(i)) dayBuckets.set(i, []);
          dayBuckets.get(i).push({
            id: ev.id,
            title: ev.title,
            startMinutes: startMin,
            endMinutes: endMin,
            start_at: ev.start_at,
            end_at: ev.end_at
          });
        }
      }
    }
  }

  // Layout and render each day
  for (const [dayIndex, dayEvents] of dayBuckets) {
    const layoutItems = computeDayLayout(dayEvents);
    const bodyEl = daysGrid.children[dayIndex]?.querySelector('.day-column-body');
    if (!bodyEl) continue;

    for (const item of layoutItems) {
      const block = document.createElement('div');
      block.className = 'event-block';

      const top = minutesToPixels(item.startMinutes);
      const height = minutesToPixels(item.endMinutes - item.startMinutes);
      const widthPercent = 100 / item.totalColumns;
      const leftPercent = item.column * widthPercent;

      block.style.top = `${top}px`;
      block.style.height = `${height}px`;
      block.style.left = `${leftPercent}%`;
      block.style.width = `calc(${widthPercent}% - 2px)`;

      const titleDiv = document.createElement('div');
      titleDiv.className = 'event-title';
      titleDiv.textContent = item.title;

      const timeDiv = document.createElement('div');
      timeDiv.className = 'event-time';
      const sH = Math.floor(item.startMinutes / 60);
      const sM = item.startMinutes % 60;
      const eH = Math.floor(item.endMinutes / 60);
      const eM = item.endMinutes % 60;
      timeDiv.textContent = `${formatTime(sH, sM)} – ${formatTime(eH, eM)}`;

      block.appendChild(titleDiv);
      block.appendChild(timeDiv);

      block.addEventListener('click', (e) => {
        e.stopPropagation();
        const event = events.find(ev => ev.id === item.id);
        if (event) openEditForm(event);
      });

      bodyEl.appendChild(block);
    }
  }
}

// ===== Load Events =====

async function loadEvents() {
  const weekEnd = addDays(currentWeekStart, 7);
  try {
    events = await fetchEvents(currentWeekStart, weekEnd);
    renderEvents();
  } catch (err) {
    console.error('Failed to load events:', err);
  }
}

// ===== Navigation =====

function updateWeekTitle() {
  const endDate = addDays(currentWeekStart, 6);
  const startMonth = MONTH_NAMES[currentWeekStart.getMonth()];
  const endMonth = MONTH_NAMES[endDate.getMonth()];

  let title;
  if (currentWeekStart.getFullYear() !== endDate.getFullYear()) {
    title = `${startMonth} ${currentWeekStart.getDate()}, ${currentWeekStart.getFullYear()} – ${endMonth} ${endDate.getDate()}, ${endDate.getFullYear()}`;
  } else if (currentWeekStart.getMonth() !== endDate.getMonth()) {
    title = `${startMonth} ${currentWeekStart.getDate()} – ${endMonth} ${endDate.getDate()}, ${endDate.getFullYear()}`;
  } else {
    title = `${startMonth} ${currentWeekStart.getDate()} – ${endDate.getDate()}, ${endDate.getFullYear()}`;
  }
  weekTitle.textContent = title;
}

function navigateWeek(offset) {
  currentWeekStart = addDays(currentWeekStart, offset * 7);
  updateWeekTitle();
  buildDayColumns();
  loadEvents();
}

document.getElementById('btn-prev').addEventListener('click', () => navigateWeek(-1));
document.getElementById('btn-next').addEventListener('click', () => navigateWeek(1));
document.getElementById('btn-today').addEventListener('click', () => {
  currentWeekStart = getMonday(new Date());
  updateWeekTitle();
  buildDayColumns();
  loadEvents();
});

document.addEventListener('keydown', (e) => {
  if (modalOverlay.style.display === 'flex') {
    if (e.key === 'Escape') closeModal();
  }
});

// ===== Init =====

function init() {
  buildTimeGutter();
  updateWeekTitle();
  buildDayColumns();
  loadEvents();

  // Scroll to 8 AM on load
  const scrollContainer = document.querySelector('.calendar-scroll');
  if (scrollContainer) {
    scrollContainer.scrollTop = 8 * HOUR_HEIGHT;
  }
}

init();
