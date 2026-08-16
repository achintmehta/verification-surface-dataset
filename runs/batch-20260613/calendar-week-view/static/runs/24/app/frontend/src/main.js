import { computeDayLayout } from './layout.js';
import { fetchEvents, createEvent, updateEvent, deleteEvent } from './api.js';
import {
  DAY_NAMES, getWeekDays, weekStart, weekEnd, isSameDay,
  formatDate, formatTime, formatWeekTitle, minutesFromMidnight,
  toDatetimeLocalValue,
} from './dateUtils.js';

// ── Constants ────────────────────────────────────────────────────────
const HOUR_HEIGHT = 60; // pixels per hour
const TOTAL_HOURS = 24;
const AXIS_HEIGHT = HOUR_HEIGHT * TOTAL_HOURS; // 1440px for 1440 minutes (1px/min)
const MIN_EVENT_HEIGHT = 4; // minimum rendered height in px for very short events

// ── State ────────────────────────────────────────────────────────────
let currentDate = new Date(); // any date within the currently viewed week
let weekDays = [];
let events = [];

// ── DOM refs ─────────────────────────────────────────────────────────
const weekTitleEl = document.getElementById('week-title');
const timeGutterEl = document.getElementById('time-gutter');
const daysContainerEl = document.getElementById('days-container');
const modalOverlay = document.getElementById('modal-overlay');
const modalTitle = document.getElementById('modal-title');
const eventForm = document.getElementById('event-form');
const eventIdInput = document.getElementById('event-id');
const eventTitleInput = document.getElementById('event-title');
const eventStartInput = document.getElementById('event-start');
const eventEndInput = document.getElementById('event-end');
const btnDelete = document.getElementById('btn-delete');
const btnCancel = document.getElementById('btn-cancel');
const btnSave = document.getElementById('btn-save');
const formError = document.getElementById('form-error');

// ── Build time gutter ────────────────────────────────────────────────
function buildTimeGutter() {
  timeGutterEl.innerHTML = '';
  timeGutterEl.style.height = `${AXIS_HEIGHT}px`;
  for (let h = 0; h < TOTAL_HOURS; h++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = `${h * HOUR_HEIGHT}px`;
    label.style.height = `${HOUR_HEIGHT}px`;
    label.textContent = `${String(h).padStart(2, '0')}:00`;
    timeGutterEl.appendChild(label);
  }
}

// ── Build day columns ────────────────────────────────────────────────
function buildDayColumns() {
  daysContainerEl.innerHTML = '';
  const today = new Date();

  weekDays.forEach((day, idx) => {
    const col = document.createElement('div');
    col.className = 'day-column';
    if (isSameDay(day, today)) {
      col.classList.add('today');
    }
    col.dataset.dayIndex = idx;

    // Header
    const header = document.createElement('div');
    header.className = 'day-header';
    header.innerHTML = `<span class="day-name">${DAY_NAMES[idx]}</span>
      <span class="day-date">${day.getDate()}</span>`;
    col.appendChild(header);

    // Slots area (the full 24h area)
    const slotsArea = document.createElement('div');
    slotsArea.className = 'day-slots';
    slotsArea.style.height = `${AXIS_HEIGHT}px`;
    slotsArea.dataset.dayIndex = idx;

    // Hour gridlines
    for (let h = 0; h < TOTAL_HOURS; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${h * HOUR_HEIGHT}px`;
      slotsArea.appendChild(line);
    }

    col.appendChild(slotsArea);
    daysContainerEl.appendChild(col);
  });
}

// ── Render events ────────────────────────────────────────────────────
function renderEvents() {
  // Clear existing event blocks
  document.querySelectorAll('.event-block').forEach(el => el.remove());

  // Group events by day
  const eventsByDay = new Map();
  for (let i = 0; i < 7; i++) eventsByDay.set(i, []);

  for (const ev of events) {
    const start = new Date(ev.start_at);
    const end = new Date(ev.end_at);

    // Find which day column(s) this event belongs to
    for (let i = 0; i < 7; i++) {
      const dayStart = new Date(weekDays[i]);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1);

      // Does this event overlap this day?
      if (start < dayEnd && end > dayStart) {
        // Clamp to this day's boundaries
        const clampedStart = start < dayStart ? dayStart : start;
        const clampedEnd = end > dayEnd ? dayEnd : end;

        const startMinutes = minutesFromMidnight(clampedStart);
        // If end is exactly midnight of next day, that's 1440 minutes
        let endMinutes;
        if (clampedEnd.getTime() === dayEnd.getTime()) {
          endMinutes = 1440;
        } else {
          endMinutes = minutesFromMidnight(clampedEnd);
        }

        // Avoid zero-height blocks
        if (endMinutes <= startMinutes) continue;

        eventsByDay.get(i).push({
          id: ev.id,
          title: ev.title,
          startMinutes,
          endMinutes,
          originalEvent: ev,
        });
      }
    }
  }

  // Layout & render each day
  for (let i = 0; i < 7; i++) {
    const dayEvents = eventsByDay.get(i);
    if (dayEvents.length === 0) continue;

    const layoutItems = computeDayLayout(dayEvents);
    const slotsArea = document.querySelector(`.day-slots[data-day-index="${i}"]`);

    for (const item of layoutItems) {
      const { event: ev, column, totalColumns } = item;
      const block = document.createElement('div');
      block.className = 'event-block';
      block.dataset.eventId = ev.id;

      // Vertical position from time arithmetic: 1 minute = 1px (AXIS_HEIGHT=1440, HOUR_HEIGHT=60)
      const top = (ev.startMinutes / 1440) * AXIS_HEIGHT;
      const height = Math.max(((ev.endMinutes - ev.startMinutes) / 1440) * AXIS_HEIGHT, MIN_EVENT_HEIGHT);

      // Horizontal position from cluster columns
      const widthPercent = 100 / totalColumns;
      const leftPercent = column * widthPercent;

      block.style.position = 'absolute';
      block.style.top = `${top}px`;
      block.style.height = `${height}px`;
      block.style.left = `${leftPercent}%`;
      block.style.width = `${widthPercent}%`;

      // Content
      const startDate = new Date(ev.originalEvent.start_at);
      const endDate = new Date(ev.originalEvent.end_at);
      block.innerHTML = `
        <div class="event-title">${escapeHtml(ev.title)}</div>
        <div class="event-time">${formatTime(startDate)} – ${formatTime(endDate)}</div>
      `;

      block.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditModal(ev.originalEvent);
      });

      slotsArea.appendChild(block);
    }
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ── Data loading ─────────────────────────────────────────────────────
async function loadWeek() {
  weekDays = getWeekDays(currentDate);
  weekTitleEl.textContent = formatWeekTitle(weekDays);

  buildDayColumns();

  const start = weekStart(currentDate);
  const end = weekEnd(currentDate);

  try {
    events = await fetchEvents(start, end);
  } catch (err) {
    console.error('Failed to load events:', err);
    events = [];
  }

  renderEvents();
}

// ── Click on empty slot to create ────────────────────────────────────
function setupSlotClicks() {
  daysContainerEl.addEventListener('mousedown', (e) => {
    const slotsArea = e.target.closest('.day-slots');
    if (!slotsArea) return;
    // Only on direct slot area or hour-line, not on event blocks
    if (e.target.closest('.event-block')) return;

    const rect = slotsArea.getBoundingClientRect();
    const dayIndex = parseInt(slotsArea.dataset.dayIndex, 10);
    const day = weekDays[dayIndex];

    const yStart = e.clientY - rect.top;
    const startMinutes = Math.max(0, Math.min(1440, Math.round(yStart / AXIS_HEIGHT * 1440)));

    // Snap to nearest 15 minutes for convenience
    const snappedStart = Math.round(startMinutes / 15) * 15;

    // Create selection overlay for drag
    const selectionEl = document.createElement('div');
    selectionEl.className = 'time-selection';
    selectionEl.style.position = 'absolute';
    selectionEl.style.top = `${(snappedStart / 1440) * AXIS_HEIGHT}px`;
    selectionEl.style.height = `${HOUR_HEIGHT / 2}px`; // default 30min
    selectionEl.style.left = '0';
    selectionEl.style.width = '100%';
    slotsArea.appendChild(selectionEl);

    let endMinutes = snappedStart + 30;

    const onMouseMove = (moveE) => {
      const yEnd = moveE.clientY - rect.top;
      const rawEnd = Math.max(0, Math.min(1440, Math.round(yEnd / AXIS_HEIGHT * 1440)));
      endMinutes = Math.round(rawEnd / 15) * 15;
      if (endMinutes <= snappedStart) endMinutes = snappedStart + 15;
      const top = (snappedStart / 1440) * AXIS_HEIGHT;
      const height = ((endMinutes - snappedStart) / 1440) * AXIS_HEIGHT;
      selectionEl.style.top = `${top}px`;
      selectionEl.style.height = `${height}px`;
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      selectionEl.remove();

      // Open create form with selected range
      const startDate = new Date(day);
      startDate.setHours(0, 0, 0, 0);
      startDate.setMinutes(snappedStart);

      const endDate = new Date(day);
      endDate.setHours(0, 0, 0, 0);
      endDate.setMinutes(endMinutes);

      openCreateModal(startDate, endDate);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}

// ── Modal handling ───────────────────────────────────────────────────
function openCreateModal(startDate, endDate) {
  modalTitle.textContent = 'Create Event';
  eventIdInput.value = '';
  eventTitleInput.value = '';
  eventStartInput.value = toDatetimeLocalValue(startDate);
  eventEndInput.value = toDatetimeLocalValue(endDate);
  btnDelete.style.display = 'none';
  btnSave.textContent = 'Create';
  formError.textContent = '';
  modalOverlay.style.display = 'flex';
  eventTitleInput.focus();
}

function openEditModal(ev) {
  modalTitle.textContent = 'Edit Event';
  eventIdInput.value = ev.id;
  eventTitleInput.value = ev.title;
  eventStartInput.value = toDatetimeLocalValue(new Date(ev.start_at));
  eventEndInput.value = toDatetimeLocalValue(new Date(ev.end_at));
  btnDelete.style.display = 'inline-block';
  btnSave.textContent = 'Save';
  formError.textContent = '';
  modalOverlay.style.display = 'flex';
  eventTitleInput.focus();
}

function closeModal() {
  modalOverlay.style.display = 'none';
  formError.textContent = '';
}

// ── Form submission ──────────────────────────────────────────────────
eventForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  formError.textContent = '';

  const title = eventTitleInput.value.trim();
  const start_at = eventStartInput.value;
  const end_at = eventEndInput.value;
  const id = eventIdInput.value;

  if (!title) {
    formError.textContent = 'Title is required.';
    return;
  }
  if (!start_at || !end_at) {
    formError.textContent = 'Start and end times are required.';
    return;
  }
  if (new Date(end_at) <= new Date(start_at)) {
    formError.textContent = 'End time must be after start time.';
    return;
  }

  try {
    const payload = {
      title,
      start_at: new Date(start_at).toISOString(),
      end_at: new Date(end_at).toISOString(),
    };

    if (id) {
      await updateEvent(id, payload);
    } else {
      await createEvent(payload);
    }

    closeModal();
    await loadWeek();
  } catch (err) {
    formError.textContent = err.message || 'An error occurred.';
  }
});

// Delete button
btnDelete.addEventListener('click', async () => {
  const id = eventIdInput.value;
  if (!id) return;

  if (!confirm('Delete this event?')) return;

  try {
    await deleteEvent(id);
    closeModal();
    await loadWeek();
  } catch (err) {
    formError.textContent = err.message || 'Failed to delete event.';
  }
});

// Cancel button + overlay click
btnCancel.addEventListener('click', closeModal);
modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeModal();
});

// ── Navigation ───────────────────────────────────────────────────────
document.getElementById('btn-prev').addEventListener('click', () => {
  currentDate.setDate(currentDate.getDate() - 7);
  loadWeek();
});

document.getElementById('btn-today').addEventListener('click', () => {
  currentDate = new Date();
  loadWeek();
});

document.getElementById('btn-next').addEventListener('click', () => {
  currentDate.setDate(currentDate.getDate() + 7);
  loadWeek();
});

// ── Keyboard shortcuts ──────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modalOverlay.style.display !== 'none') {
    closeModal();
  }
});

// ── Initialize ───────────────────────────────────────────────────────
buildTimeGutter();
setupSlotClicks();
loadWeek();
