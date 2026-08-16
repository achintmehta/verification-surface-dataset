import { fetchEvents, createEvent, updateEvent, deleteEvent } from './api.js';
import { getMonday, getSundayEnd, getWeekDays, formatWeekTitle, formatTime, toDatetimeLocal, isToday, isSameDay, DAY_NAMES } from './dateUtils.js';
import { layoutEventsForDay } from './layout.js';

// ---- Constants ----
const HOUR_HEIGHT = 60; // px per hour, must match CSS var(--hour-height)
const TOTAL_MINUTES = 1440;
const GRID_HEIGHT = HOUR_HEIGHT * 24;

// ---- State ----
let currentMonday = getMonday(new Date());
let events = [];
let editingEventId = null;

// Drag state
let dragState = null; // { col, day, startY, selectionEl }

// ---- DOM refs ----
const weekTitle = document.getElementById('week-title');
const daysContainer = document.getElementById('days-container');
const modalOverlay = document.getElementById('modal-overlay');
const modalTitle = document.getElementById('modal-title');
const eventForm = document.getElementById('event-form');
const eventTitleInput = document.getElementById('event-title');
const eventStartInput = document.getElementById('event-start');
const eventEndInput = document.getElementById('event-end');
const formError = document.getElementById('form-error');
const btnSave = document.getElementById('btn-save');
const btnDelete = document.getElementById('btn-delete');
const btnCancel = document.getElementById('btn-cancel');
const btnPrev = document.getElementById('btn-prev');
const btnToday = document.getElementById('btn-today');
const btnNext = document.getElementById('btn-next');

// ---- Event color palette ----
const EVENT_COLORS = [
  { bg: '#4285f4', text: '#fff' },
  { bg: '#0b8043', text: '#fff' },
  { bg: '#8e24aa', text: '#fff' },
  { bg: '#d81b60', text: '#fff' },
  { bg: '#e67c73', text: '#fff' },
  { bg: '#f4511e', text: '#fff' },
  { bg: '#039be5', text: '#fff' },
  { bg: '#616161', text: '#fff' },
  { bg: '#33b679', text: '#fff' },
  { bg: '#f09300', text: '#fff' },
];

function getEventColor(id) {
  return EVENT_COLORS[id % EVENT_COLORS.length];
}

// ---- Build static UI parts ----
function buildTimeGutter() {
  const gutter = document.querySelector('.time-gutter');
  gutter.innerHTML = '';
  for (let h = 0; h < 24; h++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = `${h * HOUR_HEIGHT}px`;
    label.textContent = `${h.toString().padStart(2, '0')}:00`;
    gutter.appendChild(label);
  }
}

function buildDayHeaders() {
  // Remove existing header if any
  const existingHeader = document.querySelector('.day-headers');
  if (existingHeader) existingHeader.remove();

  const days = getWeekDays(currentMonday);
  const headerRow = document.createElement('div');
  headerRow.className = 'day-headers';

  const gutterSpacer = document.createElement('div');
  gutterSpacer.className = 'day-header-gutter';
  headerRow.appendChild(gutterSpacer);

  const headersContainer = document.createElement('div');
  headersContainer.className = 'day-headers-container';

  days.forEach((day, i) => {
    const header = document.createElement('div');
    header.className = 'day-header' + (isToday(day) ? ' today' : '');

    const dayName = document.createElement('div');
    dayName.className = 'day-name';
    dayName.textContent = DAY_NAMES[i];

    const dayNumber = document.createElement('div');
    dayNumber.className = 'day-number';
    dayNumber.textContent = day.getDate();

    header.appendChild(dayName);
    header.appendChild(dayNumber);
    headersContainer.appendChild(header);
  });

  headerRow.appendChild(headersContainer);

  const calContainer = document.querySelector('.calendar-container');
  calContainer.insertBefore(headerRow, calContainer.firstChild);
}

function buildDayColumns() {
  const days = getWeekDays(currentMonday);
  daysContainer.innerHTML = '';

  days.forEach((day, i) => {
    const col = document.createElement('div');
    col.className = 'day-column' + (isToday(day) ? ' today' : '');
    col.dataset.dayIndex = i;
    col.dataset.date = day.toISOString();

    // Hour lines
    for (let h = 0; h < 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${h * HOUR_HEIGHT}px`;
      col.appendChild(line);

      // Half-hour line
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

    // Current time indicator
    if (isToday(day)) {
      const now = new Date();
      const mins = now.getHours() * 60 + now.getMinutes();
      const timeLine = document.createElement('div');
      timeLine.className = 'current-time-line';
      timeLine.style.top = `${(mins / TOTAL_MINUTES) * GRID_HEIGHT}px`;
      col.appendChild(timeLine);
    }

    daysContainer.appendChild(col);
  });
}

// ---- Drag-to-create interaction (global handlers) ----
function getScrollContainer() {
  return document.querySelector('.calendar-scroll');
}

function getYInColumn(e, col) {
  const rect = col.getBoundingClientRect();
  const scrollContainer = getScrollContainer();
  return e.clientY - rect.top + scrollContainer.scrollTop;
}

function minutesFromY(y) {
  const fraction = y / GRID_HEIGHT;
  const totalMins = fraction * TOTAL_MINUTES;
  // Round to nearest 15 minutes
  return Math.max(0, Math.min(TOTAL_MINUTES, Math.round(totalMins / 15) * 15));
}

// Mousedown on day columns
daysContainer.addEventListener('mousedown', (e) => {
  // Only handle clicks on the column background, not on events
  if (e.target.closest('.event-block')) return;

  const col = e.target.closest('.day-column');
  if (!col) return;

  e.preventDefault();

  const dayIndex = parseInt(col.dataset.dayIndex);
  const days = getWeekDays(currentMonday);
  const day = days[dayIndex];

  const startY = getYInColumn(e, col);

  const selectionEl = document.createElement('div');
  selectionEl.className = 'drag-selection';
  selectionEl.style.top = `${startY}px`;
  selectionEl.style.height = '0px';
  col.appendChild(selectionEl);

  dragState = { col, day, startY, selectionEl };
});

document.addEventListener('mousemove', (e) => {
  if (!dragState) return;

  const { col, startY, selectionEl } = dragState;
  const currentY = getYInColumn(e, col);

  const top = Math.max(0, Math.min(startY, currentY));
  const bottom = Math.min(GRID_HEIGHT, Math.max(startY, currentY));

  selectionEl.style.top = `${top}px`;
  selectionEl.style.height = `${bottom - top}px`;
});

document.addEventListener('mouseup', (e) => {
  if (!dragState) return;

  const { col, day, startY, selectionEl } = dragState;
  dragState = null;

  if (selectionEl) {
    selectionEl.remove();
  }

  const endY = getYInColumn(e, col);

  const startMins = minutesFromY(Math.min(startY, endY));
  let endMins = minutesFromY(Math.max(startY, endY));

  // If click (no drag), default to 1 hour event
  if (endMins - startMins < 15) {
    endMins = Math.min(TOTAL_MINUTES, startMins + 60);
  }

  const startDate = new Date(day);
  startDate.setHours(0, 0, 0, 0);
  startDate.setMinutes(startMins);

  const endDate = new Date(day);
  endDate.setHours(0, 0, 0, 0);
  endDate.setMinutes(endMins);

  openCreateModal(startDate, endDate);
});

// ---- Render events ----
function renderEvents() {
  const days = getWeekDays(currentMonday);
  const columns = daysContainer.querySelectorAll('.day-column');

  // Clear existing event blocks
  columns.forEach(col => {
    col.querySelectorAll('.event-block').forEach(el => el.remove());
  });

  // Group events by day
  days.forEach((day, dayIndex) => {
    const dayStart = new Date(day);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);

    // Find events that overlap with this day
    const dayEvents = events.filter(ev => {
      const evStart = new Date(ev.start_at);
      const evEnd = new Date(ev.end_at);
      return evStart < dayEnd && evEnd > dayStart;
    });

    if (dayEvents.length === 0) return;

    const layouts = layoutEventsForDay(dayEvents, dayStart);
    const col = columns[dayIndex];

    layouts.forEach(layout => {
      const block = document.createElement('div');
      block.className = 'event-block';

      const topPx = layout.top * GRID_HEIGHT;
      const heightPx = layout.height * GRID_HEIGHT;
      const leftPct = layout.left * 100;
      const widthPct = layout.width * 100;

      const color = getEventColor(layout.event.id);
      block.style.top = `${topPx}px`;
      block.style.height = `${Math.max(heightPx, 2)}px`; // minimum 2px visible
      block.style.left = `${leftPct}%`;
      block.style.width = `calc(${widthPct}% - 2px)`; // 2px gap for visual separation
      block.style.backgroundColor = color.bg;
      block.style.color = color.text;

      const evStart = new Date(layout.event.start_at);
      const evEnd = new Date(layout.event.end_at);

      const titleEl = document.createElement('div');
      titleEl.className = 'event-title';
      titleEl.textContent = layout.event.title;

      const timeEl = document.createElement('div');
      timeEl.className = 'event-time';
      timeEl.textContent = `${formatTime(evStart)} – ${formatTime(evEnd)}`;

      block.appendChild(titleEl);
      block.appendChild(timeEl);

      block.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditModal(layout.event);
      });

      col.appendChild(block);
    });
  });
}

// ---- Modal ----
function openCreateModal(startDate, endDate) {
  editingEventId = null;
  modalTitle.textContent = 'New Event';
  eventTitleInput.value = '';
  eventStartInput.value = toDatetimeLocal(startDate);
  eventEndInput.value = toDatetimeLocal(endDate);
  btnDelete.style.display = 'none';
  btnSave.textContent = 'Create';
  formError.style.display = 'none';
  modalOverlay.style.display = 'flex';
  eventTitleInput.focus();
}

function openEditModal(event) {
  editingEventId = event.id;
  modalTitle.textContent = 'Edit Event';
  eventTitleInput.value = event.title;
  eventStartInput.value = toDatetimeLocal(new Date(event.start_at));
  eventEndInput.value = toDatetimeLocal(new Date(event.end_at));
  btnDelete.style.display = 'inline-block';
  btnSave.textContent = 'Save';
  formError.style.display = 'none';
  modalOverlay.style.display = 'flex';
  eventTitleInput.focus();
}

function closeModal() {
  modalOverlay.style.display = 'none';
  editingEventId = null;
  formError.style.display = 'none';
}

function showFormError(msg) {
  formError.textContent = msg;
  formError.style.display = 'block';
}

// ---- Form submission ----
eventForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const title = eventTitleInput.value.trim();
  const start_at = eventStartInput.value;
  const end_at = eventEndInput.value;

  if (!title) {
    showFormError('Title is required');
    return;
  }

  const startDate = new Date(start_at);
  const endDate = new Date(end_at);

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    showFormError('Invalid date/time');
    return;
  }

  if (endDate <= startDate) {
    showFormError('End time must be after start time');
    return;
  }

  try {
    if (editingEventId) {
      await updateEvent(editingEventId, {
        title,
        start_at: startDate.toISOString(),
        end_at: endDate.toISOString()
      });
    } else {
      await createEvent({
        title,
        start_at: startDate.toISOString(),
        end_at: endDate.toISOString()
      });
    }
    closeModal();
    await loadAndRender();
  } catch (err) {
    showFormError(err.message);
  }
});

btnDelete.addEventListener('click', async () => {
  if (!editingEventId) return;

  if (confirm('Delete this event?')) {
    try {
      await deleteEvent(editingEventId);
      closeModal();
      await loadAndRender();
    } catch (err) {
      showFormError(err.message);
    }
  }
});

btnCancel.addEventListener('click', closeModal);

modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeModal();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modalOverlay.style.display !== 'none') {
    closeModal();
  }
});

// ---- Navigation ----
btnPrev.addEventListener('click', () => {
  currentMonday = new Date(currentMonday);
  currentMonday.setDate(currentMonday.getDate() - 7);
  buildAndLoad();
});

btnToday.addEventListener('click', () => {
  currentMonday = getMonday(new Date());
  buildAndLoad();
});

btnNext.addEventListener('click', () => {
  currentMonday = new Date(currentMonday);
  currentMonday.setDate(currentMonday.getDate() + 7);
  buildAndLoad();
});

// ---- Loading ----
async function loadEvents() {
  const start = new Date(currentMonday);
  const end = getSundayEnd(currentMonday);
  events = await fetchEvents(start, end);
}

async function loadAndRender() {
  await loadEvents();
  renderEvents();
}

function buildAndLoad() {
  weekTitle.textContent = formatWeekTitle(currentMonday);
  buildDayHeaders();
  buildDayColumns();
  loadAndRender();
}

// ---- Init ----
buildTimeGutter();
buildAndLoad();

// Scroll to 8am on initial load
setTimeout(() => {
  const scroll = document.querySelector('.calendar-scroll');
  scroll.scrollTop = 8 * HOUR_HEIGHT;
}, 100);

// Update current time line every minute
setInterval(() => {
  const existingLines = document.querySelectorAll('.current-time-line');
  existingLines.forEach(line => {
    const now = new Date();
    const mins = now.getHours() * 60 + now.getMinutes();
    line.style.top = `${(mins / TOTAL_MINUTES) * GRID_HEIGHT}px`;
  });
}, 60000);
