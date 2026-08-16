import { fetchEvents, createEvent, updateEvent, deleteEvent } from './api.js';
import { computeLayout } from './layout.js';

// Constants
const HOUR_HEIGHT = 60; // pixels per hour - must match CSS --hour-height
const TOTAL_MINUTES = 24 * 60;
const AXIS_HEIGHT = 24 * HOUR_HEIGHT; // total pixels for 24 hours
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// State
let currentWeekStart = null; // Monday of the current week (as a "wall clock" date - no tz)
let events = [];
let editingEvent = null;

// DOM references
const weekTitleEl = document.getElementById('week-title');
const dayHeadersColumns = document.getElementById('day-headers-columns');
const timeGutterEl = document.getElementById('time-gutter');
const daysContainerEl = document.getElementById('days-container');
const calendarScroll = document.getElementById('calendar-scroll');
const modalOverlay = document.getElementById('modal-overlay');
const modalTitle = document.getElementById('modal-title');
const eventForm = document.getElementById('event-form');
const eventTitleInput = document.getElementById('event-title');
const eventDateInput = document.getElementById('event-date');
const eventStartInput = document.getElementById('event-start');
const eventEndInput = document.getElementById('event-end');
const formError = document.getElementById('form-error');
const btnSave = document.getElementById('btn-save');
const btnCancel = document.getElementById('btn-cancel');
const btnDelete = document.getElementById('btn-delete');

// ==================== Wall-clock date utilities ====================
// We avoid timezone issues by treating all dates as "wall clock" strings.
// Format: "YYYY-MM-DDTHH:MM:SS" (no Z, no offset).
// Only use local Date for "today" detection and initial week calculation.

function pad(n) { return String(n).padStart(2, '0'); }

/**
 * Get today's date as {year, month, day} in local time.
 */
function todayLocal() {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
}

/**
 * Get Monday of the week containing the given {year, month, day}.
 */
function getMondayOf({ year, month, day }) {
  const d = new Date(year, month - 1, day);
  const dow = d.getDay(); // 0=Sun
  const diff = dow === 0 ? -6 : 1 - dow;
  d.setDate(d.getDate() + diff);
  return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
}

/**
 * Add days to a {year, month, day} date.
 */
function addDaysTo({ year, month, day }, n) {
  const d = new Date(year, month - 1, day + n);
  return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
}

/**
 * Format {year, month, day} as "YYYY-MM-DD"
 */
function fmtDate({ year, month, day }) {
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * Wall-clock ISO string: "YYYY-MM-DDTHH:MM:SS"
 */
function wallISO({ year, month, day }, hours, minutes) {
  return `${year}-${pad(month)}-${pad(day)}T${pad(hours)}:${pad(minutes)}:00`;
}

/**
 * Parse "YYYY-MM-DDTHH:MM:SS" or similar into components.
 */
function parseWall(s) {
  // Handle both "YYYY-MM-DDTHH:MM:SS" and "YYYY-MM-DD HH:MM:SS" and trailing Z or offset
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return null;
  return {
    year: parseInt(m[1]),
    month: parseInt(m[2]),
    day: parseInt(m[3]),
    hours: parseInt(m[4]),
    minutes: parseInt(m[5])
  };
}

function sameDateYMD(a, b) {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

function dateKey(d) {
  return `${d.year}-${pad(d.month)}-${pad(d.day)}`;
}

function formatTime(hours, minutes) {
  return `${pad(hours)}:${pad(minutes)}`;
}

function formatTimeFromMinutes(totalMinutes) {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return formatTime(h, m);
}

function minutesToPixels(minutes) {
  return (minutes / TOTAL_MINUTES) * AXIS_HEIGHT;
}

// ==================== Rendering ====================

function renderTimeGutter() {
  timeGutterEl.innerHTML = '';
  for (let h = 1; h < 24; h++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = `${h * HOUR_HEIGHT}px`;
    label.textContent = formatTime(h, 0);
    timeGutterEl.appendChild(label);
  }
}

function renderDayHeaders() {
  dayHeadersColumns.innerHTML = '';
  const today = todayLocal();

  for (let i = 0; i < 7; i++) {
    const dayDate = addDaysTo(currentWeekStart, i);
    const header = document.createElement('div');
    header.className = 'day-header';
    if (sameDateYMD(dayDate, today)) {
      header.classList.add('today');
    }

    const dayName = document.createElement('span');
    dayName.className = 'day-name';
    dayName.textContent = DAY_NAMES[i];

    const dayNumber = document.createElement('span');
    dayNumber.className = 'day-number';
    dayNumber.textContent = dayDate.day;

    header.appendChild(dayName);
    header.appendChild(dayNumber);
    dayHeadersColumns.appendChild(header);
  }
}

function renderDayColumns() {
  daysContainerEl.innerHTML = '';
  const today = todayLocal();

  for (let i = 0; i < 7; i++) {
    const dayDate = addDaysTo(currentWeekStart, i);
    const col = document.createElement('div');
    col.className = 'day-column';
    col.dataset.dayIndex = i;

    if (sameDateYMD(dayDate, today)) {
      col.classList.add('today');
    }

    // Hour lines
    for (let h = 0; h < 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${h * HOUR_HEIGHT}px`;
      col.appendChild(line);

      const halfLine = document.createElement('div');
      halfLine.className = 'hour-line half';
      halfLine.style.top = `${h * HOUR_HEIGHT + HOUR_HEIGHT / 2}px`;
      col.appendChild(halfLine);
    }
    // Bottom line at 24:00
    const bottomLine = document.createElement('div');
    bottomLine.className = 'hour-line';
    bottomLine.style.top = `${24 * HOUR_HEIGHT}px`;
    col.appendChild(bottomLine);

    // Click area
    const clickArea = document.createElement('div');
    clickArea.className = 'day-body-clickarea';
    col.appendChild(clickArea);

    // Selection highlight
    const selHighlight = document.createElement('div');
    selHighlight.className = 'selection-highlight';
    col.appendChild(selHighlight);

    // Current time line
    if (sameDateYMD(dayDate, today)) {
      const now = new Date();
      const mins = now.getHours() * 60 + now.getMinutes();
      const timeLine = document.createElement('div');
      timeLine.className = 'current-time-line';
      timeLine.style.top = `${minutesToPixels(mins)}px`;
      col.appendChild(timeLine);
    }

    // Drag-to-create
    setupDragToCreate(clickArea, col, dayDate);

    daysContainerEl.appendChild(col);
  }
}

function setupDragToCreate(clickArea, colEl, dayDate) {
  let isDragging = false;
  let startY = 0;
  let currentY = 0;
  const selHighlight = colEl.querySelector('.selection-highlight');

  function yToMinutes(y) {
    const rawMinutes = (y / AXIS_HEIGHT) * TOTAL_MINUTES;
    return Math.round(rawMinutes / 15) * 15;
  }

  clickArea.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    isDragging = true;
    const rect = colEl.getBoundingClientRect();
    startY = e.clientY - rect.top;
    currentY = startY;

    selHighlight.style.display = 'block';
    updateSelectionHighlight();
    e.preventDefault();
  });

  const onMouseMove = (e) => {
    if (!isDragging) return;
    const rect = colEl.getBoundingClientRect();
    currentY = Math.max(0, Math.min(AXIS_HEIGHT, e.clientY - rect.top));
    updateSelectionHighlight();
  };

  const onMouseUp = (e) => {
    if (!isDragging) return;
    isDragging = false;
    selHighlight.style.display = 'none';

    const rect = colEl.getBoundingClientRect();
    currentY = Math.max(0, Math.min(AXIS_HEIGHT, e.clientY - rect.top));

    let startMin = yToMinutes(Math.min(startY, currentY));
    let endMin = yToMinutes(Math.max(startY, currentY));

    if (endMin - startMin < 15) {
      endMin = Math.min(startMin + 60, TOTAL_MINUTES);
    }

    startMin = Math.max(0, startMin);
    endMin = Math.min(TOTAL_MINUTES, endMin);

    if (endMin > startMin) {
      openCreateModal(dayDate, startMin, endMin);
    }
  };

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);

  function updateSelectionHighlight() {
    const top = Math.min(startY, currentY);
    const height = Math.abs(currentY - startY);
    selHighlight.style.top = `${top}px`;
    selHighlight.style.height = `${height}px`;
  }
}

function renderEvents() {
  document.querySelectorAll('.event-block').forEach(el => el.remove());

  // Group events by day index
  const dayBuckets = new Map();
  for (let i = 0; i < 7; i++) {
    dayBuckets.set(i, []);
  }

  for (const ev of events) {
    const start = parseWall(ev.start_at);
    const end = parseWall(ev.end_at);
    if (!start || !end) continue;

    // Determine which day(s) this event spans
    for (let i = 0; i < 7; i++) {
      const dayDate = addDaysTo(currentWeekStart, i);
      const dayKey = dateKey(dayDate);
      const nextDayDate = addDaysTo(currentWeekStart, i + 1);
      const nextDayKey = dateKey(nextDayDate);

      // Wall clock start/end as sortable strings
      const dayStartStr = `${dayKey}T00:00:00`;
      const dayEndStr = `${nextDayKey}T00:00:00`;
      const evStartStr = ev.start_at;
      const evEndStr = ev.end_at;

      // Event overlaps this day if: evStart < dayEnd AND evEnd > dayStart
      if (evStartStr < dayEndStr && evEndStr > dayStartStr) {
        // Clamp to this day
        let startMins, endMins;

        if (evStartStr <= dayStartStr) {
          startMins = 0;
        } else if (dateKey(start) === dayKey) {
          startMins = start.hours * 60 + start.minutes;
        } else {
          startMins = 0;
        }

        if (evEndStr >= dayEndStr) {
          endMins = TOTAL_MINUTES;
        } else if (dateKey(end) === dayKey) {
          endMins = end.hours * 60 + end.minutes;
        } else {
          // end is on a different day but before dayEnd - shouldn't happen with above check
          endMins = TOTAL_MINUTES;
        }

        // Handle midnight end (00:00 of the same day means start of day, not end)
        if (endMins === 0 && dateKey(end) === dayKey) {
          // This means end is midnight of this day = start of this day, 
          // which means the event doesn't actually reach into this day
          continue;
        }

        const effectiveEnd = Math.max(endMins, startMins + 1);

        dayBuckets.get(i).push({
          ...ev,
          startMinutes: startMins,
          endMinutes: Math.min(effectiveEnd, TOTAL_MINUTES),
          dayIndex: i
        });
      }
    }
  }

  for (let i = 0; i < 7; i++) {
    const dayEvents = dayBuckets.get(i);
    if (dayEvents.length === 0) continue;

    computeLayout(dayEvents);

    const dayCol = document.querySelector(`.day-column[data-day-index="${i}"]`);
    if (!dayCol) continue;

    for (const ev of dayEvents) {
      const block = createEventBlock(ev);
      dayCol.appendChild(block);
    }
  }
}

function createEventBlock(ev) {
  const block = document.createElement('div');
  block.className = 'event-block';

  const top = minutesToPixels(ev.startMinutes);
  const height = minutesToPixels(ev.endMinutes - ev.startMinutes);
  const widthPercent = 100 / ev.totalColumns;
  const leftPercent = ev.column * widthPercent;

  block.style.top = `${top}px`;
  block.style.height = `${Math.max(height, 4)}px`;
  block.style.left = `${leftPercent}%`;
  block.style.width = `calc(${widthPercent}% - 2px)`;

  const titleEl = document.createElement('div');
  titleEl.className = 'event-title';
  titleEl.textContent = ev.title;

  const timeEl = document.createElement('div');
  timeEl.className = 'event-time';
  const startTimeStr = formatTimeFromMinutes(ev.startMinutes);
  const endTimeStr = ev.endMinutes === TOTAL_MINUTES ? '24:00' : formatTimeFromMinutes(ev.endMinutes);
  timeEl.textContent = `${startTimeStr} – ${endTimeStr}`;

  block.appendChild(titleEl);
  block.appendChild(timeEl);

  block.addEventListener('click', (e) => {
    e.stopPropagation();
    openEditModal(ev);
  });

  return block;
}

function updateWeekTitle() {
  const weekEnd = addDaysTo(currentWeekStart, 6);
  const startMonth = MONTH_NAMES[currentWeekStart.month - 1];
  const endMonth = MONTH_NAMES[weekEnd.month - 1];

  let title;
  if (currentWeekStart.year !== weekEnd.year) {
    title = `${startMonth} ${currentWeekStart.day}, ${currentWeekStart.year} – ${endMonth} ${weekEnd.day}, ${weekEnd.year}`;
  } else if (currentWeekStart.month !== weekEnd.month) {
    title = `${startMonth} ${currentWeekStart.day} – ${endMonth} ${weekEnd.day}, ${weekEnd.year}`;
  } else {
    title = `${startMonth} ${currentWeekStart.day} – ${weekEnd.day}, ${weekEnd.year}`;
  }

  weekTitleEl.textContent = title;
}

// ==================== Modal ====================

function showModal() {
  modalOverlay.style.display = 'flex';
  formError.style.display = 'none';
}

function hideModal() {
  modalOverlay.style.display = 'none';
  editingEvent = null;
  formError.style.display = 'none';
  eventForm.reset();
}

function showError(msg) {
  formError.textContent = msg;
  formError.style.display = 'block';
}

function openCreateModal(dayDate, startMinutes, endMinutes) {
  editingEvent = null;
  modalTitle.textContent = 'Create Event';
  btnDelete.style.display = 'none';
  btnSave.textContent = 'Create';

  eventTitleInput.value = '';
  eventDateInput.value = fmtDate(dayDate);
  eventStartInput.value = formatTimeFromMinutes(startMinutes);
  eventEndInput.value = endMinutes >= TOTAL_MINUTES ? '23:59' : formatTimeFromMinutes(endMinutes);

  showModal();
  eventTitleInput.focus();
}

function openEditModal(ev) {
  editingEvent = ev;
  modalTitle.textContent = 'Edit Event';
  btnDelete.style.display = 'inline-block';
  btnSave.textContent = 'Save';

  const start = parseWall(ev.start_at);
  const end = parseWall(ev.end_at);

  eventTitleInput.value = ev.title;
  eventDateInput.value = fmtDate(start);
  eventStartInput.value = formatTime(start.hours, start.minutes);

  // Handle midnight end (event ending at 00:00 of next day)
  if (end.hours === 0 && end.minutes === 0 && !sameDateYMD(start, end)) {
    eventEndInput.value = '23:59';
  } else {
    eventEndInput.value = formatTime(end.hours, end.minutes);
  }

  showModal();
  eventTitleInput.focus();
}

// ==================== Event Handlers ====================

async function handleFormSubmit(e) {
  e.preventDefault();
  formError.style.display = 'none';

  const title = eventTitleInput.value.trim();
  const dateStr = eventDateInput.value; // "YYYY-MM-DD"
  const startTime = eventStartInput.value; // "HH:MM"
  const endTime = eventEndInput.value; // "HH:MM"

  if (!title) {
    showError('Title is required');
    return;
  }

  if (!dateStr || !startTime || !endTime) {
    showError('All fields are required');
    return;
  }

  // Build wall-clock ISO strings
  const startAt = `${dateStr}T${startTime}:00`;
  
  let endAt;
  if (endTime === '00:00') {
    // Midnight = end of this day = start of next day
    const dateParts = dateStr.split('-');
    const nextDay = addDaysTo(
      { year: parseInt(dateParts[0]), month: parseInt(dateParts[1]), day: parseInt(dateParts[2]) },
      1
    );
    endAt = `${fmtDate(nextDay)}T00:00:00`;
  } else {
    endAt = `${dateStr}T${endTime}:00`;
  }

  if (endAt <= startAt) {
    showError('End time must be after start time');
    return;
  }

  const data = { title, start_at: startAt, end_at: endAt };

  try {
    if (editingEvent) {
      await updateEvent(editingEvent.id, data);
    } else {
      await createEvent(data);
    }
    hideModal();
    await loadWeek();
  } catch (err) {
    showError(err.message);
  }
}

async function handleDelete() {
  if (!editingEvent) return;
  if (!confirm('Delete this event?')) return;

  try {
    await deleteEvent(editingEvent.id);
    hideModal();
    await loadWeek();
  } catch (err) {
    showError(err.message);
  }
}

// ==================== Data Loading ====================

async function loadWeek() {
  const weekStart = currentWeekStart;
  const weekEnd = addDaysTo(weekStart, 7);

  // Send wall-clock boundaries as query params
  const startStr = `${fmtDate(weekStart)}T00:00:00`;
  const endStr = `${fmtDate(weekEnd)}T00:00:00`;

  try {
    events = await fetchEvents(startStr, endStr);
  } catch (err) {
    console.error('Failed to load events:', err);
    events = [];
  }

  renderDayHeaders();
  renderDayColumns();
  renderEvents();
  updateWeekTitle();
}

function navigateWeek(offset) {
  currentWeekStart = addDaysTo(currentWeekStart, offset * 7);
  loadWeek();
}

function goToToday() {
  currentWeekStart = getMondayOf(todayLocal());
  loadWeek();
}

// ==================== Initialize ====================

function init() {
  currentWeekStart = getMondayOf(todayLocal());

  renderTimeGutter();

  document.getElementById('btn-prev').addEventListener('click', () => navigateWeek(-1));
  document.getElementById('btn-next').addEventListener('click', () => navigateWeek(1));
  document.getElementById('btn-today').addEventListener('click', goToToday);

  eventForm.addEventListener('submit', handleFormSubmit);
  btnCancel.addEventListener('click', hideModal);
  btnDelete.addEventListener('click', handleDelete);
  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) hideModal();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modalOverlay.style.display !== 'none') {
      hideModal();
    }
  });

  loadWeek();

  // Scroll to 8am on initial load
  setTimeout(() => {
    if (calendarScroll) {
      calendarScroll.scrollTop = 8 * HOUR_HEIGHT;
    }
  }, 100);
}

document.addEventListener('DOMContentLoaded', init);
