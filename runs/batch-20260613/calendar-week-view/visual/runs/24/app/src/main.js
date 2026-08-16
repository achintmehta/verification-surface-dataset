import { computeLayout, minutesToTimeStr } from './layout.js';
import { fetchEvents, createEvent, updateEvent, deleteEvent } from './api.js';

// ========================
// Constants
// ========================
const HOUR_HEIGHT = 60; // px per hour
const TOTAL_MINUTES = 24 * 60;
const AXIS_HEIGHT = 24 * HOUR_HEIGHT; // total px for 24 hours
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

// Event color palette for variety
const EVENT_COLORS = [
  { bg: '#4285f4', border: '#1a73e8' },
  { bg: '#0b8043', border: '#0d652d' },
  { bg: '#8e24aa', border: '#6a1b9a' },
  { bg: '#d81b60', border: '#ad1457' },
  { bg: '#e67c73', border: '#d32f2f' },
  { bg: '#f4511e', border: '#bf360c' },
  { bg: '#039be5', border: '#0277bd' },
  { bg: '#616161', border: '#424242' },
  { bg: '#33b679', border: '#1e8e3e' },
  { bg: '#3f51b5', border: '#283593' },
];

function getEventColor(id) {
  return EVENT_COLORS[id % EVENT_COLORS.length];
}

// ========================
// State
// ========================
let currentWeekStart = getMonday(new Date());
let events = [];
let editingEventId = null;

// ========================
// Date Utilities
// ========================

/** Get the Monday 00:00 of the week containing `date`. */
function getMonday(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0 = Sun, 1 = Mon, ...
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
}

/** Add `n` days to a date. */
function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

/** Check if two dates are the same calendar day. */
function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}

/** Format date as YYYY-MM-DD */
function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Parse an ISO-like datetime string as a local date */
function parseLocalDateTime(str) {
  if (!str) return new Date(NaN);
  // If the string has timezone info, use Date constructor
  if (str.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(str)) {
    return new Date(str);
  }
  // Parse manually to avoid timezone issues
  const parts = str.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):?(\d{2})?/);
  if (!parts) return new Date(str);
  return new Date(
    parseInt(parts[1]), parseInt(parts[2]) - 1, parseInt(parts[3]),
    parseInt(parts[4]), parseInt(parts[5]), parseInt(parts[6] || 0)
  );
}

// ========================
// DOM References
// ========================
const weekTitleEl = document.getElementById('week-title');
const timeGutterEl = document.getElementById('time-gutter');
const daysContainerEl = document.getElementById('days-container');
const modalOverlayEl = document.getElementById('modal-overlay');
const modalTitleEl = document.getElementById('modal-title');
const formEl = document.getElementById('event-form');
const titleInputEl = document.getElementById('event-title');
const dateInputEl = document.getElementById('event-date');
const startInputEl = document.getElementById('event-start');
const endInputEl = document.getElementById('event-end');
const formErrorEl = document.getElementById('form-error');
const btnSave = document.getElementById('btn-save');
const btnCancel = document.getElementById('btn-cancel');
const btnDelete = document.getElementById('btn-delete');
const btnPrev = document.getElementById('btn-prev');
const btnToday = document.getElementById('btn-today');
const btnNext = document.getElementById('btn-next');

// ========================
// Rendering: Time Gutter
// ========================
function renderTimeGutter() {
  timeGutterEl.innerHTML = '';

  // Sticky header spacer
  const headerSpacer = document.createElement('div');
  headerSpacer.className = 'gutter-header';
  timeGutterEl.appendChild(headerSpacer);

  const gutterBody = document.createElement('div');
  gutterBody.className = 'gutter-body';

  for (let h = 0; h < 24; h++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = `${h * HOUR_HEIGHT}px`;
    label.textContent = `${String(h).padStart(2, '0')}:00`;
    gutterBody.appendChild(label);
  }

  timeGutterEl.appendChild(gutterBody);
}

// ========================
// Rendering: Day Columns
// ========================
function renderDayColumns() {
  daysContainerEl.innerHTML = '';

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let d = 0; d < 7; d++) {
    const date = addDays(currentWeekStart, d);
    const isToday = sameDay(date, today);

    const col = document.createElement('div');
    col.className = 'day-column' + (isToday ? ' today' : '');
    col.dataset.dayIndex = d;
    col.dataset.date = formatDate(date);

    // Header
    const header = document.createElement('div');
    header.className = 'day-header';

    const dayName = document.createElement('span');
    dayName.className = 'day-name';
    dayName.textContent = DAY_NAMES[d];

    const dayNumber = document.createElement('span');
    dayNumber.className = 'day-number';
    dayNumber.textContent = date.getDate();

    header.appendChild(dayName);
    header.appendChild(dayNumber);
    col.appendChild(header);

    // Body
    const body = document.createElement('div');
    body.className = 'day-body';

    // Hour lines
    for (let h = 0; h <= 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${h * HOUR_HEIGHT}px`;
      body.appendChild(line);
    }

    // Half-hour lines
    for (let h = 0; h < 24; h++) {
      const halfLine = document.createElement('div');
      halfLine.className = 'hour-line half-hour';
      halfLine.style.top = `${h * HOUR_HEIGHT + HOUR_HEIGHT / 2}px`;
      body.appendChild(halfLine);
    }

    col.appendChild(body);
    daysContainerEl.appendChild(col);

    // Interaction: click/drag to create
    setupDayInteraction(body, date);
  }
}

// ========================
// Rendering: Events
// ========================
function renderEvents() {
  // Clear existing event blocks
  document.querySelectorAll('.event-block').forEach(el => el.remove());

  // Group events by day
  const dayEvents = {};
  for (let d = 0; d < 7; d++) {
    dayEvents[d] = [];
  }

  for (const ev of events) {
    const start = parseLocalDateTime(ev.start_at);
    const end = parseLocalDateTime(ev.end_at);

    // Find which day(s) this event falls on
    for (let d = 0; d < 7; d++) {
      const dayStart = addDays(currentWeekStart, d);
      const dayEnd = addDays(currentWeekStart, d + 1);

      // Event overlaps this day?
      if (start < dayEnd && end > dayStart) {
        // Clamp to day boundaries
        const clampedStart = start < dayStart ? dayStart : start;
        const clampedEnd = end > dayEnd ? dayEnd : end;

        let startMinutes = clampedStart.getHours() * 60 + clampedStart.getMinutes();
        let endMinutes;

        // If the clamped end is at midnight of the next day
        if (clampedEnd.getTime() === dayEnd.getTime()) {
          endMinutes = TOTAL_MINUTES; // 1440
        } else {
          endMinutes = clampedEnd.getHours() * 60 + clampedEnd.getMinutes();
        }

        // Handle edge case: if end is midnight (00:00) on a different day from start
        if (endMinutes === 0 && !sameDay(clampedEnd, clampedStart)) {
          endMinutes = TOTAL_MINUTES;
        }

        if (endMinutes > startMinutes) {
          dayEvents[d].push({
            id: ev.id,
            title: ev.title,
            startMinutes,
            endMinutes,
            originalStart: start,
            originalEnd: end,
          });
        }
      }
    }
  }

  // Compute layout and render for each day
  for (let d = 0; d < 7; d++) {
    const layouts = computeLayout(dayEvents[d]);
    const dayBody = daysContainerEl.children[d]?.querySelector('.day-body');
    if (!dayBody) continue;

    for (const item of layouts) {
      const block = document.createElement('div');
      block.className = 'event-block';

      const color = getEventColor(item.id);

      // Vertical positioning: exact minute precision
      const top = (item.startMinutes / TOTAL_MINUTES) * AXIS_HEIGHT;
      const height = ((item.endMinutes - item.startMinutes) / TOTAL_MINUTES) * AXIS_HEIGHT;

      // Horizontal positioning: column-based
      const widthPercent = 100 / item.totalColumns;
      const leftPercent = item.column * widthPercent;

      block.style.top = `${top}px`;
      block.style.height = `${height}px`;
      block.style.left = `calc(${leftPercent}% + 1px)`;
      block.style.width = `calc(${widthPercent}% - 3px)`;
      block.style.backgroundColor = color.bg;
      block.style.borderLeftColor = color.border;

      // Content
      const titleSpan = document.createElement('span');
      titleSpan.className = 'event-title';
      titleSpan.textContent = item.title;

      const timeSpan = document.createElement('span');
      timeSpan.className = 'event-time';
      const endLabel = item.endMinutes === TOTAL_MINUTES ? '24:00' : minutesToTimeStr(item.endMinutes);
      timeSpan.textContent = `${minutesToTimeStr(item.startMinutes)} – ${endLabel}`;

      block.appendChild(titleSpan);
      block.appendChild(timeSpan);

      // Click to edit
      block.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditModal(item.id);
      });

      dayBody.appendChild(block);
    }
  }
}

// ========================
// Interaction: Click/Drag to Create
// ========================
function setupDayInteraction(dayBody, date) {
  let isDragging = false;
  let startY = 0;
  let currentY = 0;
  let selectionEl = null;
  let hasMoved = false;

  function yToMinutes(y) {
    const rect = dayBody.getBoundingClientRect();
    const relY = Math.max(0, Math.min(y - rect.top, AXIS_HEIGHT));
    return Math.round((relY / AXIS_HEIGHT) * TOTAL_MINUTES);
  }

  function snapToQuarter(minutes) {
    return Math.min(Math.round(minutes / 15) * 15, TOTAL_MINUTES);
  }

  dayBody.addEventListener('mousedown', (e) => {
    if (e.target.closest('.event-block')) return;
    if (e.button !== 0) return; // Only left click
    isDragging = true;
    hasMoved = false;
    startY = e.clientY;
    currentY = e.clientY;

    selectionEl = document.createElement('div');
    selectionEl.className = 'selection-highlight';
    dayBody.appendChild(selectionEl);

    updateSelection(e.clientY);
    e.preventDefault();
  });

  const onMouseMove = (e) => {
    if (!isDragging || !selectionEl) return;
    hasMoved = true;
    currentY = e.clientY;
    updateSelection(e.clientY);
  };

  const onMouseUp = (e) => {
    if (!isDragging) return;
    isDragging = false;

    let minStart = snapToQuarter(yToMinutes(Math.min(startY, currentY)));
    let minEnd = snapToQuarter(yToMinutes(Math.max(startY, currentY)));

    if (selectionEl) {
      selectionEl.remove();
      selectionEl = null;
    }

    // If no drag movement (just a click), create a 1-hour event
    if (!hasMoved || minEnd - minStart < 15) {
      minEnd = Math.min(minStart + 60, TOTAL_MINUTES);
    }

    if (minEnd <= minStart) {
      minEnd = Math.min(minStart + 60, TOTAL_MINUTES);
    }

    openCreateModal(date, minStart, minEnd);
  };

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);

  function updateSelection(mouseY) {
    if (!selectionEl) return;
    const topMin = yToMinutes(Math.min(startY, mouseY));
    const bottomMin = yToMinutes(Math.max(startY, mouseY));

    const top = (topMin / TOTAL_MINUTES) * AXIS_HEIGHT;
    const height = ((bottomMin - topMin) / TOTAL_MINUTES) * AXIS_HEIGHT;

    selectionEl.style.top = `${top}px`;
    selectionEl.style.height = `${Math.max(height, 2)}px`;
  }
}

// ========================
// Modal: Create
// ========================
function openCreateModal(date, startMinutes, endMinutes) {
  editingEventId = null;
  modalTitleEl.textContent = 'Create Event';
  btnDelete.style.display = 'none';
  btnSave.textContent = 'Create';

  titleInputEl.value = '';
  dateInputEl.value = formatDate(date);
  startInputEl.value = minutesToTimeStr(startMinutes);
  // For end time display, if 1440 use 23:59 (HTML time input can't do 24:00)
  endInputEl.value = endMinutes >= TOTAL_MINUTES ? '23:59' : minutesToTimeStr(endMinutes);

  hideError();
  showModal();
}

// ========================
// Modal: Edit
// ========================
function openEditModal(eventId) {
  const ev = events.find(e => e.id === eventId);
  if (!ev) return;

  editingEventId = eventId;
  modalTitleEl.textContent = 'Edit Event';
  btnDelete.style.display = 'inline-block';
  btnSave.textContent = 'Save';

  const start = parseLocalDateTime(ev.start_at);
  const end = parseLocalDateTime(ev.end_at);

  titleInputEl.value = ev.title;
  dateInputEl.value = formatDate(start);
  startInputEl.value = `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`;

  // Handle midnight end time
  if (end.getHours() === 0 && end.getMinutes() === 0 && !sameDay(start, end)) {
    endInputEl.value = '23:59';
  } else {
    endInputEl.value = `${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`;
  }

  hideError();
  showModal();
}

function showModal() {
  modalOverlayEl.style.display = 'flex';
  setTimeout(() => titleInputEl.focus(), 50);
}

function hideModal() {
  modalOverlayEl.style.display = 'none';
  editingEventId = null;
  hideError();
}

function showError(msg) {
  formErrorEl.textContent = msg;
  formErrorEl.style.display = 'block';
}

function hideError() {
  formErrorEl.style.display = 'none';
}

// ========================
// Form handlers
// ========================
formEl.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError();

  const title = titleInputEl.value.trim();
  const date = dateInputEl.value;
  const startTime = startInputEl.value;
  const endTime = endInputEl.value;

  if (!title) {
    showError('Title is required');
    return;
  }

  if (!date || !startTime || !endTime) {
    showError('All fields are required');
    return;
  }

  const startAt = `${date}T${startTime}:00`;
  let endAt;

  // Handle end time: if 23:59, treat as going to midnight (next day 00:00)
  if (endTime === '23:59' || endTime === '00:00') {
    const nextDay = addDays(new Date(date + 'T00:00:00'), 1);
    endAt = `${formatDate(nextDay)}T00:00:00`;
  } else {
    endAt = `${date}T${endTime}:00`;
  }

  // Validate end > start
  const startDate = new Date(startAt);
  const endDate = new Date(endAt);

  if (endDate <= startDate) {
    showError('End time must be after start time');
    return;
  }

  try {
    if (editingEventId) {
      await updateEvent(editingEventId, { title, start_at: startAt, end_at: endAt });
    } else {
      await createEvent({ title, start_at: startAt, end_at: endAt });
    }
    hideModal();
    await loadEvents();
  } catch (err) {
    showError(err.message || 'Failed to save event');
  }
});

btnCancel.addEventListener('click', hideModal);

modalOverlayEl.addEventListener('click', (e) => {
  if (e.target === modalOverlayEl) hideModal();
});

// Keyboard: Escape to close modal
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modalOverlayEl.style.display !== 'none') {
    hideModal();
  }
});

btnDelete.addEventListener('click', async () => {
  if (!editingEventId) return;

  if (confirm('Delete this event?')) {
    try {
      await deleteEvent(editingEventId);
      hideModal();
      await loadEvents();
    } catch (err) {
      showError(err.message || 'Failed to delete event');
    }
  }
});

// ========================
// Navigation
// ========================
btnPrev.addEventListener('click', () => {
  currentWeekStart = addDays(currentWeekStart, -7);
  renderWeek();
  loadEvents();
});

btnToday.addEventListener('click', () => {
  currentWeekStart = getMonday(new Date());
  renderWeek();
  loadEvents();
});

btnNext.addEventListener('click', () => {
  currentWeekStart = addDays(currentWeekStart, 7);
  renderWeek();
  loadEvents();
});

// ========================
// Week Title
// ========================
function updateWeekTitle() {
  const start = currentWeekStart;
  const end = addDays(currentWeekStart, 6);

  const startMonth = MONTH_NAMES[start.getMonth()];
  const endMonth = MONTH_NAMES[end.getMonth()];

  if (start.getMonth() === end.getMonth()) {
    weekTitleEl.textContent = `${startMonth} ${start.getDate()} – ${end.getDate()}, ${start.getFullYear()}`;
  } else if (start.getFullYear() === end.getFullYear()) {
    weekTitleEl.textContent = `${startMonth} ${start.getDate()} – ${endMonth} ${end.getDate()}, ${start.getFullYear()}`;
  } else {
    weekTitleEl.textContent = `${startMonth} ${start.getDate()}, ${start.getFullYear()} – ${endMonth} ${end.getDate()}, ${end.getFullYear()}`;
  }
}

// ========================
// Data Loading
// ========================
async function loadEvents() {
  const weekEnd = addDays(currentWeekStart, 7);
  try {
    events = await fetchEvents(currentWeekStart, weekEnd);
    renderEvents();
  } catch (err) {
    console.error('Failed to load events:', err);
  }
}

// ========================
// Full Render
// ========================
function renderWeek() {
  updateWeekTitle();
  renderTimeGutter();
  renderDayColumns();
}

// ========================
// Scroll to working hours on init
// ========================
function scrollToWorkingHours() {
  const container = document.querySelector('.calendar-container');
  if (container) {
    // Scroll to ~7am area so working hours are visible
    const scrollTo = 7 * HOUR_HEIGHT;
    container.scrollTop = scrollTo;
  }
}

// ========================
// Init
// ========================
renderWeek();
loadEvents().then(() => {
  scrollToWorkingHours();
});
