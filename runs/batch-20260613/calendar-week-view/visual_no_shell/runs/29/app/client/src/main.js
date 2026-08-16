const API_BASE = '/api';
const HOUR_HEIGHT = 30; // pixels per hour
const TOTAL_HOURS = 24;
const AXIS_HEIGHT = TOTAL_HOURS * HOUR_HEIGHT;

let currentWeekStart = getWeekStart(new Date());
let events = [];
let modal = null;

function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday
  const monday = new Date(d.setDate(diff));
  monday.setHours(0, 0, 0, 0);
  return monday;
}

function getWeekDays(weekStart) {
  const days = [];
  for (let i = 0; i < 7; i++) {
    const day = new Date(weekStart);
    day.setDate(day.getDate() + i);
    days.push(day);
  }
  return days;
}

function formatDateHeader(date) {
  return {
    name: date.toLocaleDateString('en-US', { weekday: 'short' }),
    date: date.getDate()
  };
}

function isToday(date) {
  const today = new Date();
  return date.toDateString() === today.toDateString();
}

function formatTime(date) {
  return date.toLocaleTimeString('en-US', { 
    hour: 'numeric', 
    minute: '2-digit',
    hour12: true 
  }).toLowerCase();
}

function minutesFromMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

function getDayBounds(day) {
  const start = new Date(day);
  start.setHours(0, 0, 0, 0);
  const end = new Date(day);
  end.setHours(24, 0, 0, 0);
  return { start, end };
}

// Fetch events for the week
async function fetchEvents(weekStart) {
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);
  
  const startISO = weekStart.toISOString();
  const endISO = weekEnd.toISOString();
  
  const res = await fetch(`${API_BASE}/events?start=${startISO}&end=${endISO}`);
  if (!res.ok) throw new Error('Failed to fetch events');
  return res.json();
}

// Event CRUD
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

async function deleteEvent(id) {
  const res = await fetch(`${API_BASE}/events/${id}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 204) {
    throw new Error('Failed to delete event');
  }
}

// Overlap layout engine
function eventsOverlap(a, b) {
  return a.start < b.end && b.start < a.end;
}

function computeLayout(eventsForDay, dayStart, dayEnd) {
  if (!eventsForDay.length) return [];

  // Clamp events to day and filter those visible in day
  const visibleEvents = eventsForDay
    .map(ev => {
      const start = new Date(Math.max(ev.start.getTime(), dayStart.getTime()));
      const end = new Date(Math.min(ev.end.getTime(), dayEnd.getTime()));
      if (start >= end) return null;
      return {
        ...ev,
        clampedStart: start,
        clampedEnd: end,
        top: (minutesFromMidnight(start) / 60) * HOUR_HEIGHT,
        height: ((minutesFromMidnight(end) - minutesFromMidnight(start)) / 60) * HOUR_HEIGHT
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start || a.id - b.id);

  if (!visibleEvents.length) return [];

  // Find clusters (transitively overlapping groups)
  const clusters = [];
  let currentCluster = [visibleEvents[0]];

  for (let i = 1; i < visibleEvents.length; i++) {
    const ev = visibleEvents[i];
    const overlapsCurrent = currentCluster.some(c => eventsOverlap(c, ev));
    if (overlapsCurrent) {
      currentCluster.push(ev);
    } else {
      clusters.push(currentCluster);
      currentCluster = [ev];
    }
  }
  clusters.push(currentCluster);

  // For each cluster, assign columns greedily
  const layouts = [];

  for (const cluster of clusters) {
    // Sort by start time for greedy assignment
    cluster.sort((a, b) => a.start - b.start || a.id - b.id);

    const columnAssignments = new Map(); // event id -> column index
    const activeColumns = []; // for each column, end time of last event

    let maxColumns = 0;

    for (const ev of cluster) {
      // Find first available column
      let col = 0;
      for (; col < activeColumns.length; col++) {
        if (activeColumns[col] <= ev.start) {
          break;
        }
      }
      if (col === activeColumns.length) {
        activeColumns.push(ev.end);
      } else {
        activeColumns[col] = ev.end;
      }
      columnAssignments.set(ev.id, col);
      maxColumns = Math.max(maxColumns, col + 1);
    }

    // Assign layout info
    const colWidth = 100 / maxColumns;
    for (const ev of cluster) {
      const col = columnAssignments.get(ev.id);
      layouts.push({
        ...ev,
        left: col * colWidth,
        width: colWidth,
        zIndex: col + 1
      });
    }
  }

  return layouts;
}

// Render the calendar
function renderCalendar() {
  const app = document.getElementById('app');
  app.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'header';
  header.innerHTML = `
    <h1>Week of ${currentWeekStart.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</h1>
    <div class="nav-buttons">
      <button id="prev-btn">← Previous</button>
      <button id="today-btn">Today</button>
      <button id="next-btn">Next →</button>
    </div>
  `;
  app.appendChild(header);

  const calendar = document.createElement('div');
  calendar.className = 'calendar';

  // Time axis
  const timeAxis = document.createElement('div');
  timeAxis.className = 'time-axis';
  for (let h = 0; h <= 24; h++) {
    const slot = document.createElement('div');
    slot.className = 'time-slot';
    slot.textContent = h === 24 ? '' : `${h.toString().padStart(2, '0')}:00`;
    if (h < 24) slot.style.height = `${HOUR_HEIGHT}px`;
    timeAxis.appendChild(slot);
  }
  calendar.appendChild(timeAxis);

  // Days container
  const daysContainer = document.createElement('div');
  daysContainer.className = 'days-container';

  const weekDays = getWeekDays(currentWeekStart);

  weekDays.forEach((day, dayIndex) => {
    const dayCol = document.createElement('div');
    dayCol.className = 'day-column';
    if (isToday(day)) dayCol.classList.add('today');

    // Header
    const header = document.createElement('div');
    header.className = `day-header ${isToday(day) ? 'today' : ''}`;
    const { name, date } = formatDateHeader(day);
    header.innerHTML = `
      <div class="day-name">${name}</div>
      <div class="day-date">${date}</div>
    `;
    dayCol.appendChild(header);

    // Hour lines container (for background)
    const hourLines = document.createElement('div');
    hourLines.className = 'hour-lines';
    for (let h = 0; h < 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.height = `${HOUR_HEIGHT}px`;
      hourLines.appendChild(line);
    }
    dayCol.appendChild(hourLines);

    // Events layer
    const eventsLayer = document.createElement('div');
    eventsLayer.className = 'events-layer';
    eventsLayer.style.height = `${AXIS_HEIGHT}px`;

    // Filter events for this day
    const dayBounds = getDayBounds(day);
    const dayEvents = events
      .map(ev => ({
        ...ev,
        start: new Date(ev.start_at),
        end: new Date(ev.end_at)
      }))
      .filter(ev => ev.start < dayBounds.end && ev.end > dayBounds.start);

    const layouts = computeLayout(dayEvents, dayBounds.start, dayBounds.end);

    layouts.forEach(layout => {
      const eventEl = document.createElement('div');
      eventEl.className = 'event';
      eventEl.style.top = `${layout.top}px`;
      eventEl.style.height = `${Math.max(layout.height, 20)}px`;
      eventEl.style.left = `${layout.left}%`;
      eventEl.style.width = `${layout.width}%`;
      eventEl.style.zIndex = layout.zIndex;

      const title = layout.title.length > 20 ? layout.title.substring(0, 17) + '...' : layout.title;
      eventEl.innerHTML = `
        <div class="event-title">${title}</div>
        <div class="event-time">${formatTime(layout.clampedStart)} - ${formatTime(layout.clampedEnd)}</div>
      `;

      eventEl.addEventListener('click', (e) => {
        e.stopPropagation();
        showEditModal(layout);
      });

      eventsLayer.appendChild(eventEl);
    });

    // Click to create on empty area
    eventsLayer.addEventListener('click', (e) => {
      if (e.target === eventsLayer) {
        const rect = eventsLayer.getBoundingClientRect();
        const y = e.clientY - rect.top;
        const minutes = Math.floor((y / HOUR_HEIGHT) * 60);
        const startHour = Math.floor(minutes / 60);
        const startMin = minutes % 60;

        const start = new Date(day);
        start.setHours(startHour, startMin, 0, 0);
        const end = new Date(start);
        end.setHours(startHour + 1, startMin, 0, 0);

        showCreateModal(start, end);
      }
    });

    dayCol.appendChild(eventsLayer);
    daysContainer.appendChild(dayCol);
  });

  calendar.appendChild(daysContainer);
  app.appendChild(calendar);

  // Navigation handlers
  document.getElementById('prev-btn').addEventListener('click', () => {
    currentWeekStart.setDate(currentWeekStart.getDate() - 7);
    loadAndRender();
  });

  document.getElementById('today-btn').addEventListener('click', () => {
    currentWeekStart = getWeekStart(new Date());
    loadAndRender();
  });

  document.getElementById('next-btn').addEventListener('click', () => {
    currentWeekStart.setDate(currentWeekStart.getDate() + 7);
    loadAndRender();
  });
}

async function loadAndRender() {
  try {
    const fetched = await fetchEvents(currentWeekStart);
    events = fetched;
    renderCalendar();
  } catch (err) {
    console.error(err);
    alert('Failed to load events');
  }
}

// Modal for create/edit
function showCreateModal(start, end) {
  if (modal) modal.remove();

  modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content">
      <h2>New Event</h2>
      <div class="form-group">
        <label>Title</label>
        <input type="text" id="event-title" placeholder="Event title" value="New Event">
      </div>
      <div class="form-group">
        <label>Start</label>
        <input type="datetime-local" id="event-start" value="${toDateTimeLocal(start)}">
      </div>
      <div class="form-group">
        <label>End</label>
        <input type="datetime-local" id="event-end" value="${toDateTimeLocal(end)}">
      </div>
      <div class="modal-actions">
        <button class="btn-secondary" id="cancel-btn">Cancel</button>
        <button class="btn-primary" id="save-btn">Create</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  modal.querySelector('#cancel-btn').addEventListener('click', () => {
    modal.remove();
    modal = null;
  });

  modal.querySelector('#save-btn').addEventListener('click', async () => {
    const title = modal.querySelector('#event-title').value.trim();
    const startVal = modal.querySelector('#event-start').value;
    const endVal = modal.querySelector('#event-end').value;

    if (!title) {
      alert('Title is required');
      return;
    }
    if (!startVal || !endVal) {
      alert('Start and end are required');
      return;
    }

    const startDate = new Date(startVal);
    const endDate = new Date(endVal);

    if (endDate <= startDate) {
      alert('End time must be after start time');
      return;
    }

    try {
      await createEvent(title, startDate, endDate);
      modal.remove();
      modal = null;
      await loadAndRender();
    } catch (err) {
      alert(err.message);
    }
  });

  // Click outside to close
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.remove();
      modal = null;
    }
  });
}

function showEditModal(event) {
  if (modal) modal.remove();

  modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content">
      <h2>Edit Event</h2>
      <div class="form-group">
        <label>Title</label>
        <input type="text" id="event-title" value="${event.title}">
      </div>
      <div class="form-group">
        <label>Start</label>
        <input type="datetime-local" id="event-start" value="${toDateTimeLocal(event.start)}">
      </div>
      <div class="form-group">
        <label>End</label>
        <input type="datetime-local" id="event-end" value="${toDateTimeLocal(event.end)}">
      </div>
      <div class="modal-actions">
        <button class="btn-danger" id="delete-btn">Delete</button>
        <button class="btn-secondary" id="cancel-btn">Cancel</button>
        <button class="btn-primary" id="save-btn">Save</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  modal.querySelector('#cancel-btn').addEventListener('click', () => {
    modal.remove();
    modal = null;
  });

  modal.querySelector('#save-btn').addEventListener('click', async () => {
    const title = modal.querySelector('#event-title').value.trim();
    const startVal = modal.querySelector('#event-start').value;
    const endVal = modal.querySelector('#event-end').value;

    if (!title) {
      alert('Title is required');
      return;
    }

    const startDate = new Date(startVal);
    const endDate = new Date(endVal);

    if (endDate <= startDate) {
      alert('End time must be after start time');
      return;
    }

    try {
      await updateEvent(event.id, title, startDate, endDate);
      modal.remove();
      modal = null;
      await loadAndRender();
    } catch (err) {
      alert(err.message);
    }
  });

  modal.querySelector('#delete-btn').addEventListener('click', async () => {
    if (confirm('Delete this event?')) {
      try {
        await deleteEvent(event.id);
        modal.remove();
        modal = null;
        await loadAndRender();
      } catch (err) {
        alert(err.message);
      }
    }
  });

  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.remove();
      modal = null;
    }
  });
}

function toDateTimeLocal(date) {
  const pad = n => n.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Initial load
async function init() {
  await loadAndRender();
}

init();