import { fetchEvents, createEvent, updateEvent, deleteEvent } from './api.js';
import { computeOverlapLayout } from './layout.js';

// ───── Constants ─────
const HOUR_HEIGHT = 60; // pixels per hour — must match CSS --hour-height
const TOTAL_MINUTES = 24 * 60;
const AXIS_HEIGHT = HOUR_HEIGHT * 24;
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ───── State ─────
let currentWeekStart = getMonday(new Date());
let events = [];
let editingEvent = null; // null = creating, object = editing

// Drag state (global so document-level handlers can use it)
let dragState = null; // { dayBody, dayDate, startY, indicator }

// ───── DOM refs ─────
const weekTitleEl = document.getElementById('week-title');
const timeGutterEl = document.getElementById('time-gutter');
const daysContainerEl = document.getElementById('days-container');
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

// ───── Date utilities ─────
function getMonday(d) {
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  const day = date.getDay(); // 0=Sun, 1=Mon...
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  return date;
}

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth() === b.getMonth() &&
         a.getDate() === b.getDate();
}

function formatTime(date) {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function minutesFromMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

function toLocalISOString(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${d}T${h}:${min}`;
}

function yToMinutes(y, dayBody) {
  const bodyRect = dayBody.getBoundingClientRect();
  const relY = y - bodyRect.top;
  const minutes = Math.round((relY / AXIS_HEIGHT) * TOTAL_MINUTES);
  // Snap to 15-minute increments
  return Math.max(0, Math.min(TOTAL_MINUTES, Math.round(minutes / 15) * 15));
}

// ───── Rendering ─────

function renderTimeGutter() {
  timeGutterEl.innerHTML = '';
  const dayHeaderHeight = 48; // matches CSS --day-header-height
  for (let h = 0; h <= 24; h++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = `${dayHeaderHeight + h * HOUR_HEIGHT}px`;
    label.textContent = `${String(h).padStart(2, '0')}:00`;
    timeGutterEl.appendChild(label);
  }
}

function renderWeekTitle() {
  const end = addDays(currentWeekStart, 6);
  const startStr = `${MONTH_NAMES[currentWeekStart.getMonth()]} ${currentWeekStart.getDate()}`;
  const endStr = `${MONTH_NAMES[end.getMonth()]} ${end.getDate()}, ${end.getFullYear()}`;
  weekTitleEl.textContent = `${startStr} – ${endStr}`;
}

function renderDayColumns() {
  daysContainerEl.innerHTML = '';
  const today = new Date();

  for (let i = 0; i < 7; i++) {
    const dayDate = addDays(currentWeekStart, i);
    const col = document.createElement('div');
    col.className = 'day-column';
    if (isSameDay(dayDate, today)) {
      col.classList.add('today');
    }
    col.dataset.dayIndex = i;

    // Header
    const header = document.createElement('div');
    header.className = 'day-header';
    const dayName = document.createElement('span');
    dayName.className = 'day-name';
    dayName.textContent = DAY_NAMES[i];
    const dayNumber = document.createElement('span');
    dayNumber.className = 'day-number';
    dayNumber.textContent = dayDate.getDate();
    header.appendChild(dayName);
    header.appendChild(dayNumber);
    col.appendChild(header);

    // Body
    const body = document.createElement('div');
    body.className = 'day-body';
    body.dataset.dayIndex = i;

    // Hour lines
    for (let h = 0; h < 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${h * HOUR_HEIGHT}px`;
      body.appendChild(line);

      const halfLine = document.createElement('div');
      halfLine.className = 'hour-line half';
      halfLine.style.top = `${h * HOUR_HEIGHT + HOUR_HEIGHT / 2}px`;
      body.appendChild(halfLine);
    }
    // Bottom line at 24:00
    const bottomLine = document.createElement('div');
    bottomLine.className = 'hour-line';
    bottomLine.style.top = `${24 * HOUR_HEIGHT}px`;
    body.appendChild(bottomLine);

    // Click target for creating events
    const clickTarget = document.createElement('div');
    clickTarget.className = 'day-body-click-target';
    clickTarget.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();

      const indicator = document.createElement('div');
      indicator.className = 'drag-indicator';
      const startMin = yToMinutes(e.clientY, body);
      const top = (startMin / TOTAL_MINUTES) * AXIS_HEIGHT;
      indicator.style.top = `${top}px`;
      indicator.style.height = `${HOUR_HEIGHT / 2}px`;
      body.appendChild(indicator);

      dragState = {
        dayBody: body,
        dayDate: new Date(dayDate),
        startY: e.clientY,
        indicator
      };
    });
    body.appendChild(clickTarget);

    col.appendChild(body);
    daysContainerEl.appendChild(col);
  }
}

function renderEvents() {
  // Clear existing event blocks
  document.querySelectorAll('.event-block').forEach(el => el.remove());

  // Group events by day
  const dayBuckets = new Map();
  for (let i = 0; i < 7; i++) {
    dayBuckets.set(i, []);
  }

  for (const ev of events) {
    const start = new Date(ev.start_at);
    const end = new Date(ev.end_at);

    for (let i = 0; i < 7; i++) {
      const dayStart = addDays(currentWeekStart, i);
      const dayEnd = addDays(currentWeekStart, i + 1);

      if (start < dayEnd && end > dayStart) {
        // Clamp to this day
        const clampedStart = start < dayStart ? dayStart : start;
        const clampedEnd = end > dayEnd ? dayEnd : end;

        const startMin = minutesFromMidnight(clampedStart);
        let endMin;
        if (clampedEnd.getTime() === dayEnd.getTime()) {
          endMin = TOTAL_MINUTES;
        } else {
          endMin = minutesFromMidnight(clampedEnd);
        }

        if (endMin <= startMin) continue;

        dayBuckets.get(i).push({
          ...ev,
          startMinutes: startMin,
          endMinutes: endMin,
          displayStart: clampedStart,
          displayEnd: clampedEnd
        });
      }
    }
  }

  // For each day, compute layout and render
  for (const [dayIndex, dayEvents] of dayBuckets) {
    if (dayEvents.length === 0) continue;

    const layoutEvents = computeOverlapLayout(dayEvents);
    const dayBody = document.querySelector(`.day-body[data-day-index="${dayIndex}"]`);
    if (!dayBody) continue;

    for (const ev of layoutEvents) {
      const block = document.createElement('div');
      block.className = 'event-block';
      block.classList.add(`event-color-${ev.id % 8}`);

      // Vertical positioning: exact pixel from time
      const top = (ev.startMinutes / TOTAL_MINUTES) * AXIS_HEIGHT;
      const height = ((ev.endMinutes - ev.startMinutes) / TOTAL_MINUTES) * AXIS_HEIGHT;
      block.style.top = `${top}px`;
      block.style.height = `${height}px`;

      // Horizontal positioning (percentage within day column)
      const widthPercent = 100 / ev.totalColumns;
      const leftPercent = ev.column * widthPercent;
      block.style.left = `${leftPercent}%`;
      block.style.width = `${widthPercent}%`;

      // Content
      const titleEl = document.createElement('div');
      titleEl.className = 'event-title';
      titleEl.textContent = ev.title;

      const timeEl = document.createElement('div');
      timeEl.className = 'event-time';
      const endTimeStr = ev.endMinutes === TOTAL_MINUTES ? '24:00' : formatTime(ev.displayEnd);
      timeEl.textContent = `${formatTime(ev.displayStart)} – ${endTimeStr}`;

      block.appendChild(titleEl);
      block.appendChild(timeEl);

      // Click to edit
      block.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditModal(ev);
      });

      dayBody.appendChild(block);
    }
  }
}

// ───── Global drag handlers (registered once) ─────

document.addEventListener('mousemove', (e) => {
  if (!dragState) return;
  const { dayBody, startY, indicator } = dragState;

  const startMin = yToMinutes(startY, dayBody);
  const currentMin = yToMinutes(e.clientY, dayBody);
  const topMin = Math.min(startMin, currentMin);
  const bottomMin = Math.max(startMin, currentMin);
  const effectiveBottom = Math.max(bottomMin, topMin + 15);

  const top = (topMin / TOTAL_MINUTES) * AXIS_HEIGHT;
  const height = ((effectiveBottom - topMin) / TOTAL_MINUTES) * AXIS_HEIGHT;
  indicator.style.top = `${top}px`;
  indicator.style.height = `${height}px`;
});

document.addEventListener('mouseup', (e) => {
  if (!dragState) return;
  const { dayBody, dayDate, startY, indicator } = dragState;
  dragState = null;

  indicator.remove();

  const startMin = yToMinutes(startY, dayBody);
  const endMin = yToMinutes(e.clientY, dayBody);
  const topMin = Math.min(startMin, endMin);
  let bottomMin = Math.max(startMin, endMin);
  if (bottomMin <= topMin) bottomMin = topMin + 60; // Default 1 hour

  const startDate = new Date(dayDate);
  startDate.setHours(0, topMin, 0, 0);
  const endDate = new Date(dayDate);
  endDate.setHours(0, bottomMin, 0, 0);

  openCreateModal(startDate, endDate);
});

// ───── Modal ─────

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

function showError(msg) {
  formError.textContent = msg;
  formError.classList.remove('hidden');
}

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
  if (!start_at || !end_at) {
    showError('Start and end times are required');
    return;
  }
  if (new Date(end_at) <= new Date(start_at)) {
    showError('End time must be after start time');
    return;
  }

  try {
    if (editingEvent) {
      await updateEvent(editingEvent.id, {
        title,
        start_at: new Date(start_at).toISOString(),
        end_at: new Date(end_at).toISOString()
      });
    } else {
      await createEvent({
        title,
        start_at: new Date(start_at).toISOString(),
        end_at: new Date(end_at).toISOString()
      });
    }
    closeModal();
    await loadEvents();
  } catch (err) {
    showError(err.message);
  }
});

btnDelete.addEventListener('click', async () => {
  if (!editingEvent) return;
  try {
    await deleteEvent(editingEvent.id);
    closeModal();
    await loadEvents();
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

// ───── Navigation ─────

document.getElementById('btn-prev').addEventListener('click', () => {
  currentWeekStart = addDays(currentWeekStart, -7);
  renderWeek();
});

document.getElementById('btn-today').addEventListener('click', () => {
  currentWeekStart = getMonday(new Date());
  renderWeek();
});

document.getElementById('btn-next').addEventListener('click', () => {
  currentWeekStart = addDays(currentWeekStart, 7);
  renderWeek();
});

// ───── Data loading ─────

async function loadEvents() {
  const weekEnd = addDays(currentWeekStart, 7);
  events = await fetchEvents(currentWeekStart, weekEnd);
  renderEvents();
}

async function renderWeek() {
  renderWeekTitle();
  renderDayColumns();
  await loadEvents();
}

// ───── Init ─────
renderTimeGutter();
renderWeek();

// Scroll to 8 AM on initial load
setTimeout(() => {
  const container = document.getElementById('calendar-container');
  container.scrollTop = 8 * HOUR_HEIGHT;
}, 200);
