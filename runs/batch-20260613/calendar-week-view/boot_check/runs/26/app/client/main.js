const API_BASE = '/api';
const HOUR_HEIGHT = 30; // pixels per hour
const TOTAL_HOURS = 24;
const CALENDAR_HEIGHT = HOUR_HEIGHT * TOTAL_HOURS; // 720px

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
  return `${start.toLocaleDateString(undefined, opts)} - ${end.toLocaleDateString(undefined, opts)}`;
}

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDateTimeLocal(date) {
  const pad = n => n.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseDateTimeLocal(str) {
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
function renderTimeAxis() {
  const axis = document.getElementById('time-axis');
  axis.innerHTML = '';
  axis.style.height = `${CALENDAR_HEIGHT}px`;

  for (let hour = 0; hour <= 24; hour++) {
    const label = document.createElement('div');
    label.className = 'hour-label';
    label.style.top = `${hour * HOUR_HEIGHT}px`;
    label.textContent = hour === 24 ? '24:00' : `${hour.toString().padStart(2, '0')}:00`;
    axis.appendChild(label);

    if (hour < 24) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${hour * HOUR_HEIGHT}px`;
      axis.appendChild(line);
    }
  }
}

// Render day columns
function renderDayColumns(weekStart) {
  const container = document.getElementById('days-container');
  container.innerHTML = '';
  container.style.height = `${CALENDAR_HEIGHT}px`;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 0; i < 7; i++) {
    const dayDate = new Date(weekStart);
    dayDate.setDate(weekStart.getDate() + i);

    const column = document.createElement('div');
    column.className = 'day-column';
    column.dataset.date = dayDate.toISOString().split('T')[0];

    const header = document.createElement('div');
    header.className = 'day-header';
    const dayName = dayDate.toLocaleDateString(undefined, { weekday: 'short' });
    const dateNum = dayDate.getDate();
    header.textContent = `${dayName} ${dateNum}`;
    if (dayDate.getTime() === today.getTime()) {
      header.classList.add('today');
    }
    column.appendChild(header);

    // Add hour lines for visual grid
    for (let h = 0; h < 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${h * HOUR_HEIGHT}px`;
      column.appendChild(line);
    }

    // Click to create event
    column.addEventListener('click', (e) => {
      if (e.target.classList.contains('event') || e.target.closest('.event')) return;
      
      const rect = column.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const minutesFromMidnight = Math.floor((y / HOUR_HEIGHT) * 60);
      const startHour = Math.floor(minutesFromMidnight / 60);
      const startMin = minutesFromMidnight % 60;
      
      const start = new Date(dayDate);
      start.setHours(startHour, startMin, 0, 0);
      
      const end = new Date(start);
      end.setHours(start.getHours() + 1);

      openCreateModal(start, end);
    });

    container.appendChild(column);
  }
}

// Cluster-based overlap layout algorithm
function computeEventLayout(dayEvents) {
  if (!dayEvents.length) return [];

  // Sort by start time
  const sorted = [...dayEvents].sort((a, b) => new Date(a.start_at) - new Date(b.start_at));

  // Find overlap clusters (transitive)
  const clusters = [];
  let currentCluster = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const evt = sorted[i];
    const clusterEnd = Math.max(...currentCluster.map(e => new Date(e.end_at).getTime()));
    if (new Date(evt.start_at).getTime() < clusterEnd) {
      currentCluster.push(evt);
    } else {
      clusters.push(currentCluster);
      currentCluster = [evt];
    }
  }
  clusters.push(currentCluster);

  const layouts = [];

  clusters.forEach(cluster => {
    // Greedy column assignment
    const columns = []; // array of end times for each column
    const eventColumns = new Map();

    cluster.forEach(evt => {
      const start = new Date(evt.start_at).getTime();
      let assignedCol = 0;
      
      // Find first available column
      for (let c = 0; c < columns.length; c++) {
        if (columns[c] <= start) {
          assignedCol = c;
          break;
        }
        assignedCol = c + 1;
      }
      
      if (assignedCol >= columns.length) {
        columns.push(new Date(evt.end_at).getTime());
      } else {
        columns[assignedCol] = new Date(evt.end_at).getTime();
      }
      
      eventColumns.set(evt, assignedCol);
    });

    const numCols = columns.length;
    const colWidth = 100 / numCols;

    cluster.forEach(evt => {
      const colIdx = eventColumns.get(evt);
      const left = colIdx * colWidth;
      const width = colWidth;

      layouts.push({
        ...evt,
        leftPercent: left,
        widthPercent: width
      });
    });
  });

  return layouts;
}

// Render events for the week
function renderEvents() {
  // Clear existing events
  document.querySelectorAll('.event').forEach(el => el.remove());

  const dayColumns = document.querySelectorAll('.day-column');

  // Group events by day
  const eventsByDay = {};
  dayColumns.forEach(col => {
    eventsByDay[col.dataset.date] = [];
  });

  events.forEach(evt => {
    const start = new Date(evt.start_at);
    const end = new Date(evt.end_at);
    const dayKey = start.toISOString().split('T')[0];
    
    if (eventsByDay[dayKey]) {
      eventsByDay[dayKey].push(evt);
    } else {
      // Handle events starting on previous days but visible? For simplicity, skip or clamp
      // But per spec, clamp to day, but for week view we assume events within week mostly
    }
  });

  // Also handle events that cross days? For now, render only on start day, but better to split? 
  // Per requirements, events are per day column, assume no cross or handle start day.
  // To be better, let's render on the day it starts, and clamp if ends next day.

  Object.keys(eventsByDay).forEach(dateKey => {
    const column = Array.from(dayColumns).find(c => c.dataset.date === dateKey);
    if (!column) return;

    const dayEvents = events.filter(evt => {
      const s = new Date(evt.start_at);
      return s.toISOString().split('T')[0] === dateKey;
    });

    const laidOut = computeEventLayout(dayEvents);

    laidOut.forEach(evt => {
      const start = new Date(evt.start_at);
      const end = new Date(evt.end_at);
      
      // Compute top and height, clamped to day
      const dayStart = new Date(start);
      dayStart.setHours(0, 0, 0, 0);
      
      let minutesFromStart = (start - dayStart) / (1000 * 60);
      let durationMinutes = (end - start) / (1000 * 60);
      
      // Clamp
      if (minutesFromStart < 0) minutesFromStart = 0;
      if (minutesFromStart + durationMinutes > 24 * 60) {
        durationMinutes = 24 * 60 - minutesFromStart;
      }

      const top = (minutesFromStart / 60) * HOUR_HEIGHT;
      const height = (durationMinutes / 60) * HOUR_HEIGHT;

      const eventEl = document.createElement('div');
      eventEl.className = 'event';
      eventEl.style.top = `${top}px`;
      eventEl.style.height = `${Math.max(height, 20)}px`; // min height
      eventEl.style.left = `${evt.leftPercent}%`;
      eventEl.style.width = `${evt.widthPercent}%`;

      const titleEl = document.createElement('div');
      titleEl.className = 'event-title';
      titleEl.textContent = evt.title;

      const timeEl = document.createElement('div');
      timeEl.className = 'event-time';
      timeEl.textContent = `${formatTime(start)} - ${formatTime(end)}`;

      eventEl.appendChild(titleEl);
      eventEl.appendChild(timeEl);

      eventEl.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditModal(evt);
      });

      column.appendChild(eventEl);
    });
  });
}

// Navigation
function updateWeek(weekStart) {
  currentWeekStart = new Date(weekStart);
  const weekEnd = new Date(currentWeekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);

  document.getElementById('week-range').textContent = formatDateRange(currentWeekStart, weekEnd);

  renderDayColumns(currentWeekStart);
  loadAndRenderEvents();
}

async function loadAndRenderEvents() {
  if (!currentWeekStart) return;
  const weekEnd = new Date(currentWeekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);

  try {
    events = await fetchEvents(currentWeekStart, weekEnd);
    renderEvents();
  } catch (err) {
    console.error(err);
    alert('Failed to load events');
  }
}

// Modal handling
let modalMode = 'create'; // 'create' or 'edit'
let currentEventId = null;

function openCreateModal(start, end) {
  modalMode = 'create';
  currentEventId = null;

  document.getElementById('modal-title').textContent = 'Create Event';
  document.getElementById('title').value = '';
  document.getElementById('start').value = formatDateTimeLocal(start);
  document.getElementById('end').value = formatDateTimeLocal(end);
  document.getElementById('delete-btn').classList.add('hidden');

  document.getElementById('modal').classList.remove('hidden');
}

function openEditModal(evt) {
  modalMode = 'edit';
  currentEventId = evt.id;

  document.getElementById('modal-title').textContent = 'Edit Event';
  document.getElementById('title').value = evt.title;
  document.getElementById('start').value = formatDateTimeLocal(new Date(evt.start_at));
  document.getElementById('end').value = formatDateTimeLocal(new Date(evt.end_at));
  document.getElementById('delete-btn').classList.remove('hidden');

  document.getElementById('modal').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('modal').classList.add('hidden');
}

// Form submit
async function handleFormSubmit(e) {
  e.preventDefault();

  const title = document.getElementById('title').value.trim();
  const startStr = document.getElementById('start').value;
  const endStr = document.getElementById('end').value;

  if (!title) {
    alert('Title cannot be empty');
    return;
  }

  const start = parseDateTimeLocal(startStr);
  const end = parseDateTimeLocal(endStr);

  if (end <= start) {
    alert('End time must be after start time');
    return;
  }

  try {
    if (modalMode === 'create') {
      await createEvent(title, start, end);
    } else {
      await updateEvent(currentEventId, title, start, end);
    }
    closeModal();
    await loadAndRenderEvents();
  } catch (err) {
    alert(err.message);
  }
}

async function handleDelete() {
  if (!currentEventId) return;
  if (!confirm('Delete this event?')) return;

  try {
    await deleteEvent(currentEventId);
    closeModal();
    await loadAndRenderEvents();
  } catch (err) {
    alert(err.message);
  }
}

// Initialize
function init() {
  renderTimeAxis();

  // Set initial week to current Monday
  const now = new Date();
  const monday = getMonday(now);
  updateWeek(monday);

  // Navigation
  document.getElementById('prev-week').addEventListener('click', () => {
    const prev = new Date(currentWeekStart);
    prev.setDate(prev.getDate() - 7);
    updateWeek(prev);
  });

  document.getElementById('today').addEventListener('click', () => {
    const monday = getMonday(new Date());
    updateWeek(monday);
  });

  document.getElementById('next-week').addEventListener('click', () => {
    const next = new Date(currentWeekStart);
    next.setDate(next.getDate() + 7);
    updateWeek(next);
  });

  // Modal
  document.getElementById('event-form').addEventListener('submit', handleFormSubmit);
  document.getElementById('cancel-btn').addEventListener('click', closeModal);
  document.getElementById('delete-btn').addEventListener('click', handleDelete);

  // Close modal on outside click
  document.getElementById('modal').addEventListener('click', (e) => {
    if (e.target.id === 'modal') closeModal();
  });

  // Keyboard escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });
}

init();