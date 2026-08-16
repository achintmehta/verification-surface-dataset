const API_BASE = '/api';

let currentWeekStart = getWeekStart(new Date());
let events = [];

function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday start
  return new Date(d.setDate(diff));
}

function formatDate(date) {
  return date.toISOString().split('T')[0];
}

function formatTime(date) {
  return date.toTimeString().slice(0, 5);
}

function getMinutesFromMidnight(dateStr) {
  const date = new Date(dateStr);
  return date.getHours() * 60 + date.getMinutes();
}

function parseISO(iso) {
  return new Date(iso);
}

async function fetchEvents(weekStart) {
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);
  const start = weekStart.toISOString();
  const end = weekEnd.toISOString();
  const res = await fetch(`${API_BASE}/events?start=${start}&end=${end}`);
  if (!res.ok) throw new Error('Failed to fetch events');
  return res.json();
}

async function createEvent(eventData) {
  const res = await fetch(`${API_BASE}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(eventData)
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to create event');
  }
  return res.json();
}

async function updateEvent(id, eventData) {
  const res = await fetch(`${API_BASE}/events/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(eventData)
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to update event');
  }
  return res.json();
}

async function deleteEvent(id) {
  const res = await fetch(`${API_BASE}/events/${id}`, {
    method: 'DELETE'
  });
  if (!res.ok && res.status !== 204) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to delete event');
  }
}

function renderHeader(weekStart) {
  const header = document.createElement('div');
  header.className = 'header';
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);
  header.innerHTML = `
    <h1>Week of ${weekStart.toLocaleDateString()} - ${weekEnd.toLocaleDateString()}</h1>
    <div class="nav-buttons">
      <button id="prev-week">Previous</button>
      <button id="today">Today</button>
      <button id="next-week">Next</button>
    </div>
  `;
  return header;
}

function renderTimeAxis() {
  const axis = document.createElement('div');
  axis.className = 'time-axis';
  for (let hour = 0; hour < 24; hour++) {
    const slot = document.createElement('div');
    slot.className = 'time-slot';
    slot.textContent = `${hour.toString().padStart(2, '0')}:00`;
    axis.appendChild(slot);
  }
  return axis;
}

function renderDayHeader(dayDate, isToday) {
  const header = document.createElement('div');
  header.className = `day-header${isToday ? ' today' : ''}`;
  const dayName = dayDate.toLocaleDateString(undefined, { weekday: 'short' });
  const dateStr = dayDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  header.innerHTML = `
    <div class="day-name">${dayName}</div>
    <div class="day-date">${dateStr}</div>
  `;
  return header;
}

function renderHourLines() {
  const lines = document.createElement('div');
  lines.className = 'hour-lines';
  for (let hour = 0; hour < 24; hour++) {
    const line = document.createElement('div');
    line.className = `hour-line ${hour % 1 === 0 ? 'major' : ''}`;
    lines.appendChild(line);
  }
  return lines;
}

// Cluster-based overlap layout
function computeEventLayout(dayEvents) {
  if (dayEvents.length === 0) return [];

  // Sort by start time
  const sorted = [...dayEvents].sort((a, b) => 
    new Date(a.start_at) - new Date(b.start_at)
  );

  // Find overlap clusters
  const clusters = [];
  let currentCluster = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const event = sorted[i];
    const clusterEnd = Math.max(...currentCluster.map(e => new Date(e.end_at).getTime()));
    if (new Date(event.start_at).getTime() < clusterEnd) {
      currentCluster.push(event);
    } else {
      clusters.push(currentCluster);
      currentCluster = [event];
    }
  }
  clusters.push(currentCluster);

  const layouts = [];

  clusters.forEach(cluster => {
    // Greedy column assignment
    const columns = [];
    const eventColumns = new Map();

    cluster.forEach(event => {
      const start = new Date(event.start_at).getTime();
      let assignedCol = 0;
      for (let col = 0; col < columns.length; col++) {
        if (columns[col] <= start) {
          assignedCol = col;
          break;
        }
        assignedCol = col + 1;
      }
      if (assignedCol >= columns.length) {
        columns.push(new Date(event.end_at).getTime());
      } else {
        columns[assignedCol] = new Date(event.end_at).getTime();
      }
      eventColumns.set(event, assignedCol);
    });

    const numCols = columns.length;

    cluster.forEach(event => {
      const colIndex = eventColumns.get(event);
      const width = 100 / numCols;
      const left = colIndex * width;
      layouts.push({
        event,
        left: left + '%',
        width: width + '%'
      });
    });
  });

  return layouts;
}

function renderEvent(event, left, width, onClick) {
  const start = parseISO(event.start_at);
  const end = parseISO(event.end_at);
  const top = getMinutesFromMidnight(event.start_at);
  const height = getMinutesFromMidnight(event.end_at) - top;

  const el = document.createElement('div');
  el.className = 'event';
  el.style.top = `${top}px`;
  el.style.height = `${height}px`;
  el.style.left = left;
  el.style.width = width;

  const title = document.createElement('div');
  title.className = 'event-title';
  title.textContent = event.title;

  const time = document.createElement('div');
  time.className = 'event-time';
  time.textContent = `${formatTime(start)} - ${formatTime(end)}`;

  el.appendChild(title);
  el.appendChild(time);

  el.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick(event);
  });

  return el;
}

function renderDayColumn(dayDate, dayEvents, isToday, onEventClick, onTimeSelect) {
  const column = document.createElement('div');
  column.className = 'day-column';

  const header = renderDayHeader(dayDate, isToday);
  column.appendChild(header);

  const lines = renderHourLines();
  column.appendChild(lines);

  const eventsLayer = document.createElement('div');
  eventsLayer.className = 'events-layer';

  const layout = computeEventLayout(dayEvents);
  layout.forEach(({ event, left, width }) => {
    const eventEl = renderEvent(event, left, width, onEventClick);
    eventsLayer.appendChild(eventEl);
  });

  // Click to create
  column.addEventListener('click', (e) => {
    if (e.target.closest('.event')) return;
    const rect = column.getBoundingClientRect();
    const headerHeight = 50;
    const clickY = e.clientY - rect.top - headerHeight;
    const minutes = Math.floor(clickY);
    const startHour = Math.floor(minutes / 60);
    const startMin = minutes % 60;
    const start = new Date(dayDate);
    start.setHours(startHour, startMin, 0, 0);
    const end = new Date(start);
    end.setHours(startHour + 1, startMin, 0, 0);
    onTimeSelect(start, end);
  });

  column.appendChild(eventsLayer);
  return column;
}

function renderCalendar(weekStart, allEvents, onEventClick, onTimeSelect) {
  const container = document.createElement('div');
  container.className = 'calendar-container';

  const timeAxis = renderTimeAxis();
  container.appendChild(timeAxis);

  const daysHeader = document.createElement('div');
  daysHeader.className = 'days-header';

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 0; i < 7; i++) {
    const dayDate = new Date(weekStart);
    dayDate.setDate(dayDate.getDate() + i);
    dayDate.setHours(0, 0, 0, 0);

    const dayStart = new Date(dayDate);
    const dayEnd = new Date(dayDate);
    dayEnd.setDate(dayEnd.getDate() + 1);

    const dayEvents = allEvents.filter(ev => {
      const evStart = parseISO(ev.start_at);
      const evEnd = parseISO(ev.end_at);
      return evStart < dayEnd && evEnd > dayStart;
    });

    const isToday = dayDate.getTime() === today.getTime();
    const column = renderDayColumn(dayDate, dayEvents, isToday, onEventClick, onTimeSelect);
    daysHeader.appendChild(column);
  }

  container.appendChild(daysHeader);
  return container;
}

function showEventModal(event = null, onSave, onDelete) {
  const modal = document.createElement('div');
  modal.className = 'modal';

  const isEdit = !!event;
  const startVal = event ? parseISO(event.start_at).toISOString().slice(0, 16) : '';
  const endVal = event ? parseISO(event.end_at).toISOString().slice(0, 16) : '';

  modal.innerHTML = `
    <div class="modal-content">
      <h2>${isEdit ? 'Edit Event' : 'New Event'}</h2>
      <div class="form-group">
        <label>Title</label>
        <input type="text" id="title" value="${event ? event.title : ''}" required>
      </div>
      <div class="form-group">
        <label>Start</label>
        <input type="datetime-local" id="start" value="${startVal}" required>
      </div>
      <div class="form-group">
        <label>End</label>
        <input type="datetime-local" id="end" value="${endVal}" required>
      </div>
      <div class="modal-actions">
        ${isEdit ? '<button id="delete" class="btn-danger">Delete</button>' : ''}
        <button id="cancel" class="btn-secondary">Cancel</button>
        <button id="save" class="btn-primary">Save</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  const titleInput = modal.querySelector('#title');
  const startInput = modal.querySelector('#start');
  const endInput = modal.querySelector('#end');

  modal.querySelector('#cancel').addEventListener('click', () => {
    modal.remove();
  });

  modal.querySelector('#save').addEventListener('click', async () => {
    const title = titleInput.value.trim();
    const start = startInput.value;
    const end = endInput.value;

    if (!title || !start || !end) {
      alert('All fields are required');
      return;
    }
    if (new Date(end) <= new Date(start)) {
      alert('End time must be after start time');
      return;
    }

    try {
      if (isEdit) {
        await onSave(event.id, { title, start_at: new Date(start).toISOString(), end_at: new Date(end).toISOString() });
      } else {
        await onSave({ title, start_at: new Date(start).toISOString(), end_at: new Date(end).toISOString() });
      }
      modal.remove();
    } catch (err) {
      alert(err.message);
    }
  });

  if (isEdit) {
    modal.querySelector('#delete').addEventListener('click', async () => {
      if (confirm('Delete this event?')) {
        try {
          await onDelete(event.id);
          modal.remove();
        } catch (err) {
          alert(err.message);
        }
      }
    });
  }
}

async function renderApp() {
  const app = document.getElementById('app');
  app.innerHTML = '';

  const header = renderHeader(currentWeekStart);
  app.appendChild(header);

  try {
    events = await fetchEvents(currentWeekStart);
  } catch (err) {
    console.error(err);
    events = [];
  }

  const calendar = renderCalendar(
    currentWeekStart,
    events,
    (event) => {
      showEventModal(event, async (id, data) => {
        await updateEvent(id, data);
        renderApp();
      }, async (id) => {
        await deleteEvent(id);
        renderApp();
      });
    },
    (start, end) => {
      showEventModal(null, async (data) => {
        await createEvent(data);
        renderApp();
      });
    }
  );
  app.appendChild(calendar);

  // Navigation
  header.querySelector('#prev-week').addEventListener('click', () => {
    currentWeekStart.setDate(currentWeekStart.getDate() - 7);
    renderApp();
  });

  header.querySelector('#today').addEventListener('click', () => {
    currentWeekStart = getWeekStart(new Date());
    renderApp();
  });

  header.querySelector('#next-week').addEventListener('click', () => {
    currentWeekStart.setDate(currentWeekStart.getDate() + 7);
    renderApp();
  });
}

function init() {
  renderApp();
}

init();