import { fetchEvents, createEvent, updateEvent, deleteEvent } from './api.js';
import { computeDayLayout } from './layout.js';
import {
  getMonday, getWeekEnd, getWeekDays,
  formatDayHeader, formatWeekTitle, isSameDay,
  minutesFromMidnight, formatTime, formatDateTime,
  toDatetimeLocalValue
} from './dateutils.js';

// Constants
const HOUR_HEIGHT = 60; // px per hour
const TOTAL_MINUTES = 1440;
const AXIS_HEIGHT = HOUR_HEIGHT * 24; // 1440px

// State
let currentMonday = getMonday(new Date());
let events = [];
let editingEventId = null;
let initialScrollDone = false;

// Drag state (global so we only have one set of document listeners)
let dragState = null; // { clickArea, startY, selectionEl, day }

// DOM refs
const weekTitle = document.getElementById('week-title');
const timeGutter = document.getElementById('time-gutter');
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

// ---- Initialization ----

function init() {
  renderTimeGutter();
  bindNavigation();
  bindModal();
  bindDragListeners();
  loadWeek();
}

// ---- Time Gutter ----

function renderTimeGutter() {
  timeGutter.innerHTML = '';
  // Spacer for day headers
  const spacer = document.createElement('div');
  spacer.style.height = '50px';
  timeGutter.appendChild(spacer);

  for (let h = 0; h <= 24; h++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = `${50 + h * HOUR_HEIGHT}px`;
    if (h < 24) {
      label.textContent = formatTime(h, 0);
    }
    timeGutter.appendChild(label);
  }

  timeGutter.style.minHeight = `${50 + AXIS_HEIGHT}px`;
}

// ---- Week Grid ----

function renderWeekGrid() {
  const days = getWeekDays(currentMonday);
  const today = new Date();

  weekTitle.textContent = formatWeekTitle(currentMonday);
  daysContainer.innerHTML = '';

  days.forEach((day, index) => {
    const col = document.createElement('div');
    col.className = 'day-column';
    col.dataset.dayIndex = index;

    if (isSameDay(day, today)) {
      col.classList.add('today');
    }

    // Day header
    const header = document.createElement('div');
    header.className = 'day-header';
    const { dayName, dayDate } = formatDayHeader(day);
    header.innerHTML = `
      <span class="day-name">${dayName}</span>
      <span class="day-date">${dayDate}</span>
    `;
    col.appendChild(header);

    // Hour lines
    for (let h = 0; h <= 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${50 + h * HOUR_HEIGHT}px`;
      col.appendChild(line);
    }

    // Click area for creating events (behind event blocks)
    const clickArea = document.createElement('div');
    clickArea.className = 'click-area';
    clickArea.dataset.dayIndex = index;
    clickArea.dataset.dayIso = day.toISOString();
    col.appendChild(clickArea);

    // Events area (above click area via z-index)
    const eventsArea = document.createElement('div');
    eventsArea.className = 'events-area';
    eventsArea.dataset.dayIndex = index;
    col.appendChild(eventsArea);

    // Current time line for today
    if (isSameDay(day, today)) {
      const nowMinutes = minutesFromMidnight(today);
      const timeLine = document.createElement('div');
      timeLine.className = 'current-time-line';
      timeLine.style.top = `${50 + (nowMinutes / TOTAL_MINUTES) * AXIS_HEIGHT}px`;
      col.appendChild(timeLine);
    }

    daysContainer.appendChild(col);
  });
}

// ---- Drag-to-select (single set of document listeners) ----

function yToMinutes(y) {
  const fraction = y / AXIS_HEIGHT;
  const raw = fraction * TOTAL_MINUTES;
  return Math.max(0, Math.min(TOTAL_MINUTES, Math.round(raw / 15) * 15));
}

function bindDragListeners() {
  // Mousedown on any click-area starts the drag
  daysContainer.addEventListener('mousedown', (e) => {
    const clickArea = e.target.closest('.click-area');
    if (!clickArea || e.button !== 0) return;

    const rect = clickArea.getBoundingClientRect();
    const startY = e.clientY - rect.top;

    const selectionEl = document.createElement('div');
    selectionEl.className = 'drag-selection';
    selectionEl.style.top = `${startY}px`;
    selectionEl.style.height = '0px';
    clickArea.appendChild(selectionEl);

    dragState = {
      clickArea,
      startY,
      selectionEl,
      day: new Date(clickArea.dataset.dayIso)
    };

    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragState) return;
    const rect = dragState.clickArea.getBoundingClientRect();
    const currentY = Math.max(0, Math.min(AXIS_HEIGHT, e.clientY - rect.top));
    const top = Math.min(dragState.startY, currentY);
    const bottom = Math.max(dragState.startY, currentY);
    dragState.selectionEl.style.top = `${top}px`;
    dragState.selectionEl.style.height = `${bottom - top}px`;
  });

  document.addEventListener('mouseup', (e) => {
    if (!dragState) return;

    const { clickArea, startY, selectionEl, day } = dragState;
    const rect = clickArea.getBoundingClientRect();
    const endY = Math.max(0, Math.min(AXIS_HEIGHT, e.clientY - rect.top));

    const startMin = yToMinutes(Math.min(startY, endY));
    let endMin = yToMinutes(Math.max(startY, endY));

    // If click (no drag), default to 1 hour
    if (endMin - startMin < 15) {
      endMin = Math.min(TOTAL_MINUTES, startMin + 60);
    }

    selectionEl.remove();
    dragState = null;

    // Open create modal with pre-filled times
    const startDate = new Date(day);
    startDate.setHours(Math.floor(startMin / 60), startMin % 60, 0, 0);
    const endDate = new Date(day);
    endDate.setHours(Math.floor(endMin / 60), endMin % 60, 0, 0);

    // Handle endMin === 1440 (midnight next day)
    if (endMin === TOTAL_MINUTES) {
      endDate.setDate(endDate.getDate() + 1);
      endDate.setHours(0, 0, 0, 0);
    }

    openCreateModal(startDate, endDate);
  });
}

// ---- Render Events ----

function renderEvents() {
  const days = getWeekDays(currentMonday);

  // Clear all events areas
  document.querySelectorAll('.events-area').forEach(area => {
    area.innerHTML = '';
  });

  // Group events by day
  const eventsByDay = new Map();

  for (const evt of events) {
    const start = new Date(evt.start_at);
    const end = new Date(evt.end_at);

    for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
      const dayStart = new Date(days[dayIdx]);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1); // midnight next day

      // Check if event overlaps this day
      if (start < dayEnd && end > dayStart) {
        // Clamp to this day's boundaries
        const clampedStart = start < dayStart ? dayStart : start;
        const clampedEnd = end > dayEnd ? dayEnd : end;

        const startMinutes = clampedStart <= dayStart ? 0 : minutesFromMidnight(clampedStart);
        let endMinutes;
        if (clampedEnd >= dayEnd) {
          endMinutes = TOTAL_MINUTES;
        } else {
          endMinutes = minutesFromMidnight(clampedEnd);
        }

        // Ensure positive height
        if (endMinutes <= startMinutes) continue;

        if (!eventsByDay.has(dayIdx)) {
          eventsByDay.set(dayIdx, []);
        }
        eventsByDay.get(dayIdx).push({
          ...evt,
          startMinutes,
          endMinutes,
          originalStart: start,
          originalEnd: end
        });
      }
    }
  }

  // Layout and render each day
  for (const [dayIdx, dayEvents] of eventsByDay) {
    const eventsArea = document.querySelector(`.events-area[data-day-index="${dayIdx}"]`);
    if (!eventsArea) continue;

    const layoutItems = computeDayLayout(dayEvents);

    for (const item of layoutItems) {
      const block = document.createElement('div');
      block.className = 'event-block';
      block.dataset.eventId = item.event.id;

      // Position: exact pixel placement based on minutes
      const topPx = (item.event.startMinutes / TOTAL_MINUTES) * AXIS_HEIGHT;
      const heightPx = ((item.event.endMinutes - item.event.startMinutes) / TOTAL_MINUTES) * AXIS_HEIGHT;

      block.style.top = `${topPx}px`;
      block.style.height = `${heightPx}px`;
      block.style.left = `${item.left * 100}%`;
      block.style.width = `calc(${item.width * 100}% - 2px)`;
      block.style.marginLeft = '1px';

      // Content
      const timeStr = `${formatDateTime(item.event.originalStart)} – ${formatDateTime(item.event.originalEnd)}`;
      block.innerHTML = `
        <div class="event-block-title">${escapeHtml(item.event.title)}</div>
        <div class="event-block-time">${timeStr}</div>
      `;

      // Click to edit
      block.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditModal(item.event);
      });

      eventsArea.appendChild(block);
    }
  }
}

// ---- Modal ----

function openCreateModal(startDate, endDate) {
  editingEventId = null;
  modalTitle.textContent = 'Create Event';
  eventTitleInput.value = '';
  eventStartInput.value = toDatetimeLocalValue(startDate);
  eventEndInput.value = toDatetimeLocalValue(endDate);
  btnDelete.classList.add('hidden');
  formError.classList.add('hidden');
  modalOverlay.classList.remove('hidden');
  eventTitleInput.focus();
}

function openEditModal(evt) {
  editingEventId = evt.id;
  modalTitle.textContent = 'Edit Event';
  eventTitleInput.value = evt.title;
  eventStartInput.value = toDatetimeLocalValue(new Date(evt.start_at));
  eventEndInput.value = toDatetimeLocalValue(new Date(evt.end_at));
  btnDelete.classList.remove('hidden');
  formError.classList.add('hidden');
  modalOverlay.classList.remove('hidden');
  eventTitleInput.focus();
}

function closeModal() {
  modalOverlay.classList.add('hidden');
  editingEventId = null;
  formError.classList.add('hidden');
}

function showError(msg) {
  formError.textContent = msg;
  formError.classList.remove('hidden');
}

function bindModal() {
  eventForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    formError.classList.add('hidden');

    const title = eventTitleInput.value.trim();
    const start_at = eventStartInput.value;
    const end_at = eventEndInput.value;

    if (!title) {
      showError('Title is required');
      return;
    }

    const startDate = new Date(start_at);
    const endDate = new Date(end_at);

    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      showError('Invalid date/time');
      return;
    }

    if (endDate <= startDate) {
      showError('End time must be after start time');
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
      await loadWeek();
    } catch (err) {
      showError(err.message);
    }
  });

  btnDelete.addEventListener('click', async () => {
    if (!editingEventId) return;
    if (!confirm('Delete this event?')) return;
    try {
      await deleteEvent(editingEventId);
      closeModal();
      await loadWeek();
    } catch (err) {
      showError(err.message);
    }
  });

  btnCancel.addEventListener('click', closeModal);

  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) {
      closeModal();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modalOverlay.classList.contains('hidden')) {
      closeModal();
    }
  });
}

// ---- Navigation ----

function bindNavigation() {
  btnPrev.addEventListener('click', () => {
    const d = new Date(currentMonday);
    d.setDate(d.getDate() - 7);
    currentMonday = d;
    loadWeek();
  });

  btnToday.addEventListener('click', () => {
    currentMonday = getMonday(new Date());
    loadWeek();
  });

  btnNext.addEventListener('click', () => {
    const d = new Date(currentMonday);
    d.setDate(d.getDate() + 7);
    currentMonday = d;
    loadWeek();
  });
}

// ---- Data Loading ----

async function loadWeek() {
  renderWeekGrid();

  const weekEnd = getWeekEnd(currentMonday);
  try {
    events = await fetchEvents(currentMonday, weekEnd);
  } catch (err) {
    console.error('Failed to load events:', err);
    events = [];
  }

  renderEvents();

  // Scroll to ~8am on first load
  if (!initialScrollDone) {
    initialScrollDone = true;
    const container = document.getElementById('calendar-container');
    const scrollTo8am = 50 + 8 * HOUR_HEIGHT;
    container.scrollTop = scrollTo8am - 20;
  }
}

// ---- Helpers ----

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---- Start ----

init();
