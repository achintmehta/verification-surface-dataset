import { api } from './api.js';
import { computeDayLayout, toMinutes, toEndMinutes, minutesToPx } from './layout.js';
import {
  getWeekStart, getWeekDays, toLocalISO, toInputDateTime,
  formatWeekLabel, formatDayHeader, formatTime, formatEventTime,
  getDateStr, isToday, addWeeks,
} from './week.js';

// ============================================================
// Constants
// ============================================================
const HOUR_HEIGHT = 60; // px — must match CSS --hour-height

// ============================================================
// State
// ============================================================
let currentWeekStart = getWeekStart(new Date());
let events = []; // all events for the current week

// Drag state
let dragState = null; // { dayIndex, startY, startMin, colEl, selEl }

// ============================================================
// DOM refs
// ============================================================
const weekLabel    = document.getElementById('week-label');
const dayHeaders   = document.getElementById('day-headers');
const timeGutter   = document.getElementById('time-gutter');
const dayColumns   = document.getElementById('day-columns');
const calScroll    = document.getElementById('calendar-scroll');

const modalOverlay = document.getElementById('modal-overlay');
const modalTitle   = document.getElementById('modal-title');
const eventForm    = document.getElementById('event-form');
const eventIdInput = document.getElementById('event-id');
const titleInput   = document.getElementById('event-title');
const startInput   = document.getElementById('event-start');
const endInput     = document.getElementById('event-end');
const formError    = document.getElementById('form-error');
const btnDelete    = document.getElementById('btn-delete');
const btnCancel    = document.getElementById('btn-cancel');
const btnSave      = document.getElementById('btn-save');
const modalClose   = document.getElementById('modal-close');

// ============================================================
// Initialization
// ============================================================
async function init() {
  buildTimeGutter();
  await loadAndRender();
  scrollToBusinessHours();
  startCurrentTimeTicker();

  document.getElementById('btn-prev').addEventListener('click', () => navigate(-1));
  document.getElementById('btn-today').addEventListener('click', navigateToday);
  document.getElementById('btn-next').addEventListener('click', () => navigate(1));

  btnCancel.addEventListener('click', closeModal);
  modalClose.addEventListener('click', closeModal);
  modalOverlay.addEventListener('click', e => { if (e.target === modalOverlay) closeModal(); });
  btnDelete.addEventListener('click', handleDelete);
  eventForm.addEventListener('submit', handleSave);
}

// ============================================================
// Time gutter
// ============================================================
function buildTimeGutter() {
  timeGutter.innerHTML = '';
  for (let h = 0; h <= 24; h++) {
    if (h === 0) continue; // skip midnight label at top
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = `${minutesToPx(h * 60, HOUR_HEIGHT)}px`;
    label.textContent = formatTime(h === 24 ? 0 : h, 0);
    timeGutter.appendChild(label);
  }
}

// ============================================================
// Load & Render
// ============================================================
async function loadAndRender() {
  const weekDays = getWeekDays(currentWeekStart);
  const rangeStart = toLocalISO(weekDays[0]);
  const rangeEnd   = (() => {
    const d = new Date(weekDays[6]);
    d.setDate(d.getDate() + 1);
    d.setHours(0, 0, 0, 0);
    return toLocalISO(d);
  })();

  weekLabel.textContent = formatWeekLabel(currentWeekStart);

  try {
    events = await api.getEvents(rangeStart, rangeEnd);
  } catch (err) {
    console.error('Failed to load events:', err);
    events = [];
  }

  renderDayHeaders(weekDays);
  renderDayColumns(weekDays);
}

// ============================================================
// Day headers
// ============================================================
function renderDayHeaders(weekDays) {
  dayHeaders.innerHTML = '';
  weekDays.forEach(day => {
    const { name, number } = formatDayHeader(day);
    const div = document.createElement('div');
    div.className = 'day-header' + (isToday(day) ? ' today' : '');
    div.innerHTML = `
      <span class="day-name">${name}</span>
      <span class="day-number">${number}</span>
    `;
    dayHeaders.appendChild(div);
  });
}

// ============================================================
// Day columns
// ============================================================
function renderDayColumns(weekDays) {
  dayColumns.innerHTML = '';

  weekDays.forEach((day, dayIndex) => {
    const col = document.createElement('div');
    col.className = 'day-col' + (isToday(day) ? ' today' : '');
    col.dataset.dayIndex = dayIndex;

    // Hour grid lines
    for (let h = 0; h <= 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${minutesToPx(h * 60, HOUR_HEIGHT)}px`;
      col.appendChild(line);

      if (h < 24) {
        const half = document.createElement('div');
        half.className = 'half-line';
        half.style.top = `${minutesToPx(h * 60 + 30, HOUR_HEIGHT)}px`;
        col.appendChild(half);
      }
    }

    // Current time indicator (only on today's column)
    if (isToday(day)) {
      const timeLine = document.createElement('div');
      timeLine.className = 'current-time-line';
      timeLine.id = 'current-time-line';
      updateCurrentTimeLine(timeLine);
      col.appendChild(timeLine);
    }

    // Events for this day
    const dayStr = getDateStr(toLocalISO(day));
    const dayEvents = events.filter(ev => {
      // An event belongs to this day if its start date matches
      return getDateStr(ev.start_at) === dayStr;
    });

    const layouts = computeDayLayout(dayEvents);
    layouts.forEach(({ event, colIndex, colCount }) => {
      const block = createEventBlock(event, colIndex, colCount);
      col.appendChild(block);
    });

    // Drag-to-create
    col.addEventListener('mousedown', e => onDayMouseDown(e, col, day, dayIndex));

    dayColumns.appendChild(col);
  });
}

// ============================================================
// Event blocks
// ============================================================
function createEventBlock(event, colIndex, colCount) {
  const startMin = toMinutes(event.start_at);
  const endMin   = toEndMinutes(event.start_at, event.end_at);

  // Clamp to [0, 1440]
  const clampedStart = Math.max(0, Math.min(1440, startMin));
  const clampedEnd   = Math.max(0, Math.min(1440, endMin));

  const top    = minutesToPx(clampedStart, HOUR_HEIGHT);
  const height = Math.max(minutesToPx(clampedEnd - clampedStart, HOUR_HEIGHT), 18);

  // Horizontal layout
  // Each column slot is (100 / colCount)% wide.
  // We add a 1px left margin and 1px right margin inside each slot for visual separation.
  const widthPct = 100 / colCount;
  const leftPct  = colIndex * widthPct;

  const block = document.createElement('div');
  block.className = `event-block event-color-${event.id % 8}`;
  block.style.top    = `${top}px`;
  block.style.height = `${height}px`;
  // 1px gap on each side within the slot
  block.style.left   = `calc(${leftPct}% + 1px)`;
  block.style.width  = `calc(${widthPct}% - 2px)`;

  block.innerHTML = `
    <span class="event-title">${escapeHtml(event.title)}</span>
    <span class="event-time">${formatEventTime(event.start_at, event.end_at)}</span>
  `;

  block.addEventListener('click', e => {
    e.stopPropagation();
    openEditModal(event);
  });

  return block;
}

// ============================================================
// Current time line
// ============================================================
function updateCurrentTimeLine(el) {
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  el.style.top = `${minutesToPx(minutes, HOUR_HEIGHT)}px`;
}

function startCurrentTimeTicker() {
  setInterval(() => {
    const line = document.getElementById('current-time-line');
    if (line) updateCurrentTimeLine(line);
  }, 60_000);
}

// ============================================================
// Scroll to business hours on load
// ============================================================
function scrollToBusinessHours() {
  // Scroll to 07:00
  calScroll.scrollTop = minutesToPx(7 * 60, HOUR_HEIGHT);
}

// ============================================================
// Navigation
// ============================================================
function navigate(weeks) {
  currentWeekStart = addWeeks(currentWeekStart, weeks);
  loadAndRender();
}

function navigateToday() {
  currentWeekStart = getWeekStart(new Date());
  loadAndRender().then(scrollToBusinessHours);
}

// ============================================================
// Drag-to-create
// ============================================================
function onDayMouseDown(e, col, day, dayIndex) {
  // Only left button, not on event blocks
  if (e.button !== 0) return;
  if (e.target.closest('.event-block')) return;

  e.preventDefault();

  // Compute Y position relative to the column's top (accounting for scroll)
  const colRect    = col.getBoundingClientRect();
  const scrollRect = calScroll.getBoundingClientRect();

  function getMinutesFromEvent(clientY) {
    // clientY relative to the scroll container's visible top, plus scroll offset
    const y = clientY - colRect.top + calScroll.scrollTop;
    return Math.max(0, Math.min(1440, (y / HOUR_HEIGHT) * 60));
  }

  const rawStartMin = getMinutesFromEvent(e.clientY);
  const startMin    = snapToInterval(rawStartMin, 15);
  const initEndMin  = Math.min(1440, startMin + 15);

  // Create selection element
  const selEl = document.createElement('div');
  selEl.className = 'drag-selection';
  selEl.style.top    = `${minutesToPx(startMin, HOUR_HEIGHT)}px`;
  selEl.style.height = `${minutesToPx(initEndMin - startMin, HOUR_HEIGHT)}px`;
  col.appendChild(selEl);

  dragState = { col, day, dayIndex, startMin, currentEndMin: initEndMin, selEl };

  const onMouseMove = (e2) => {
    if (!dragState) return;
    const rawEndMin = getMinutesFromEvent(e2.clientY);
    const endMin    = Math.min(1440, Math.max(dragState.startMin + 15, snapToInterval(rawEndMin, 15)));
    dragState.currentEndMin = endMin;

    selEl.style.top    = `${minutesToPx(dragState.startMin, HOUR_HEIGHT)}px`;
    selEl.style.height = `${minutesToPx(endMin - dragState.startMin, HOUR_HEIGHT)}px`;
  };

  const onMouseUp = () => {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);

    if (!dragState) return;
    const { day: d, startMin, currentEndMin, selEl: sel } = dragState;
    sel.remove();
    dragState = null;

    // Open create modal with pre-filled times
    const startDate = minutesToDate(d, startMin);
    const endDate   = minutesToDate(d, currentEndMin);
    openCreateModal(startDate, endDate);
  };

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
}

function snapToInterval(minutes, interval) {
  return Math.round(minutes / interval) * interval;
}

function minutesToDate(day, minutes) {
  const d = new Date(day);
  d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return d;
}

// ============================================================
// Modal
// ============================================================
function openCreateModal(startDate, endDate) {
  modalTitle.textContent = 'New Event';
  eventIdInput.value = '';
  titleInput.value   = '';
  startInput.value   = toInputDateTime(startDate);
  endInput.value     = toInputDateTime(endDate);
  btnDelete.classList.add('hidden');
  hideFormError();
  showModal();
  titleInput.focus();
}

function openEditModal(event) {
  modalTitle.textContent = 'Edit Event';
  eventIdInput.value = event.id;
  titleInput.value   = event.title;
  startInput.value   = event.start_at.slice(0, 16); // "YYYY-MM-DDTHH:MM"

  // Handle midnight end: if end_at is next day at 00:00, show as same day 24:00
  // datetime-local doesn't support 24:00, so we keep the actual stored value
  endInput.value = event.end_at.slice(0, 16);

  btnDelete.classList.remove('hidden');
  hideFormError();
  showModal();
  titleInput.focus();
}

function showModal() {
  modalOverlay.classList.remove('hidden');
}

function closeModal() {
  modalOverlay.classList.add('hidden');
  eventForm.reset();
  hideFormError();
}

function showFormError(msg) {
  formError.textContent = msg;
  formError.classList.remove('hidden');
}

function hideFormError() {
  formError.classList.add('hidden');
  formError.textContent = '';
}

// ============================================================
// Save / Delete
// ============================================================
async function handleSave(e) {
  e.preventDefault();
  hideFormError();

  const id      = eventIdInput.value;
  const title   = titleInput.value.trim();
  const startAt = startInput.value; // "YYYY-MM-DDTHH:MM"
  const endAt   = endInput.value;

  if (!title) {
    showFormError('Title is required.');
    return;
  }
  if (!startAt || !endAt) {
    showFormError('Start and end times are required.');
    return;
  }
  if (new Date(endAt) <= new Date(startAt)) {
    showFormError('End time must be after start time.');
    return;
  }

  // Append seconds for the server
  const payload = {
    title,
    start_at: startAt + ':00',
    end_at:   endAt   + ':00',
  };

  try {
    if (id) {
      await api.updateEvent(id, payload);
    } else {
      await api.createEvent(payload);
    }
    closeModal();
    await loadAndRender();
  } catch (err) {
    showFormError(err.data?.error || err.message || 'Failed to save event.');
  }
}

async function handleDelete() {
  const id = eventIdInput.value;
  if (!id) return;

  if (!confirm('Delete this event?')) return;

  try {
    await api.deleteEvent(id);
    closeModal();
    await loadAndRender();
  } catch (err) {
    showFormError(err.data?.error || err.message || 'Failed to delete event.');
  }
}

// ============================================================
// Utilities
// ============================================================
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================
// Boot
// ============================================================
init().catch(console.error);
