const API_BASE = '/api';
const HOUR_HEIGHT = 30; // pixels per hour
const TOTAL_HOURS = 24;
const CALENDAR_HEIGHT = HOUR_HEIGHT * TOTAL_HOURS;

let currentWeekStart = null; // Monday of current week
let events = [];

// Utility: Get Monday of a given date
function getMonday(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(d.setDate(diff));
}

// Format date range for header
function formatWeekRange(start) {
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const opts = { month: 'short', day: 'numeric' };
  return `${start.toLocaleDateString(undefined, opts)} – ${end.toLocaleDateString(undefined, opts)}`;
}

// Get ISO week dates for 7 days
function getWeekDays(start) {
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    days.push(d);
  }
  return days;
}

// Format datetime-local input value
function toDateTimeLocal(date) {
  const pad = n => n.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Parse datetime-local to Date
function fromDateTimeLocal(str) {
  return new Date(str);
}

// Fetch events for the week
async function fetchEvents(start, end) {
  const startIso = start.toISOString();
  const endIso = end.toISOString();
  const res = await fetch(`${API_BASE}/events?start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}`);
  if (!res.ok) throw new Error('Failed to fetch events');
  return res.json();
}

// Create event
async function createEvent(title, start_at, end_at) {
  const res = await fetch(`${API_BASE}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, start_at: start_at.toISOString(), end_at: end_at.toISOString() })
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to create event');
  }
  return res.json();
}

// Update event
async function updateEvent(id, title, start_at, end_at) {
  const res = await fetch(`${API_BASE}/events/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, start_at: start_at.toISOString(), end_at: end_at.toISOString() })
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to update event');
  }
  return res.json();
}

// Delete event
async function deleteEvent(id) {
  const res = await fetch(`${API_BASE}/events/${id}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 204) {
    throw new Error('Failed to delete event');
  }
}

// Render time axis
function renderTimeAxis(container) {
  container.innerHTML = '';
  container.style.height = `${CALENDAR_HEIGHT}px`;
  for (let h = 0; h <= 24; h++) {
    const label = document.createElement('div');
    label.className = 'hour-label';
    label.style.top = `${h * HOUR_HEIGHT}px`;
    label.textContent = `${h.toString().padStart(2, '0')}:00`;
    container.appendChild(label);

    if (h < 24) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${h * HOUR_HEIGHT}px`;
      container.appendChild(line);
    }
  }
}

// Compute overlap clusters and column assignment for a day's events
function computeDayLayout(dayEvents, dayStart, dayEnd) {
  if (!dayEvents.length) return [];

  // Sort by start time
  const sorted = [...dayEvents].sort((a, b) => new Date(a.start_at) - new Date(b.start_at));

  // Find clusters: groups of transitively overlapping events
  const clusters = [];
  let currentCluster = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const evt = sorted[i];
    const clusterEnd = new Date(Math.max(...currentCluster.map(e => new Date(e.end_at).getTime())));
    if (new Date(evt.start_at) < clusterEnd) {
      currentCluster.push(evt);
    } else {
      clusters.push(currentCluster);
      currentCluster = [evt];
    }
  }
  clusters.push(currentCluster);

  // For each cluster, assign columns greedily
  const layoutItems = [];

  clusters.forEach(cluster => {
    const n = cluster.length;
    // Sort cluster by start for greedy column assignment
    const clusterSorted = [...cluster].sort((a, b) => new Date(a.start_at) - new Date(b.start_at));

    const columnAssignments = new Array(n).fill(0);
    const columnEndTimes = new Array(n).fill(null); // track end time per column

    for (let i = 0; i < n; i++) {
      const evt = clusterSorted[i];
      const start = new Date(evt.start_at);
      let assignedCol = 0;
      for (let c = 0; c < n; c++) {
        if (!columnEndTimes[c] || new Date(columnEndTimes[c]) <= start) {
          assignedCol = c;
          break;
        }
      }
      columnAssignments[i] = assignedCol;
      columnEndTimes[assignedCol] = evt.end_at;
    }

    // Map back to original events with layout info
    clusterSorted.forEach((evt, idx) => {
      const col = columnAssignments[idx];
      const width = 100 / n;
      const left = col * width;

      const start = new Date(evt.start_at);
      const end = new Date(evt.end_at);

      // Clamp to day
      const visibleStart = Math.max(start, dayStart);
      const visibleEnd = Math.min(end, dayEnd);

      const top = ((visibleStart - dayStart) / (1000 * 60 * 60)) * HOUR_HEIGHT;
      const height = ((visibleEnd - visibleStart) / (1000 * 60 * 60)) * HOUR_HEIGHT;

      layoutItems.push({
        ...evt,
        leftPercent: left,
        widthPercent: width,
        top: Math.max(0, top),
        height: Math.max(10, height) // min height for visibility
      });
    });
  });

  return layoutItems;
}

// Render a single day column
function renderDayColumn(dayDate, dayEvents, container, weekStart) {
  const col = document.createElement('div');
  col.className = 'day-column';

  const dayStart = new Date(dayDate);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayDate);
  dayEnd.setHours(24, 0, 0, 0);

  // Header
  const header = document.createElement('div');
  header.className = 'day-header';
  const isToday = dayDate.toDateString() === new Date().toDateString();
  if (isToday) header.classList.add('today');
  const dayName = dayDate.toLocaleDateString(undefined, { weekday: 'short' });
  const dateNum = dayDate.getDate();
  header.textContent = `${dayName} ${dateNum}`;
  col.appendChild(header);

  // Hour lines (visual)
  for (let h = 0; h < 24; h++) {
    const line = document.createElement('div');
    line.className = 'hour-line';
    line.style.top = `${h * HOUR_HEIGHT}px`;
    col.appendChild(line);
  }

  // Compute layout
  const layoutEvents = computeDayLayout(dayEvents, dayStart, dayEnd);

  // Render events
  layoutEvents.forEach(evt => {
    const eventEl = document.createElement('div');
    eventEl.className = 'event';
    eventEl.style.top = `${evt.top}px`;
    eventEl.style.height = `${evt.height}px`;
    eventEl.style.left = `${evt.leftPercent}%`;
    eventEl.style.width = `${evt.widthPercent}%`;

    const startTime = new Date(evt.start_at);
    const endTime = new Date(evt.end_at);
    const timeStr = `${startTime.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})} - ${endTime.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}`;

    eventEl.innerHTML = `
      <div class="event-title">${evt.title}</div>
      <div class="event-time">${timeStr}</div>
    `;

    eventEl.addEventListener('click', (e) => {
      e.stopPropagation();
      openEditModal(evt);
    });

    col.appendChild(eventEl);
  });

  // Click to create on empty space
  col.addEventListener('click', (e) => {
    if (e.target.classList.contains('day-column') || e.target.classList.contains('hour-line')) {
      const rect = col.getBoundingClientRect();
      const clickY = e.clientY - rect.top;
      const hour = clickY / HOUR_HEIGHT;
      const startHour = Math.floor(hour);
      const startMin = Math.floor((hour - startHour) * 60 / 15) * 15; // snap to 15 min? but minute precision ok, use 0 for simplicity or exact

      const start = new Date(dayDate);
      start.setHours(startHour, startMin || 0, 0, 0);

      const end = new Date(start);
      end.setHours(start.getHours() + 1);

      openCreateModal(start, end);
    }
  });

  // Also support drag selection? For simplicity, click opens with 1h default, but to support range, we can do mousedown/mouseup
  // Implement simple drag for range selection
  let dragStartY = null;
  col.addEventListener('mousedown', (e) => {
    if (e.target.classList.contains('day-column') || e.target.classList.contains('hour-line')) {
      const rect = col.getBoundingClientRect();
      dragStartY = e.clientY - rect.top;
    }
  });

  col.addEventListener('mouseup', (e) => {
    if (dragStartY !== null && (e.target.classList.contains('day-column') || e.target.classList.contains('hour-line'))) {
      const rect = col.getBoundingClientRect();
      const dragEndY = e.clientY - rect.top;
      const startHour = Math.min(dragStartY, dragEndY) / HOUR_HEIGHT;
      const endHour = Math.max(dragStartY, dragEndY) / HOUR_HEIGHT;

      const start = new Date(dayDate);
      start.setHours(Math.floor(startHour), Math.floor((startHour % 1) * 60), 0, 0);

      const end = new Date(dayDate);
      end.setHours(Math.floor(endHour), Math.ceil((endHour % 1) * 60) || 0, 0, 0);
      if (end <= start) end.setHours(start.getHours() + 1);

      openCreateModal(start, end);
      dragStartY = null;
    }
  });

  container.appendChild(col);
}

// Main render function
async function renderWeek(weekStart) {
  currentWeekStart = new Date(weekStart);
  currentWeekStart.setHours(0,0,0,0);

  const weekEnd = new Date(currentWeekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);

  document.getElementById('week-range').textContent = formatWeekRange(currentWeekStart);

  // Fetch events
  try {
    events = await fetchEvents(currentWeekStart, weekEnd);
  } catch (e) {
    console.error(e);
    events = [];
  }

  // Render calendar
  const daysContainer = document.getElementById('days-container');
  daysContainer.innerHTML = '';
  daysContainer.style.height = `${CALENDAR_HEIGHT}px`;

  const timeAxis = document.getElementById('time-axis');
  renderTimeAxis(timeAxis);

  const weekDays = getWeekDays(currentWeekStart);

  weekDays.forEach(day => {
    const dayStart = new Date(day); dayStart.setHours(0,0,0,0);
    const dayEnd = new Date(day); dayEnd.setHours(24,0,0,0);

    const dayEvents = events.filter(evt => {
      const s = new Date(evt.start_at);
      const e = new Date(evt.end_at);
      return s < dayEnd && e > dayStart;
    });

    renderDayColumn(day, dayEvents, daysContainer, currentWeekStart);
  });
}

// Modal handling
let modal = null;
let form = null;

function setupModal() {
  modal = document.getElementById('modal');
  form = document.getElementById('event-form');

  document.getElementById('cancel-btn').addEventListener('click', closeModal);
  document.getElementById('delete-btn').addEventListener('click', handleDelete);

  form.addEventListener('submit', handleFormSubmit);

  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });
}

function openCreateModal(start, end) {
  document.getElementById('modal-title').textContent = 'Create Event';
  document.getElementById('event-id').value = '';
  document.getElementById('title').value = '';
  document.getElementById('start').value = toDateTimeLocal(start);
  document.getElementById('end').value = toDateTimeLocal(end);
  document.getElementById('delete-btn').classList.add('hidden');
  modal.classList.remove('hidden');
}

function openEditModal(evt) {
  document.getElementById('modal-title').textContent = 'Edit Event';
  document.getElementById('event-id').value = evt.id;
  document.getElementById('title').value = evt.title;
  document.getElementById('start').value = toDateTimeLocal(new Date(evt.start_at));
  document.getElementById('end').value = toDateTimeLocal(new Date(evt.end_at));
  document.getElementById('delete-btn').classList.remove('hidden');
  modal.classList.remove('hidden');
}

function closeModal() {
  modal.classList.add('hidden');
}

async function handleFormSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('event-id').value;
  const title = document.getElementById('title').value.trim();
  const startStr = document.getElementById('start').value;
  const endStr = document.getElementById('end').value;

  if (!title || !startStr || !endStr) {
    alert('Please fill all fields');
    return;
  }

  const start = fromDateTimeLocal(startStr);
  const end = fromDateTimeLocal(endStr);

  try {
    if (id) {
      await updateEvent(id, title, start, end);
    } else {
      await createEvent(title, start, end);
    }
    closeModal();
    await renderWeek(currentWeekStart);
  } catch (err) {
    alert(err.message);
  }
}

async function handleDelete() {
  const id = document.getElementById('event-id').value;
  if (!id) return;
  if (!confirm('Delete this event?')) return;

  try {
    await deleteEvent(id);
    closeModal();
    await renderWeek(currentWeekStart);
  } catch (err) {
    alert(err.message);
  }
}

// Navigation
function setupNavigation() {
  document.getElementById('prev-week').addEventListener('click', () => {
    const prev = new Date(currentWeekStart);
    prev.setDate(prev.getDate() - 7);
    renderWeek(prev);
  });

  document.getElementById('today').addEventListener('click', () => {
    const today = getMonday(new Date());
    renderWeek(today);
  });

  document.getElementById('next-week').addEventListener('click', () => {
    const next = new Date(currentWeekStart);
    next.setDate(next.getDate() + 7);
    renderWeek(next);
  });
}

// Initialize
async function init() {
  setupModal();
  setupNavigation();

  // Start with current week
  const monday = getMonday(new Date());
  await renderWeek(monday);
}

init().catch(console.error);