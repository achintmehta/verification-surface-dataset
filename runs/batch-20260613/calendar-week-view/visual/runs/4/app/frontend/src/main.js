import { fetchEvents, createEvent, updateEvent, deleteEvent } from './api.js';
import { computeLayout, HOUR_HEIGHT, TOTAL_HEIGHT, minutesToPx } from './layout.js';

// ===== State =====
let currentWeekStart = getWeekStart(new Date());
let events = [];
let editingEventId = null;
let dragState = null;
let weekDays = [];

// ===== Date Utilities =====

/** Get Monday of the week containing `date` (local time) */
function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun
  const diff = (day === 0) ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Get array of 7 Date objects Mon–Sun */
function getWeekDays(weekStart) {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    d.setHours(0, 0, 0, 0);
    return d;
  });
}

/** Local date string "YYYY-MM-DD" */
function localDateStr(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Format a Date as datetime-local input value: "YYYY-MM-DDTHH:MM" */
function toDatetimeLocal(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Format time portion of a datetime string as "HH:MM" */
function formatTime(datetimeStr) {
  // datetimeStr is "YYYY-MM-DDTHH:MM:SS" (local, no Z)
  return datetimeStr.slice(11, 16);
}

/** Check if a local Date is today */
function isToday(date) {
  const today = new Date();
  return localDateStr(date) === localDateStr(today);
}

/** Format week label e.g. "June 2026" or "May – June 2026" */
function formatWeekLabel(days) {
  const start = days[0];
  const end = days[6];
  const startMonth = start.toLocaleDateString(undefined, { month: 'long' });
  const endMonth = end.toLocaleDateString(undefined, { month: 'long' });
  const year = start.getFullYear();
  if (startMonth === endMonth && start.getFullYear() === end.getFullYear()) {
    return `${startMonth} ${year}`;
  }
  return `${startMonth} – ${endMonth} ${year}`;
}

/** Get events for a specific day using local date string matching on start_at */
function getEventsForDay(date) {
  const dayStr = localDateStr(date);
  return events.filter(ev => ev.start_at.slice(0, 10) === dayStr);
}

// ===== Event Colors =====
const EVENT_COLORS = [
  { bg: '#1a73e8', text: '#fff' },
  { bg: '#0b8043', text: '#fff' },
  { bg: '#8430ce', text: '#fff' },
  { bg: '#e37400', text: '#fff' },
  { bg: '#c0392b', text: '#fff' },
  { bg: '#00838f', text: '#fff' },
  { bg: '#558b2f', text: '#fff' },
  { bg: '#d81b60', text: '#fff' },
];

function getEventColor(eventId) {
  return EVENT_COLORS[eventId % EVENT_COLORS.length];
}

// ===== Rendering =====

function renderTimeAxis() {
  const axis = document.getElementById('time-axis');
  axis.innerHTML = '';
  axis.style.height = TOTAL_HEIGHT + 'px';

  // Labels for hours 1–23 (not 0 at top, not 24 at bottom)
  for (let h = 1; h < 24; h++) {
    const label = document.createElement('div');
    label.className = 'hour-label';
    label.style.top = minutesToPx(h * 60) + 'px';
    label.textContent = `${String(h).padStart(2, '0')}:00`;
    axis.appendChild(label);
  }
}

function renderDayHeaders() {
  const container = document.getElementById('day-headers');
  container.innerHTML = '';
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  for (const day of weekDays) {
    const col = document.createElement('div');
    col.className = 'day-header' + (isToday(day) ? ' today' : '');

    const nameEl = document.createElement('div');
    nameEl.className = 'day-name';
    nameEl.textContent = DAY_NAMES[day.getDay()];

    const numEl = document.createElement('div');
    numEl.className = 'day-num';
    numEl.textContent = day.getDate();

    col.appendChild(nameEl);
    col.appendChild(numEl);
    container.appendChild(col);
  }
}

function renderDaysBody() {
  const body = document.getElementById('days-body');
  body.innerHTML = '';
  body.style.height = TOTAL_HEIGHT + 'px';

  for (let di = 0; di < 7; di++) {
    const day = weekDays[di];
    const col = document.createElement('div');
    col.className = 'day-column' + (isToday(day) ? ' today-col' : '');
    col.dataset.dayIndex = di;
    col.dataset.date = localDateStr(day);

    // Hour and half-hour grid lines
    for (let h = 0; h <= 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = minutesToPx(h * 60) + 'px';
      col.appendChild(line);

      if (h < 24) {
        const halfLine = document.createElement('div');
        halfLine.className = 'half-hour-line';
        halfLine.style.top = minutesToPx(h * 60 + 30) + 'px';
        col.appendChild(halfLine);
      }
    }

    col.addEventListener('mousedown', onDayMouseDown);
    body.appendChild(col);
  }
}

function renderEvents() {
  const body = document.getElementById('days-body');
  if (!body) return;

  // Remove existing event blocks
  body.querySelectorAll('.event-block').forEach(el => el.remove());

  const columns = body.querySelectorAll('.day-column');

  for (let di = 0; di < 7; di++) {
    const col = columns[di];
    const day = weekDays[di];
    const dayEvents = getEventsForDay(day);

    if (dayEvents.length === 0) continue;

    const layouts = computeLayout(dayEvents);

    for (const { event, top, height, leftPct, widthPct } of layouts) {
      const block = createEventBlock(event, top, height, leftPct, widthPct);
      col.appendChild(block);
    }
  }
}

function createEventBlock(event, top, height, leftPct, widthPct) {
  const block = document.createElement('div');
  // Mark short events (< 30px = 30min) so CSS can hide the time label
  block.className = 'event-block' + (height < 30 ? ' short' : '');
  block.dataset.eventId = event.id;

  const color = getEventColor(event.id);
  block.style.background = color.bg;
  block.style.color = color.text;
  block.style.top = top + 'px';
  block.style.height = Math.max(height, 18) + 'px';

  // Use percentage-based positioning so events stay within their day column.
  // Add a small inset gap (0.5%) on each side for visual separation.
  const GAP = 0.5;
  block.style.left = (leftPct + GAP) + '%';
  block.style.width = (widthPct - GAP * 2) + '%';

  const titleEl = document.createElement('div');
  titleEl.className = 'event-title';
  titleEl.textContent = event.title;

  const timeEl = document.createElement('div');
  timeEl.className = 'event-time';
  timeEl.textContent = `${formatTime(event.start_at)} – ${formatTime(event.end_at)}`;

  block.appendChild(titleEl);
  block.appendChild(timeEl);

  block.addEventListener('click', (e) => {
    e.stopPropagation();
    openEditModal(event);
  });

  return block;
}

function renderCurrentTimeLine() {
  const body = document.getElementById('days-body');
  if (!body) return;

  body.querySelectorAll('.current-time-line').forEach(el => el.remove());

  const now = new Date();
  const todayStr = localDateStr(now);
  const columns = body.querySelectorAll('.day-column');

  for (let di = 0; di < 7; di++) {
    if (columns[di].dataset.date === todayStr) {
      const minutes = now.getHours() * 60 + now.getMinutes();
      const line = document.createElement('div');
      line.className = 'current-time-line';
      line.style.top = minutesToPx(minutes) + 'px';
      columns[di].appendChild(line);
      break;
    }
  }
}

function render() {
  document.getElementById('week-label').textContent = formatWeekLabel(weekDays);
  renderDayHeaders();
  renderDaysBody();
  renderEvents();
  renderCurrentTimeLine();
}

// ===== Data Loading =====

/** Format a Date as a local ISO string without timezone offset */
function toLocalISOString(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

async function loadAndRender() {
  weekDays = getWeekDays(currentWeekStart);

  // Week range: Monday 00:00 to Sunday 23:59:59 local time
  const weekEnd = new Date(weekDays[6]);
  weekEnd.setHours(23, 59, 59, 999);

  const startISO = toLocalISOString(currentWeekStart);
  const endISO = toLocalISOString(weekEnd);

  try {
    events = await fetchEvents(startISO, endISO);
  } catch (err) {
    console.error('Failed to load events:', err);
    events = [];
  }

  render();
}

// ===== Navigation =====

document.getElementById('btn-prev').addEventListener('click', () => {
  currentWeekStart = new Date(currentWeekStart);
  currentWeekStart.setDate(currentWeekStart.getDate() - 7);
  loadAndRender();
});

document.getElementById('btn-next').addEventListener('click', () => {
  currentWeekStart = new Date(currentWeekStart);
  currentWeekStart.setDate(currentWeekStart.getDate() + 7);
  loadAndRender();
});

document.getElementById('btn-today').addEventListener('click', () => {
  currentWeekStart = getWeekStart(new Date());
  loadAndRender();
});

// ===== Drag to Create =====

function getMinutesFromY(col, clientY) {
  const rect = col.getBoundingClientRect();
  const y = clientY - rect.top;
  const rawMinutes = (y / HOUR_HEIGHT) * 60;
  // Snap to 15-minute intervals
  return Math.max(0, Math.min(1440, Math.round(rawMinutes / 15) * 15));
}

function onDayMouseDown(e) {
  if (e.button !== 0) return;
  if (e.target.closest('.event-block')) return;

  const col = e.currentTarget;
  const dateStr = col.dataset.date;
  const startMin = getMinutesFromY(col, e.clientY);

  // Create ghost element
  const ghost = document.createElement('div');
  ghost.className = 'drag-ghost';
  setGhostGeometry(ghost, startMin, startMin + 60);
  col.appendChild(ghost);

  dragState = { col, dateStr, startMin, endMin: startMin + 60, ghost };

  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('mouseup', onDragEnd);
  e.preventDefault();
}

function setGhostGeometry(ghost, startMin, endMin) {
  ghost.style.top = minutesToPx(startMin) + 'px';
  ghost.style.height = minutesToPx(Math.max(endMin - startMin, 15)) + 'px';
  ghost.style.left = '2px';
  ghost.style.right = '2px';
  ghost.style.width = 'auto';
}

function onDragMove(e) {
  if (!dragState) return;
  const currentMin = getMinutesFromY(dragState.col, e.clientY);
  const endMin = Math.max(currentMin, dragState.startMin + 15);
  dragState.endMin = endMin;
  setGhostGeometry(dragState.ghost, dragState.startMin, endMin);
}

function onDragEnd() {
  document.removeEventListener('mousemove', onDragMove);
  document.removeEventListener('mouseup', onDragEnd);
  if (!dragState) return;

  const { dateStr, startMin, endMin, ghost } = dragState;
  ghost.remove();
  dragState = null;

  // Build datetime strings from date + minutes
  const startDate = new Date(dateStr + 'T00:00:00');
  startDate.setMinutes(startMin);
  const endDate = new Date(dateStr + 'T00:00:00');
  endDate.setMinutes(endMin);

  openCreateModal(toDatetimeLocal(startDate), toDatetimeLocal(endDate));
}

// ===== Modal =====

function openCreateModal(startVal, endVal) {
  editingEventId = null;
  document.getElementById('modal-title').textContent = 'New Event';
  document.getElementById('field-title').value = '';
  document.getElementById('field-start').value = startVal || '';
  document.getElementById('field-end').value = endVal || '';
  document.getElementById('btn-delete').classList.add('hidden');
  hideFormError();
  document.getElementById('modal-overlay').classList.remove('hidden');
  setTimeout(() => document.getElementById('field-title').focus(), 50);
}

function openEditModal(event) {
  editingEventId = event.id;
  document.getElementById('modal-title').textContent = 'Edit Event';
  document.getElementById('field-title').value = event.title;
  // event.start_at is "YYYY-MM-DDTHH:MM:SS" — slice to "YYYY-MM-DDTHH:MM"
  document.getElementById('field-start').value = event.start_at.slice(0, 16);
  document.getElementById('field-end').value = event.end_at.slice(0, 16);
  document.getElementById('btn-delete').classList.remove('hidden');
  hideFormError();
  document.getElementById('modal-overlay').classList.remove('hidden');
  setTimeout(() => document.getElementById('field-title').focus(), 50);
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
  editingEventId = null;
}

function showFormError(msg) {
  const el = document.getElementById('form-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function hideFormError() {
  const el = document.getElementById('form-error');
  el.textContent = '';
  el.classList.add('hidden');
}

document.getElementById('btn-cancel').addEventListener('click', closeModal);

document.getElementById('modal-overlay').addEventListener('click', (e) => {
  if (e.target === document.getElementById('modal-overlay')) closeModal();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});

document.getElementById('event-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  hideFormError();

  const title = document.getElementById('field-title').value.trim();
  const startVal = document.getElementById('field-start').value; // "YYYY-MM-DDTHH:MM"
  const endVal = document.getElementById('field-end').value;

  if (!title) { showFormError('Title is required.'); return; }
  if (!startVal || !endVal) { showFormError('Start and end times are required.'); return; }

  // Validate locally
  const startDate = new Date(startVal);
  const endDate = new Date(endVal);
  if (endDate <= startDate) { showFormError('End time must be after start time.'); return; }

  // Send as local ISO strings (no Z) — the server stores them as-is
  const data = {
    title,
    start_at: startVal + ':00',   // "YYYY-MM-DDTHH:MM:SS"
    end_at: endVal + ':00',
  };

  try {
    if (editingEventId !== null) {
      await updateEvent(editingEventId, data);
    } else {
      await createEvent(data);
    }
    closeModal();
    await loadAndRender();
  } catch (err) {
    showFormError(err.message);
  }
});

document.getElementById('btn-delete').addEventListener('click', async () => {
  if (editingEventId === null) return;
  if (!confirm('Delete this event?')) return;
  try {
    await deleteEvent(editingEventId);
    closeModal();
    await loadAndRender();
  } catch (err) {
    showFormError(err.message);
  }
});

// ===== Scroll to business hours =====
function scrollToBusinessHours() {
  const scrollArea = document.getElementById('scroll-area');
  if (scrollArea) {
    // Support ?scrollTo=HH for testing
    const params = new URLSearchParams(window.location.search);
    const scrollTo = params.get('scrollTo');
    if (scrollTo === 'bottom') {
      scrollArea.scrollTop = TOTAL_HEIGHT;
    } else if (scrollTo) {
      scrollArea.scrollTop = minutesToPx(parseInt(scrollTo) * 60) - 20;
    } else {
      // Default: scroll to 7:00 AM
      scrollArea.scrollTop = minutesToPx(7 * 60) - 20;
    }
  }
}

// ===== Current time refresh =====
setInterval(() => {
  renderCurrentTimeLine();
}, 60000);

// ===== Initialize =====
async function init() {
  renderTimeAxis();
  await loadAndRender();
  // Use requestAnimationFrame to ensure DOM is painted before scrolling
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      scrollToBusinessHours();
    });
  });
}

init();
