// ============================================================
// Constants
// ============================================================
const HOUR_HEIGHT = 60; // px per hour
const TOTAL_MINUTES = 24 * 60;
const AXIS_HEIGHT = HOUR_HEIGHT * 24; // 1440px for 24 hours
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const API_BASE = '/api/events';

// ============================================================
// State
// ============================================================
let currentWeekStart = getMonday(new Date());
let events = [];

// ============================================================
// Date Utilities
// ============================================================

function getMonday(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  // JS getDay: 0=Sun, 1=Mon, ...6=Sat → offset to Monday
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

function formatTime(hours, minutes) {
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function isSameDay(d1, d2) {
  return d1.getFullYear() === d2.getFullYear() &&
         d1.getMonth() === d2.getMonth() &&
         d1.getDate() === d2.getDate();
}

function isToday(date) {
  return isSameDay(date, new Date());
}

function parseLocalDateTime(dateStr, timeStr) {
  return `${dateStr}T${timeStr}:00`;
}

// Minutes from midnight for a given date within a specific day
function minutesFromMidnight(dateTime, dayDate) {
  const dt = new Date(dateTime);
  const dayStart = new Date(dayDate);
  dayStart.setHours(0, 0, 0, 0);
  const diff = (dt.getTime() - dayStart.getTime()) / 60000;
  return Math.max(0, Math.min(TOTAL_MINUTES, diff));
}

function minutesToPx(minutes) {
  return (minutes / 60) * HOUR_HEIGHT;
}

// ============================================================
// API
// ============================================================

async function fetchEvents(weekStart) {
  const start = formatDate(weekStart) + 'T00:00:00';
  const end = formatDate(addDays(weekStart, 7)) + 'T00:00:00';
  const res = await fetch(`${API_BASE}?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
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
  if (!res.ok) throw new Error('Failed to delete event');
  return res.json();
}

// ============================================================
// Overlap Layout Engine
// ============================================================

/**
 * Given an array of events for a single day (each with startMin and endMin
 * representing minutes from midnight), compute the layout: column index and
 * total columns per cluster.
 *
 * Returns an array of { event, col, totalCols }
 */
function computeOverlapLayout(dayEvents) {
  if (dayEvents.length === 0) return [];

  // Sort by start time, then by end time (longer events first for tie-breaks)
  const sorted = [...dayEvents].sort((a, b) => {
    if (a.startMin !== b.startMin) return a.startMin - b.startMin;
    return b.endMin - a.endMin; // longer first
  });

  // Build clusters of transitively overlapping events
  const clusters = [];
  let currentCluster = [sorted[0]];
  let clusterEnd = sorted[0].endMin;

  for (let i = 1; i < sorted.length; i++) {
    const ev = sorted[i];
    if (ev.startMin < clusterEnd) {
      // Overlaps with cluster
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

  // For each cluster, assign columns greedily
  const result = [];

  for (const cluster of clusters) {
    const columns = []; // columns[i] = end time of last event in column i

    const assignments = [];
    for (const ev of cluster) {
      let placed = false;
      for (let c = 0; c < columns.length; c++) {
        if (columns[c] <= ev.startMin) {
          columns[c] = ev.endMin;
          assignments.push({ event: ev, col: c });
          placed = true;
          break;
        }
      }
      if (!placed) {
        assignments.push({ event: ev, col: columns.length });
        columns.push(ev.endMin);
      }
    }

    const totalCols = columns.length;
    for (const a of assignments) {
      result.push({ event: a.event, col: a.col, totalCols });
    }
  }

  return result;
}

// ============================================================
// Rendering
// ============================================================

function buildTimeGutter() {
  const gutter = document.getElementById('time-gutter');
  gutter.innerHTML = '';

  // Sticky header spacer
  const spacer = document.createElement('div');
  spacer.className = 'time-gutter-header';
  gutter.appendChild(spacer);

  const body = document.createElement('div');
  body.style.position = 'relative';
  body.style.height = AXIS_HEIGHT + 'px';

  for (let h = 0; h <= 24; h++) {
    const label = document.createElement('div');
    label.className = 'hour-label';
    label.style.top = (h * HOUR_HEIGHT) + 'px';
    label.textContent = formatTime(h, 0);
    body.appendChild(label);
  }

  gutter.appendChild(body);
}

function buildDayColumns() {
  const container = document.getElementById('days-container');
  container.innerHTML = '';

  for (let i = 0; i < 7; i++) {
    const dayDate = addDays(currentWeekStart, i);

    const col = document.createElement('div');
    col.className = 'day-column';
    col.dataset.dayIndex = i;
    col.dataset.date = formatDate(dayDate);

    if (isToday(dayDate)) {
      col.classList.add('today');
    }

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

    // Body (time slots)
    const body = document.createElement('div');
    body.className = 'day-body';
    body.dataset.date = formatDate(dayDate);

    // Hour lines
    for (let h = 0; h < 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = (h * HOUR_HEIGHT) + 'px';
      body.appendChild(line);

      const halfLine = document.createElement('div');
      halfLine.className = 'hour-line half';
      halfLine.style.top = (h * HOUR_HEIGHT + HOUR_HEIGHT / 2) + 'px';
      body.appendChild(halfLine);
    }

    // Bottom line at 24:00
    const bottomLine = document.createElement('div');
    bottomLine.className = 'hour-line';
    bottomLine.style.top = (24 * HOUR_HEIGHT) + 'px';
    body.appendChild(bottomLine);

    // Click/drag to create event
    setupDayBodyInteraction(body, dayDate);

    col.appendChild(body);
    container.appendChild(col);
  }
}

function renderEvents() {
  // Clear existing event blocks
  document.querySelectorAll('.event-block').forEach(el => el.remove());
  document.querySelectorAll('.selection-overlay').forEach(el => el.remove());

  // Group events by day
  for (let i = 0; i < 7; i++) {
    const dayDate = addDays(currentWeekStart, i);
    const dayStr = formatDate(dayDate);
    const nextDayDate = addDays(dayDate, 1);

    // Events that appear on this day
    const dayEvents = events
      .filter(ev => {
        const evStart = new Date(ev.start_at);
        const evEnd = new Date(ev.end_at);
        const dayStart = new Date(dayDate);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(nextDayDate);
        dayEnd.setHours(0, 0, 0, 0);
        return evStart < dayEnd && evEnd > dayStart;
      })
      .map(ev => {
        const startMin = minutesFromMidnight(ev.start_at, dayDate);
        const endMin = minutesFromMidnight(ev.end_at, dayDate);
        return { ...ev, startMin, endMin };
      })
      .filter(ev => ev.endMin > ev.startMin); // Must have visible duration

    const layout = computeOverlapLayout(dayEvents);

    const dayBody = document.querySelector(`.day-body[data-date="${dayStr}"]`);
    if (!dayBody) continue;

    for (const { event, col, totalCols } of layout) {
      const block = document.createElement('div');
      block.className = 'event-block';

      const top = minutesToPx(event.startMin);
      const height = minutesToPx(event.endMin - event.startMin);
      const widthPercent = 100 / totalCols;
      const leftPercent = col * widthPercent;

      block.style.top = top + 'px';
      block.style.height = height + 'px';
      block.style.left = leftPercent + '%';
      block.style.width = `calc(${widthPercent}% - 2px)`;

      const titleEl = document.createElement('div');
      titleEl.className = 'event-title';
      titleEl.textContent = event.title;

      const timeEl = document.createElement('div');
      timeEl.className = 'event-time';
      const sStart = new Date(event.start_at);
      const sEnd = new Date(event.end_at);
      timeEl.textContent = `${formatTime(sStart.getHours(), sStart.getMinutes())} – ${formatTime(sEnd.getHours(), sEnd.getMinutes())}`;

      block.appendChild(titleEl);
      block.appendChild(timeEl);

      block.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditModal(event);
      });

      dayBody.appendChild(block);
    }
  }
}

function updateWeekTitle() {
  const endDate = addDays(currentWeekStart, 6);
  const opts = { month: 'short', day: 'numeric', year: 'numeric' };
  const startStr = currentWeekStart.toLocaleDateString(undefined, opts);
  const endStr = endDate.toLocaleDateString(undefined, opts);
  document.getElementById('week-title').textContent = `${startStr} — ${endStr}`;
}

// ============================================================
// Day Body Interaction (click-drag to create)
// ============================================================

function setupDayBodyInteraction(dayBody, dayDate) {
  let isDragging = false;
  let startY = 0;
  let selectionEl = null;

  function yToMinutes(y) {
    // Snap to 15-minute increments
    const raw = (y / AXIS_HEIGHT) * TOTAL_MINUTES;
    return Math.max(0, Math.min(TOTAL_MINUTES, Math.round(raw / 15) * 15));
  }

  dayBody.addEventListener('mousedown', (e) => {
    if (e.target.closest('.event-block')) return;
    e.preventDefault();
    isDragging = true;
    const rect = dayBody.getBoundingClientRect();
    startY = e.clientY - rect.top;

    selectionEl = document.createElement('div');
    selectionEl.className = 'selection-overlay';
    const startMin = yToMinutes(startY);
    selectionEl.style.top = minutesToPx(startMin) + 'px';
    selectionEl.style.height = minutesToPx(15) + 'px'; // minimum 15 min
    dayBody.appendChild(selectionEl);
  });

  dayBody.addEventListener('mousemove', (e) => {
    if (!isDragging || !selectionEl) return;
    const rect = dayBody.getBoundingClientRect();
    const currentY = e.clientY - rect.top;

    const startMin = yToMinutes(startY);
    const endMin = yToMinutes(currentY);
    const top = Math.min(startMin, endMin);
    const bottom = Math.max(startMin, endMin);
    const effectiveBottom = bottom === top ? top + 15 : bottom;

    selectionEl.style.top = minutesToPx(top) + 'px';
    selectionEl.style.height = minutesToPx(effectiveBottom - top) + 'px';
  });

  const finishDrag = (e) => {
    if (!isDragging) return;
    isDragging = false;

    const rect = dayBody.getBoundingClientRect();
    const endY = e.clientY - rect.top;

    const startMin = yToMinutes(startY);
    const endMin = yToMinutes(endY);
    let top = Math.min(startMin, endMin);
    let bottom = Math.max(startMin, endMin);
    if (bottom === top) bottom = top + 30; // default 30min on click
    if (bottom > TOTAL_MINUTES) bottom = TOTAL_MINUTES;

    if (selectionEl) {
      selectionEl.remove();
      selectionEl = null;
    }

    const startHour = Math.floor(top / 60);
    const startMinute = top % 60;
    const endHour = Math.floor(bottom / 60);
    const endMinute = bottom % 60;

    openCreateModal(
      formatDate(dayDate),
      formatTime(startHour, startMinute),
      formatTime(endHour, endMinute)
    );
  };

  dayBody.addEventListener('mouseup', finishDrag);
  dayBody.addEventListener('mouseleave', (e) => {
    if (isDragging) {
      // Cancel selection on leave
      isDragging = false;
      if (selectionEl) {
        selectionEl.remove();
        selectionEl = null;
      }
    }
  });
}

// ============================================================
// Modal
// ============================================================

function showModal() {
  document.getElementById('modal-overlay').style.display = 'flex';
}

function hideModal() {
  document.getElementById('modal-overlay').style.display = 'none';
  document.getElementById('form-error').style.display = 'none';
  document.getElementById('event-form').reset();
}

function showError(msg) {
  const el = document.getElementById('form-error');
  el.textContent = msg;
  el.style.display = 'block';
}

function openCreateModal(date, startTime, endTime) {
  document.getElementById('modal-title').textContent = 'Create Event';
  document.getElementById('event-id').value = '';
  document.getElementById('event-date').value = date;
  document.getElementById('event-start').value = startTime;
  document.getElementById('event-end').value = endTime;
  document.getElementById('event-title-input').value = '';
  document.getElementById('btn-delete').style.display = 'none';
  showModal();
  document.getElementById('event-title-input').focus();
}

function openEditModal(event) {
  document.getElementById('modal-title').textContent = 'Edit Event';
  document.getElementById('event-id').value = event.id;

  const start = new Date(event.start_at);
  const end = new Date(event.end_at);

  document.getElementById('event-date').value = formatDate(start);
  document.getElementById('event-start').value = formatTime(start.getHours(), start.getMinutes());

  // Handle 24:00 (midnight next day that means end of current day)
  if (end.getHours() === 0 && end.getMinutes() === 0 && !isSameDay(start, end)) {
    document.getElementById('event-end').value = '23:59';
    // We'll store end date as same day but 24:00
  } else {
    document.getElementById('event-end').value = formatTime(end.getHours(), end.getMinutes());
  }

  document.getElementById('event-title-input').value = event.title;
  document.getElementById('btn-delete').style.display = 'inline-block';
  showModal();
}

// ============================================================
// Form Handlers
// ============================================================

document.getElementById('event-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const id = document.getElementById('event-id').value;
  const title = document.getElementById('event-title-input').value.trim();
  const date = document.getElementById('event-date').value;
  const startTime = document.getElementById('event-start').value;
  const endTime = document.getElementById('event-end').value;

  if (!title) {
    showError('Title is required');
    return;
  }

  if (!date || !startTime || !endTime) {
    showError('All fields are required');
    return;
  }

  let start_at = parseLocalDateTime(date, startTime);
  let end_at;

  // Handle end time: if "00:00" and it's meant to be end of day, use next day
  if (endTime === '00:00' || endTime <= startTime) {
    // If end is midnight or earlier than start, we treat it as next day midnight
    if (endTime === '00:00') {
      const nextDay = addDays(new Date(date), 1);
      end_at = parseLocalDateTime(formatDate(nextDay), '00:00');
    } else {
      showError('End time must be after start time');
      return;
    }
  } else {
    end_at = parseLocalDateTime(date, endTime);
  }

  try {
    if (id) {
      await updateEvent(id, { title, start_at, end_at });
    } else {
      await createEvent({ title, start_at, end_at });
    }
    hideModal();
    await loadEvents();
  } catch (err) {
    showError(err.message);
  }
});

document.getElementById('btn-delete').addEventListener('click', async () => {
  const id = document.getElementById('event-id').value;
  if (!id) return;

  if (confirm('Delete this event?')) {
    try {
      await deleteEvent(id);
      hideModal();
      await loadEvents();
    } catch (err) {
      showError(err.message);
    }
  }
});

document.getElementById('btn-cancel').addEventListener('click', () => {
  hideModal();
});

document.getElementById('modal-overlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) {
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
// Main
// ============================================================

async function loadEvents() {
  events = await fetchEvents(currentWeekStart);
  renderEvents();
}

async function renderWeek() {
  updateWeekTitle();
  buildTimeGutter();
  buildDayColumns();
  await loadEvents();

  // Scroll to ~8am
  const container = document.querySelector('.calendar-container');
  container.scrollTop = 8 * HOUR_HEIGHT;
}

// Initial render
renderWeek();
