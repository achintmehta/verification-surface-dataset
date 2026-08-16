// ============================================================
// Constants
// ============================================================
const HOUR_HEIGHT = 60; // pixels per hour
const DAY_BODY_HEIGHT = 24 * HOUR_HEIGHT; // total height of one day column body
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ============================================================
// State
// ============================================================
let currentWeekStart = getMonday(new Date());
let events = [];

// ============================================================
// Date Utilities
// ============================================================

/** Return the Monday 00:00:00 of the week containing `date` (local time). */
function getMonday(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0=Sun .. 6=Sat
  const diff = day === 0 ? -6 : 1 - day; // Monday=1
  d.setDate(d.getDate() + diff);
  return d;
}

/** Add `n` days to a date, returning a new Date. */
function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

/** Format a Date to "YYYY-MM-DDTHH:MM" for datetime-local inputs. */
function toLocalDateTimeString(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${d}T${hh}:${mm}`;
}

/** Format time as "HH:MM". */
function formatTime(date) {
  return date.getHours().toString().padStart(2, '0') + ':' + date.getMinutes().toString().padStart(2, '0');
}

/** Minutes from midnight (local time). */
function minutesFromMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

/** Check if two dates are the same calendar day (local time). */
function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}

// ============================================================
// API
// ============================================================

async function fetchEvents(weekStart) {
  const start = weekStart.toISOString();
  const end = addDays(weekStart, 7).toISOString();
  const res = await fetch(`/api/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
  if (!res.ok) throw new Error('Failed to fetch events');
  const data = await res.json();
  return data.map(e => ({
    ...e,
    start_at: new Date(e.start_at),
    end_at: new Date(e.end_at)
  }));
}

async function apiCreateEvent(title, startAt, endAt) {
  const res = await fetch('/api/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, start_at: startAt.toISOString(), end_at: endAt.toISOString() })
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to create event');
  }
  return res.json();
}

async function apiUpdateEvent(id, title, startAt, endAt) {
  const res = await fetch(`/api/events/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, start_at: startAt.toISOString(), end_at: endAt.toISOString() })
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to update event');
  }
  return res.json();
}

async function apiDeleteEvent(id) {
  const res = await fetch(`/api/events/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete event');
}

// ============================================================
// Layout Engine
// ============================================================

/**
 * Given an array of events for a single day, compute the overlap layout.
 * Each event gets { col, totalCols } assigned.
 *
 * Algorithm:
 * 1. Sort events by start time, then by end time descending (longer events first).
 * 2. Group into overlap clusters (maximal sets of transitively overlapping events).
 *    Two events overlap if one starts before the other ends (exclusive; touching endpoints don't overlap).
 * 3. Within each cluster, assign columns greedily by start time.
 * 4. Each event's width = dayColumnWidth / totalCols, offset = col * width.
 *
 * Returns a Map<eventId, { col, totalCols }>.
 */
function computeOverlapLayout(dayEvents) {
  if (dayEvents.length === 0) return new Map();

  // Sort: earliest start first; tie-break by longer duration first
  const sorted = [...dayEvents].sort((a, b) => {
    const sd = a.startMin - b.startMin;
    if (sd !== 0) return sd;
    return b.endMin - a.endMin; // longer events first
  });

  const result = new Map();

  // Build clusters: events are in the same cluster if they transitively overlap
  const clusters = [];
  let clusterEvents = [sorted[0]];
  let clusterEnd = sorted[0].endMin;

  for (let i = 1; i < sorted.length; i++) {
    const ev = sorted[i];
    if (ev.startMin < clusterEnd) {
      // Overlaps with current cluster (starts before the cluster's latest end)
      clusterEvents.push(ev);
      clusterEnd = Math.max(clusterEnd, ev.endMin);
    } else {
      // New cluster
      clusters.push(clusterEvents);
      clusterEvents = [ev];
      clusterEnd = ev.endMin;
    }
  }
  clusters.push(clusterEvents);

  // For each cluster, assign columns greedily
  for (const cluster of clusters) {
    // columns[c] = end time (minutes) of the last event placed in column c
    const columns = [];

    for (const ev of cluster) {
      let placed = false;
      for (let c = 0; c < columns.length; c++) {
        // An event can be placed in column c if it starts at or after the column's last end
        if (ev.startMin >= columns[c]) {
          columns[c] = ev.endMin;
          result.set(ev.id, { col: c, totalCols: 0 });
          placed = true;
          break;
        }
      }
      if (!placed) {
        result.set(ev.id, { col: columns.length, totalCols: 0 });
        columns.push(ev.endMin);
      }
    }

    // totalCols = number of columns this cluster needed
    const totalCols = columns.length;
    for (const ev of cluster) {
      const entry = result.get(ev.id);
      if (entry) entry.totalCols = totalCols;
    }
  }

  return result;
}

// ============================================================
// Rendering
// ============================================================

function renderTimeGutter() {
  const gutter = document.getElementById('time-gutter');
  gutter.innerHTML = '';

  // Spacer to match the day header height
  const spacer = document.createElement('div');
  spacer.className = 'gutter-header-spacer';
  spacer.style.height = '52px';
  spacer.style.flexShrink = '0';
  gutter.appendChild(spacer);

  const gutterBody = document.createElement('div');
  gutterBody.style.position = 'relative';
  gutterBody.style.height = DAY_BODY_HEIGHT + 'px';
  gutter.appendChild(gutterBody);

  for (let h = 0; h <= 24; h++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = (h * HOUR_HEIGHT) + 'px';
    label.textContent = h.toString().padStart(2, '0') + ':00';
    gutterBody.appendChild(label);
  }
}

function renderWeekHeader() {
  const title = document.getElementById('week-title');
  const weekEnd = addDays(currentWeekStart, 6);
  const startMonth = MONTH_NAMES[currentWeekStart.getMonth()];
  const endMonth = MONTH_NAMES[weekEnd.getMonth()];
  const startYear = currentWeekStart.getFullYear();
  const endYear = weekEnd.getFullYear();

  if (startYear !== endYear) {
    title.textContent = `${startMonth} ${currentWeekStart.getDate()}, ${startYear} – ${endMonth} ${weekEnd.getDate()}, ${endYear}`;
  } else if (startMonth !== endMonth) {
    title.textContent = `${startMonth} ${currentWeekStart.getDate()} – ${endMonth} ${weekEnd.getDate()}, ${startYear}`;
  } else {
    title.textContent = `${startMonth} ${currentWeekStart.getDate()} – ${weekEnd.getDate()}, ${startYear}`;
  }
}

function renderDayColumns() {
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
    header.innerHTML = `
      <div class="day-name">${DAY_NAMES[d]}</div>
      <div class="day-date">${dayDate.getDate()}</div>
    `;
    col.appendChild(header);

    // Body
    const body = document.createElement('div');
    body.className = 'day-body';
    body.style.height = DAY_BODY_HEIGHT + 'px';
    body.style.position = 'relative';
    body.dataset.dayIndex = d;
    body.dataset.date = dayDate.toISOString();

    // Hour lines
    for (let h = 0; h < 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = (h * HOUR_HEIGHT) + 'px';
      body.appendChild(line);

      // Half-hour line
      const halfLine = document.createElement('div');
      halfLine.className = 'hour-line half';
      halfLine.style.top = (h * HOUR_HEIGHT + HOUR_HEIGHT / 2) + 'px';
      body.appendChild(halfLine);
    }
    // Bottom line at 24:00
    const bottomLine = document.createElement('div');
    bottomLine.className = 'hour-line';
    bottomLine.style.top = DAY_BODY_HEIGHT + 'px';
    body.appendChild(bottomLine);

    // Click area for creating events (behind event blocks)
    const clickArea = document.createElement('div');
    clickArea.className = 'day-click-area';
    body.appendChild(clickArea);

    // Current time indicator
    if (isToday) {
      const now = new Date();
      const mins = minutesFromMidnight(now);
      const topPx = (mins / 60) * HOUR_HEIGHT;
      const timeLine = document.createElement('div');
      timeLine.className = 'current-time-line';
      timeLine.style.top = topPx + 'px';
      body.appendChild(timeLine);
    }

    col.appendChild(body);
    container.appendChild(col);
  }
}

function renderEvents() {
  // Clear existing event blocks
  document.querySelectorAll('.event-block').forEach(el => el.remove());

  // Group events by day index (0-6 for Mon-Sun of this week)
  const dayBuckets = Array.from({ length: 7 }, () => []);

  for (const ev of events) {
    // An event can span multiple days; render in each day it touches
    for (let d = 0; d < 7; d++) {
      const dayStart = addDays(currentWeekStart, d);
      const dayEnd = addDays(currentWeekStart, d + 1);

      // Check if event overlaps this day
      if (ev.start_at < dayEnd && ev.end_at > dayStart) {
        // Clamp to this day
        const clampedStart = ev.start_at < dayStart ? dayStart : ev.start_at;
        const clampedEnd = ev.end_at > dayEnd ? dayEnd : ev.end_at;

        const startMin = minutesFromMidnight(clampedStart);
        // If clampedEnd is exactly midnight of next day, that means 24*60=1440
        let endMin;
        if (clampedEnd.getTime() === dayEnd.getTime()) {
          endMin = 1440;
        } else {
          endMin = minutesFromMidnight(clampedEnd);
        }

        // Ensure valid range
        if (endMin <= startMin) continue;

        dayBuckets[d].push({
          id: ev.id,
          title: ev.title,
          start_at: ev.start_at,
          end_at: ev.end_at,
          startMin,
          endMin,
          dayIndex: d
        });
      }
    }
  }

  // For each day, compute layout and render
  for (let d = 0; d < 7; d++) {
    const dayEvents = dayBuckets[d];
    if (dayEvents.length === 0) continue;

    const layout = computeOverlapLayout(dayEvents);
    const dayBody = document.querySelector(`.day-body[data-day-index="${d}"]`);
    if (!dayBody) continue;

    for (const ev of dayEvents) {
      const layoutInfo = layout.get(ev.id);
      if (!layoutInfo) continue;
      const { col, totalCols } = layoutInfo;

      const topPx = (ev.startMin / 60) * HOUR_HEIGHT;
      const heightPx = ((ev.endMin - ev.startMin) / 60) * HOUR_HEIGHT;

      const widthPercent = 100 / totalCols;
      const leftPercent = col * widthPercent;

      const block = document.createElement('div');
      block.className = 'event-block';
      block.dataset.eventId = ev.id;
      block.style.top = topPx + 'px';
      block.style.height = Math.max(heightPx, 14) + 'px'; // min height for clickability
      block.style.left = leftPercent + '%';
      block.style.width = `calc(${widthPercent}% - 2px)`; // small gap between side-by-side events
      block.style.right = 'auto';

      const startTime = formatTime(ev.start_at);
      const endTime = formatTime(ev.end_at);

      block.innerHTML = `
        <div class="event-title">${escapeHTML(ev.title)}</div>
        <div class="event-time">${startTime} – ${endTime}</div>
      `;

      block.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditModal(ev.id);
      });

      dayBody.appendChild(block);
    }
  }
}

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ============================================================
// Time Selection (click-drag to create)
// ============================================================

// We track active drag state globally to avoid leaking listeners
let dragState = null;

function setupDayClickHandlers() {
  // Remove old global listeners if any
  document.removeEventListener('mousemove', handleDragMove);
  document.removeEventListener('mouseup', handleDragEnd);

  // Add fresh global listeners
  document.addEventListener('mousemove', handleDragMove);
  document.addEventListener('mouseup', handleDragEnd);

  const dayBodies = document.querySelectorAll('.day-body');
  dayBodies.forEach(dayBody => {
    const clickArea = dayBody.querySelector('.day-click-area');
    if (!clickArea) return;

    clickArea.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();

      const dayDate = new Date(dayBody.dataset.date);

      dragState = {
        dayBody,
        dayDate,
        startY: e.clientY,
        selectionEl: null
      };

      const selectionEl = document.createElement('div');
      selectionEl.className = 'selection-highlight';
      dayBody.appendChild(selectionEl);
      dragState.selectionEl = selectionEl;

      const mins = getMinutesFromY(e.clientY, dayBody);
      const topPx = (mins / 1440) * DAY_BODY_HEIGHT;
      selectionEl.style.top = topPx + 'px';
      selectionEl.style.height = '0px';
    });
  });
}

function getMinutesFromY(y, dayBody) {
  const rect = dayBody.getBoundingClientRect();
  const relY = Math.max(0, Math.min(y - rect.top, DAY_BODY_HEIGHT));
  const totalMinutes = (relY / DAY_BODY_HEIGHT) * 1440;
  // Snap to nearest 15 minutes
  return Math.round(totalMinutes / 15) * 15;
}

function handleDragMove(e) {
  if (!dragState || !dragState.selectionEl) return;

  const startMins = getMinutesFromY(dragState.startY, dragState.dayBody);
  const currentMins = getMinutesFromY(e.clientY, dragState.dayBody);

  const minVal = Math.min(startMins, currentMins);
  const maxVal = Math.max(startMins, currentMins);

  const topPx = (minVal / 1440) * DAY_BODY_HEIGHT;
  const heightPx = ((maxVal - minVal) / 1440) * DAY_BODY_HEIGHT;

  dragState.selectionEl.style.top = topPx + 'px';
  dragState.selectionEl.style.height = heightPx + 'px';
}

function handleDragEnd(e) {
  if (!dragState) return;

  const { dayBody, dayDate, startY, selectionEl } = dragState;
  dragState = null;

  if (selectionEl) {
    selectionEl.remove();
  }

  const startMins = getMinutesFromY(startY, dayBody);
  const endMins = getMinutesFromY(e.clientY, dayBody);

  let minVal = Math.min(startMins, endMins);
  let maxVal = Math.max(startMins, endMins);

  // If just a click (no meaningful drag), create a 1-hour event
  if (maxVal - minVal < 15) {
    maxVal = Math.min(minVal + 60, 1440);
  }

  // Clamp
  minVal = Math.max(0, minVal);
  maxVal = Math.min(1440, maxVal);

  if (maxVal <= minVal) return;

  const startDate = new Date(dayDate);
  startDate.setHours(0, 0, 0, 0);
  startDate.setMinutes(minVal);

  const endDate = new Date(dayDate);
  endDate.setHours(0, 0, 0, 0);
  endDate.setMinutes(maxVal);

  openCreateModal(startDate, endDate);
}

// ============================================================
// Modal
// ============================================================

function openCreateModal(startDate, endDate) {
  document.getElementById('modal-title').textContent = 'Create Event';
  document.getElementById('event-id').value = '';
  document.getElementById('event-title').value = '';
  document.getElementById('event-start').value = toLocalDateTimeString(startDate);
  document.getElementById('event-end').value = toLocalDateTimeString(endDate);
  document.getElementById('btn-delete').style.display = 'none';
  document.getElementById('form-error').style.display = 'none';
  document.getElementById('modal-overlay').style.display = 'flex';
  document.getElementById('event-title').focus();
}

function openEditModal(eventId) {
  const ev = events.find(e => e.id === eventId);
  if (!ev) return;

  document.getElementById('modal-title').textContent = 'Edit Event';
  document.getElementById('event-id').value = ev.id;
  document.getElementById('event-title').value = ev.title;
  document.getElementById('event-start').value = toLocalDateTimeString(ev.start_at);
  document.getElementById('event-end').value = toLocalDateTimeString(ev.end_at);
  document.getElementById('btn-delete').style.display = 'inline-block';
  document.getElementById('form-error').style.display = 'none';
  document.getElementById('modal-overlay').style.display = 'flex';
  document.getElementById('event-title').focus();
}

function closeModal() {
  document.getElementById('modal-overlay').style.display = 'none';
  document.getElementById('form-error').style.display = 'none';
}

function showFormError(msg) {
  const el = document.getElementById('form-error');
  el.textContent = msg;
  el.style.display = 'block';
}

// ============================================================
// Event Handlers
// ============================================================

async function handleFormSubmit(e) {
  e.preventDefault();

  const id = document.getElementById('event-id').value;
  const title = document.getElementById('event-title').value.trim();
  const startStr = document.getElementById('event-start').value;
  const endStr = document.getElementById('event-end').value;

  if (!title) {
    showFormError('Title is required');
    return;
  }

  const startDate = new Date(startStr);
  const endDate = new Date(endStr);

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    showFormError('Invalid date/time');
    return;
  }

  if (endDate <= startDate) {
    showFormError('End time must be after start time');
    return;
  }

  try {
    if (id) {
      await apiUpdateEvent(parseInt(id), title, startDate, endDate);
    } else {
      await apiCreateEvent(title, startDate, endDate);
    }
    closeModal();
    await loadAndRender();
  } catch (err) {
    showFormError(err.message);
  }
}

async function handleDelete() {
  const id = document.getElementById('event-id').value;
  if (!id) return;

  if (!confirm('Delete this event?')) return;

  try {
    await apiDeleteEvent(parseInt(id));
    closeModal();
    await loadAndRender();
  } catch (err) {
    showFormError(err.message);
  }
}

// ============================================================
// Navigation
// ============================================================

function navigateWeek(delta) {
  currentWeekStart = addDays(currentWeekStart, delta * 7);
  loadAndRender();
}

function goToday() {
  currentWeekStart = getMonday(new Date());
  loadAndRender();
}

// ============================================================
// Main Load & Render
// ============================================================

let initialLoad = true;

async function loadAndRender() {
  // Preserve scroll position on navigation
  const container = document.querySelector('.calendar-container');
  const prevScroll = container ? container.scrollTop : 0;

  renderWeekHeader();
  renderDayColumns();
  renderTimeGutter();

  try {
    events = await fetchEvents(currentWeekStart);
  } catch (err) {
    console.error('Failed to load events:', err);
    events = [];
  }

  renderEvents();
  setupDayClickHandlers();

  // Scroll to ~8am on initial load, preserve scroll on navigation
  if (container) {
    if (initialLoad) {
      container.scrollTop = 8 * HOUR_HEIGHT;
      initialLoad = false;
    } else {
      container.scrollTop = prevScroll;
    }
  }
}

// ============================================================
// Init
// ============================================================

function init() {
  document.getElementById('btn-prev').addEventListener('click', () => navigateWeek(-1));
  document.getElementById('btn-next').addEventListener('click', () => navigateWeek(1));
  document.getElementById('btn-today').addEventListener('click', goToday);
  document.getElementById('event-form').addEventListener('submit', handleFormSubmit);
  document.getElementById('btn-delete').addEventListener('click', handleDelete);
  document.getElementById('btn-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });

  loadAndRender();
}

document.addEventListener('DOMContentLoaded', init);
