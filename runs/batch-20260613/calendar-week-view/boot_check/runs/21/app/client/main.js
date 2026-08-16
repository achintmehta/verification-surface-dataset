// ─── Configuration ──────────────────────────────────────────────
const API_BASE = '/api/events';
const HOUR_HEIGHT = 60; // px per hour, must match CSS --hour-height
const AXIS_HEIGHT = 24 * HOUR_HEIGHT; // total height of day body
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ─── State ──────────────────────────────────────────────────────
let currentWeekStart = getMonday(new Date());
let events = [];

// ─── Date Helpers ───────────────────────────────────────────────
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

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatTime(d) {
  return d.toTimeString().slice(0, 5);
}

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}

function minutesFromMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

function minutesToPx(mins) {
  return (mins / 60) * HOUR_HEIGHT;
}

// ─── API ────────────────────────────────────────────────────────
async function fetchEvents(startDate, endDate) {
  const res = await fetch(`${API_BASE}?start=${startDate.toISOString()}&end=${endDate.toISOString()}`);
  if (!res.ok) throw new Error('Failed to fetch events');
  return res.json();
}

async function createEvent(data) {
  const res = await fetch(API_BASE, {
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
  const res = await fetch(`${API_BASE}/${id}`, {
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
  const res = await fetch(`${API_BASE}/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to delete event');
  }
  return res.json();
}

// ─── Overlap Layout Engine ──────────────────────────────────────

/**
 * Given an array of events for a single day, each with:
 *   { id, title, startMin, endMin }   (minutes from midnight, clamped 0-1440)
 * Returns the same events augmented with:
 *   { col, totalCols }
 */
function layoutEventsForDay(dayEvents) {
  if (dayEvents.length === 0) return [];

  // Sort by start time, then by end time descending (longer events first)
  const sorted = [...dayEvents].sort((a, b) => {
    if (a.startMin !== b.startMin) return a.startMin - b.startMin;
    return b.endMin - a.endMin;
  });

  // Step 1: Build overlap clusters (maximal sets of transitively overlapping events)
  const clusters = [];
  let cluster = [sorted[0]];

  let clusterEnd = sorted[0].endMin;

  for (let i = 1; i < sorted.length; i++) {
    const ev = sorted[i];
    if (ev.startMin < clusterEnd) {
      // Overlaps with current cluster
      cluster.push(ev);
      clusterEnd = Math.max(clusterEnd, ev.endMin);
    } else {
      clusters.push(cluster);
      cluster = [ev];
      clusterEnd = ev.endMin;
    }
  }
  clusters.push(cluster);

  // Step 2: For each cluster, greedily assign columns
  for (const cluster of clusters) {
    // columns[i] = end time of the last event placed in column i
    const columns = [];

    for (const ev of cluster) {
      let placed = false;
      for (let c = 0; c < columns.length; c++) {
        if (columns[c] <= ev.startMin) {
          ev.col = c;
          columns[c] = ev.endMin;
          placed = true;
          break;
        }
      }
      if (!placed) {
        ev.col = columns.length;
        columns.push(ev.endMin);
      }
    }

    const totalCols = columns.length;
    for (const ev of cluster) {
      ev.totalCols = totalCols;
    }
  }

  return sorted;
}

// ─── Rendering ──────────────────────────────────────────────────

function buildTimeGutter() {
  const gutter = document.getElementById('time-gutter');
  gutter.innerHTML = '';

  // We need a spacer for the header area
  const spacer = document.createElement('div');
  spacer.style.height = 'var(--header-height)';
  // Time labels are absolute positioned relative to gutter

  for (let h = 0; h <= 24; h++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    const top = h * HOUR_HEIGHT + 50; // 50px = header height
    label.style.top = `${top}px`;
    label.textContent = `${String(h).padStart(2, '0')}:00`;
    gutter.appendChild(label);
  }

  // Set gutter total height
  gutter.style.height = `${AXIS_HEIGHT + 50}px`;
}

function buildWeekGrid() {
  const grid = document.getElementById('week-grid');
  grid.innerHTML = '';

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let d = 0; d < 7; d++) {
    const dayDate = addDays(currentWeekStart, d);
    const isToday = isSameDay(dayDate, today);

    const col = document.createElement('div');
    col.className = 'day-column' + (isToday ? ' today' : '');
    col.dataset.dayIndex = d;
    col.dataset.date = formatDate(dayDate);

    // Header
    const header = document.createElement('div');
    header.className = 'day-header' + (isToday ? ' today' : '');

    const dayName = document.createElement('span');
    dayName.className = 'day-name';
    dayName.textContent = DAY_NAMES[d];

    const dayNum = document.createElement('span');
    dayNum.className = 'day-number';
    dayNum.textContent = dayDate.getDate();

    header.appendChild(dayName);
    header.appendChild(dayNum);
    col.appendChild(header);

    // Body
    const body = document.createElement('div');
    body.className = 'day-body';
    body.dataset.date = formatDate(dayDate);

    // Hour lines
    for (let h = 0; h < 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${h * HOUR_HEIGHT}px`;
      body.appendChild(line);
    }
    // Bottom line at 24:00
    const bottomLine = document.createElement('div');
    bottomLine.className = 'hour-line';
    bottomLine.style.top = `${24 * HOUR_HEIGHT}px`;
    body.appendChild(bottomLine);

    // Click area for creating events
    const clickArea = document.createElement('div');
    clickArea.className = 'day-body-clickarea';
    setupDragToCreate(clickArea, body, dayDate);
    body.appendChild(clickArea);

    col.appendChild(body);
    grid.appendChild(col);
  }
}

function renderEvents() {
  // Clear existing event blocks
  document.querySelectorAll('.event-block').forEach(el => el.remove());

  // Group events by day
  const weekEnd = addDays(currentWeekStart, 7);
  const byDay = new Map();

  for (let d = 0; d < 7; d++) {
    byDay.set(d, []);
  }

  for (const ev of events) {
    const start = new Date(ev.start_at);
    const end = new Date(ev.end_at);

    // An event could span multiple days in theory, but we only render it on the day
    // it starts (since multi-day events are not in scope, but we handle edge cases)
    for (let d = 0; d < 7; d++) {
      const dayStart = addDays(currentWeekStart, d);
      const dayEnd = addDays(currentWeekStart, d + 1);

      // Does event overlap this day?
      if (start < dayEnd && end > dayStart) {
        // Clamp to day boundaries
        const clampedStart = start < dayStart ? dayStart : start;
        const clampedEnd = end > dayEnd ? dayEnd : end;

        const startMin = minutesFromMidnight(clampedStart);
        const endMin = clampedEnd >= dayEnd ? 1440 : minutesFromMidnight(clampedEnd);

        byDay.get(d).push({
          id: ev.id,
          title: ev.title,
          startMin: startMin,
          endMin: endMin === startMin ? startMin + 1 : endMin, // ensure visual height
          origStart: start,
          origEnd: end
        });
      }
    }
  }

  // Layout and render each day
  for (let d = 0; d < 7; d++) {
    const dayEvents = byDay.get(d);
    const laid = layoutEventsForDay(dayEvents);

    const body = document.querySelectorAll('.day-body')[d];
    if (!body) continue;

    for (const ev of laid) {
      const block = document.createElement('div');
      block.className = 'event-block';

      const top = minutesToPx(ev.startMin);
      const height = Math.max(minutesToPx(ev.endMin - ev.startMin), 2);
      const widthPct = 100 / ev.totalCols;
      const leftPct = ev.col * widthPct;

      block.style.top = `${top}px`;
      block.style.height = `${height}px`;
      block.style.left = `${leftPct}%`;
      block.style.width = `calc(${widthPct}% - 2px)`;

      const titleEl = document.createElement('div');
      titleEl.className = 'event-title';
      titleEl.textContent = ev.title;

      const timeEl = document.createElement('div');
      timeEl.className = 'event-time';
      timeEl.textContent = `${formatTime(ev.origStart)} – ${formatTime(ev.origEnd)}`;

      block.appendChild(titleEl);
      block.appendChild(timeEl);

      block.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditForm(ev.id);
      });

      body.appendChild(block);
    }
  }
}

// ─── Drag to Create ─────────────────────────────────────────────

function setupDragToCreate(clickArea, dayBody, dayDate) {
  let isDragging = false;
  let startY = 0;
  let selectionEl = null;

  function yToMinutes(y) {
    // Snap to 15-minute intervals
    const raw = (y / HOUR_HEIGHT) * 60;
    return Math.round(raw / 15) * 15;
  }

  clickArea.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    isDragging = true;
    const rect = dayBody.getBoundingClientRect();
    startY = e.clientY - rect.top;

    selectionEl = document.createElement('div');
    selectionEl.className = 'drag-selection';
    selectionEl.style.top = `${startY}px`;
    selectionEl.style.height = '0px';
    dayBody.appendChild(selectionEl);

    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging || !selectionEl) return;
    const rect = dayBody.getBoundingClientRect();
    const currentY = Math.max(0, Math.min(e.clientY - rect.top, AXIS_HEIGHT));
    const top = Math.min(startY, currentY);
    const height = Math.abs(currentY - startY);
    selectionEl.style.top = `${top}px`;
    selectionEl.style.height = `${height}px`;
  });

  document.addEventListener('mouseup', (e) => {
    if (!isDragging) return;
    isDragging = false;

    const rect = dayBody.getBoundingClientRect();
    const endY = Math.max(0, Math.min(e.clientY - rect.top, AXIS_HEIGHT));

    const minY = Math.min(startY, endY);
    const maxY = Math.max(startY, endY);

    let startMin = yToMinutes(minY);
    let endMin = yToMinutes(maxY);

    // If it was a click (no drag), create a 1-hour event
    if (endMin - startMin < 15) {
      endMin = Math.min(startMin + 60, 1440);
    }

    // Clamp
    startMin = Math.max(0, Math.min(startMin, 1440));
    endMin = Math.max(0, Math.min(endMin, 1440));

    if (startMin >= endMin) {
      endMin = Math.min(startMin + 60, 1440);
    }

    if (selectionEl) {
      selectionEl.remove();
      selectionEl = null;
    }

    // Open create form
    const startH = String(Math.floor(startMin / 60)).padStart(2, '0');
    const startM = String(startMin % 60).padStart(2, '0');
    const endH = String(Math.floor(endMin / 60)).padStart(2, '0');
    const endM = String(endMin % 60).padStart(2, '0');

    openCreateForm(formatDate(dayDate), `${startH}:${startM}`, `${endH}:${endM}`);
  });
}

// ─── Modal / Form ───────────────────────────────────────────────

let editingEventId = null;

function openCreateForm(date, startTime, endTime) {
  editingEventId = null;
  document.getElementById('modal-title').textContent = 'Create Event';
  document.getElementById('event-title').value = '';
  document.getElementById('event-date').value = date;
  document.getElementById('event-start').value = startTime;
  document.getElementById('event-end').value = endTime;
  document.getElementById('btn-delete').style.display = 'none';
  document.getElementById('form-error').style.display = 'none';
  document.getElementById('modal-overlay').style.display = 'flex';
  document.getElementById('event-title').focus();
}

function openEditForm(eventId) {
  const ev = events.find(e => e.id === eventId);
  if (!ev) return;

  editingEventId = eventId;
  const start = new Date(ev.start_at);
  const end = new Date(ev.end_at);

  document.getElementById('modal-title').textContent = 'Edit Event';
  document.getElementById('event-title').value = ev.title;
  document.getElementById('event-date').value = formatDate(start);
  document.getElementById('event-start').value = formatTime(start);
  document.getElementById('event-end').value = formatTime(end);
  document.getElementById('btn-delete').style.display = 'inline-block';
  document.getElementById('form-error').style.display = 'none';
  document.getElementById('modal-overlay').style.display = 'flex';
  document.getElementById('event-title').focus();
}

function closeModal() {
  document.getElementById('modal-overlay').style.display = 'none';
  editingEventId = null;
}

function showFormError(msg) {
  const el = document.getElementById('form-error');
  el.textContent = msg;
  el.style.display = 'block';
}

// ─── Week Navigation ────────────────────────────────────────────

function updateWeekTitle() {
  const end = addDays(currentWeekStart, 6);
  const opts = { month: 'short', day: 'numeric', year: 'numeric' };
  document.getElementById('week-title').textContent =
    `${currentWeekStart.toLocaleDateString(undefined, opts)} – ${end.toLocaleDateString(undefined, opts)}`;
}

async function loadWeek() {
  const weekEnd = addDays(currentWeekStart, 7);
  updateWeekTitle();
  buildWeekGrid();

  try {
    events = await fetchEvents(currentWeekStart, weekEnd);
  } catch (err) {
    console.error('Error loading events:', err);
    events = [];
  }

  renderEvents();
}

// ─── Init ───────────────────────────────────────────────────────

function init() {
  buildTimeGutter();
  loadWeek();

  // Navigation
  document.getElementById('btn-prev').addEventListener('click', () => {
    currentWeekStart = addDays(currentWeekStart, -7);
    loadWeek();
  });

  document.getElementById('btn-next').addEventListener('click', () => {
    currentWeekStart = addDays(currentWeekStart, 7);
    loadWeek();
  });

  document.getElementById('btn-today').addEventListener('click', () => {
    currentWeekStart = getMonday(new Date());
    loadWeek();
  });

  // Modal handlers
  document.getElementById('btn-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });

  // Form submit
  document.getElementById('event-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = document.getElementById('event-title').value.trim();
    const date = document.getElementById('event-date').value;
    const startTime = document.getElementById('event-start').value;
    const endTime = document.getElementById('event-end').value;

    if (!title) {
      showFormError('Title is required');
      return;
    }
    if (!date || !startTime || !endTime) {
      showFormError('All fields are required');
      return;
    }

    const start_at = new Date(`${date}T${startTime}:00`).toISOString();
    const end_at = new Date(`${date}T${endTime}:00`).toISOString();

    if (new Date(end_at) <= new Date(start_at)) {
      showFormError('End time must be after start time');
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
      showFormError(err.message);
    }
  });

  // Delete
  document.getElementById('btn-delete').addEventListener('click', async () => {
    if (!editingEventId) return;
    try {
      await deleteEvent(editingEventId);
      closeModal();
      await loadWeek();
    } catch (err) {
      showFormError(err.message);
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
