// ============================================================
// Calendar Week View - Main Application
// ============================================================

const API_BASE = '/api/events';
const HOUR_HEIGHT = 60; // px per hour, must match CSS --hour-height
const TOTAL_MINUTES = 24 * 60;
const AXIS_HEIGHT = HOUR_HEIGHT * 24; // 1440px

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const FULL_DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// ============================================================
// State
// ============================================================
let currentWeekStart = getMonday(new Date()); // Always a Monday at 00:00
let events = []; // Events for the current week

// ============================================================
// Date Utilities
// ============================================================

function getMonday(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0=Sun, 1=Mon...
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatISO(date) {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  return `${y}-${mo}-${d}T${h}:${mi}`;
}

function formatTimeShort(date) {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}

function parseDateLocal(str) {
  // Parse "YYYY-MM-DDTHH:MM:SS" or "YYYY-MM-DDTHH:MM" as local time
  const parts = str.split('T');
  const [y, m, d] = parts[0].split('-').map(Number);
  const timeParts = parts[1] ? parts[1].split(':').map(Number) : [0, 0, 0];
  return new Date(y, m - 1, d, timeParts[0] || 0, timeParts[1] || 0, timeParts[2] || 0);
}

function minutesFromMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

// ============================================================
// API
// ============================================================

async function fetchEvents(weekStart) {
  const start = formatISO(weekStart);
  const end = formatISO(addDays(weekStart, 7));
  const resp = await fetch(`${API_BASE}?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
  if (!resp.ok) throw new Error('Failed to fetch events');
  const data = await resp.json();
  return data.map(e => ({
    ...e,
    start_at: parseDateLocal(e.start_at),
    end_at: parseDateLocal(e.end_at),
  }));
}

async function createEvent(eventData) {
  const resp = await fetch(API_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(eventData),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || 'Failed to create event');
  return data;
}

async function updateEvent(id, eventData) {
  const resp = await fetch(`${API_BASE}/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(eventData),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || 'Failed to update event');
  return data;
}

async function deleteEvent(id) {
  const resp = await fetch(`${API_BASE}/${id}`, {
    method: 'DELETE',
  });
  if (!resp.ok) {
    const data = await resp.json();
    throw new Error(data.error || 'Failed to delete event');
  }
}

// ============================================================
// Overlap Layout Engine
// ============================================================

/**
 * Given an array of event objects for a single day, each with
 * `startMin` and `endMin` (minutes from midnight, clamped to [0, 1440]),
 * compute layout info: { col, totalCols } for each event.
 *
 * Algorithm:
 * 1. Sort events by start time, then by end time descending (longer events first).
 * 2. Group into overlap clusters (maximal sets of transitively overlapping events).
 * 3. Within each cluster, greedily assign column indices.
 * 4. The cluster's totalCols = max column index + 1.
 */
function computeOverlapLayout(dayEvents) {
  if (dayEvents.length === 0) return [];

  // Sort: by start ascending, then by duration descending (end descending)
  const sorted = [...dayEvents].sort((a, b) => {
    if (a.startMin !== b.startMin) return a.startMin - b.startMin;
    return b.endMin - a.endMin; // longer events first
  });

  // Build overlap clusters
  const clusters = [];
  let currentCluster = [sorted[0]];
  let clusterEnd = sorted[0].endMin;

  for (let i = 1; i < sorted.length; i++) {
    const ev = sorted[i];
    if (ev.startMin < clusterEnd) {
      // Overlaps with current cluster
      currentCluster.push(ev);
      clusterEnd = Math.max(clusterEnd, ev.endMin);
    } else {
      // New cluster
      clusters.push(currentCluster);
      currentCluster = [ev];
      clusterEnd = ev.endMin;
    }
  }
  clusters.push(currentCluster);

  // Assign columns within each cluster
  const layoutMap = new Map(); // event id -> { col, totalCols }

  for (const cluster of clusters) {
    // Events in this cluster are already sorted by start, then longest first
    const columns = []; // columns[colIndex] = endMin of last event in that column

    for (const ev of cluster) {
      // Find the first column where this event fits (its start >= column's end)
      let assigned = -1;
      for (let c = 0; c < columns.length; c++) {
        if (ev.startMin >= columns[c]) {
          assigned = c;
          break;
        }
      }
      if (assigned === -1) {
        assigned = columns.length;
        columns.push(0);
      }
      columns[assigned] = ev.endMin;
      ev._col = assigned;
    }

    const totalCols = columns.length;
    for (const ev of cluster) {
      layoutMap.set(ev.id, { col: ev._col, totalCols });
    }
  }

  return layoutMap;
}

// ============================================================
// Rendering
// ============================================================

function renderTimeGutter() {
  const gutter = document.getElementById('time-gutter');
  gutter.innerHTML = '';

  // Sticky header spacer (matches day-headers height)
  const gutterHeader = document.createElement('div');
  gutterHeader.className = 'gutter-header';
  gutter.appendChild(gutterHeader);

  // Body with time labels
  const gutterBody = document.createElement('div');
  gutterBody.className = 'gutter-body';

  for (let h = 0; h <= 24; h++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = `${h * HOUR_HEIGHT}px`;
    label.textContent = `${String(h).padStart(2, '0')}:00`;
    gutterBody.appendChild(label);
  }

  gutter.appendChild(gutterBody);
}

function renderDayHeaders() {
  const container = document.getElementById('day-headers');
  container.innerHTML = '';
  const today = new Date();

  for (let i = 0; i < 7; i++) {
    const day = addDays(currentWeekStart, i);
    const header = document.createElement('div');
    header.className = 'day-header';
    if (isSameDay(day, today)) {
      header.classList.add('today');
    }

    const nameEl = document.createElement('div');
    nameEl.className = 'day-name';
    nameEl.textContent = DAY_NAMES[i];

    const dateEl = document.createElement('div');
    dateEl.className = 'day-date';
    dateEl.textContent = day.getDate();

    header.appendChild(nameEl);
    header.appendChild(dateEl);
    container.appendChild(header);
  }
}

function renderWeekTitle() {
  const titleEl = document.getElementById('week-title');
  const weekEnd = addDays(currentWeekStart, 6);
  const startMonth = currentWeekStart.toLocaleString('default', { month: 'long' });
  const endMonth = weekEnd.toLocaleString('default', { month: 'long' });
  const startYear = currentWeekStart.getFullYear();
  const endYear = weekEnd.getFullYear();

  if (startYear !== endYear) {
    titleEl.textContent = `${startMonth} ${currentWeekStart.getDate()}, ${startYear} – ${endMonth} ${weekEnd.getDate()}, ${endYear}`;
  } else if (startMonth !== endMonth) {
    titleEl.textContent = `${startMonth} ${currentWeekStart.getDate()} – ${endMonth} ${weekEnd.getDate()}, ${startYear}`;
  } else {
    titleEl.textContent = `${startMonth} ${currentWeekStart.getDate()} – ${weekEnd.getDate()}, ${startYear}`;
  }
}

function renderDayColumns() {
  const container = document.getElementById('day-columns');
  container.innerHTML = '';
  const today = new Date();

  for (let i = 0; i < 7; i++) {
    const day = addDays(currentWeekStart, i);
    const col = document.createElement('div');
    col.className = 'day-column';
    col.dataset.dayIndex = i;
    col.dataset.date = formatDate(day);

    if (isSameDay(day, today)) {
      col.classList.add('today');
    }

    // Hour lines
    for (let h = 0; h < 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${h * HOUR_HEIGHT}px`;
      col.appendChild(line);

      // Half hour line
      const halfLine = document.createElement('div');
      halfLine.className = 'half-hour-line';
      halfLine.style.top = `${h * HOUR_HEIGHT + HOUR_HEIGHT / 2}px`;
      col.appendChild(halfLine);
    }
    // Bottom line at 24:00
    const bottomLine = document.createElement('div');
    bottomLine.className = 'hour-line';
    bottomLine.style.top = `${24 * HOUR_HEIGHT}px`;
    col.appendChild(bottomLine);

    // Clickable background for creating events
    const bg = document.createElement('div');
    bg.className = 'day-column-bg';
    bg.dataset.dayIndex = i;
    col.appendChild(bg);

    container.appendChild(col);
  }
}

function renderEvents() {
  // Remove existing event blocks
  document.querySelectorAll('.event-block').forEach(el => el.remove());

  // Group events by day index
  const eventsByDay = new Map(); // dayIndex -> array of { event, startMin, endMin }

  for (const ev of events) {
    // An event may span multiple days; render a clipped block in each day
    for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
      const dayStart = addDays(currentWeekStart, dayIdx);
      const dayEnd = addDays(currentWeekStart, dayIdx + 1);

      // Does this event overlap this day?
      if (ev.start_at < dayEnd && ev.end_at > dayStart) {
        // Clamp to day boundaries
        const clampedStart = ev.start_at < dayStart ? dayStart : ev.start_at;
        const clampedEnd = ev.end_at > dayEnd ? dayEnd : ev.end_at;

        const startMin = minutesFromMidnight(clampedStart);
        // If clampedEnd is exactly midnight of next day, that's 1440
        let endMin;
        if (clampedEnd.getTime() === dayEnd.getTime()) {
          endMin = TOTAL_MINUTES;
        } else {
          endMin = minutesFromMidnight(clampedEnd);
        }

        // Guard: ensure endMin > startMin
        if (endMin <= startMin) continue;

        if (!eventsByDay.has(dayIdx)) eventsByDay.set(dayIdx, []);
        eventsByDay.get(dayIdx).push({
          id: ev.id,
          event: ev,
          startMin,
          endMin,
        });
      }
    }
  }

  // For each day, compute layout and render
  const columns = document.querySelectorAll('.day-column');

  for (const [dayIdx, dayEvents] of eventsByDay) {
    const col = columns[dayIdx];
    if (!col) continue;

    const layoutMap = computeOverlapLayout(dayEvents);

    for (const de of dayEvents) {
      const layout = layoutMap.get(de.id);
      if (!layout) continue;

      const top = (de.startMin / TOTAL_MINUTES) * AXIS_HEIGHT;
      const height = ((de.endMin - de.startMin) / TOTAL_MINUTES) * AXIS_HEIGHT;
      const widthPercent = 100 / layout.totalCols;
      const leftPercent = layout.col * widthPercent;

      const block = document.createElement('div');
      block.className = 'event-block';
      block.dataset.eventId = de.event.id;
      block.style.top = `${top}px`;
      block.style.height = `${height}px`;
      block.style.left = `${leftPercent}%`;
      block.style.width = `calc(${widthPercent}% - 2px)`; // 2px gap
      block.style.minHeight = '0';

      const titleEl = document.createElement('div');
      titleEl.className = 'event-block-title';
      titleEl.textContent = de.event.title;

      const timeEl = document.createElement('div');
      timeEl.className = 'event-block-time';
      timeEl.textContent = `${formatTimeShort(de.event.start_at)} – ${formatTimeShort(de.event.end_at)}`;

      block.appendChild(titleEl);
      block.appendChild(timeEl);

      // Click to edit
      block.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditModal(de.event);
      });

      col.appendChild(block);
    }
  }
}

// ============================================================
// Week Navigation
// ============================================================

async function loadWeek() {
  renderWeekTitle();
  renderDayHeaders();
  renderDayColumns();

  try {
    events = await fetchEvents(currentWeekStart);
  } catch (err) {
    console.error('Failed to load events:', err);
    events = [];
  }

  renderEvents();

  // Scroll to ~8am on load
  const container = document.getElementById('calendar-container');
  container.scrollTop = 8 * HOUR_HEIGHT - 20;
}

function navigateWeek(offset) {
  currentWeekStart = addDays(currentWeekStart, offset * 7);
  loadWeek();
}

function goToday() {
  currentWeekStart = getMonday(new Date());
  loadWeek();
}

// ============================================================
// Event Creation via Click/Drag on Day Column
// ============================================================

let dragState = null; // { dayIndex, startY, currentY, overlay }

function setupDragCreation() {
  const dayColumnsContainer = document.getElementById('day-columns');

  dayColumnsContainer.addEventListener('mousedown', (e) => {
    const bg = e.target.closest('.day-column-bg');
    if (!bg) return;

    const dayIdx = parseInt(bg.dataset.dayIndex);
    const col = bg.closest('.day-column');
    const rect = col.getBoundingClientRect();
    const y = e.clientY - rect.top;

    // Create selection overlay
    const overlay = document.createElement('div');
    overlay.className = 'selection-overlay';
    col.appendChild(overlay);

    dragState = {
      dayIndex: dayIdx,
      startY: y,
      currentY: y,
      overlay,
      col,
      rect,
    };

    updateSelectionOverlay();
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragState) return;
    const rect = dragState.col.getBoundingClientRect();
    dragState.currentY = Math.max(0, Math.min(AXIS_HEIGHT, e.clientY - rect.top));
    updateSelectionOverlay();
    e.preventDefault();
  });

  document.addEventListener('mouseup', (e) => {
    if (!dragState) return;

    const { dayIndex, startY, currentY, overlay } = dragState;
    overlay.remove();

    const minY = Math.max(0, Math.min(startY, currentY));
    const maxY = Math.min(AXIS_HEIGHT, Math.max(startY, currentY));

    // Convert Y to minutes, snap to 15-minute grid
    let startMin = Math.round((minY / AXIS_HEIGHT) * TOTAL_MINUTES / 15) * 15;
    let endMin = Math.round((maxY / AXIS_HEIGHT) * TOTAL_MINUTES / 15) * 15;

    // If click (no drag), default to 1 hour
    if (endMin - startMin < 15) {
      endMin = Math.min(startMin + 60, TOTAL_MINUTES);
    }

    // Clamp
    startMin = Math.max(0, startMin);
    endMin = Math.min(TOTAL_MINUTES, endMin);
    if (endMin <= startMin) endMin = startMin + 15;

    const day = addDays(currentWeekStart, dayIndex);
    const startDate = new Date(day);
    startDate.setHours(Math.floor(startMin / 60), startMin % 60, 0, 0);

    const endDate = new Date(day);
    endDate.setHours(Math.floor(endMin / 60), endMin % 60, 0, 0);

    dragState = null;
    openCreateModal(startDate, endDate);
  });
}

function updateSelectionOverlay() {
  if (!dragState) return;
  const { startY, currentY, overlay } = dragState;
  const top = Math.max(0, Math.min(startY, currentY));
  const bottom = Math.min(AXIS_HEIGHT, Math.max(startY, currentY));
  overlay.style.top = `${top}px`;
  overlay.style.height = `${bottom - top}px`;
}

// ============================================================
// Modal (Create / Edit)
// ============================================================

function openModal() {
  document.getElementById('event-modal').classList.remove('hidden');
  document.getElementById('form-error').classList.add('hidden');
}

function closeModal() {
  document.getElementById('event-modal').classList.add('hidden');
  document.getElementById('event-form').reset();
  document.getElementById('event-id').value = '';
  document.getElementById('form-error').classList.add('hidden');
}

function showFormError(msg) {
  const errEl = document.getElementById('form-error');
  errEl.textContent = msg;
  errEl.classList.remove('hidden');
}

function openCreateModal(startDate, endDate) {
  document.getElementById('modal-title').textContent = 'Create Event';
  document.getElementById('event-id').value = '';
  document.getElementById('event-title').value = '';
  document.getElementById('event-start').value = formatISO(startDate);
  document.getElementById('event-end').value = formatISO(endDate);
  document.getElementById('btn-delete').classList.add('hidden');
  openModal();
  document.getElementById('event-title').focus();
}

function openEditModal(event) {
  document.getElementById('modal-title').textContent = 'Edit Event';
  document.getElementById('event-id').value = event.id;
  document.getElementById('event-title').value = event.title;
  document.getElementById('event-start').value = formatISO(event.start_at);
  document.getElementById('event-end').value = formatISO(event.end_at);
  document.getElementById('btn-delete').classList.remove('hidden');
  openModal();
}

async function handleFormSubmit(e) {
  e.preventDefault();

  const id = document.getElementById('event-id').value;
  const title = document.getElementById('event-title').value.trim();
  const startStr = document.getElementById('event-start').value;
  const endStr = document.getElementById('event-end').value;

  // Client-side validation
  if (!title) {
    showFormError('Title is required.');
    return;
  }
  if (!startStr || !endStr) {
    showFormError('Start and end times are required.');
    return;
  }

  const start = new Date(startStr);
  const end = new Date(endStr);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    showFormError('Invalid date/time.');
    return;
  }
  if (end <= start) {
    showFormError('End time must be after start time.');
    return;
  }

  const payload = {
    title,
    start_at: startStr,
    end_at: endStr,
  };

  try {
    if (id) {
      await updateEvent(id, payload);
    } else {
      await createEvent(payload);
    }
    closeModal();
    // Reload events
    events = await fetchEvents(currentWeekStart);
    renderEvents();
  } catch (err) {
    showFormError(err.message);
  }
}

async function handleDelete() {
  const id = document.getElementById('event-id').value;
  if (!id) return;

  if (!confirm('Delete this event?')) return;

  try {
    await deleteEvent(id);
    closeModal();
    events = await fetchEvents(currentWeekStart);
    renderEvents();
  } catch (err) {
    showFormError(err.message);
  }
}

// ============================================================
// Initialization
// ============================================================

function init() {
  renderTimeGutter();

  // Navigation
  document.getElementById('btn-prev').addEventListener('click', () => navigateWeek(-1));
  document.getElementById('btn-next').addEventListener('click', () => navigateWeek(1));
  document.getElementById('btn-today').addEventListener('click', goToday);

  // Modal
  document.getElementById('event-form').addEventListener('submit', handleFormSubmit);
  document.getElementById('btn-cancel').addEventListener('click', closeModal);
  document.getElementById('btn-delete').addEventListener('click', handleDelete);
  document.querySelector('.modal-overlay').addEventListener('click', closeModal);

  // Drag creation
  setupDragCreation();

  // Load current week
  loadWeek();
}

document.addEventListener('DOMContentLoaded', init);
