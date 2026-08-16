import {
  getWeekStart, getWeekEnd, getWeekDays, formatWeekTitle,
  isToday, getDayName, getMinutesSinceMidnight,
  toDatetimeLocalValue, formatTime, toLocalISOString
} from './dateUtils.js';
import { computeDayLayout, computeEventPosition } from './layout.js';
import { fetchEvents, createEvent, updateEvent, deleteEvent } from './api.js';

// --- Constants ---
const HOUR_HEIGHT = 60; // px per hour — must match CSS --hour-height
const AXIS_HEIGHT = HOUR_HEIGHT * 24; // 1440px for 24 hours
const TOTAL_HOURS = 24;
const SNAP_MINUTES = 15;

// --- State ---
let currentWeekStart = getWeekStart(new Date());
let events = [];

// --- DOM refs ---
const dayHeaders = document.getElementById('day-headers');
const timeGutter = document.getElementById('time-gutter');
const daysGrid = document.getElementById('days-grid');
const calendarScroll = document.getElementById('calendar-scroll');
const weekTitle = document.getElementById('week-title');
const btnPrev = document.getElementById('btn-prev');
const btnToday = document.getElementById('btn-today');
const btnNext = document.getElementById('btn-next');
const modalOverlay = document.getElementById('modal-overlay');
const modalTitle = document.getElementById('modal-title');
const eventForm = document.getElementById('event-form');
const eventIdInput = document.getElementById('event-id');
const eventTitleInput = document.getElementById('event-title');
const eventStartInput = document.getElementById('event-start');
const eventEndInput = document.getElementById('event-end');
const formError = document.getElementById('form-error');
const btnDelete = document.getElementById('btn-delete');
const btnCancel = document.getElementById('btn-cancel');

// --- Initialization ---
function init() {
  buildTimeGutter();
  setupNavigation();
  setupModal();
  loadWeek().then(() => {
    // Scroll to 8am after initial render
    requestAnimationFrame(() => {
      calendarScroll.scrollTop = 8 * HOUR_HEIGHT;
      // Compensate for scrollbar width in the header row
      adjustHeaderForScrollbar();
    });
  });
}

function adjustHeaderForScrollbar() {
  const scrollbarWidth = calendarScroll.offsetWidth - calendarScroll.clientWidth;
  const headersRow = document.querySelector('.day-headers-row');
  if (headersRow && scrollbarWidth > 0) {
    headersRow.style.paddingRight = `${scrollbarWidth}px`;
  }
}

// --- Time Gutter ---
function buildTimeGutter() {
  timeGutter.innerHTML = '';

  for (let h = 0; h < TOTAL_HOURS; h++) {
    const label = document.createElement('div');
    label.className = 'hour-label';
    label.style.top = `${h * HOUR_HEIGHT}px`;
    label.textContent = `${String(h).padStart(2, '0')}:00`;
    timeGutter.appendChild(label);
  }
}

// --- Navigation ---
function setupNavigation() {
  btnPrev.addEventListener('click', () => {
    currentWeekStart = new Date(currentWeekStart);
    currentWeekStart.setDate(currentWeekStart.getDate() - 7);
    loadWeek();
  });

  btnToday.addEventListener('click', () => {
    currentWeekStart = getWeekStart(new Date());
    loadWeek();
  });

  btnNext.addEventListener('click', () => {
    currentWeekStart = new Date(currentWeekStart);
    currentWeekStart.setDate(currentWeekStart.getDate() + 7);
    loadWeek();
  });
}

// --- Load Week ---
async function loadWeek() {
  weekTitle.textContent = formatWeekTitle(currentWeekStart);
  const weekEnd = getWeekEnd(currentWeekStart);

  try {
    events = await fetchEvents(currentWeekStart, weekEnd);
  } catch (err) {
    console.error('Failed to load events:', err);
    events = [];
  }

  renderWeek();
}

// --- Render Week ---
function renderWeek() {
  const days = getWeekDays(currentWeekStart);

  // Render day headers
  dayHeaders.innerHTML = '';
  days.forEach((day, dayIndex) => {
    const header = document.createElement('div');
    header.className = 'day-header';
    if (isToday(day)) header.classList.add('today');

    const dayName = document.createElement('div');
    dayName.className = 'day-name';
    dayName.textContent = getDayName(dayIndex);

    const dayNumber = document.createElement('div');
    dayNumber.className = 'day-number';
    dayNumber.textContent = day.getDate();

    header.appendChild(dayName);
    header.appendChild(dayNumber);
    dayHeaders.appendChild(header);
  });

  // Render day columns
  daysGrid.innerHTML = '';
  days.forEach((day) => {
    const col = renderDayColumn(day);
    daysGrid.appendChild(col);
  });
}

function renderDayColumn(day) {
  const col = document.createElement('div');
  col.className = 'day-column';
  if (isToday(day)) col.classList.add('today');

  // Hour lines
  for (let h = 0; h <= TOTAL_HOURS; h++) {
    const line = document.createElement('div');
    line.className = 'hour-line';
    line.style.top = `${h * HOUR_HEIGHT}px`;
    col.appendChild(line);

    // Half-hour line (not for the last hour boundary)
    if (h < TOTAL_HOURS) {
      const halfLine = document.createElement('div');
      halfLine.className = 'half-hour-line';
      halfLine.style.top = `${h * HOUR_HEIGHT + HOUR_HEIGHT / 2}px`;
      col.appendChild(halfLine);
    }
  }

  // Current time indicator (only for today)
  if (isToday(day)) {
    const now = new Date();
    const minutes = getMinutesSinceMidnight(now);
    const top = (minutes / 1440) * AXIS_HEIGHT;
    const timeLine = document.createElement('div');
    timeLine.className = 'current-time-line';
    timeLine.style.top = `${top}px`;
    col.appendChild(timeLine);
  }

  // Render events for this day
  renderDayEvents(col, day);

  // Click/drag to create event
  setupDayColumnInteraction(col, day);

  return col;
}

// --- Render Events for a Day ---
function renderDayEvents(col, day) {
  const dayStart = new Date(day);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(day);
  dayEnd.setDate(dayEnd.getDate() + 1);
  dayEnd.setHours(0, 0, 0, 0);

  // Filter and transform events for this day
  const dayEvents = events
    .map(ev => {
      const start = new Date(ev.start_at);
      const end = new Date(ev.end_at);
      return { ...ev, start, end };
    })
    .filter(ev => ev.start < dayEnd && ev.end > dayStart)
    .map(ev => {
      // Clamp to day boundaries
      const clampedStart = ev.start < dayStart ? dayStart : ev.start;
      const clampedEnd = ev.end > dayEnd ? dayEnd : ev.end;

      const startMinutes = getMinutesSinceMidnight(clampedStart);
      let endMinutes;
      if (clampedEnd.getTime() === dayEnd.getTime()) {
        endMinutes = 1440;
      } else {
        endMinutes = getMinutesSinceMidnight(clampedEnd);
      }
      // Ensure endMinutes doesn't exceed 1440
      endMinutes = Math.min(endMinutes, 1440);

      return {
        ...ev,
        startMinutes,
        endMinutes
      };
    });

  if (dayEvents.length === 0) return;

  // Compute layout
  const layoutEvents = computeDayLayout(dayEvents);

  // Render each event block
  for (const ev of layoutEvents) {
    const { top, height } = computeEventPosition(ev.startMinutes, ev.endMinutes, AXIS_HEIGHT);
    const widthPercent = 100 / ev.totalColumns;
    const leftPercent = ev.column * widthPercent;

    const block = document.createElement('div');
    block.className = 'event-block';
    block.style.top = `${top}px`;
    block.style.height = `${height}px`;
    block.style.left = `calc(${leftPercent}% + 1px)`;
    block.style.width = `calc(${widthPercent}% - 3px)`;

    // Color variation based on event id
    const hue = ((ev.id * 47) + 200) % 360;
    block.style.background = `hsl(${hue}, 55%, 55%)`;
    block.style.borderLeftColor = `hsl(${hue}, 55%, 35%)`;

    const titleDiv = document.createElement('div');
    titleDiv.className = 'event-title';
    titleDiv.textContent = ev.title;

    const timeDiv = document.createElement('div');
    timeDiv.className = 'event-time';
    timeDiv.textContent = `${formatTime(ev.start)} – ${formatTime(ev.end)}`;

    block.appendChild(titleDiv);
    block.appendChild(timeDiv);

    // Click to edit
    block.addEventListener('click', (e) => {
      e.stopPropagation();
      openEditModal(ev);
    });

    col.appendChild(block);
  }
}

// --- Day Column Interaction (click/drag to create) ---
function setupDayColumnInteraction(col, day) {
  let isDragging = false;
  let dragStartY = 0;
  let selectionRect = null;

  col.addEventListener('mousedown', (e) => {
    // Don't start drag on event blocks
    if (e.target.closest('.event-block')) return;
    e.preventDefault();
    isDragging = true;

    // Get Y relative to the column
    const rect = col.getBoundingClientRect();
    dragStartY = e.clientY - rect.top;

    selectionRect = document.createElement('div');
    selectionRect.className = 'selection-rect';
    const snappedY = snapToGrid(dragStartY);
    selectionRect.style.top = `${snappedY}px`;
    selectionRect.style.height = `${snapMinutesToPx(SNAP_MINUTES)}px`;
    col.appendChild(selectionRect);
  });

  col.addEventListener('mousemove', (e) => {
    if (!isDragging || !selectionRect) return;
    const rect = col.getBoundingClientRect();
    const currentY = clampPx(e.clientY - rect.top);
    const snappedStart = snapToGrid(dragStartY);
    const snappedEnd = snapToGrid(currentY);
    const top = Math.min(snappedStart, snappedEnd);
    const bottom = Math.max(snappedStart, snappedEnd);
    const minHeight = snapMinutesToPx(SNAP_MINUTES);
    selectionRect.style.top = `${top}px`;
    selectionRect.style.height = `${Math.max(bottom - top, minHeight)}px`;
  });

  const finishDrag = (e) => {
    if (!isDragging) return;
    isDragging = false;

    const rect = col.getBoundingClientRect();
    let currentY;
    if (e.clientY !== undefined) {
      currentY = clampPx(e.clientY - rect.top);
    } else {
      currentY = dragStartY + snapMinutesToPx(60); // default 1 hour
    }

    let snappedStart = snapToGrid(dragStartY);
    let snappedEnd = snapToGrid(currentY);

    if (snappedStart === snappedEnd) {
      snappedEnd = snappedStart + snapMinutesToPx(SNAP_MINUTES);
    }
    if (snappedStart > snappedEnd) {
      [snappedStart, snappedEnd] = [snappedEnd, snappedStart];
    }

    // Convert pixels to minutes
    const startMinutes = Math.round(pxToMinutes(snappedStart));
    const endMinutes = Math.min(Math.round(pxToMinutes(snappedEnd)), 1440);

    // Clean up
    if (selectionRect && selectionRect.parentNode) {
      selectionRect.parentNode.removeChild(selectionRect);
    }
    selectionRect = null;

    // Build dates
    const startDate = new Date(day);
    startDate.setHours(0, 0, 0, 0);
    startDate.setMinutes(startMinutes);

    const endDate = new Date(day);
    endDate.setHours(0, 0, 0, 0);
    endDate.setMinutes(endMinutes);

    if (endDate <= startDate) {
      endDate.setTime(startDate.getTime() + SNAP_MINUTES * 60000);
    }

    openCreateModal(startDate, endDate);
  };

  col.addEventListener('mouseup', finishDrag);
  col.addEventListener('mouseleave', () => {
    if (isDragging && selectionRect) {
      if (selectionRect.parentNode) {
        selectionRect.parentNode.removeChild(selectionRect);
      }
      selectionRect = null;
      isDragging = false;
    }
  });
}

function snapToGrid(px) {
  const minutes = pxToMinutes(px);
  const snapped = Math.round(minutes / SNAP_MINUTES) * SNAP_MINUTES;
  return minutesToPx(snapped);
}

function pxToMinutes(px) {
  return (px / AXIS_HEIGHT) * 1440;
}

function minutesToPx(minutes) {
  return (minutes / 1440) * AXIS_HEIGHT;
}

function snapMinutesToPx(minutes) {
  return (minutes / 1440) * AXIS_HEIGHT;
}

function clampPx(px) {
  return Math.max(0, Math.min(px, AXIS_HEIGHT));
}

// --- Modal ---
function setupModal() {
  btnCancel.addEventListener('click', closeModal);
  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) closeModal();
  });

  eventForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    await saveEvent();
  });

  btnDelete.addEventListener('click', async () => {
    const id = eventIdInput.value;
    if (!id) return;
    try {
      await deleteEvent(parseInt(id));
      closeModal();
      await loadWeek();
    } catch (err) {
      showFormError(err.message);
    }
  });
}

function openCreateModal(startDate, endDate) {
  modalTitle.textContent = 'New Event';
  eventIdInput.value = '';
  eventTitleInput.value = '';
  eventStartInput.value = toDatetimeLocalValue(startDate);
  eventEndInput.value = toDatetimeLocalValue(endDate);
  btnDelete.style.display = 'none';
  hideFormError();
  modalOverlay.style.display = 'flex';
  eventTitleInput.focus();
}

function openEditModal(event) {
  modalTitle.textContent = 'Edit Event';
  eventIdInput.value = event.id;
  eventTitleInput.value = event.title;
  eventStartInput.value = toDatetimeLocalValue(event.start);
  eventEndInput.value = toDatetimeLocalValue(event.end);
  btnDelete.style.display = 'inline-block';
  hideFormError();
  modalOverlay.style.display = 'flex';
  eventTitleInput.focus();
}

function closeModal() {
  modalOverlay.style.display = 'none';
  eventForm.reset();
  hideFormError();
}

function showFormError(msg) {
  formError.textContent = msg;
  formError.style.display = 'block';
}

function hideFormError() {
  formError.style.display = 'none';
  formError.textContent = '';
}

async function saveEvent() {
  const title = eventTitleInput.value.trim();
  const startVal = eventStartInput.value;
  const endVal = eventEndInput.value;

  if (!title) {
    showFormError('Title is required');
    return;
  }
  if (!startVal || !endVal) {
    showFormError('Start and end times are required');
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

  const data = {
    title,
    start_at: toLocalISOString(startDate),
    end_at: toLocalISOString(endDate)
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
}

// --- Start ---
init();
