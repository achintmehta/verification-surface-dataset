import { fetchEvents, createEvent, updateEvent, deleteEvent } from './api.js';
import { computeLayout } from './layout.js';
import {
  getMonday, getWeekDays, formatDayHeader, formatWeekTitle,
  isSameDay, minutesFromMidnight, formatTime, dateFromMinutes, toLocalInputValue
} from './dates.js';

// Constants
const HOUR_HEIGHT = 60; // px per hour – must match CSS --hour-height
const TOTAL_MINUTES = 1440; // 24 * 60
const AXIS_HEIGHT = HOUR_HEIGHT * 24;

// State
let currentMonday = getMonday(new Date());
let weekDays = [];
let events = [];

// DOM references
const weekTitle = document.getElementById('week-title');
const timeGutter = document.getElementById('time-gutter');
const weekGrid = document.getElementById('week-grid');
const btnPrev = document.getElementById('btn-prev');
const btnToday = document.getElementById('btn-today');
const btnNext = document.getElementById('btn-next');

// Modal references
const modalOverlay = document.getElementById('modal-overlay');
const modalTitle = document.getElementById('modal-title');
const eventForm = document.getElementById('event-form');
const eventIdInput = document.getElementById('event-id');
const eventTitleInput = document.getElementById('event-title');
const eventStartInput = document.getElementById('event-start');
const eventEndInput = document.getElementById('event-end');
const btnDelete = document.getElementById('btn-delete');
const btnCancel = document.getElementById('btn-cancel');
const formError = document.getElementById('form-error');

// ============================================================
// Rendering
// ============================================================

function renderTimeGutter() {
  timeGutter.innerHTML = '';

  // Header spacer
  const header = document.createElement('div');
  header.className = 'time-gutter-header';
  timeGutter.appendChild(header);

  // Body with hour labels
  const body = document.createElement('div');
  body.className = 'time-gutter-body';

  for (let h = 0; h <= 24; h++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = `${h * HOUR_HEIGHT}px`;
    label.textContent = `${String(h).padStart(2, '0')}:00`;
    body.appendChild(label);
  }

  timeGutter.appendChild(body);
}

function renderWeekGrid() {
  weekGrid.innerHTML = '';
  const today = new Date();

  weekDays.forEach((day, dayIndex) => {
    const col = document.createElement('div');
    col.className = 'day-column';
    if (isSameDay(day, today)) {
      col.classList.add('today-column');
    }

    // Header
    const header = document.createElement('div');
    header.className = 'day-header';
    if (isSameDay(day, today)) {
      header.classList.add('today');
    }
    header.textContent = formatDayHeader(day);
    col.appendChild(header);

    // Body
    const body = document.createElement('div');
    body.className = 'day-body';
    body.dataset.dayIndex = dayIndex;

    // Hour lines
    for (let h = 0; h < 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line on-the-hour';
      line.style.top = `${h * HOUR_HEIGHT}px`;
      body.appendChild(line);
    }
    // Bottom line at 24:00
    const bottomLine = document.createElement('div');
    bottomLine.className = 'hour-line on-the-hour';
    bottomLine.style.top = `${24 * HOUR_HEIGHT}px`;
    body.appendChild(bottomLine);

    // Click handler on the day body for creating events
    body.addEventListener('mousedown', (e) => handleDayMouseDown(e, day, body));

    col.appendChild(body);
    weekGrid.appendChild(col);
  });
}

function renderEvents() {
  // Clear existing event blocks
  document.querySelectorAll('.event-block').forEach(el => el.remove());

  const today = new Date();

  // Group events by day
  weekDays.forEach((day, dayIndex) => {
    const dayStart = new Date(day);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(day);
    dayEnd.setHours(24, 0, 0, 0); // midnight next day

    // Filter events for this day
    const dayEvents = events
      .filter(ev => {
        const evStart = new Date(ev.start_at);
        const evEnd = new Date(ev.end_at);
        // Event overlaps this day if evStart < dayEnd && evEnd > dayStart
        return evStart < dayEnd && evEnd > dayStart;
      })
      .map(ev => {
        const evStart = new Date(ev.start_at);
        const evEnd = new Date(ev.end_at);

        // Clamp to this day's boundaries
        const clampedStart = evStart < dayStart ? dayStart : evStart;
        const clampedEnd = evEnd > dayEnd ? dayEnd : evEnd;

        return {
          ...ev,
          minuteStart: minutesFromMidnight(clampedStart),
          minuteEnd: clampedEnd.getTime() === dayEnd.getTime() ? 1440 : minutesFromMidnight(clampedEnd)
        };
      });

    if (dayEvents.length === 0) return;

    // Compute layout
    const layoutItems = computeLayout(dayEvents);

    // Get the day body element
    const dayBody = weekGrid.children[dayIndex].querySelector('.day-body');

    layoutItems.forEach(({ event, column, totalColumns }) => {
      const block = document.createElement('div');
      block.className = `event-block event-color-${event.id % 7}`;

      const top = (event.minuteStart / TOTAL_MINUTES) * AXIS_HEIGHT;
      const height = ((event.minuteEnd - event.minuteStart) / TOTAL_MINUTES) * AXIS_HEIGHT;
      const widthPercent = 100 / totalColumns;
      const leftPercent = column * widthPercent;

      block.style.top = `${top}px`;
      block.style.height = `${Math.max(height, 2)}px`; // min 2px for very short events
      block.style.left = `${leftPercent}%`;
      block.style.width = `calc(${widthPercent}% - 2px)`; // small gap between side-by-side

      // Content
      const titleEl = document.createElement('div');
      titleEl.className = 'event-title';
      titleEl.textContent = event.title;

      const timeEl = document.createElement('div');
      timeEl.className = 'event-time';
      const startStr = formatTime(event.minuteStart);
      const endStr = formatTime(event.minuteEnd === 1440 ? 1440 : event.minuteEnd);
      timeEl.textContent = `${startStr} – ${endStr}`;

      block.appendChild(titleEl);
      block.appendChild(timeEl);

      // Click to edit
      block.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditModal(event);
      });

      dayBody.appendChild(block);
    });
  });
}

// ============================================================
// Interaction: click-to-create on day body
// ============================================================

let dragState = null;

function handleDayMouseDown(e, day, dayBody) {
  if (e.target.closest('.event-block')) return;
  e.preventDefault();

  const rect = dayBody.getBoundingClientRect();
  const yOffset = e.clientY - rect.top;
  const minuteStart = Math.max(0, Math.min(1440, Math.round((yOffset / AXIS_HEIGHT) * TOTAL_MINUTES)));

  // Snap to nearest 15 minutes
  const snappedStart = Math.round(minuteStart / 15) * 15;

  dragState = {
    day,
    dayBody,
    startMinute: snappedStart,
    currentMinute: snappedStart
  };

  const onMouseMove = (e2) => {
    const y2 = e2.clientY - rect.top;
    const minute = Math.max(0, Math.min(1440, Math.round((y2 / AXIS_HEIGHT) * TOTAL_MINUTES)));
    dragState.currentMinute = Math.round(minute / 15) * 15;
  };

  const onMouseUp = () => {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);

    if (!dragState) return;

    let startMin = Math.min(dragState.startMinute, dragState.currentMinute);
    let endMin = Math.max(dragState.startMinute, dragState.currentMinute);

    // If it was just a click (no drag), default to 1 hour
    if (endMin - startMin < 15) {
      endMin = Math.min(startMin + 60, 1440);
    }

    const startDate = dateFromMinutes(day, startMin);
    const endDate = dateFromMinutes(day, endMin);

    openCreateModal(startDate, endDate);
    dragState = null;
  };

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
}

// ============================================================
// Modal
// ============================================================

function openCreateModal(startDate, endDate) {
  modalTitle.textContent = 'Create Event';
  eventIdInput.value = '';
  eventTitleInput.value = '';
  eventStartInput.value = toLocalInputValue(startDate);
  eventEndInput.value = toLocalInputValue(endDate);
  btnDelete.style.display = 'none';
  formError.style.display = 'none';
  modalOverlay.style.display = 'flex';
  eventTitleInput.focus();
}

function openEditModal(event) {
  modalTitle.textContent = 'Edit Event';
  eventIdInput.value = event.id;
  eventTitleInput.value = event.title;
  eventStartInput.value = toLocalInputValue(new Date(event.start_at));
  eventEndInput.value = toLocalInputValue(new Date(event.end_at));
  btnDelete.style.display = 'inline-block';
  formError.style.display = 'none';
  modalOverlay.style.display = 'flex';
  eventTitleInput.focus();
}

function closeModal() {
  modalOverlay.style.display = 'none';
  eventForm.reset();
  formError.style.display = 'none';
}

function showFormError(msg) {
  formError.textContent = msg;
  formError.style.display = 'block';
}

// ============================================================
// Data loading
// ============================================================

async function loadWeek() {
  weekDays = getWeekDays(currentMonday);
  weekTitle.textContent = formatWeekTitle(currentMonday);

  renderWeekGrid();

  // Fetch from Monday 00:00 to next Monday 00:00
  const weekStart = new Date(currentMonday);
  weekStart.setHours(0, 0, 0, 0);
  const weekEnd = new Date(currentMonday);
  weekEnd.setDate(weekEnd.getDate() + 7);
  weekEnd.setHours(0, 0, 0, 0);

  try {
    events = await fetchEvents(weekStart, weekEnd);
    renderEvents();
  } catch (err) {
    console.error('Failed to load events:', err);
  }
}

// ============================================================
// Event handlers
// ============================================================

btnPrev.addEventListener('click', () => {
  currentMonday.setDate(currentMonday.getDate() - 7);
  currentMonday = getMonday(currentMonday);
  loadWeek();
});

btnToday.addEventListener('click', () => {
  currentMonday = getMonday(new Date());
  loadWeek();
});

btnNext.addEventListener('click', () => {
  currentMonday.setDate(currentMonday.getDate() + 7);
  currentMonday = getMonday(currentMonday);
  loadWeek();
});

btnCancel.addEventListener('click', closeModal);

modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeModal();
});

eventForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  formError.style.display = 'none';

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
    showFormError('Invalid date');
    return;
  }

  if (endDate <= startDate) {
    showFormError('End time must be after start time');
    return;
  }

  const data = {
    title,
    start_at: startDate.toISOString(),
    end_at: endDate.toISOString()
  };

  const id = eventIdInput.value;

  try {
    if (id) {
      await updateEvent(parseInt(id), data);
    } else {
      await createEvent(data);
    }
    closeModal();
    await loadWeek();
  } catch (err) {
    showFormError(err.message);
  }
});

btnDelete.addEventListener('click', async () => {
  const id = eventIdInput.value;
  if (!id) return;

  if (!confirm('Delete this event?')) return;

  try {
    await deleteEvent(parseInt(id));
    closeModal();
    await loadWeek();
  } catch (err) {
    showFormError(err.message);
  }
});

// ============================================================
// Init
// ============================================================

renderTimeGutter();
loadWeek();
