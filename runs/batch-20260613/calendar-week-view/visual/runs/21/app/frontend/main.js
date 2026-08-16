const API_BASE = '/api';

// Constants
const HOUR_HEIGHT = 60; // px per hour
const TOTAL_HOURS = 24;
const AXIS_HEIGHT = HOUR_HEIGHT * TOTAL_HOURS; // 1440px

// State
let currentWeekStart = getMonday(new Date());
let events = [];
let editingEventId = null;

// Drag state (global, one drag at a time)
let dragState = null; // { dayBody, dayDate, startY, selectionEl }

// DOM references
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
const btnDelete = document.getElementById('btn-delete');
const btnCancel = document.getElementById('btn-cancel');
const btnPrev = document.getElementById('btn-prev');
const btnToday = document.getElementById('btn-today');
const btnNext = document.getElementById('btn-next');

// ────────────────────────────────────────────────
// Date helpers
// ────────────────────────────────────────────────

function getMonday(d) {
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  return date;
}

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function formatWeekTitle(start) {
  const end = addDays(start, 6);
  const startStr = start.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  const endStr = end.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  return `${startStr} – ${endStr}`;
}

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth() === b.getMonth() &&
         a.getDate() === b.getDate();
}

function dayStartOf(d) {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}

/** Minutes from midnight of dayDate for a given date, clamped to [0, 1440] */
function minutesFromMidnight(date, dayDate) {
  const dayStart = dayStartOf(dayDate);
  const diffMs = date.getTime() - dayStart.getTime();
  const mins = diffMs / 60000;
  return Math.max(0, Math.min(TOTAL_HOURS * 60, mins));
}

function minutesToTimeStr(mins) {
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Format a Date as a local datetime-local input value */
function toLocalISOString(date) {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  return `${y}-${mo}-${d}T${h}:${mi}`;
}

// ────────────────────────────────────────────────
// API
// ────────────────────────────────────────────────

async function fetchEvents(start, end) {
  const url = `${API_BASE}/events?start=${start.toISOString()}&end=${end.toISOString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to fetch events');
  return res.json();
}

async function createEvent(data) {
  const res = await fetch(`${API_BASE}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to create event');
  }
  return res.json();
}

async function updateEvent(id, data) {
  const res = await fetch(`${API_BASE}/events/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to update event');
  }
  return res.json();
}

async function deleteEvent(id) {
  const res = await fetch(`${API_BASE}/events/${id}`, {
    method: 'DELETE'
  });
  if (!res.ok) throw new Error('Failed to delete event');
  return res.json();
}

// ────────────────────────────────────────────────
// Overlap layout algorithm
// ────────────────────────────────────────────────

/**
 * Compute layout for events on a single day.
 * Returns array of { event, column, totalColumns, top, height }
 *
 * Algorithm:
 * 1. Sort by start time, then by duration desc (longer events first when tied)
 * 2. Group into clusters of transitively overlapping events
 * 3. Greedily assign columns within each cluster
 * 4. Width = 1/totalColumns, offset = column * width
 */
function computeDayLayout(dayEvents, dayDate) {
  if (dayEvents.length === 0) return [];

  const dayStart = dayStartOf(dayDate);
  const dayEndMs = dayStart.getTime() + TOTAL_HOURS * 60 * 60000;

  const items = dayEvents.map(ev => {
    const evStart = new Date(ev.start_at);
    const evEnd = new Date(ev.end_at);

    // Clamp to this day's boundaries
    const clampedStart = new Date(Math.max(evStart.getTime(), dayStart.getTime()));
    const clampedEnd = new Date(Math.min(evEnd.getTime(), dayEndMs));

    const startMins = (clampedStart.getTime() - dayStart.getTime()) / 60000;
    const endMins = (clampedEnd.getTime() - dayStart.getTime()) / 60000;

    const top = (startMins / (TOTAL_HOURS * 60)) * AXIS_HEIGHT;
    const height = Math.max(((endMins - startMins) / (TOTAL_HOURS * 60)) * AXIS_HEIGHT, 2);

    return { event: ev, startMins, endMins, top, height };
  });

  // Sort: earliest start first, then longest duration first
  items.sort((a, b) => {
    if (a.startMins !== b.startMins) return a.startMins - b.startMins;
    return b.endMins - a.endMins;
  });

  // Build clusters of transitively overlapping events
  const clusters = [];
  let cluster = [items[0]];
  let clusterEnd = items[0].endMins;

  for (let i = 1; i < items.length; i++) {
    if (items[i].startMins < clusterEnd) {
      cluster.push(items[i]);
      clusterEnd = Math.max(clusterEnd, items[i].endMins);
    } else {
      clusters.push(cluster);
      cluster = [items[i]];
      clusterEnd = items[i].endMins;
    }
  }
  clusters.push(cluster);

  // Assign columns within each cluster
  const results = [];
  for (const cluster of clusters) {
    const columnEnds = []; // columnEnds[c] = endMins of last event in column c

    for (const item of cluster) {
      let placed = false;
      for (let c = 0; c < columnEnds.length; c++) {
        if (item.startMins >= columnEnds[c]) {
          columnEnds[c] = item.endMins;
          item.column = c;
          placed = true;
          break;
        }
      }
      if (!placed) {
        item.column = columnEnds.length;
        columnEnds.push(item.endMins);
      }
    }

    const totalColumns = columnEnds.length;
    for (const item of cluster) {
      item.totalColumns = totalColumns;
      results.push(item);
    }
  }

  return results;
}

// ────────────────────────────────────────────────
// Rendering
// ────────────────────────────────────────────────

function renderTimeGutter() {
  timeGutterEl.innerHTML = '';

  // Sticky header spacer
  const spacer = document.createElement('div');
  spacer.className = 'time-gutter-header';
  timeGutterEl.appendChild(spacer);

  // Hour labels container
  const body = document.createElement('div');
  body.style.position = 'relative';
  body.style.height = AXIS_HEIGHT + 'px';

  for (let h = 0; h <= 24; h++) {
    const label = document.createElement('div');
    label.className = 'hour-label';
    label.style.top = (h * HOUR_HEIGHT) + 'px';
    label.textContent = h === 0 ? '' : `${String(h).padStart(2, '0')}:00`;
    body.appendChild(label);
  }

  timeGutterEl.appendChild(body);
}

function renderDayColumns() {
  daysContainerEl.innerHTML = '';

  const today = new Date();
  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  for (let i = 0; i < 7; i++) {
    const dayDate = addDays(currentWeekStart, i);
    const isToday = isSameDay(dayDate, today);

    const col = document.createElement('div');
    col.className = 'day-column' + (isToday ? ' today' : '');
    col.dataset.dayIndex = i;

    // Header
    const header = document.createElement('div');
    header.className = 'day-header';

    const dayName = document.createElement('span');
    dayName.className = 'day-name';
    dayName.textContent = dayNames[i];

    const dayNumber = document.createElement('span');
    dayNumber.className = 'day-number';
    dayNumber.textContent = dayDate.getDate();

    header.appendChild(dayName);
    header.appendChild(dayNumber);
    col.appendChild(header);

    // Body with hour lines
    const body = document.createElement('div');
    body.className = 'day-body';
    body.dataset.dayIndex = i;

    for (let h = 0; h < 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line' + (h === 0 ? ' major' : '');
      line.style.top = (h * HOUR_HEIGHT) + 'px';
      body.appendChild(line);
    }
    // Bottom line at 24:00
    const bottomLine = document.createElement('div');
    bottomLine.className = 'hour-line major';
    bottomLine.style.top = AXIS_HEIGHT + 'px';
    body.appendChild(bottomLine);

    // Mousedown for drag-to-create (per-column)
    body.addEventListener('mousedown', (e) => {
      if (e.target.closest('.event-block')) return;
      if (e.button !== 0) return;
      e.preventDefault();

      const selectionEl = document.createElement('div');
      selectionEl.className = 'selection-highlight';
      body.appendChild(selectionEl);

      const startMins = yToMinutes(e.clientY, body);
      const topPx = (startMins / (TOTAL_HOURS * 60)) * AXIS_HEIGHT;
      selectionEl.style.top = topPx + 'px';
      selectionEl.style.height = '0px';

      dragState = {
        dayBody: body,
        dayDate: new Date(dayDate),
        startY: e.clientY,
        selectionEl
      };
    });

    col.appendChild(body);
    daysContainerEl.appendChild(col);
  }
}

/** Convert a clientY position to snapped minutes from midnight */
function yToMinutes(clientY, dayBody) {
  const rect = dayBody.getBoundingClientRect();
  const relY = Math.max(0, Math.min(clientY - rect.top, AXIS_HEIGHT));
  const mins = (relY / AXIS_HEIGHT) * TOTAL_HOURS * 60;
  return Math.round(mins / 15) * 15;
}

// Global mousemove / mouseup for drag-to-create
document.addEventListener('mousemove', (e) => {
  if (!dragState) return;
  const { dayBody, startY, selectionEl } = dragState;

  const startMins = yToMinutes(startY, dayBody);
  const currentMins = yToMinutes(e.clientY, dayBody);

  const minMins = Math.min(startMins, currentMins);
  const maxMins = Math.max(startMins, currentMins);

  const topPx = (minMins / (TOTAL_HOURS * 60)) * AXIS_HEIGHT;
  const heightPx = ((maxMins - minMins) / (TOTAL_HOURS * 60)) * AXIS_HEIGHT;

  selectionEl.style.top = topPx + 'px';
  selectionEl.style.height = heightPx + 'px';
});

document.addEventListener('mouseup', (e) => {
  if (!dragState) return;
  const { dayBody, dayDate, startY, selectionEl } = dragState;
  dragState = null;

  selectionEl.remove();

  const startMins = yToMinutes(startY, dayBody);
  const endMins = yToMinutes(e.clientY, dayBody);

  let fromMins = Math.min(startMins, endMins);
  let toMins = Math.max(startMins, endMins);

  // If just a click, default to 1 hour
  if (fromMins === toMins) {
    toMins = Math.min(fromMins + 60, TOTAL_HOURS * 60);
  }

  const startDate = new Date(dayDate);
  startDate.setHours(0, 0, 0, 0);
  startDate.setMinutes(fromMins);

  const endDate = new Date(dayDate);
  endDate.setHours(0, 0, 0, 0);
  endDate.setMinutes(toMins);

  openCreateModal(startDate, endDate);
});

function renderEvents() {
  // Clear existing event blocks
  document.querySelectorAll('.event-block').forEach(el => el.remove());

  for (let i = 0; i < 7; i++) {
    const dayDate = addDays(currentWeekStart, i);
    const dayStart = dayStartOf(dayDate);
    const dayEndMs = dayStart.getTime() + TOTAL_HOURS * 60 * 60000;

    // Filter events that fall on this day
    const dayEvents = events.filter(ev => {
      const evStart = new Date(ev.start_at).getTime();
      const evEnd = new Date(ev.end_at).getTime();
      return evStart < dayEndMs && evEnd > dayStart.getTime();
    });

    const layoutItems = computeDayLayout(dayEvents, dayDate);
    const dayBody = document.querySelector(`.day-body[data-day-index="${i}"]`);
    if (!dayBody) continue;

    for (const item of layoutItems) {
      const block = document.createElement('div');
      block.className = 'event-block';
      block.style.top = item.top + 'px';
      block.style.height = item.height + 'px';

      const widthPercent = 100 / item.totalColumns;
      const leftPercent = item.column * widthPercent;
      block.style.left = leftPercent + '%';
      block.style.width = `calc(${widthPercent}% - 2px)`;

      const titleEl = document.createElement('div');
      titleEl.className = 'event-title';
      titleEl.textContent = item.event.title;

      const evStart = new Date(item.event.start_at);
      const evEnd = new Date(item.event.end_at);
      const timeEl = document.createElement('div');
      timeEl.className = 'event-time';
      const startTimeStr = minutesToTimeStr(minutesFromMidnight(evStart, dayDate));
      const endTimeStr = minutesToTimeStr(minutesFromMidnight(evEnd, dayDate));
      timeEl.textContent = `${startTimeStr} – ${endTimeStr}`;

      block.appendChild(titleEl);
      block.appendChild(timeEl);

      block.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditModal(item.event);
      });

      dayBody.appendChild(block);
    }
  }
}

// ────────────────────────────────────────────────
// Modal
// ────────────────────────────────────────────────

function openCreateModal(startDate, endDate) {
  editingEventId = null;
  modalTitle.textContent = 'Create Event';
  btnDelete.style.display = 'none';
  formError.textContent = '';

  eventTitleInput.value = '';
  eventStartInput.value = toLocalISOString(startDate);
  eventEndInput.value = toLocalISOString(endDate);

  modalOverlay.classList.add('active');
  eventTitleInput.focus();
}

function openEditModal(event) {
  editingEventId = event.id;
  modalTitle.textContent = 'Edit Event';
  btnDelete.style.display = 'inline-block';
  formError.textContent = '';

  eventTitleInput.value = event.title;
  eventStartInput.value = toLocalISOString(new Date(event.start_at));
  eventEndInput.value = toLocalISOString(new Date(event.end_at));

  modalOverlay.classList.add('active');
  eventTitleInput.focus();
}

function closeModal() {
  modalOverlay.classList.remove('active');
  editingEventId = null;
  formError.textContent = '';
}

// ────────────────────────────────────────────────
// Form handlers
// ────────────────────────────────────────────────

eventForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  formError.textContent = '';

  const title = eventTitleInput.value.trim();
  const startVal = eventStartInput.value;
  const endVal = eventEndInput.value;

  if (!title) {
    formError.textContent = 'Title is required';
    return;
  }

  if (!startVal || !endVal) {
    formError.textContent = 'Start and end times are required';
    return;
  }

  const start_at = new Date(startVal).toISOString();
  const end_at = new Date(endVal).toISOString();

  if (new Date(end_at) <= new Date(start_at)) {
    formError.textContent = 'End time must be after start time';
    return;
  }

  try {
    if (editingEventId) {
      await updateEvent(editingEventId, { title, start_at, end_at });
    } else {
      await createEvent({ title, start_at, end_at });
    }
    closeModal();
    await loadWeek();
  } catch (err) {
    formError.textContent = err.message;
  }
});

btnDelete.addEventListener('click', async () => {
  if (!editingEventId) return;
  try {
    await deleteEvent(editingEventId);
    closeModal();
    await loadWeek();
  } catch (err) {
    formError.textContent = err.message;
  }
});

btnCancel.addEventListener('click', closeModal);

modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeModal();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modalOverlay.classList.contains('active')) {
    closeModal();
  }
});

// ────────────────────────────────────────────────
// Navigation
// ────────────────────────────────────────────────

btnPrev.addEventListener('click', () => {
  currentWeekStart = addDays(currentWeekStart, -7);
  loadWeek();
});

btnToday.addEventListener('click', () => {
  currentWeekStart = getMonday(new Date());
  loadWeek();
});

btnNext.addEventListener('click', () => {
  currentWeekStart = addDays(currentWeekStart, 7);
  loadWeek();
});

// ────────────────────────────────────────────────
// Load week
// ────────────────────────────────────────────────

async function loadWeek() {
  weekTitleEl.textContent = formatWeekTitle(currentWeekStart);
  const weekEnd = addDays(currentWeekStart, 7);

  renderDayColumns();

  try {
    events = await fetchEvents(currentWeekStart, weekEnd);
  } catch (err) {
    console.error('Failed to load events:', err);
    events = [];
  }

  renderEvents();
}

// ────────────────────────────────────────────────
// Init
// ────────────────────────────────────────────────

renderTimeGutter();
loadWeek().then(() => {
  // Auto-scroll to ~8:00am area on initial load
  const container = document.querySelector('.calendar-container');
  if (container) {
    const scrollTo = 8 * HOUR_HEIGHT; // 8:00am
    container.scrollTop = scrollTo;
  }
});
