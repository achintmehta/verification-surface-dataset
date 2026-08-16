import {
  getWeekStart,
  getWeekDays,
  formatDayHeader,
  formatWeekLabel,
  isSameDay,
  toDatetimeLocal,
  toLocalISOString,
  parseLocalISO,
  formatTime,
  pxToMinutes,
  snapMinutes,
  minutesToDate,
} from './dates.js';
import { computeLayout, toMinutes, computeGeometry } from './layout.js';
import { fetchEvents, createEvent, updateEvent, deleteEvent } from './api.js';

// ===== Constants =====
const HOUR_HEIGHT = 60; // px per hour — must match CSS --hour-height

// ===== State =====
let currentWeekStart = getWeekStart(new Date());
let events = [];
let editingEventId = null;
let dragState = null;

// ===== DOM References =====
const weekLabel          = document.getElementById('week-label');
const dayHeaders         = document.getElementById('day-headers');
const dayColumns         = document.getElementById('day-columns');
const gutterInner        = document.getElementById('gutter-inner');
const gutterScroll       = document.getElementById('gutter-scroll');
const timeLines          = document.getElementById('time-lines');
const gridScroll         = document.getElementById('grid-scroll');

const modalOverlay       = document.getElementById('modal-overlay');
const modalTitle         = document.getElementById('modal-title');
const eventForm          = document.getElementById('event-form');
const inputTitle         = document.getElementById('input-title');
const inputStart         = document.getElementById('input-start');
const inputEnd           = document.getElementById('input-end');
const formError          = document.getElementById('form-error');
const btnSave            = document.getElementById('btn-save');
const btnDelete          = document.getElementById('btn-delete');
const btnCancel          = document.getElementById('btn-cancel');

// ===== Initialization =====
buildTimeGutter();
buildTimeLines();
setupGutterSync();
setupNavigation();
setupModal();
loadWeek();
startCurrentTimeTicker();

// Scroll to 7am on load
setTimeout(() => {
  gridScroll.scrollTop = HOUR_HEIGHT * 7;
}, 100);

// ===== Time Gutter =====
function buildTimeGutter() {
  for (let h = 0; h <= 24; h++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = `${h * HOUR_HEIGHT}px`;
    // Show label for hours 1–23; skip 0 and 24 (edges)
    if (h > 0 && h < 24) {
      label.textContent = `${pad(h)}:00`;
    }
    gutterInner.appendChild(label);
  }
}

function pad(n) { return String(n).padStart(2, '0'); }

// ===== Sync gutter scroll with grid scroll =====
function setupGutterSync() {
  gridScroll.addEventListener('scroll', () => {
    gutterScroll.scrollTop = gridScroll.scrollTop;
  });
}

// ===== Time Lines =====
function buildTimeLines() {
  for (let h = 0; h <= 24; h++) {
    const line = document.createElement('div');
    line.className = 'hour-line';
    line.style.top = `${h * HOUR_HEIGHT}px`;
    timeLines.appendChild(line);

    if (h < 24) {
      const half = document.createElement('div');
      half.className = 'half-hour-line';
      half.style.top = `${h * HOUR_HEIGHT + HOUR_HEIGHT / 2}px`;
      timeLines.appendChild(half);
    }
  }
}

// ===== Navigation =====
function setupNavigation() {
  document.getElementById('btn-prev').addEventListener('click', () => {
    currentWeekStart = new Date(currentWeekStart);
    currentWeekStart.setDate(currentWeekStart.getDate() - 7);
    loadWeek();
  });

  document.getElementById('btn-today').addEventListener('click', () => {
    currentWeekStart = getWeekStart(new Date());
    loadWeek();
  });

  document.getElementById('btn-next').addEventListener('click', () => {
    currentWeekStart = new Date(currentWeekStart);
    currentWeekStart.setDate(currentWeekStart.getDate() + 7);
    loadWeek();
  });
}

// ===== Load Week =====
async function loadWeek() {
  const weekDays = getWeekDays(currentWeekStart);
  const weekEnd = new Date(weekDays[6]);
  weekEnd.setHours(23, 59, 59, 999);

  weekLabel.textContent = formatWeekLabel(currentWeekStart);
  renderDayHeaders(weekDays);
  renderDayColumns(weekDays);

  try {
    events = await fetchEvents(
      toLocalISOString(currentWeekStart),
      toLocalISOString(weekEnd)
    );
    renderEvents(weekDays);
  } catch (err) {
    console.error('Failed to load events:', err);
  }
}

// ===== Render Day Headers =====
function renderDayHeaders(weekDays) {
  dayHeaders.innerHTML = '';
  const today = new Date();

  weekDays.forEach((day) => {
    const { name, number } = formatDayHeader(day);
    const isToday = isSameDay(day, today);

    const header = document.createElement('div');
    header.className = 'day-header' + (isToday ? ' today' : '');

    const nameEl = document.createElement('div');
    nameEl.className = 'day-name';
    nameEl.textContent = name;

    const numEl = document.createElement('div');
    numEl.className = 'day-number';
    numEl.textContent = number;

    header.appendChild(nameEl);
    header.appendChild(numEl);
    dayHeaders.appendChild(header);
  });
}

// ===== Render Day Columns =====
function renderDayColumns(weekDays) {
  dayColumns.innerHTML = '';
  const today = new Date();

  weekDays.forEach((day, dayIndex) => {
    const isToday = isSameDay(day, today);
    const col = document.createElement('div');
    col.className = 'day-col' + (isToday ? ' today' : '');
    col.dataset.dayIndex = dayIndex;

    if (isToday) {
      const timeLine = document.createElement('div');
      timeLine.className = 'current-time-line';
      timeLine.id = 'current-time-line';
      updateCurrentTimeLine(timeLine);
      col.appendChild(timeLine);
    }

    col.addEventListener('mousedown', (e) => onDayMouseDown(e, col, day));
    dayColumns.appendChild(col);
  });
}

// ===== Render Events =====
function renderEvents(weekDays) {
  document.querySelectorAll('.event-block').forEach(el => el.remove());
  document.querySelectorAll('.selection-highlight').forEach(el => el.remove());

  const cols = dayColumns.querySelectorAll('.day-col');

  weekDays.forEach((day, dayIndex) => {
    const col = cols[dayIndex];
    if (!col) return;

    // Day boundaries (local time)
    const dayStartMs = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0, 0).getTime();
    const dayEndMs   = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 23, 59, 59, 999).getTime();

    // Events overlapping this day
    const dayEvents = events.filter(evt => {
      const s = parseLocalISO(evt.start_at).getTime();
      const e = parseLocalISO(evt.end_at).getTime();
      return s < dayEndMs && e > dayStartMs;
    });

    if (dayEvents.length === 0) return;

    // Compute overlap layout (uses local-time minutes)
    const laid = computeLayout(dayEvents);

    // Measure column pixel width
    const colWidth = col.getBoundingClientRect().width || 120;

    laid.forEach((evt) => {
      const startDate = parseLocalISO(evt.start_at);
      const endDate   = parseLocalISO(evt.end_at);

      // Clamp to this day's 00:00–24:00
      const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0);
      const dayEnd   = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1, 0, 0, 0);

      const clampedStart = startDate < dayStart ? dayStart : startDate;
      const clampedEnd   = endDate   > dayEnd   ? dayEnd   : endDate;

      // Minutes from midnight for this day
      const startMins = clampedStart.getHours() * 60 + clampedStart.getMinutes();

      // If clampedEnd is exactly midnight of the next day → 1440 minutes
      const isNextDay = (
        clampedEnd.getDate()  !== day.getDate()  ||
        clampedEnd.getMonth() !== day.getMonth() ||
        clampedEnd.getFullYear() !== day.getFullYear()
      );
      const endMins = isNextDay ? 1440 : (clampedEnd.getHours() * 60 + clampedEnd.getMinutes());

      const geo = computeGeometry(
        startMins,
        endMins,
        evt.colIndex,
        evt.colCount,
        HOUR_HEIGHT,
        colWidth,
        2
      );

      const block = document.createElement('div');
      block.className = 'event-block';
      block.dataset.id = evt.id;
      block.dataset.color = (evt.id - 1) % 7;
      block.style.top    = `${geo.top}px`;
      block.style.height = `${geo.height}px`;
      block.style.left   = `${geo.left}px`;
      block.style.width  = `${geo.width}px`;

      const titleEl = document.createElement('div');
      titleEl.className = 'event-title';
      titleEl.textContent = evt.title;

      const timeEl = document.createElement('div');
      timeEl.className = 'event-time';
      timeEl.textContent = `${formatTime(evt.start_at)} \u2013 ${formatTime(evt.end_at)}`;

      block.appendChild(titleEl);
      // Only show time row if block is tall enough
      if (geo.height >= 32) {
        block.appendChild(timeEl);
      }
      block.title = `${evt.title}\n${formatTime(evt.start_at)} \u2013 ${formatTime(evt.end_at)}`;

      block.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditModal(evt);
      });

      col.appendChild(block);
    });
  });
}

// ===== Current Time Indicator =====
function updateCurrentTimeLine(el) {
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  el.style.top = `${(mins / 60) * HOUR_HEIGHT}px`;
}

function startCurrentTimeTicker() {
  const update = () => {
    const line = document.getElementById('current-time-line');
    if (line) updateCurrentTimeLine(line);
  };
  update();
  setInterval(update, 60000);
}

// ===== Drag to Create =====
function onDayMouseDown(e, col, day) {
  if (e.button !== 0) return;
  if (e.target.closest('.event-block')) return;

  e.preventDefault();

  const rect = col.getBoundingClientRect();
  const rawMinutes = pxToMinutes(e.clientY - rect.top, HOUR_HEIGHT);
  const startMinutes = snapMinutes(rawMinutes, 15);

  const highlight = document.createElement('div');
  highlight.className = 'selection-highlight';
  col.appendChild(highlight);

  dragState = {
    dayDate: day,
    startMinutes,
    endMinutes: startMinutes + 60,
    col,
    highlight,
  };

  updateHighlight();

  const onMouseMove = (e) => {
    if (!dragState) return;
    const rawEnd = pxToMinutes(e.clientY - rect.top, HOUR_HEIGHT);
    const endMinutes = snapMinutes(rawEnd, 15);
    dragState.endMinutes = Math.max(dragState.startMinutes + 15, endMinutes);
    updateHighlight();
  };

  const onMouseUp = () => {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);

    if (!dragState) return;

    const { startMinutes, endMinutes, dayDate, highlight } = dragState;
    highlight.remove();

    const duration = endMinutes - startMinutes;
    const finalEnd = duration < 15 ? startMinutes + 60 : endMinutes;

    openCreateModal(dayDate, startMinutes, Math.min(finalEnd, 1440));
    dragState = null;
  };

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
}

function updateHighlight() {
  if (!dragState) return;
  const { startMinutes, endMinutes, highlight } = dragState;
  const pxPerMin = HOUR_HEIGHT / 60;
  highlight.style.top    = `${startMinutes * pxPerMin}px`;
  highlight.style.height = `${Math.max(15, endMinutes - startMinutes) * pxPerMin}px`;
}

// ===== Modal =====
function setupModal() {
  btnCancel.addEventListener('click', closeModal);
  btnDelete.addEventListener('click', handleDelete);
  eventForm.addEventListener('submit', handleSave);

  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) closeModal();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });
}

function openCreateModal(dayDate, startMinutes, endMinutes) {
  editingEventId = null;
  modalTitle.textContent = 'New Event';
  btnDelete.classList.add('hidden');
  btnSave.textContent = 'Create';

  const startDate = minutesToDate(dayDate, startMinutes);
  const endDate   = minutesToDate(dayDate, Math.min(endMinutes, 1439));

  inputTitle.value = '';
  inputStart.value = toDatetimeLocal(startDate);
  inputEnd.value   = toDatetimeLocal(endDate);
  hideFormError();

  modalOverlay.classList.remove('hidden');
  setTimeout(() => inputTitle.focus(), 50);
}

function openEditModal(evt) {
  editingEventId = evt.id;
  modalTitle.textContent = 'Edit Event';
  btnDelete.classList.remove('hidden');
  btnSave.textContent = 'Save';

  inputTitle.value = evt.title;
  inputStart.value = toDatetimeLocal(parseLocalISO(evt.start_at));
  inputEnd.value   = toDatetimeLocal(parseLocalISO(evt.end_at));
  hideFormError();

  modalOverlay.classList.remove('hidden');
  setTimeout(() => inputTitle.focus(), 50);
}

function closeModal() {
  modalOverlay.classList.add('hidden');
  editingEventId = null;
  hideFormError();
}

async function handleSave(e) {
  e.preventDefault();
  hideFormError();

  const title    = inputTitle.value.trim();
  const startVal = inputStart.value;  // "YYYY-MM-DDTHH:MM"
  const endVal   = inputEnd.value;

  if (!title) {
    showFormError('Title is required.');
    return;
  }
  if (!startVal || !endVal) {
    showFormError('Start and end times are required.');
    return;
  }

  const startDate = new Date(startVal);
  const endDate   = new Date(endVal);

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    showFormError('Invalid date/time values.');
    return;
  }
  if (endDate <= startDate) {
    showFormError('End time must be after start time.');
    return;
  }

  // Send wall-clock strings (no UTC conversion)
  const data = {
    title,
    start_at: startVal + ':00',
    end_at:   endVal   + ':00',
  };

  btnSave.disabled = true;
  btnSave.textContent = 'Saving\u2026';

  try {
    if (editingEventId !== null) {
      await updateEvent(editingEventId, data);
    } else {
      await createEvent(data);
    }
    closeModal();
    await loadWeek();
  } catch (err) {
    showFormError(err.message);
  } finally {
    btnSave.disabled = false;
    btnSave.textContent = editingEventId !== null ? 'Save' : 'Create';
  }
}

async function handleDelete() {
  if (editingEventId === null) return;
  if (!confirm('Delete this event?')) return;

  btnDelete.disabled = true;

  try {
    await deleteEvent(editingEventId);
    closeModal();
    await loadWeek();
  } catch (err) {
    showFormError(err.message);
  } finally {
    btnDelete.disabled = false;
  }
}

function showFormError(msg) {
  formError.textContent = msg;
  formError.classList.remove('hidden');
}

function hideFormError() {
  formError.textContent = '';
  formError.classList.add('hidden');
}

// ===== Handle window resize =====
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const weekDays = getWeekDays(currentWeekStart);
    renderEvents(weekDays);
  }, 150);
});
