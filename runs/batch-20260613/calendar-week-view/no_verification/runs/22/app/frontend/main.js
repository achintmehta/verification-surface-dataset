// === Configuration ===
const API_BASE = '/api';
const HOUR_HEIGHT = 60; // pixels per hour
const TOTAL_MINUTES = 24 * 60;
const DAY_HEIGHT = 24 * HOUR_HEIGHT; // total height of a day column body
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Event colors palette
const EVENT_COLORS = [
  { bg: '#d4e5ff', border: '#4285f4', text: '#1a3e72' },
  { bg: '#d4f5e9', border: '#34a853', text: '#1a5c34' },
  { bg: '#fce8e6', border: '#ea4335', text: '#7a1b14' },
  { bg: '#fef3cd', border: '#fbbc04', text: '#7a5c00' },
  { bg: '#e8d5f5', border: '#a142f4', text: '#4a1a72' },
  { bg: '#d5f0f0', border: '#00acc1', text: '#004d54' },
  { bg: '#ffe0cc', border: '#ff7043', text: '#7a2e14' },
];

// === State ===
let currentWeekStart = getMonday(new Date());
let events = [];
let editingEvent = null; // null for create, event object for edit

// === Utility functions ===

function getMonday(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  // JS: 0=Sun, 1=Mon ... 6=Sat. We want Monday as start.
  const diff = (day === 0 ? -6 : 1) - day;
  d.setDate(d.getDate() + diff);
  return d;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function isSameDay(d1, d2) {
  return d1.getFullYear() === d2.getFullYear() &&
         d1.getMonth() === d2.getMonth() &&
         d1.getDate() === d2.getDate();
}

function minutesFromMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

function minutesToPx(minutes) {
  return (minutes / 60) * HOUR_HEIGHT;
}

function pxToMinutes(px) {
  return (px / HOUR_HEIGHT) * 60;
}

function formatTime(date) {
  const h = date.getHours().toString().padStart(2, '0');
  const m = date.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}

function formatDateForInput(date) {
  // Format: YYYY-MM-DDTHH:MM
  const y = date.getFullYear();
  const mo = (date.getMonth() + 1).toString().padStart(2, '0');
  const d = date.getDate().toString().padStart(2, '0');
  const h = date.getHours().toString().padStart(2, '0');
  const mi = date.getMinutes().toString().padStart(2, '0');
  return `${y}-${mo}-${d}T${h}:${mi}`;
}

function getEventColor(id) {
  return EVENT_COLORS[id % EVENT_COLORS.length];
}

// === API ===

async function fetchEvents(weekStart) {
  const start = weekStart.toISOString();
  const end = addDays(weekStart, 7).toISOString();
  const res = await fetch(`${API_BASE}/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
  if (!res.ok) throw new Error('Failed to fetch events');
  return res.json();
}

async function createEvent(data) {
  const res = await fetch(`${API_BASE}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
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
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to update event');
  }
  return res.json();
}

async function deleteEvent(id) {
  const res = await fetch(`${API_BASE}/events/${id}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to delete event');
  }
  return res.json();
}

// === Layout Engine ===

/**
 * Given an array of events for a single day, compute layout positions.
 * Each event gets: { event, top, height, left (fraction), width (fraction) }
 * 
 * Algorithm:
 * 1. Sort events by start time, then by end time (longer events first for ties).
 * 2. Group into overlap clusters (maximal sets of transitively overlapping events).
 * 3. Within each cluster, greedily assign columns.
 * 4. Each event's width = 1/maxColumns, left = columnIndex/maxColumns.
 */
function layoutEventsForDay(dayEvents, dayStart) {
  if (dayEvents.length === 0) return [];

  // For each event, compute start/end in minutes from midnight of dayStart, clamped to [0, 1440]
  const items = dayEvents.map(ev => {
    const evStart = new Date(ev.start_at);
    const evEnd = new Date(ev.end_at);

    // Clamp to the day
    const dayEnd = addDays(dayStart, 1);

    const clampedStart = evStart < dayStart ? dayStart : evStart;
    const clampedEnd = evEnd > dayEnd ? dayEnd : evEnd;

    const startMin = minutesFromMidnight(clampedStart);
    const endMin = clampedEnd.getTime() === dayEnd.getTime() ? TOTAL_MINUTES : minutesFromMidnight(clampedEnd);

    return {
      event: ev,
      startMin,
      endMin: Math.max(endMin, startMin + 1), // minimum 1 minute height
    };
  });

  // Sort by start time, then longer events first (earlier end = later in sort)
  items.sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);

  // Group into overlap clusters
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

  // Layout each cluster
  const results = [];
  for (const cluster of clusters) {
    // Greedy column assignment
    // columns[i] = end time of the last event placed in column i
    const columns = [];

    const assignments = []; // parallel to cluster: column index for each item

    for (const item of cluster) {
      let placed = false;
      for (let c = 0; c < columns.length; c++) {
        if (columns[c] <= item.startMin) {
          columns[c] = item.endMin;
          assignments.push(c);
          placed = true;
          break;
        }
      }
      if (!placed) {
        assignments.push(columns.length);
        columns.push(item.endMin);
      }
    }

    const totalColumns = columns.length;

    for (let i = 0; i < cluster.length; i++) {
      const item = cluster[i];
      const col = assignments[i];
      results.push({
        event: item.event,
        top: minutesToPx(item.startMin),
        height: minutesToPx(item.endMin - item.startMin),
        left: col / totalColumns,
        width: 1 / totalColumns,
      });
    }
  }

  return results;
}

// === Rendering ===

function renderTimeGutter() {
  const gutter = document.getElementById('time-gutter');
  gutter.innerHTML = '';

  // Need the gutter to have same height as day bodies
  // We add a spacer for the header area
  const headerSpacer = document.createElement('div');
  headerSpacer.className = 'time-gutter-header';
  headerSpacer.style.height = '62px'; // match day-header height
  headerSpacer.style.flexShrink = '0';
  gutter.appendChild(headerSpacer);

  const body = document.createElement('div');
  body.style.position = 'relative';
  body.style.height = DAY_HEIGHT + 'px';
  gutter.appendChild(body);

  for (let h = 0; h <= 24; h++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = (h * HOUR_HEIGHT) + 'px';
    label.textContent = h.toString().padStart(2, '0') + ':00';
    body.appendChild(label);
  }
}

function renderWeekGrid() {
  const grid = document.getElementById('week-grid');
  grid.innerHTML = '';

  const today = new Date();

  for (let d = 0; d < 7; d++) {
    const dayDate = addDays(currentWeekStart, d);
    const col = document.createElement('div');
    col.className = 'day-column';
    if (isSameDay(dayDate, today)) {
      col.classList.add('today');
    }
    col.dataset.dayIndex = d;

    // Header
    const header = document.createElement('div');
    header.className = 'day-header';
    header.innerHTML = `
      <div class="day-name">${DAY_NAMES[d]}</div>
      <div class="day-date">${dayDate.getDate()}</div>
    `;
    col.appendChild(header);

    // Body
    const body = document.createElement('div');
    body.className = 'day-body';
    body.style.height = DAY_HEIGHT + 'px';
    body.dataset.dayIndex = d;

    // Hour lines
    for (let h = 0; h < 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = (h * HOUR_HEIGHT) + 'px';
      body.appendChild(line);

      const halfLine = document.createElement('div');
      halfLine.className = 'half-hour-line';
      halfLine.style.top = (h * HOUR_HEIGHT + HOUR_HEIGHT / 2) + 'px';
      body.appendChild(halfLine);
    }
    // Bottom line at 24:00
    const bottomLine = document.createElement('div');
    bottomLine.className = 'hour-line';
    bottomLine.style.top = DAY_HEIGHT + 'px';
    body.appendChild(bottomLine);

    // Attach mouse events for selection creation
    setupDayBodyInteraction(body, d);

    col.appendChild(body);
    grid.appendChild(col);
  }

  // Update title
  const weekEnd = addDays(currentWeekStart, 6);
  const titleEl = document.getElementById('week-title');
  if (currentWeekStart.getMonth() === weekEnd.getMonth()) {
    titleEl.textContent = `${MONTH_NAMES[currentWeekStart.getMonth()]} ${currentWeekStart.getDate()} – ${weekEnd.getDate()}, ${currentWeekStart.getFullYear()}`;
  } else if (currentWeekStart.getFullYear() === weekEnd.getFullYear()) {
    titleEl.textContent = `${MONTH_NAMES[currentWeekStart.getMonth()]} ${currentWeekStart.getDate()} – ${MONTH_NAMES[weekEnd.getMonth()]} ${weekEnd.getDate()}, ${currentWeekStart.getFullYear()}`;
  } else {
    titleEl.textContent = `${MONTH_NAMES[currentWeekStart.getMonth()]} ${currentWeekStart.getDate()}, ${currentWeekStart.getFullYear()} – ${MONTH_NAMES[weekEnd.getMonth()]} ${weekEnd.getDate()}, ${weekEnd.getFullYear()}`;
  }
}

function renderEvents() {
  // Clear existing event blocks
  document.querySelectorAll('.event-block').forEach(el => el.remove());
  document.querySelectorAll('.selection-overlay').forEach(el => el.remove());

  // Group events by day
  for (let d = 0; d < 7; d++) {
    const dayStart = addDays(currentWeekStart, d);
    const dayEnd = addDays(dayStart, 1);

    const dayEvents = events.filter(ev => {
      const evStart = new Date(ev.start_at);
      const evEnd = new Date(ev.end_at);
      return evStart < dayEnd && evEnd > dayStart;
    });

    const layouts = layoutEventsForDay(dayEvents, dayStart);
    const body = document.querySelector(`.day-body[data-day-index="${d}"]`);
    if (!body) continue;

    for (const layout of layouts) {
      const block = document.createElement('div');
      block.className = 'event-block';
      const color = getEventColor(layout.event.id);
      block.style.top = layout.top + 'px';
      block.style.height = layout.height + 'px';
      block.style.left = (layout.left * 100) + '%';
      block.style.width = `calc(${layout.width * 100}% - 2px)`;
      block.style.backgroundColor = color.bg;
      block.style.borderLeftColor = color.border;
      block.style.color = color.text;

      const evStart = new Date(layout.event.start_at);
      const evEnd = new Date(layout.event.end_at);

      block.innerHTML = `
        <div class="event-title">${escapeHtml(layout.event.title)}</div>
        <div class="event-time">${formatTime(evStart)} – ${formatTime(evEnd)}</div>
      `;

      block.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditForm(layout.event);
      });

      body.appendChild(block);
    }
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// === Day Body Interaction (click-drag to select time range) ===

function setupDayBodyInteraction(body, dayIndex) {
  let isDragging = false;
  let startY = 0;
  let selectionEl = null;

  function getMinutesFromY(y) {
    const rect = body.getBoundingClientRect();
    const relY = Math.max(0, Math.min(y - rect.top, DAY_HEIGHT));
    const minutes = pxToMinutes(relY);
    // Snap to 15-minute intervals
    return Math.round(minutes / 15) * 15;
  }

  body.addEventListener('mousedown', (e) => {
    if (e.target.closest('.event-block')) return;
    e.preventDefault();
    isDragging = true;
    startY = e.clientY;

    // Create selection overlay
    selectionEl = document.createElement('div');
    selectionEl.className = 'selection-overlay';
    body.appendChild(selectionEl);

    const startMin = getMinutesFromY(e.clientY);
    selectionEl.dataset.startMin = startMin;
    selectionEl.style.top = minutesToPx(startMin) + 'px';
    selectionEl.style.height = '0px';
  });

  body.addEventListener('mousemove', (e) => {
    if (!isDragging || !selectionEl) return;
    e.preventDefault();

    const startMin = parseInt(selectionEl.dataset.startMin);
    const currentMin = getMinutesFromY(e.clientY);

    const topMin = Math.min(startMin, currentMin);
    const bottomMin = Math.max(startMin, currentMin);

    selectionEl.style.top = minutesToPx(topMin) + 'px';
    selectionEl.style.height = minutesToPx(bottomMin - topMin) + 'px';
  });

  const finishDrag = (e) => {
    if (!isDragging || !selectionEl) return;
    isDragging = false;

    const startMin = parseInt(selectionEl.dataset.startMin);
    const endMin = getMinutesFromY(e.clientY);

    selectionEl.remove();
    selectionEl = null;

    let topMin = Math.min(startMin, endMin);
    let bottomMin = Math.max(startMin, endMin);

    // If just a click (no drag), default to 1-hour event
    if (bottomMin - topMin < 15) {
      bottomMin = Math.min(topMin + 60, TOTAL_MINUTES);
    }

    // Clamp
    topMin = Math.max(0, topMin);
    bottomMin = Math.min(TOTAL_MINUTES, bottomMin);

    if (bottomMin <= topMin) return;

    const dayDate = addDays(currentWeekStart, dayIndex);
    const start = new Date(dayDate);
    start.setHours(Math.floor(topMin / 60), topMin % 60, 0, 0);
    const end = new Date(dayDate);
    end.setHours(Math.floor(bottomMin / 60), bottomMin % 60, 0, 0);

    openCreateForm(start, end);
  };

  body.addEventListener('mouseup', finishDrag);
  body.addEventListener('mouseleave', (e) => {
    if (isDragging) {
      finishDrag(e);
    }
  });
}

// === Modal / Form ===

function openCreateForm(start, end) {
  editingEvent = null;
  document.getElementById('modal-title').textContent = 'New Event';
  document.getElementById('input-title').value = '';
  document.getElementById('input-start').value = formatDateForInput(start);
  document.getElementById('input-end').value = formatDateForInput(end);
  document.getElementById('btn-delete').style.display = 'none';
  document.getElementById('form-error').style.display = 'none';
  document.getElementById('modal-overlay').style.display = 'flex';
  document.getElementById('input-title').focus();
}

function openEditForm(event) {
  editingEvent = event;
  document.getElementById('modal-title').textContent = 'Edit Event';
  document.getElementById('input-title').value = event.title;
  document.getElementById('input-start').value = formatDateForInput(new Date(event.start_at));
  document.getElementById('input-end').value = formatDateForInput(new Date(event.end_at));
  document.getElementById('btn-delete').style.display = 'inline-block';
  document.getElementById('form-error').style.display = 'none';
  document.getElementById('modal-overlay').style.display = 'flex';
  document.getElementById('input-title').focus();
}

function closeModal() {
  document.getElementById('modal-overlay').style.display = 'none';
  editingEvent = null;
}

function showFormError(msg) {
  const el = document.getElementById('form-error');
  el.textContent = msg;
  el.style.display = 'block';
}

// === Event Handlers ===

async function handleFormSubmit(e) {
  e.preventDefault();

  const title = document.getElementById('input-title').value.trim();
  const startStr = document.getElementById('input-start').value;
  const endStr = document.getElementById('input-end').value;

  if (!title) {
    showFormError('Title is required.');
    return;
  }

  const start_at = new Date(startStr);
  const end_at = new Date(endStr);

  if (isNaN(start_at.getTime()) || isNaN(end_at.getTime())) {
    showFormError('Please enter valid start and end times.');
    return;
  }

  if (end_at <= start_at) {
    showFormError('End time must be after start time.');
    return;
  }

  try {
    if (editingEvent) {
      await updateEvent(editingEvent.id, {
        title,
        start_at: start_at.toISOString(),
        end_at: end_at.toISOString(),
      });
    } else {
      await createEvent({
        title,
        start_at: start_at.toISOString(),
        end_at: end_at.toISOString(),
      });
    }

    closeModal();
    await loadAndRender();
  } catch (err) {
    showFormError(err.message);
  }
}

async function handleDelete() {
  if (!editingEvent) return;

  if (!confirm('Delete this event?')) return;

  try {
    await deleteEvent(editingEvent.id);
    closeModal();
    await loadAndRender();
  } catch (err) {
    showFormError(err.message);
  }
}

// === Load & Render ===

async function loadAndRender() {
  try {
    events = await fetchEvents(currentWeekStart);
  } catch (err) {
    console.error('Failed to load events:', err);
    events = [];
  }
  renderWeekGrid();
  renderTimeGutter();
  renderEvents();
}

// === Navigation ===

function goToPrevWeek() {
  currentWeekStart = addDays(currentWeekStart, -7);
  loadAndRender();
}

function goToNextWeek() {
  currentWeekStart = addDays(currentWeekStart, 7);
  loadAndRender();
}

function goToToday() {
  currentWeekStart = getMonday(new Date());
  loadAndRender();
}

// === Initialize ===

function init() {
  // Navigation buttons
  document.getElementById('btn-prev').addEventListener('click', goToPrevWeek);
  document.getElementById('btn-next').addEventListener('click', goToNextWeek);
  document.getElementById('btn-today').addEventListener('click', goToToday);

  // Form
  document.getElementById('event-form').addEventListener('submit', handleFormSubmit);
  document.getElementById('btn-cancel').addEventListener('click', closeModal);
  document.getElementById('btn-delete').addEventListener('click', handleDelete);

  // Close modal on overlay click
  document.getElementById('modal-overlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('modal-overlay')) {
      closeModal();
    }
  });

  // Keyboard: Escape to close modal
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeModal();
    }
  });

  // Initial load
  loadAndRender();

  // Scroll to 8am on load
  setTimeout(() => {
    const container = document.querySelector('.calendar-container');
    if (container) {
      container.scrollTop = 8 * HOUR_HEIGHT;
    }
  }, 100);
}

document.addEventListener('DOMContentLoaded', init);
