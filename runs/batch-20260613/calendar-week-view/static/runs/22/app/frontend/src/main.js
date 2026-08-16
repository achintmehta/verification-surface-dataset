/**
 * Main application – Week Calendar View
 */
import { computeDayLayout, minutesToPixels, pixelsToMinutes, dateToMinutes } from './layout.js';
import { fetchEvents, createEvent, updateEvent, deleteEvent } from './api.js';
import {
  getMonday, getWeekDays, nextWeek, prevWeek, isSameDay,
  formatWeekTitle, dayName, formatTime, formatDateTime,
  formatDateInput, minutesToTimeStr, timeStrToMinutes, buildLocalDate
} from './dateUtils.js';

// Constants
const HOUR_HEIGHT = 60; // px per hour – must match CSS --hour-height
const AXIS_HEIGHT = HOUR_HEIGHT * 24; // 1440px for 24 hours
const SNAP_MINUTES = 15; // snap drag selection to 15-minute increments

// State
let currentMonday = getMonday(new Date());
let events = []; // raw events from API for current week
let weekDays = []; // current week's Date objects (Mon-Sun)

// Drag state (global, only one drag at a time)
let dragState = null; // { col, dayDate, startY, selectionEl }

// DOM elements
const weekTitleEl = document.getElementById('week-title');
const gridEl = document.getElementById('calendar-grid');
const btnPrev = document.getElementById('btn-prev');
const btnToday = document.getElementById('btn-today');
const btnNext = document.getElementById('btn-next');

// Modal elements
const modalOverlay = document.getElementById('modal-overlay');
const modalTitle = document.getElementById('modal-title');
const eventForm = document.getElementById('event-form');
const eventIdInput = document.getElementById('event-id');
const eventTitleInput = document.getElementById('event-title-input');
const eventDateInput = document.getElementById('event-date-input');
const eventStartInput = document.getElementById('event-start-input');
const eventEndInput = document.getElementById('event-end-input');
const formError = document.getElementById('form-error');
const btnSave = document.getElementById('btn-save');
const btnCancel = document.getElementById('btn-cancel');
const btnDelete = document.getElementById('btn-delete');

// ============================================================
// Initialization
// ============================================================

function init() {
  btnPrev.addEventListener('click', () => navigateWeek(-1));
  btnToday.addEventListener('click', () => navigateToToday());
  btnNext.addEventListener('click', () => navigateWeek(1));
  btnCancel.addEventListener('click', closeModal);
  btnDelete.addEventListener('click', handleDelete);
  eventForm.addEventListener('submit', handleFormSubmit);
  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) closeModal();
  });

  // Global drag handlers (registered once)
  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('mouseup', onDragEnd);

  renderWeek();
}

// ============================================================
// Navigation
// ============================================================

function navigateWeek(direction) {
  currentMonday = direction > 0 ? nextWeek(currentMonday) : prevWeek(currentMonday);
  renderWeek();
}

function navigateToToday() {
  currentMonday = getMonday(new Date());
  renderWeek();
}

// ============================================================
// Render
// ============================================================

async function renderWeek() {
  weekDays = getWeekDays(currentMonday);
  weekTitleEl.textContent = formatWeekTitle(currentMonday);

  // Build the grid
  buildGrid(weekDays);

  // Fetch events for this week
  const weekStart = new Date(currentMonday);
  const weekEnd = new Date(weekDays[6]);
  weekEnd.setDate(weekEnd.getDate() + 1); // end of Sunday = start of next Monday

  try {
    events = await fetchEvents(weekStart, weekEnd);
  } catch (err) {
    console.error('Failed to fetch events:', err);
    events = [];
  }

  renderEvents(weekDays);
}

function buildGrid(days) {
  const today = new Date();

  // Cancel any in-progress drag
  if (dragState) {
    if (dragState.selectionEl && dragState.selectionEl.parentNode) {
      dragState.selectionEl.remove();
    }
    dragState = null;
  }

  gridEl.innerHTML = '';

  // Gutter header (top-left corner)
  const gutterHeader = document.createElement('div');
  gutterHeader.className = 'gutter-header';
  gridEl.appendChild(gutterHeader);

  // Day headers
  for (let i = 0; i < 7; i++) {
    const header = document.createElement('div');
    header.className = 'day-header' + (isSameDay(days[i], today) ? ' today' : '');

    const nameEl = document.createElement('div');
    nameEl.className = 'day-name';
    nameEl.textContent = dayName(i);

    const numEl = document.createElement('div');
    numEl.className = 'day-number';
    numEl.textContent = days[i].getDate();

    header.appendChild(nameEl);
    header.appendChild(numEl);
    gridEl.appendChild(header);
  }

  // Time gutter
  const gutter = document.createElement('div');
  gutter.className = 'time-gutter';
  gutter.style.height = `${AXIS_HEIGHT}px`;

  for (let h = 0; h < 24; h++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = `${h * HOUR_HEIGHT}px`;
    label.textContent = formatTime(h, 0);
    gutter.appendChild(label);
  }

  gridEl.appendChild(gutter);

  // Day columns
  for (let i = 0; i < 7; i++) {
    const col = document.createElement('div');
    col.className = 'day-column' + (isSameDay(days[i], today) ? ' today' : '');
    col.style.height = `${AXIS_HEIGHT}px`;
    col.dataset.dayIndex = String(i);

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
    bottomLine.style.top = `${AXIS_HEIGHT}px`;
    col.appendChild(bottomLine);

    // Mousedown for drag-to-create
    col.addEventListener('mousedown', (e) => onDragStart(e, col, days[i]));

    gridEl.appendChild(col);
  }
}

function renderEvents(days) {
  // Remove existing event blocks
  document.querySelectorAll('.event-block').forEach(el => el.remove());

  // Group events by day
  const eventsByDay = new Map();
  for (let i = 0; i < 7; i++) {
    eventsByDay.set(i, []);
  }

  for (const ev of events) {
    const start = new Date(ev.start_at);
    const end = new Date(ev.end_at);

    // Find which day column(s) this event belongs to
    for (let i = 0; i < 7; i++) {
      const dayStart = new Date(days[i]);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1);

      // Event overlaps this day if event.start < dayEnd AND event.end > dayStart
      if (start < dayEnd && end > dayStart) {
        // Clamp to day boundaries
        const clampedStart = start < dayStart ? dayStart : start;
        const clampedEnd = end > dayEnd ? dayEnd : end;

        const startMinutes = dateToMinutes(clampedStart);
        const endMinutes = clampedEnd >= dayEnd ? 1440 : dateToMinutes(clampedEnd);

        eventsByDay.get(i).push({
          ...ev,
          startMinutes: Math.max(0, startMinutes),
          endMinutes: Math.min(1440, endMinutes),
          originalStart: start,
          originalEnd: end
        });
      }
    }
  }

  // Layout and render each day
  const dayColumns = gridEl.querySelectorAll('.day-column');

  for (let i = 0; i < 7; i++) {
    const dayEvents = eventsByDay.get(i);
    if (!dayEvents || dayEvents.length === 0) continue;

    const layoutItems = computeDayLayout(dayEvents);
    const col = dayColumns[i];

    for (const item of layoutItems) {
      const { event, column, totalColumns } = item;
      const top = minutesToPixels(event.startMinutes, AXIS_HEIGHT);
      const height = minutesToPixels(event.endMinutes, AXIS_HEIGHT) - top;
      const widthPercent = 100 / totalColumns;
      const leftPercent = column * widthPercent;

      const block = document.createElement('div');
      block.className = 'event-block';
      block.style.top = `${top}px`;
      block.style.height = `${Math.max(height, 2)}px`; // min 2px for very short events
      block.style.left = `${leftPercent}%`;
      block.style.width = `calc(${widthPercent}% - 2px)`; // 2px gap for visual separation
      block.style.right = 'auto';
      block.dataset.eventId = event.id;

      const titleDiv = document.createElement('div');
      titleDiv.className = 'event-title';
      titleDiv.textContent = event.title;

      const timeDiv = document.createElement('div');
      timeDiv.className = 'event-time';
      timeDiv.textContent = `${minutesToTimeStr(event.startMinutes)} – ${minutesToTimeStr(event.endMinutes)}`;

      block.appendChild(titleDiv);
      block.appendChild(timeDiv);

      block.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditModal(event);
      });

      col.appendChild(block);
    }
  }
}

// ============================================================
// Drag-to-Create (global handlers)
// ============================================================

function onDragStart(e, col, dayDate) {
  // Only react to clicks on the column itself (not on events)
  if (e.target.closest('.event-block')) return;

  const rect = col.getBoundingClientRect();
  const startY = Math.max(0, Math.min(AXIS_HEIGHT, e.clientY - rect.top));

  const selectionEl = document.createElement('div');
  selectionEl.className = 'drag-selection';
  selectionEl.style.top = `${startY}px`;
  selectionEl.style.height = '0px';
  col.appendChild(selectionEl);

  dragState = { col, dayDate, startY, selectionEl };
  e.preventDefault();
}

function onDragMove(e) {
  if (!dragState) return;

  const rect = dragState.col.getBoundingClientRect();
  let currentY = e.clientY - rect.top;
  currentY = Math.max(0, Math.min(AXIS_HEIGHT, currentY));

  const top = Math.min(dragState.startY, currentY);
  const height = Math.abs(currentY - dragState.startY);

  dragState.selectionEl.style.top = `${top}px`;
  dragState.selectionEl.style.height = `${height}px`;
}

function onDragEnd(e) {
  if (!dragState) return;

  const { col, dayDate, startY, selectionEl } = dragState;
  dragState = null;

  const rect = col.getBoundingClientRect();
  let endY = e.clientY - rect.top;
  endY = Math.max(0, Math.min(AXIS_HEIGHT, endY));

  const topY = Math.min(startY, endY);
  const bottomY = Math.max(startY, endY);

  selectionEl.remove();

  // Convert to minutes, snap to 15-minute intervals
  let startMin = pixelsToMinutes(topY, AXIS_HEIGHT);
  let endMin = pixelsToMinutes(bottomY, AXIS_HEIGHT);

  startMin = Math.round(startMin / SNAP_MINUTES) * SNAP_MINUTES;
  endMin = Math.round(endMin / SNAP_MINUTES) * SNAP_MINUTES;

  // Ensure minimum 15 minutes
  if (endMin <= startMin) {
    endMin = startMin + SNAP_MINUTES;
  }

  // Clamp
  startMin = Math.max(0, startMin);
  endMin = Math.min(1440, endMin);

  if (endMin <= startMin) return;

  openCreateModal(dayDate, startMin, endMin);
}

// ============================================================
// Modal
// ============================================================

function openCreateModal(dayDate, startMin, endMin) {
  modalTitle.textContent = 'Create Event';
  eventIdInput.value = '';
  eventTitleInput.value = '';
  eventDateInput.value = formatDateInput(dayDate);
  eventStartInput.value = minutesToTimeStr(startMin);
  // Handle 1440 (24:00) — HTML time input doesn't support 24:00, use 23:59
  if (endMin >= 1440) {
    eventEndInput.value = '23:59';
  } else {
    eventEndInput.value = minutesToTimeStr(endMin);
  }
  formError.hidden = true;
  btnDelete.hidden = true;
  btnSave.textContent = 'Create';
  modalOverlay.hidden = false;
  eventTitleInput.focus();
}

function openEditModal(event) {
  const start = new Date(event.start_at || event.originalStart);
  const end = new Date(event.end_at || event.originalEnd);

  modalTitle.textContent = 'Edit Event';
  eventIdInput.value = event.id;
  eventTitleInput.value = event.title;
  eventDateInput.value = formatDateInput(start);
  eventStartInput.value = formatDateTime(start);

  // Handle end at midnight (24:00 == next day 00:00)
  if (end.getHours() === 0 && end.getMinutes() === 0 && end > start) {
    // Check if end is exactly one day after start's date
    const startDay = new Date(start);
    startDay.setHours(0, 0, 0, 0);
    const nextDay = new Date(startDay);
    nextDay.setDate(nextDay.getDate() + 1);
    if (end.getTime() === nextDay.getTime()) {
      eventEndInput.value = '23:59';
    } else {
      eventEndInput.value = formatDateTime(end);
    }
  } else {
    eventEndInput.value = formatDateTime(end);
  }

  formError.hidden = true;
  btnDelete.hidden = false;
  btnSave.textContent = 'Save';
  modalOverlay.hidden = false;
  eventTitleInput.focus();
}

function closeModal() {
  modalOverlay.hidden = true;
  eventForm.reset();
  formError.hidden = true;
}

function showFormError(msg) {
  formError.textContent = msg;
  formError.hidden = false;
}

async function handleFormSubmit(e) {
  e.preventDefault();
  formError.hidden = true;

  const title = eventTitleInput.value.trim();
  const dateStr = eventDateInput.value;
  const startTimeStr = eventStartInput.value;
  const endTimeStr = eventEndInput.value;

  if (!title) {
    showFormError('Title is required');
    return;
  }
  if (!dateStr || !startTimeStr || !endTimeStr) {
    showFormError('All fields are required');
    return;
  }

  const startDate = buildLocalDate(dateStr, startTimeStr);
  let endDate = buildLocalDate(dateStr, endTimeStr);

  // If end time is 00:00, treat as 24:00 (next day midnight)
  if (endTimeStr === '00:00') {
    endDate = new Date(startDate);
    endDate.setHours(0, 0, 0, 0);
    endDate.setDate(endDate.getDate() + 1);
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
    await renderWeek();
  } catch (err) {
    showFormError(err.message);
  }
}

async function handleDelete() {
  const id = eventIdInput.value;
  if (!id) return;

  if (!confirm('Delete this event?')) return;

  try {
    await deleteEvent(parseInt(id));
    closeModal();
    await renderWeek();
  } catch (err) {
    showFormError(err.message);
  }
}

// ============================================================
// Start
// ============================================================

document.addEventListener('DOMContentLoaded', init);
