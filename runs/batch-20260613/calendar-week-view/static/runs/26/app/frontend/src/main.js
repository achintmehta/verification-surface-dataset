const API_BASE = '/api';
const HOUR_HEIGHT = 30; // pixels per hour
const TOTAL_HOURS = 24;
const CALENDAR_HEIGHT = HOUR_HEIGHT * TOTAL_HOURS; // 720px

let currentWeekStart = null; // Monday of current week, as Date
let events = [];

// Utility functions
function getMonday(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // adjust when day is sunday
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
async function createEvent(title, start, end) {
  const res = await fetch(`${API_BASE}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, start_at: start.toISOString(), end_at: end.toISOString() })
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to create event');
  }
  return res.json();
}

// Update event
async function updateEvent(id, title, start, end) {
  const res = await fetch(`${API_BASE}/events/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, start_at: start.toISOString(), end_at: end.toISOString() })
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
    label.textContent = h === 24 ? '24:00' : `${h.toString().padStart(2, '0')}:00`;
    container.appendChild(label);

    if (h < 24) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${h * HOUR_HEIGHT}px`;
      container.appendChild(line);
    }e = 'hour-line';
      line.style.top = `${h * HOUR_HEIGHT}px`;
      container.appendChild(line);
    }
  }
}

// Compute overlap clusters and layout for a day's events
function computeEventLayout(dayEvents, dayStart, columnWidth) {
  if (dayEvents.length === 0) return [];

  // sorting by start time
  dayEvents.sort((a, b) => new Date(a.start_at) - new Date(b.start_at));

  // Find clusters: groups of transitively overlapping events
  const clusters = [];
  let currentCluster = [dayEvents[0]];

  for (let i = 1; i < dayEvents.length; i++) {
    const evt = dayEvents[i];
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
    const eventColumns = new Map(); // event -> column index

    cluster.forEach(evt => {
      const startTime = new Date(evt.start_at).getTime();
      let assignedCol = -1;
      for (let c = 0; c < columns.length; c++) {
        if (columns[c] <= startTime) {
          assignedCol = c;
          break;
        }
      }
      if (assignedCol === -1) {
        assignedCol = columns.length;
        columns.push(0);
      }
      columns[assignedCol] = new Date(evt.end_at).getTime();
      eventColumns.set(evt, assignedCol);
    });

    const numCols = columns.length;
    const colWidth = columnWidth / numCols;

    cluster.forEach(evt => {
      const colIdx = eventColumns.get(evt);
      const left = colIdx * colWidth;
      const width = colWidth;

      const start = new Date(evt.start_at);
      const end = new Date(evt.end_at);

      // Minutes from midnight of the day, clamped to visible day
      const dayMidnight = new Date(dayStart);
      dayMidnight.setHours(0, 0, 0, 0);
      const nextMidnight = new Date(dayMidnight);
      nextMidnight.setDate(nextMidnight.getDate() + 1);

      let startMin = (start - dayMidnight) / 60000;
      let endMin = (end - dayMidnight) / 60000;

      startMin = Math.max(0, Math.min(24 * 60, startMin));
      endMin = Math.max(0, Math.min(24 * 60, endMin));

      const top = (startMin / 60) * HOUR_HEIGHT;
      const height = ((endMin - startMin) / 60) * HOUR_HEIGHT;

      layouts.push({
        event: evt,
        top: top,
        height: Math.max(20, height), // min height for visibility
        left: left,
        width: width
      });
    });
  });

  return layouts;
}

// Render a single day column
function renderDayColumn(dayDate, dayEvents, container, isToday) {
  const col = document.createElement('div');
  col.className = 'day-column';
  col.style.height = `${CALENDAR_HEIGHT}px`;

  // Header
  const header = document.createElement('div');
  header.className = `day-header${isToday ? ' today' : ''}`;
  const dayName = dayDate.toLocaleDateString(undefined, { weekday: 'short' });
  const dateNum = dayDate.getDate();
  header.textContent = `${dayName} ${dateNum}`;
  col.appendChild(header);

  // Event container (for absolute positioning relative to column)
  const eventsLayer = document.createElement('div');
  eventsLayer.style.position = 'relative';
  eventsLayer.style.height = `${CALENDAR_HEIGHT}px`;
  eventsLayer.style.width = '100%';
  col.appendChild(eventsLayer);

  // Compute layouts
  const columnWidth = 100; // will be adjusted by flex, but we use % or compute actual later
  // Since flex, better to use % widths
  const layouts = computeEventLayout(dayEvents, dayDate, 100); // use percent

  layouts.forEach(layout => {
    const evtEl = document.createElement('div');
    evtEl.className = 'event';
    evtEl.style.top = `${layout.top}px`;
    evtEl.style.height = `${layout.height}px`;
    evtEl.style.left = `${layout.left}%`;
    evtEl.style.width = `${layout.width}%`;

    const titleEl = document.createElement('div');
    titleEl.className = 'event-title';
    titleEl.textContent = layout.event.title;

    const timeEl = document.createElement('div');
    timeEl.className = 'event-time';
    const s = new Date(layout.event.start_at);
    const e = new Date(layout.event.end_at);
    timeEl.textContent = `${formatTime(s)} - ${formatTime(e)}`;

    evtEl.appendChild(titleEl);
    evtEl.appendChild(timeEl);

    evtEl.addEventListener('click', (e) => {
      e.stopPropagation();
      openEditModal(layout.event);
    });

    eventsLayer.appendChild(evtEl);
  });

  // Click to create on empty space
  col.addEventListener('click', (e) => {
    if (e.target === col || e.target === eventsLayer) {
      const rect = eventsLayer.getBoundingClientRect();
      const clickY = e.clientY - rect.top;
      const minutesFromMidnight = (clickY / HOUR_HEIGHT) * 60;
      const startHour = Math.floor(minutesFromMidnight / 60);
      const startMin = Math.floor(minutesFromMidnight % 60 / 15) * 15; // snap to 15 min

      const start = new Date(dayDate);
      start.setHours(startHour, startMin, 0, 0);

      const end = new Date(start);
      end.setHours(start.getHours() + 1);

      openCreateModal(start, end);
    }
  });

  // Also support drag selection? For simplicity, click opens 1h slot, but to support range, we can do mousedown drag.
  // Implement simple drag for range selection
  let dragStartY = null;
  let dragStartDate = null;

  col.addEventListener('mousedown', (e) => {
    if (e.target !== col && e.target !== eventsLayer) return;
    const rect = eventsLayer.getBoundingClientRect();
    dragStartY = e.clientY - rect.top;
    const minutes = (dragStartY / HOUR_HEIGHT) * 60;
    const h = Math.floor(minutes / 60);
    const m = Math.floor((minutes % 60) / 15) * 15;
    dragStartDate = new Date(dayDate);
    dragStartDate.setHours(h, m, 0, 0);
  });

  col.addEventListener('mouseup', (e) => {
    if (dragStartY === null || !dragStartDate) return;
    const rect = eventsLayer.getBoundingClientRect();
    const dragEndY = e.clientY - rect.top;
    const minutesEnd = (dragEndY / HOUR_HEIGHT) * 60;
    const hEnd = Math.floor(minutesEnd / 60);
    const mEnd = Math.floor((minutesEnd % 60) / 15) * 15;

    let endDate = new Date(dayDate);
    endDate.setHours(hEnd, mEnd, 0, 0);

    if (endDate <= dragStartDate) {
      endDate = new Date(dragStartDate);
      endDate.setHours(dragStartDate.getHours() + 1);
    }

    openCreateModal(dragStartDate, endDate);
    dragStartY = null;
    dragStartDate = null;
  });

  container.appendChild(col);
}

// Main render function
async function renderWeek(weekStart) {
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);

  // Update header
  document.getElementById('week-range').textContent = formatDateRange(weekStart, new Date(weekEnd.getTime() - 86400000));

  // Fetch events
  try {
    events = await fetchEvents(weekStart, weekEnd);
  } catch (e) {
    console.error(e);
    events = [];
  }

  // Clear and render days
  const daysContainer = document.getElementById('days-container');
  daysContainer.innerHTML = '';
  daysContainer.style.height = `${CALENDAR_HEIGHT}px`;

  const today = new Date();
  today.setHours(0,0,0,0);

  for (let i = 0; i < 7; i++) {
    const dayDate = new Date(weekStart);
    dayDate.setDate(dayDate.getDate() + i);
    dayDate.setHours(0,0,0,0);

    const dayStart = dayDate;
    const dayEnd = new Date(dayDate);
    dayEnd.setDate(dayEnd.getDate() + 1);

    const dayEvents = events.filter(ev => {
      const s = new Date(ev.start_at);
      const e = new Date(ev.end_at);
      return s < dayEnd && e > dayStart;
    });

    const isToday = dayDate.getTime() === today.getTime();
    renderDayColumn(dayDate, dayEvents, daysContainer, isToday);
  }
}

// Modal handling
let currentEventId = null;
const modal = document.getElementById('event-modal');
const form = document.getElementById('event-form');
const titleInput = document.getElementById('event-title');
const startInput = document.getElementById('event-start');
const endInput = document.getElementById('event-end');
const deleteBtn = document.getElementById('delete-btn');
const modalTitle = document.getElementById('modal-title');

function openCreateModal(start, end) {
  currentEventId = null;
  modalTitle.textContent = 'Create Event';
  titleInput.value = '';
  startInput.value = toLocalISOString(start);
  endInput.value = toLocalISOString(end);
  deleteBtn.classList.add('hidden');
  modal.classList.remove('hidden');
}

function openEditModal(event) {
  currentEventId = event.id;
  modalTitle.textContent = 'Edit Event';
  titleInput.value = event.title;
  startInput.value = toLocalISOString(new Date(event.start_at));
  endInput.value = toLocalISOString(new Date(event.end_at));
  deleteBtn.classList.remove('hidden');
  modal.classList.remove('hidden');
}

function closeModal() {
  modal.classList.add('hidden');
  currentEventId = null;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = titleInput.value.trim();
  const start = parseLocalDateTime(startInput.value);
  const end = parseLocalDateTime(endInput.value);

  if (!title || end <= start) {
    alert('Invalid input: title required and end must be after start');
    return;
  }

  try {
    if (currentEventId) {
      await updateEvent(currentEventId, title, start, end);
    } else {
      await createEvent(title, start, end);
    }
    closeModal();
    await renderWeek(currentWeekStart);
  } catch (err) {
    alert(err.message);
  }
});

deleteBtn.addEventListener('click', async () => {
  if (!currentEventId) return;
  if (!confirm('Delete this event?')) return;
  try {
    await deleteEvent(currentEventId);
    closeModal();
    await renderWeek(currentWeekStart);
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById('cancel-btn').addEventListener('click', closeModal);

// Navigation
document.getElementById('prev-week').addEventListener('click', () => {
  currentWeekStart.setDate(currentWeekStart.getDate() - 7);
  renderWeek(currentWeekStart);
});

document.getElementById('next-week').addEventListener('click', () => {
  currentWeekStart.setDate(currentWeekStart.getDate() + 7);
  renderWeek(currentWeekStart);
});

document.getElementById('today').addEventListener('click', () => {
  currentWeekStart = getMonday(new Date());
  renderWeek(currentWeekStart);
});

// Initialize
function init() {
  const timeAxis = document.getElementById('time-axis');
  renderTimeAxis(timeAxis);

  currentWeekStart = getMonday(new Date());
  renderWeek(currentWeekStart);
}

init();