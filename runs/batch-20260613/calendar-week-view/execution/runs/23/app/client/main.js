// ============================================================
// Constants
// ============================================================
const HOUR_HEIGHT = 60; // px per hour
const TOTAL_HOURS = 24;
const AXIS_HEIGHT = HOUR_HEIGHT * TOTAL_HOURS; // 1440px = 1px per minute
const API_BASE = '/api/events';

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                     'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ============================================================
// State
// ============================================================
let currentWeekStart = getMonday(new Date()); // Monday 00:00 local
let events = [];
let editingEvent = null; // null when creating, event object when editing

// Drag state (global since mousemove/mouseup are on document)
let dragState = null;

// ============================================================
// Date utilities
// ============================================================
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

function getWeekEnd(monday) {
  return addDays(monday, 7);
}

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}

function formatTime(d) {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function formatDateForInput(d) {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${mo}-${da}T${hh}:${mm}`;
}

function minutesFromMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

// ============================================================
// API
// ============================================================
async function fetchEvents(start, end) {
  const url = `${API_BASE}?start=${start.toISOString()}&end=${end.toISOString()}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('Failed to fetch events');
  return resp.json();
}

async function createEvent(data) {
  const resp = await fetch(API_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if (!resp.ok) {
    const err = await resp.json();
    throw new Error(err.error || 'Failed to create event');
  }
  return resp.json();
}

async function updateEvent(id, data) {
  const resp = await fetch(`${API_BASE}/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if (!resp.ok) {
    const err = await resp.json();
    throw new Error(err.error || 'Failed to update event');
  }
  return resp.json();
}

async function deleteEvent(id) {
  const resp = await fetch(`${API_BASE}/${id}`, {
    method: 'DELETE'
  });
  if (!resp.ok) {
    const err = await resp.json();
    throw new Error(err.error || 'Failed to delete event');
  }
  return resp.json();
}

// ============================================================
// Layout engine – cluster overlap algorithm
// ============================================================

/**
 * Given an array of event objects for a single day, compute layout info.
 * Each event gets: { event, top, height, left (fraction), width (fraction) }
 *
 * Algorithm:
 * 1. Sort by start time, then by longer events first (end desc).
 * 2. Group into clusters: maximal sets of transitively overlapping events.
 * 3. Within each cluster, greedily assign columns by start time.
 * 4. Width = 1 / numColumns, left = colIndex / numColumns.
 */
function computeLayout(dayEvents, dayDate) {
  if (dayEvents.length === 0) return [];

  const dayStart = new Date(dayDate);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayDate);
  dayEnd.setHours(0, 0, 0, 0);
  dayEnd.setDate(dayEnd.getDate() + 1); // next day midnight

  // Convert to working structures with clamped minutes
  const items = dayEvents.map(ev => {
    const startDt = new Date(ev.start_at);
    const endDt = new Date(ev.end_at);

    const clampedStart = startDt < dayStart ? dayStart : startDt;
    const clampedEnd = endDt > dayEnd ? dayEnd : endDt;

    const startMin = minutesFromMidnight(clampedStart);
    let endMin;
    if (clampedEnd.getTime() >= dayEnd.getTime()) {
      endMin = 1440;
    } else {
      endMin = minutesFromMidnight(clampedEnd);
    }

    // Ensure at least 1 minute height
    if (endMin <= startMin) endMin = startMin + 1;

    return { event: ev, startMin, endMin };
  });

  // Sort by start, then longer events first (end descending)
  items.sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);

  // Group into clusters of transitively overlapping events
  const clusters = [];
  let clusterItems = [items[0]];
  let clusterEnd = items[0].endMin;

  for (let i = 1; i < items.length; i++) {
    const item = items[i];
    if (item.startMin < clusterEnd) {
      // Overlaps with current cluster
      clusterItems.push(item);
      clusterEnd = Math.max(clusterEnd, item.endMin);
    } else {
      // New cluster
      clusters.push(clusterItems);
      clusterItems = [item];
      clusterEnd = item.endMin;
    }
  }
  clusters.push(clusterItems);

  // Layout each cluster independently
  const results = [];

  for (const cluster of clusters) {
    // Greedy column assignment
    // columns[c] = end time of last event placed in column c
    const columns = [];

    const assignments = cluster.map(item => {
      let col = -1;
      for (let c = 0; c < columns.length; c++) {
        if (columns[c] <= item.startMin) {
          col = c;
          break;
        }
      }
      if (col === -1) {
        col = columns.length;
        columns.push(0);
      }
      columns[col] = item.endMin;
      return { ...item, col };
    });

    const numCols = columns.length;

    for (const a of assignments) {
      const top = (a.startMin / 1440) * AXIS_HEIGHT;
      const height = ((a.endMin - a.startMin) / 1440) * AXIS_HEIGHT;
      const left = a.col / numCols;
      const width = 1 / numCols;

      results.push({
        event: a.event,
        top,
        height,
        left,   // fraction of day column width
        width   // fraction of day column width
      });
    }
  }

  return results;
}

// ============================================================
// Rendering
// ============================================================

function renderWeekTitle() {
  const weekEnd = addDays(currentWeekStart, 6);
  const startMonth = MONTH_NAMES[currentWeekStart.getMonth()];
  const endMonth = MONTH_NAMES[weekEnd.getMonth()];
  const startYear = currentWeekStart.getFullYear();
  const endYear = weekEnd.getFullYear();

  let title;
  if (startYear !== endYear) {
    title = `${startMonth} ${currentWeekStart.getDate()}, ${startYear} – ${endMonth} ${weekEnd.getDate()}, ${endYear}`;
  } else if (currentWeekStart.getMonth() !== weekEnd.getMonth()) {
    title = `${startMonth} ${currentWeekStart.getDate()} – ${endMonth} ${weekEnd.getDate()}, ${startYear}`;
  } else {
    title = `${startMonth} ${currentWeekStart.getDate()} – ${weekEnd.getDate()}, ${startYear}`;
  }

  document.getElementById('week-title').textContent = title;
}

function renderTimeGutter() {
  const gutter = document.getElementById('time-gutter');
  // Remove old labels
  gutter.querySelectorAll('.hour-label').forEach(el => el.remove());

  for (let h = 1; h < 24; h++) {
    const label = document.createElement('div');
    label.className = 'hour-label';
    // Position relative to the gutter content area (after the sticky header pseudo-element)
    label.style.top = `calc(var(--day-header-height) + ${h * HOUR_HEIGHT}px)`;
    label.textContent = `${String(h).padStart(2, '0')}:00`;
    gutter.appendChild(label);
  }
}

function renderGrid() {
  const container = document.getElementById('days-container');
  container.innerHTML = '';

  const today = new Date();

  for (let d = 0; d < 7; d++) {
    const dayDate = addDays(currentWeekStart, d);
    const isToday = isSameDay(dayDate, today);

    const col = document.createElement('div');
    col.className = 'day-column' + (isToday ? ' today' : '');
    col.dataset.dayIndex = d;

    // Header
    const header = document.createElement('div');
    header.className = 'day-header';

    const dayName = document.createElement('span');
    dayName.className = 'day-name';
    dayName.textContent = DAY_NAMES[d];

    const dayNum = document.createElement('span');
    dayNum.className = 'day-number' + (isToday ? ' today-number' : '');
    dayNum.textContent = dayDate.getDate();

    header.appendChild(dayName);
    header.appendChild(dayNum);
    col.appendChild(header);

    // Body (the time axis area)
    const body = document.createElement('div');
    body.className = 'day-body';
    body.dataset.dayIndex = d;
    body.dataset.date = dayDate.toISOString();

    // Hour lines
    for (let h = 0; h <= 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${h * HOUR_HEIGHT}px`;
      body.appendChild(line);

      if (h < 24) {
        const halfLine = document.createElement('div');
        halfLine.className = 'half-hour-line';
        halfLine.style.top = `${h * HOUR_HEIGHT + HOUR_HEIGHT / 2}px`;
        body.appendChild(halfLine);
      }
    }

    // Click area for creating events (behind event blocks)
    const clickArea = document.createElement('div');
    clickArea.className = 'day-body-click-area';
    clickArea.dataset.dayIndex = d;
    body.appendChild(clickArea);

    col.appendChild(body);
    container.appendChild(col);
  }
}

function renderEvents() {
  // Remove existing event blocks
  document.querySelectorAll('.event-block').forEach(el => el.remove());
  // Remove any lingering drag selections
  document.querySelectorAll('.drag-selection').forEach(el => el.remove());

  const weekStart = currentWeekStart;

  // Group events by day index
  const dayBuckets = new Map();
  for (let d = 0; d < 7; d++) {
    dayBuckets.set(d, []);
  }

  for (const ev of events) {
    const startDt = new Date(ev.start_at);
    const endDt = new Date(ev.end_at);

    for (let d = 0; d < 7; d++) {
      const dayStart = new Date(addDays(weekStart, d));
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1);

      if (startDt < dayEnd && endDt > dayStart) {
        dayBuckets.get(d).push(ev);
      }
    }
  }

  for (let d = 0; d < 7; d++) {
    const dayDate = addDays(weekStart, d);
    const dayEvents = dayBuckets.get(d);
    const layouts = computeLayout(dayEvents, dayDate);

    const dayBody = document.querySelector(`.day-body[data-day-index="${d}"]`);
    if (!dayBody) continue;

    for (const layout of layouts) {
      const block = document.createElement('div');
      block.className = 'event-block';
      block.dataset.eventId = layout.event.id;
      block.style.top = `${layout.top}px`;
      block.style.height = `${layout.height}px`;
      block.style.left = `calc(${layout.left * 100}% + 1px)`;
      block.style.width = `calc(${layout.width * 100}% - 3px)`;

      const titleEl = document.createElement('div');
      titleEl.className = 'event-title';
      titleEl.textContent = layout.event.title;

      const timeEl = document.createElement('div');
      timeEl.className = 'event-time';
      const sTime = formatTime(new Date(layout.event.start_at));
      const eTime = formatTime(new Date(layout.event.end_at));
      timeEl.textContent = `${sTime} – ${eTime}`;

      block.appendChild(titleEl);
      block.appendChild(timeEl);

      block.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditForm(layout.event);
      });

      dayBody.appendChild(block);
    }
  }
}

// ============================================================
// Click/drag to create events (single global handler)
// ============================================================
function yToMinutes(y) {
  const mins = (y / AXIS_HEIGHT) * 1440;
  // Snap to nearest 15 minutes
  return Math.max(0, Math.min(1440, Math.round(mins / 15) * 15));
}

function getDayDateFromBody(dayBody) {
  return new Date(dayBody.dataset.date);
}

document.addEventListener('mousedown', (e) => {
  // Only start drag on click areas
  const clickArea = e.target.closest('.day-body-click-area');
  if (!clickArea || e.button !== 0) return;

  const dayBody = clickArea.closest('.day-body');
  if (!dayBody) return;

  const rect = dayBody.getBoundingClientRect();
  const startY = e.clientY - rect.top;

  // Create selection element
  const selectionEl = document.createElement('div');
  selectionEl.className = 'drag-selection';
  selectionEl.style.top = `${Math.max(0, startY)}px`;
  selectionEl.style.height = '0px';
  dayBody.appendChild(selectionEl);

  dragState = {
    dayBody,
    startY,
    selectionEl,
    rect
  };

  e.preventDefault();
});

document.addEventListener('mousemove', (e) => {
  if (!dragState) return;

  const { dayBody, startY, selectionEl } = dragState;
  const rect = dayBody.getBoundingClientRect();
  const currentY = e.clientY - rect.top;

  const top = Math.max(0, Math.min(startY, currentY));
  const bottom = Math.min(AXIS_HEIGHT, Math.max(startY, currentY));

  selectionEl.style.top = `${top}px`;
  selectionEl.style.height = `${bottom - top}px`;
});

document.addEventListener('mouseup', (e) => {
  if (!dragState) return;

  const { dayBody, startY, selectionEl } = dragState;
  dragState = null;

  if (selectionEl.parentNode) {
    selectionEl.remove();
  }

  const rect = dayBody.getBoundingClientRect();
  const endY = e.clientY - rect.top;

  let minStart = yToMinutes(Math.min(startY, endY));
  let minEnd = yToMinutes(Math.max(startY, endY));

  // If it was a click (no drag), default to 1 hour
  if (minEnd - minStart < 15) {
    minEnd = Math.min(1440, minStart + 60);
    if (minEnd === 1440 && minStart > 1380) {
      minStart = 1380;
    }
  }

  const dayDate = getDayDateFromBody(dayBody);

  const startDt = new Date(dayDate);
  startDt.setHours(0, 0, 0, 0);
  startDt.setMinutes(minStart);

  const endDt = new Date(dayDate);
  endDt.setHours(0, 0, 0, 0);
  endDt.setMinutes(minEnd);

  openCreateForm(startDt, endDt);
});

// ============================================================
// Modal / Forms
// ============================================================
const modalOverlay = document.getElementById('modal-overlay');
const modalTitle = document.getElementById('modal-title');
const eventForm = document.getElementById('event-form');
const inputTitle = document.getElementById('input-title');
const inputStart = document.getElementById('input-start');
const inputEnd = document.getElementById('input-end');
const formError = document.getElementById('form-error');
const btnDelete = document.getElementById('btn-delete');
const btnCancel = document.getElementById('btn-cancel');

function showModal() {
  modalOverlay.classList.remove('hidden');
  formError.classList.add('hidden');
  formError.textContent = '';
}

function hideModal() {
  modalOverlay.classList.add('hidden');
  editingEvent = null;
}

function openCreateForm(startDt, endDt) {
  editingEvent = null;
  modalTitle.textContent = 'Create Event';
  inputTitle.value = '';
  inputStart.value = formatDateForInput(startDt);
  inputEnd.value = formatDateForInput(endDt);
  btnDelete.classList.add('hidden');
  showModal();
  inputTitle.focus();
}

function openEditForm(ev) {
  editingEvent = ev;
  modalTitle.textContent = 'Edit Event';
  inputTitle.value = ev.title;
  inputStart.value = formatDateForInput(new Date(ev.start_at));
  inputEnd.value = formatDateForInput(new Date(ev.end_at));
  btnDelete.classList.remove('hidden');
  showModal();
  inputTitle.focus();
}

eventForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  formError.classList.add('hidden');

  const title = inputTitle.value.trim();
  const startVal = inputStart.value;
  const endVal = inputEnd.value;

  if (!title) {
    formError.textContent = 'Title is required.';
    formError.classList.remove('hidden');
    return;
  }

  if (!startVal || !endVal) {
    formError.textContent = 'Start and end times are required.';
    formError.classList.remove('hidden');
    return;
  }

  const startDate = new Date(startVal);
  const endDate = new Date(endVal);

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    formError.textContent = 'Invalid date format.';
    formError.classList.remove('hidden');
    return;
  }

  if (endDate <= startDate) {
    formError.textContent = 'End time must be after start time.';
    formError.classList.remove('hidden');
    return;
  }

  const start_at = startDate.toISOString();
  const end_at = endDate.toISOString();

  try {
    if (editingEvent) {
      await updateEvent(editingEvent.id, { title, start_at, end_at });
    } else {
      await createEvent({ title, start_at, end_at });
    }
    hideModal();
    await loadEvents();
  } catch (err) {
    formError.textContent = err.message;
    formError.classList.remove('hidden');
  }
});

btnDelete.addEventListener('click', async () => {
  if (!editingEvent) return;
  if (!confirm('Delete this event?')) return;

  try {
    await deleteEvent(editingEvent.id);
    hideModal();
    await loadEvents();
  } catch (err) {
    formError.textContent = err.message;
    formError.classList.remove('hidden');
  }
});

btnCancel.addEventListener('click', () => {
  hideModal();
});

modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) {
    hideModal();
  }
});

// ============================================================
// Navigation
// ============================================================
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

// ============================================================
// Main render cycle
// ============================================================
async function loadEvents() {
  const weekEnd = getWeekEnd(currentWeekStart);
  events = await fetchEvents(currentWeekStart, weekEnd);
  renderEvents();
}

async function renderWeek() {
  renderWeekTitle();
  renderGrid();
  renderTimeGutter();
  await loadEvents();

  // Scroll to ~7am on initial load
  const container = document.getElementById('calendar-container');
  container.scrollTop = 7 * HOUR_HEIGHT + 50; // +50 for day header
}

// Initial render
renderWeek();
