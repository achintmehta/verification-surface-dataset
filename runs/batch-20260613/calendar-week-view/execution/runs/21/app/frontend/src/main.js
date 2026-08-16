import { fetchEvents, createEvent, updateEvent, deleteEvent } from './api.js';
import { computeDayLayout } from './layout.js';
import {
  getMonday, getWeekDays, getWeekRange,
  formatDayHeader, formatWeekTitle, isSameDay,
  formatTime, minutesFromMidnight, toLocalISOString, toAPIDateString
} from './date-utils.js';

// Constants
const HOUR_HEIGHT = 60; // px per hour - must match CSS var(--hour-height)
const TOTAL_MINUTES = 24 * 60;
const TOTAL_HEIGHT = 24 * HOUR_HEIGHT;

// State
let currentMonday = getMonday(new Date());
let events = [];
let editingEvent = null; // null = creating, object = editing

// Drag state (module-level to avoid leaking listeners)
let dragState = null; // { column, day, startMinute, selectionEl }

// DOM references
const weekTitle = document.getElementById('week-title');
const dayHeaders = document.getElementById('day-headers');
const weekGrid = document.getElementById('week-grid');
const timeGutter = document.getElementById('time-gutter');
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

// --- Rendering ---

function renderTimeGutter() {
  timeGutter.innerHTML = '';
  for (let h = 0; h <= 24; h++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    // Show "00:00" for both 0 and 24 is fine; the 24 label sits at the bottom edge
    label.textContent = formatTime(h % 24, 0);
    label.style.top = `${h * HOUR_HEIGHT}px`;
    timeGutter.appendChild(label);
  }
}

function renderDayHeaders() {
  const days = getWeekDays(currentMonday);
  const today = new Date();
  dayHeaders.innerHTML = '';

  days.forEach(day => {
    const { dayName, dayNumber } = formatDayHeader(day);
    const header = document.createElement('div');
    header.className = 'day-header';
    if (isSameDay(day, today)) {
      header.classList.add('today');
    }

    const nameEl = document.createElement('span');
    nameEl.className = 'day-name';
    nameEl.textContent = dayName;

    const numEl = document.createElement('span');
    numEl.className = 'day-number';
    numEl.textContent = dayNumber;

    header.appendChild(nameEl);
    header.appendChild(numEl);
    dayHeaders.appendChild(header);
  });
}

function renderWeekGrid() {
  const days = getWeekDays(currentMonday);
  const today = new Date();
  weekGrid.innerHTML = '';

  days.forEach((day, dayIndex) => {
    const column = document.createElement('div');
    column.className = 'day-column';
    column.dataset.dayIndex = dayIndex;
    if (isSameDay(day, today)) {
      column.classList.add('today');
    }

    // Hour lines and half-hour lines
    for (let h = 0; h < 24; h++) {
      const hourLine = document.createElement('div');
      hourLine.className = 'hour-line';
      hourLine.style.top = `${h * HOUR_HEIGHT}px`;
      column.appendChild(hourLine);

      const halfLine = document.createElement('div');
      halfLine.className = 'half-hour-line';
      halfLine.style.top = `${h * HOUR_HEIGHT + HOUR_HEIGHT / 2}px`;
      column.appendChild(halfLine);
    }

    // Bottom line at 24:00
    const bottomLine = document.createElement('div');
    bottomLine.className = 'hour-line';
    bottomLine.style.top = `${24 * HOUR_HEIGHT}px`;
    column.appendChild(bottomLine);

    // Mousedown on the column for creating events
    column.addEventListener('mousedown', (e) => {
      if (e.target.closest('.event-block')) return;
      if (e.button !== 0) return;
      e.preventDefault();

      const minute = snapToQuarter(getMinuteFromColumn(e.clientY, column));

      const selectionEl = document.createElement('div');
      selectionEl.className = 'selection-highlight';
      const top = (minute / TOTAL_MINUTES) * TOTAL_HEIGHT;
      selectionEl.style.top = `${top}px`;
      selectionEl.style.height = `${HOUR_HEIGHT / 2}px`;
      column.appendChild(selectionEl);

      dragState = {
        column,
        day: new Date(day),
        startMinute: minute,
        selectionEl
      };
    });

    weekGrid.appendChild(column);
  });

  renderEvents();
}

function getMinuteFromColumn(clientY, column) {
  const colRect = column.getBoundingClientRect();
  const relativeY = clientY - colRect.top;
  const minute = Math.round((relativeY / TOTAL_HEIGHT) * TOTAL_MINUTES);
  return Math.max(0, Math.min(TOTAL_MINUTES, minute));
}

function snapToQuarter(minute) {
  return Math.round(minute / 15) * 15;
}

// Global mouse handlers for drag (registered once)
document.addEventListener('mousemove', (e) => {
  if (!dragState) return;
  const { column, startMinute, selectionEl } = dragState;
  const currentMinute = snapToQuarter(getMinuteFromColumn(e.clientY, column));
  const minStart = Math.min(startMinute, currentMinute);
  const minEnd = Math.max(startMinute, currentMinute);

  const top = (minStart / TOTAL_MINUTES) * TOTAL_HEIGHT;
  const height = ((minEnd - minStart) / TOTAL_MINUTES) * TOTAL_HEIGHT;

  selectionEl.style.top = `${top}px`;
  selectionEl.style.height = `${Math.max(height, 1)}px`;
});

document.addEventListener('mouseup', (e) => {
  if (!dragState) return;
  const { column, day, startMinute, selectionEl } = dragState;

  let endMinute = snapToQuarter(getMinuteFromColumn(e.clientY, column));
  let minStart = Math.min(startMinute, endMinute);
  let minEnd = Math.max(startMinute, endMinute);

  // If just clicking (no significant drag), default to 1 hour
  if (minEnd - minStart < 15) {
    minEnd = Math.min(minStart + 60, TOTAL_MINUTES);
  }

  // Remove selection highlight
  selectionEl.remove();
  dragState = null;

  // Open create modal with pre-filled times
  const startDate = new Date(day);
  startDate.setHours(Math.floor(minStart / 60), minStart % 60, 0, 0);

  const endDate = new Date(day);
  endDate.setHours(Math.floor(minEnd / 60), minEnd % 60, 0, 0);

  openCreateModal(startDate, endDate);
});

function renderEvents() {
  const days = getWeekDays(currentMonday);

  // Group events by day
  const eventsByDay = new Map();
  days.forEach((_, i) => eventsByDay.set(i, []));

  events.forEach(ev => {
    const evStart = new Date(ev.start_at);
    const evEnd = new Date(ev.end_at);

    days.forEach((day, dayIndex) => {
      const dayStart = new Date(day);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(day);
      dayEnd.setHours(0, 0, 0, 0);
      dayEnd.setDate(dayEnd.getDate() + 1);

      // Check if event overlaps this day
      if (evStart < dayEnd && evEnd > dayStart) {
        // Clamp to day boundaries
        const clampedStart = evStart < dayStart ? dayStart : evStart;
        const clampedEnd = evEnd > dayEnd ? dayEnd : evEnd;

        const minuteStart = minutesFromMidnight(clampedStart);
        // If clampedEnd is exactly midnight of next day, that's 1440
        let minuteEnd;
        if (clampedEnd.getTime() === dayEnd.getTime()) {
          minuteEnd = TOTAL_MINUTES;
        } else {
          minuteEnd = minutesFromMidnight(clampedEnd);
        }

        if (minuteEnd <= minuteStart) return;

        eventsByDay.get(dayIndex).push({
          id: ev.id,
          title: ev.title,
          minuteStart,
          minuteEnd,
          _event: ev
        });
      }
    });
  });

  // For each day column, compute layout and render event blocks
  const columns = weekGrid.querySelectorAll('.day-column');
  columns.forEach((col, dayIndex) => {
    // Remove existing event blocks
    col.querySelectorAll('.event-block').forEach(el => el.remove());

    const dayEvents = eventsByDay.get(dayIndex) || [];
    const layoutEvents = computeDayLayout(dayEvents);

    layoutEvents.forEach(le => {
      const block = document.createElement('div');
      block.className = 'event-block';

      // Vertical positioning: proportional to minutes
      const top = (le.minuteStart / TOTAL_MINUTES) * TOTAL_HEIGHT;
      const height = ((le.minuteEnd - le.minuteStart) / TOTAL_MINUTES) * TOTAL_HEIGHT;

      // Horizontal positioning: column-based within day column
      const widthPercent = 100 / le.totalColumns;
      const leftPercent = le.column * widthPercent;

      block.style.top = `${top}px`;
      block.style.height = `${height}px`;
      block.style.left = `${leftPercent}%`;
      block.style.width = `${widthPercent}%`;

      // Content
      const startH = Math.floor(le.minuteStart / 60);
      const startM = le.minuteStart % 60;
      const endH = Math.floor(le.minuteEnd / 60);
      const endM = le.minuteEnd % 60;

      const titleEl = document.createElement('div');
      titleEl.className = 'event-title';
      titleEl.textContent = le.title;

      const timeEl = document.createElement('div');
      timeEl.className = 'event-time';
      timeEl.textContent = `${formatTime(startH, startM)} – ${formatTime(endH % 24, endM)}`;

      block.appendChild(titleEl);
      block.appendChild(timeEl);

      // Click to edit
      block.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditModal(le._event);
      });

      col.appendChild(block);
    });
  });
}

// --- Modal ---

function openCreateModal(startDate, endDate) {
  editingEvent = null;
  modalTitle.textContent = 'Create Event';
  eventTitleInput.value = '';
  eventStartInput.value = toLocalISOString(startDate);
  eventEndInput.value = toLocalISOString(endDate);
  btnDelete.classList.add('hidden');
  btnSave.textContent = 'Create';
  formError.classList.add('hidden');
  modalOverlay.classList.remove('hidden');
  eventTitleInput.focus();
}

function openEditModal(ev) {
  editingEvent = ev;
  modalTitle.textContent = 'Edit Event';
  eventTitleInput.value = ev.title;
  eventStartInput.value = toLocalISOString(new Date(ev.start_at));
  eventEndInput.value = toLocalISOString(new Date(ev.end_at));
  btnDelete.classList.remove('hidden');
  btnSave.textContent = 'Save';
  formError.classList.add('hidden');
  modalOverlay.classList.remove('hidden');
  eventTitleInput.focus();
}

function closeModal() {
  modalOverlay.classList.add('hidden');
  editingEvent = null;
  formError.classList.add('hidden');
}

function showFormError(message) {
  formError.textContent = message;
  formError.classList.remove('hidden');
}

// --- Event Handlers ---

eventForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  formError.classList.add('hidden');

  const title = eventTitleInput.value.trim();
  const startVal = eventStartInput.value;
  const endVal = eventEndInput.value;

  if (!title) {
    showFormError('Title is required');
    return;
  }

  const startDate = new Date(startVal);
  const endDate = new Date(endVal);

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    showFormError('Invalid date/time');
    return;
  }

  if (endDate <= startDate) {
    showFormError('End time must be after start time');
    return;
  }

  const eventData = {
    title,
    start_at: toAPIDateString(startDate),
    end_at: toAPIDateString(endDate)
  };

  try {
    if (editingEvent) {
      await updateEvent(editingEvent.id, eventData);
    } else {
      await createEvent(eventData);
    }
    closeModal();
    await loadEvents();
  } catch (err) {
    showFormError(err.message);
  }
});

btnDelete.addEventListener('click', async () => {
  if (!editingEvent) return;
  try {
    await deleteEvent(editingEvent.id);
    closeModal();
    await loadEvents();
  } catch (err) {
    showFormError(err.message);
  }
});

btnCancel.addEventListener('click', closeModal);

modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) {
    closeModal();
  }
});

// Escape key to close modal
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modalOverlay.classList.contains('hidden')) {
    closeModal();
  }
});

// Week navigation
btnPrev.addEventListener('click', () => {
  currentMonday = new Date(currentMonday);
  currentMonday.setDate(currentMonday.getDate() - 7);
  renderWeek();
  loadEvents();
});

btnToday.addEventListener('click', () => {
  currentMonday = getMonday(new Date());
  renderWeek();
  loadEvents();
});

btnNext.addEventListener('click', () => {
  currentMonday = new Date(currentMonday);
  currentMonday.setDate(currentMonday.getDate() + 7);
  renderWeek();
  loadEvents();
});

// --- Data Loading ---

async function loadEvents() {
  const { start, end } = getWeekRange(currentMonday);
  try {
    events = await fetchEvents(start, end);
    renderEvents();
  } catch (err) {
    console.error('Failed to load events:', err);
  }
}

function renderWeek() {
  weekTitle.textContent = formatWeekTitle(currentMonday);
  renderDayHeaders();
  renderWeekGrid();
}

// --- Init ---
function init() {
  renderTimeGutter();
  renderWeek();
  loadEvents();
}

init();
