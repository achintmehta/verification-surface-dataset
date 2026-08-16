const API_BASE = '/api';

let currentWeekStart = null; // Monday of current week
let events = [];

// Utility functions
function getMonday(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(d.setDate(diff));
}

function formatDateRange(start, end) {
  const opts = { month: 'short', day: 'numeric' };
  return `${start.toLocaleDateString(undefined, opts)} – ${end.toLocaleDateString(undefined, opts)}`;
}

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function toLocalISOString(date) {
  const pad = n => n.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseLocalDateTime(str) {
  return new Date(str);
}

// Fetch events for the week
async function fetchEvents(weekStart, weekEnd) {
  const startISO = weekStart.toISOString();
  const endISO = weekEnd.toISOString();
  const res = await fetch(`${API_BASE}/events?start=${encodeURIComponent(startISO)}&end=${encodeURIComponent(endISO)}`);
  if (!res.ok) throw new Error('Failed to fetch events');
  return res.json();
}

// Create event
async function createEvent(eventData) {
  const res = await fetch(`${API_BASE}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(eventData)
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to create event');
  }
  return res.json();
}

// Update event
async function updateEvent(id, eventData) {
  const res = await fetch(`${API_BASE}/events/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(eventData)
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to update event');
  }
  return res.json();
}

// Delete event
async function deleteEvent(id) {
  const res = await fetch(`${API_BASE}/events/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete event');
}

// Overlap layout engine
function computeLayout(eventsForDay) {
  if (!eventsForDay.length) return [];

  // Sort by start time
  const sorted = [...eventsForDay].sort((a, b) => new Date(a.start_at) - new Date(b.start_at));

  // Find clusters (transitively overlapping groups)
  const clusters = [];
  let currentCluster = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const evt = sorted[i];
    const clusterEnd = new Date(Math.max(...currentCluster.map(e => new Date(e.end_at))));
    if (new Date(evt.start_at) < clusterEnd) {
      currentCluster.push(evt);
    } else {
      clusters.push(currentCluster);
      currentCluster = [evt];
    }
  }
  clusters.push(currentCluster);

  const layout = [];

  for (const cluster of clusters) {
    // Assign columns greedily
    const columns = []; // array of end times for each column
    const eventColumns = new Map();

    for (const evt of cluster.sort((a, b) => new Date(a.start_at) - new Date(b.start_at))) {
      let assignedCol = 0;
      for (let c = 0; c < columns.length; c++) {
        if (new Date(columns[c]) <= new Date(evt.start_at)) {
          assignedCol = c;
          break;
        }
        assignedCol = c + 1;
      }
      if (assignedCol >= columns.length) {
        columns.push(evt.end_at);
      } else {
        columns[assignedCol] = evt.end_at;
      }
      eventColumns.set(evt, assignedCol);
    }

    const numCols = columns.length;
    const colWidth = 100 / numCols;

    for (const evt of cluster) {
      const col = eventColumns.get(evt);
      layout.push({
        ...evt,
        col,
        numCols,
        colWidth,
        left: col * colWidth,
        width: colWidth
      });
    }
  }

  return layout;
}

// Render the calendar
function renderCalendar(weekStart, weekEvents) {
  const container = document.getElementById('days-container');
  const timeAxis = document.getElementById('time-axis');
  container.innerHTML = '';
  timeAxis.innerHTML = '';

  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);

  document.getElementById('week-range').textContent = formatDateRange(weekStart, weekEnd);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Render time axis (00:00 to 24:00)
  const HOUR_HEIGHT = 60; // pixels per hour
  const TOTAL_HEIGHT = 24 * HOUR_HEIGHT;

  timeAxis.style.height = `${TOTAL_HEIGHT}px`;

  for (let h = 0; h <= 24; h++) {
    const line = document.createElement('div');
    line.className = `hour-line ${h % 1 === 0 ? 'major' : ''}`;
    line.style.top = `${h * HOUR_HEIGHT}px`;
    timeAxis.appendChild(line);

    if (h < 24) {
      const label = document.createElement('div');
      label.className = 'hour-label';
      label.style.top = `${h * HOUR_HEIGHT + 2}px`;
      label.textContent = `${h.toString().padStart(2, '0')}:00`;
      timeAxis.appendChild(label);
    }
  }

  // Render 7 day columns
  for (let d = 0; d < 7; d++) {
    const dayDate = new Date(weekStart);
    dayDate.setDate(dayDate.getDate() + d);

    const dayCol = document.createElement('div');
    dayCol.className = 'day-column';
    if (dayDate.getTime() === today.getTime()) {
      dayCol.classList.add('today');
    }
    dayCol.style.height = `${TOTAL_HEIGHT}px`;

    // Day header
    const header = document.createElement('div');
    header.className = 'day-header';
    if (dayDate.getTime() === today.getTime()) header.classList.add('today');
    const dayName = dayDate.toLocaleDateString(undefined, { weekday: 'short' });
    const dateNum = dayDate.getDate();
    header.innerHTML = `${dayName}<br><small>${dateNum}</small>`;
    dayCol.appendChild(header);

    // Hour lines for visual grid
    for (let h = 0; h <= 24; h++) {
      const line = document.createElement('div');
      line.className = `hour-line ${h % 1 === 0 ? 'major' : ''}`;
      line.style.top = `${h * HOUR_HEIGHT}px`;
      dayCol.appendChild(line);
    }

    // Get events for this day
    const dayStart = new Date(dayDate);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayDate);
    dayEnd.setHours(24, 0, 0, 0);

    const dayEvents = weekEvents.filter(e => {
      const es = new Date(e.start_at);
      const ee = new Date(e.end_at);
      return es < dayEnd && ee > dayStart;
    });

    // Compute layout
    const laidOut = computeLayout(dayEvents);

    // Render events
    for (const evt of laidOut) {
      const eventEl = document.createElement('div');
      eventEl.className = 'event';

      const start = new Date(evt.start_at);
      const end = new Date(evt.end_at);

      // Clamp to day
      const visibleStart = Math.max(start, dayStart);
      const visibleEnd = Math.min(end, dayEnd);

      const minutesFromMidnightStart = (visibleStart.getHours() * 60 + visibleStart.getMinutes());
      const minutesFromMidnightEnd = (visibleEnd.getHours() * 60 + visibleEnd.getMinutes());

      const top = (minutesFromMidnightStart / 60) * HOUR_HEIGHT;
      const height = Math.max(((minutesFromMidnightEnd - minutesFromMidnightStart) / 60) * HOUR_HEIGHT, 20);

      eventEl.style.top = `${top}px`;
      eventEl.style.height = `${height}px`;
      eventEl.style.left = `${evt.left}%`;
      eventEl.style.width = `${evt.width}%`;

      const titleEl = document.createElement('div');
      titleEl.className = 'event-title';
      titleEl.textContent = evt.title;

      const timeEl = document.createElement('div');
      timeEl.className = 'event-time';
      timeEl.textContent = `${formatTime(start)} – ${formatTime(end)}`;

      eventEl.appendChild(titleEl);
      eventEl.appendChild(timeEl);

      // Click to edit
      eventEl.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditModal(evt);
      });

      dayCol.appendChild(eventEl);
    }

    // Click to create on empty space
    dayCol.addEventListener('click', (e) => {
      if (e.target.classList.contains('event') || e.target.closest('.event')) return;

      const rect = dayCol.getBoundingClientRect();
      const headerHeight = 50;
      const clickY = e.clientY - rect.top - headerHeight;
      const minutes = Math.floor((clickY / HOUR_HEIGHT) * 60);
      const roundedMinutes = Math.round(minutes / 15) * 15; // snap to 15 min

      const startTime = new Date(dayDate);
      startTime.setHours(0, 0, 0, 0);
      startTime.setMinutes(roundedMinutes);

      const endTime = new Date(startTime);
      endTime.setHours(startTime.getHours() + 1);

      openCreateModal(startTime, endTime);
    });

    container.appendChild(dayCol);
  }
}

// Modal handling
let modal = null;
let form = null;

function initModal() {
  modal = document.getElementById('event-modal');
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
  document.getElementById('start').value = toLocalISOString(start);
  document.getElementById('end').value = toLocalISOString(end);
  document.getElementById('delete-btn').classList.add('hidden');
  modal.classList.remove('hidden');
}

function openEditModal(event) {
  document.getElementById('modal-title').textContent = 'Edit Event';
  document.getElementById('event-id').value = event.id;
  document.getElementById('title').value = event.title;
  document.getElementById('start').value = toLocalISOString(new Date(event.start_at));
  document.getElementById('end').value = toLocalISOString(new Date(event.end_at));
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
  const start = document.getElementById('start').value;
  const end = document.getElementById('end').value;

  if (!title) {
    alert('Title is required');
    return;
  }

  const startDate = parseLocalDateTime(start);
  const endDate = parseLocalDateTime(end);

  if (endDate <= startDate) {
    alert('End time must be after start time');
    return;
  }

  const eventData = {
    title,
    start_at: startDate.toISOString(),
    end_at: endDate.toISOString()
  };

  try {
    if (id) {
      await updateEvent(id, eventData);
    } else {
      await createEvent(eventData);
    }
    closeModal();
    await loadAndRenderWeek();
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
    await loadAndRenderWeek();
  } catch (err) {
    alert(err.message);
  }
}

// Navigation
function navigateWeek(offset) {
  currentWeekStart.setDate(currentWeekStart.getDate() + offset * 7);
  loadAndRenderWeek();
}

function goToToday() {
  currentWeekStart = getMonday(new Date());
  loadAndRenderWeek();
}

// Main load function
async function loadAndRenderWeek() {
  if (!currentWeekStart) {
    currentWeekStart = getMonday(new Date());
  }

  const weekEnd = new Date(currentWeekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);

  try {
    events = await fetchEvents(currentWeekStart, weekEnd);
    renderCalendar(currentWeekStart, events);
  } catch (err) {
    console.error(err);
    alert('Failed to load events');
  }
}

// Initialize app
function initApp() {
  initModal();

  document.getElementById('prev-week').addEventListener('click', () => navigateWeek(-1));
  document.getElementById('today').addEventListener('click', goToToday);
  document.getElementById('next-week').addEventListener('click', () => navigateWeek(1));

  loadAndRenderWeek();
}

initApp();