import { fetchEvents, createEvent, updateEvent, deleteEvent } from './api.js';
import { computeDayLayout } from './layout.js';
import {
  getMonday, getWeekDays, getWeekStart, getWeekEnd,
  formatWeekTitle, formatMinutes, minutesFromMidnight,
  toDateString, isSameDay, isToday, dayName
} from './dateUtils.js';

// ========== Constants ==========
const HOUR_HEIGHT = 60; // px per hour — must match CSS --hour-height
const TOTAL_MINUTES = 1440; // 24 * 60
const AXIS_HEIGHT = HOUR_HEIGHT * 24; // 1440px

// ========== State ==========
let currentMonday = getMonday(new Date());
let events = [];
let editingEvent = null; // null = creating, object = editing

// ========== DOM refs ==========
const timeGutter = document.getElementById('time-gutter');
const daysContainer = document.getElementById('days-container');
const weekTitle = document.getElementById('week-title');
const modalOverlay = document.getElementById('modal-overlay');
const modalTitle = document.getElementById('modal-title');
const eventForm = document.getElementById('event-form');
const inputTitle = document.getElementById('event-title');
const inputDate = document.getElementById('event-date');
const inputStart = document.getElementById('event-start');
const inputEnd = document.getElementById('event-end');
const formError = document.getElementById('form-error');
const btnSave = document.getElementById('btn-save');
const btnDelete = document.getElementById('btn-delete');
const btnCancel = document.getElementById('btn-cancel');
const btnPrev = document.getElementById('btn-prev');
const btnToday = document.getElementById('btn-today');
const btnNext = document.getElementById('btn-next');

// ========== Time Gutter ==========
function renderTimeGutter() {
  timeGutter.innerHTML = '';

  // Sticky header spacer
  const headerSpacer = document.createElement('div');
  headerSpacer.className = 'time-gutter-header';
  timeGutter.appendChild(headerSpacer);

  const body = document.createElement('div');
  body.className = 'time-gutter-body';

  for (let h = 0; h < 24; h++) {
    const label = document.createElement('div');
    label.className = 'hour-label';
    label.style.top = `${h * HOUR_HEIGHT}px`;
    label.textContent = formatMinutes(h * 60);
    body.appendChild(label);
  }

  timeGutter.appendChild(body);
}

// ========== Week Grid ==========
function renderWeekGrid() {
  const days = getWeekDays(currentMonday);
  weekTitle.textContent = formatWeekTitle(currentMonday);

  daysContainer.innerHTML = '';

  days.forEach((date, index) => {
    const col = document.createElement('div');
    col.className = 'day-column';
    col.dataset.date = toDateString(date);
    if (isToday(date)) col.classList.add('today');

    // Header
    const header = document.createElement('div');
    header.className = 'day-header';
    header.innerHTML = `
      <span class="day-name">${dayName(index)}</span>
      <span class="day-number">${date.getDate()}</span>
    `;
    col.appendChild(header);

    // Body
    const body = document.createElement('div');
    body.className = 'day-body';
    body.dataset.date = toDateString(date);

    // Hour lines
    for (let h = 0; h <= 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${h * HOUR_HEIGHT}px`;
      body.appendChild(line);
    }

    // Clickable area for creating events
    const clickable = document.createElement('div');
    clickable.className = 'day-body-clickable';
    setupDayBodyInteraction(clickable, date);
    body.appendChild(clickable);

    // Current time indicator for today
    if (isToday(date)) {
      const now = new Date();
      const mins = minutesFromMidnight(now);
      const timeLine = document.createElement('div');
      timeLine.className = 'current-time-line';
      timeLine.style.top = `${(mins / TOTAL_MINUTES) * AXIS_HEIGHT}px`;
      body.appendChild(timeLine);
    }

    col.appendChild(body);
    daysContainer.appendChild(col);
  });
}

// ========== Day Body Interaction (click-drag to select time range) ==========
// Global drag state to avoid adding multiple document-level listeners
let dragState = {
  isDragging: false,
  startY: 0,
  selectionEl: null,
  clickable: null,
  date: null
};

function yToMinutes(y) {
  // Snap to 15-minute increments
  const rawMinutes = (y / AXIS_HEIGHT) * TOTAL_MINUTES;
  return Math.round(rawMinutes / 15) * 15;
}

document.addEventListener('mousemove', (e) => {
  if (!dragState.isDragging || !dragState.selectionEl || !dragState.clickable) return;
  const rect = dragState.clickable.getBoundingClientRect();
  const currentY = e.clientY - rect.top;

  const startMin = yToMinutes(Math.min(dragState.startY, currentY));
  const endMin = yToMinutes(Math.max(dragState.startY, currentY));
  const clampedStart = Math.max(0, Math.min(startMin, TOTAL_MINUTES));
  const clampedEnd = Math.max(0, Math.min(Math.max(endMin, clampedStart + 15), TOTAL_MINUTES));

  dragState.selectionEl.style.top = `${(clampedStart / TOTAL_MINUTES) * AXIS_HEIGHT}px`;
  dragState.selectionEl.style.height = `${((clampedEnd - clampedStart) / TOTAL_MINUTES) * AXIS_HEIGHT}px`;
});

document.addEventListener('mouseup', (e) => {
  if (!dragState.isDragging) return;
  dragState.isDragging = false;

  if (dragState.selectionEl && dragState.clickable) {
    const rect = dragState.clickable.getBoundingClientRect();
    const endY = e.clientY - rect.top;

    let startMin = yToMinutes(Math.min(dragState.startY, endY));
    let endMin = yToMinutes(Math.max(dragState.startY, endY));
    startMin = Math.max(0, Math.min(startMin, TOTAL_MINUTES));
    endMin = Math.max(0, Math.min(endMin, TOTAL_MINUTES));

    if (endMin <= startMin) endMin = startMin + 60; // default 1 hour
    if (endMin > TOTAL_MINUTES) endMin = TOTAL_MINUTES;

    dragState.selectionEl.remove();
    const date = dragState.date;
    dragState.selectionEl = null;
    dragState.clickable = null;
    dragState.date = null;

    openCreateModal(date, startMin, endMin);
  }
});

function setupDayBodyInteraction(clickable, date) {
  clickable.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    dragState.isDragging = true;
    dragState.clickable = clickable;
    dragState.date = date;

    const rect = clickable.getBoundingClientRect();
    dragState.startY = e.clientY - rect.top;

    // Create selection overlay
    const selectionEl = document.createElement('div');
    selectionEl.className = 'selection-overlay';
    const startMin = yToMinutes(dragState.startY);
    selectionEl.style.top = `${(startMin / TOTAL_MINUTES) * AXIS_HEIGHT}px`;
    selectionEl.style.height = `${(15 / TOTAL_MINUTES) * AXIS_HEIGHT}px`; // min 15min
    clickable.parentElement.appendChild(selectionEl);
    dragState.selectionEl = selectionEl;

    e.preventDefault();
  });
}

// ========== Render Events ==========
function renderEvents() {
  // Clear existing event blocks
  document.querySelectorAll('.event-block').forEach(el => el.remove());

  // Group events by day
  const days = getWeekDays(currentMonday);
  const dayMap = new Map(); // dateString -> events with minutes

  days.forEach(date => {
    dayMap.set(toDateString(date), []);
  });

  events.forEach(ev => {
    const startDate = new Date(ev.start_at);
    const endDate = new Date(ev.end_at);

    // Determine which day columns this event belongs to
    days.forEach(day => {
      const dayStart = new Date(day);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(day);
      dayEnd.setHours(24, 0, 0, 0);

      // Event overlaps this day?
      if (startDate < dayEnd && endDate > dayStart) {
        // Clamp to this day
        const clampedStart = startDate < dayStart ? dayStart : startDate;
        const clampedEnd = endDate > dayEnd ? dayEnd : endDate;

        const startMinutes = minutesFromMidnight(clampedStart);
        let endMinutes;
        // If clamped end is exactly midnight of the next day => 1440
        if (clampedEnd.getTime() === dayEnd.getTime()) {
          endMinutes = TOTAL_MINUTES;
        } else {
          endMinutes = minutesFromMidnight(clampedEnd);
        }
        // Ensure minimum end
        if (endMinutes <= startMinutes) endMinutes = startMinutes + 1;

        const dateStr = toDateString(day);
        if (dayMap.has(dateStr)) {
          dayMap.get(dateStr).push({
            id: ev.id,
            title: ev.title,
            startMinutes,
            endMinutes,
            originalEvent: ev
          });
        }
      }
    });
  });

  // Layout and render each day
  dayMap.forEach((dayEvents, dateStr) => {
    if (dayEvents.length === 0) return;

    const layoutEvents = computeDayLayout(dayEvents);
    const dayBody = document.querySelector(`.day-body[data-date="${dateStr}"]`);
    if (!dayBody) return;

    layoutEvents.forEach(ev => {
      const block = document.createElement('div');
      block.className = 'event-block';

      // Vertical position
      const top = (ev.startMinutes / TOTAL_MINUTES) * AXIS_HEIGHT;
      const height = ((ev.endMinutes - ev.startMinutes) / TOTAL_MINUTES) * AXIS_HEIGHT;
      block.style.top = `${top}px`;
      block.style.height = `${height}px`;

      // Horizontal position
      const widthPercent = 100 / ev.totalColumns;
      const leftPercent = ev.column * widthPercent;
      block.style.left = `calc(${leftPercent}% + 1px)`;
      block.style.width = `calc(${widthPercent}% - 2px)`;

      // Content
      const titleEl = document.createElement('div');
      titleEl.className = 'event-title';
      titleEl.textContent = ev.title;

      const timeEl = document.createElement('div');
      timeEl.className = 'event-time';
      timeEl.textContent = `${formatMinutes(ev.startMinutes)} – ${formatMinutes(ev.endMinutes)}`;

      block.appendChild(titleEl);
      block.appendChild(timeEl);

      // Click to edit
      block.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditModal(ev.originalEvent || ev);
      });

      dayBody.appendChild(block);
    });
  });
}

// ========== Modal ==========
function openCreateModal(date, startMinutes, endMinutes) {
  editingEvent = null;
  modalTitle.textContent = 'Create Event';
  btnDelete.style.display = 'none';
  btnSave.textContent = 'Create';

  inputTitle.value = '';
  inputDate.value = toDateString(date);
  inputStart.value = formatMinutes(startMinutes);
  inputEnd.value = formatMinutes(endMinutes);
  formError.style.display = 'none';

  modalOverlay.style.display = 'flex';
  inputTitle.focus();
}

function openEditModal(ev) {
  editingEvent = ev;
  modalTitle.textContent = 'Edit Event';
  btnDelete.style.display = 'inline-block';
  btnSave.textContent = 'Save';

  const startDate = new Date(ev.start_at);
  const endDate = new Date(ev.end_at);

  inputTitle.value = ev.title;
  inputDate.value = toDateString(startDate);
  inputStart.value = formatMinutes(minutesFromMidnight(startDate));

  // Handle end time: if end is midnight of the next day, show 00:00 on the same date
  const endMins = minutesFromMidnight(endDate);
  if (endMins === 0 && endDate.getTime() > startDate.getTime()) {
    // Ends at midnight — show 00:00 (the form handler knows to add a day)
    inputEnd.value = '00:00';
  } else {
    inputEnd.value = formatMinutes(endMins);
  }
  formError.style.display = 'none';

  modalOverlay.style.display = 'flex';
  inputTitle.focus();
}

function closeModal() {
  modalOverlay.style.display = 'none';
  editingEvent = null;
  formError.style.display = 'none';
}

function showFormError(msg) {
  formError.textContent = msg;
  formError.style.display = 'block';
}

// ========== Form Submission ==========
eventForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const title = inputTitle.value.trim();
  const dateStr = inputDate.value;
  const startTime = inputStart.value;
  const endTime = inputEnd.value;

  if (!title) {
    showFormError('Title is required.');
    return;
  }

  if (!dateStr || !startTime || !endTime) {
    showFormError('All fields are required.');
    return;
  }

  // Build ISO timestamps
  const startAt = new Date(`${dateStr}T${startTime}:00`);
  let endAt = new Date(`${dateStr}T${endTime}:00`);

  // Handle midnight (00:00) as end time = end of day
  if (endTime === '00:00' || endTime === '24:00') {
    endAt = new Date(`${dateStr}T00:00:00`);
    endAt.setDate(endAt.getDate() + 1);
  }

  if (isNaN(startAt.getTime()) || isNaN(endAt.getTime())) {
    showFormError('Invalid date/time.');
    return;
  }

  if (endAt <= startAt) {
    showFormError('End time must be after start time.');
    return;
  }

  try {
    if (editingEvent) {
      await updateEvent(editingEvent.id, {
        title,
        start_at: startAt.toISOString(),
        end_at: endAt.toISOString()
      });
    } else {
      await createEvent({
        title,
        start_at: startAt.toISOString(),
        end_at: endAt.toISOString()
      });
    }
    closeModal();
    await loadEvents();
  } catch (err) {
    showFormError(err.message);
  }
});

// Delete button
btnDelete.addEventListener('click', async () => {
  if (!editingEvent) return;
  if (!confirm('Delete this event?')) return;

  try {
    await deleteEvent(editingEvent.id);
    closeModal();
    await loadEvents();
  } catch (err) {
    showFormError(err.message);
  }
});

// Cancel button
btnCancel.addEventListener('click', closeModal);

// Close modal on overlay click
modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeModal();
});

// Close on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modalOverlay.style.display !== 'none') {
    closeModal();
  }
});

// ========== Navigation ==========
btnPrev.addEventListener('click', () => {
  const prev = new Date(currentMonday);
  prev.setDate(prev.getDate() - 7);
  currentMonday = prev;
  renderWeekGrid();
  loadEvents();
});

btnToday.addEventListener('click', () => {
  currentMonday = getMonday(new Date());
  renderWeekGrid();
  loadEvents();
});

btnNext.addEventListener('click', () => {
  const next = new Date(currentMonday);
  next.setDate(next.getDate() + 7);
  currentMonday = next;
  renderWeekGrid();
  loadEvents();
});

// ========== Load Events ==========
async function loadEvents() {
  try {
    const weekStart = getWeekStart(currentMonday);
    const weekEnd = getWeekEnd(currentMonday);
    events = await fetchEvents(weekStart, weekEnd);
    renderEvents();
  } catch (err) {
    console.error('Failed to load events:', err);
  }
}

// ========== Initialization ==========
function init() {
  renderTimeGutter();
  renderWeekGrid();
  loadEvents();

  // Update current time indicator every minute
  setInterval(() => {
    const existingLine = document.querySelector('.current-time-line');
    if (existingLine) {
      const now = new Date();
      const mins = minutesFromMidnight(now);
      existingLine.style.top = `${(mins / TOTAL_MINUTES) * AXIS_HEIGHT}px`;
    }
  }, 60000);

  // Scroll to current hour or 8am on load
  setTimeout(() => {
    const container = document.querySelector('.calendar-container');
    if (container) {
      const now = new Date();
      const currentHour = now.getHours();
      // Scroll to one hour before current time, or 8am if outside working hours
      const scrollHour = (currentHour >= 6 && currentHour <= 22) ? Math.max(0, currentHour - 1) : 8;
      container.scrollTop = scrollHour * HOUR_HEIGHT;
    }
  }, 100);
}

init();
