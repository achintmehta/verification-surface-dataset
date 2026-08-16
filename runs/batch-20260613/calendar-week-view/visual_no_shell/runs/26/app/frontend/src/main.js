import './style.css';

const HOUR_HEIGHT = 25; // pixels per hour
const TOTAL_HOURS = 24;
const CALENDAR_HEIGHT = TOTAL_HOURS * HOUR_HEIGHT; // 600px

let currentWeekStart = getWeekStart(new Date());
let events = [];
let selectedEvent = null;

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

function getDayDate(weekStart, dayIndex) {
  const date = new Date(weekStart);
  date.setDate(date.getDate() + dayIndex);
  return date;
}

function isToday(date) {
  const today = new Date();
  return date.toDateString() === today.toDateString();
}

async function fetchEvents(start, end) {
  const startIso = new Date(start).toISOString();
  const endIso = new Date(end).toISOString();
  const res = await fetch(`/api/events?start=${startIso}&end=${endIso}`);
  if (!res.ok) throw new Error('Failed to fetch events');
  return res.json();
}

async function createEvent(title, start_at, end_at) {
  const res = await fetch('/api/events', {
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
  const res = await fetch(`/api/events/${id}`, {
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
  const res = await fetch(`/api/events/${id}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 204) {
    throw new Error('Failed to delete event');
  }
}

function renderHeader(weekStart) {
  const header = document.createElement('div');
  header.className = 'header';
  
  const title = document.createElement('h1');
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);
  title.textContent = `${weekStart.toLocaleDateString()} - ${weekEnd.toLocaleDateString()}`;
  
  const nav = document.createElement('div');
  nav.className = 'nav-buttons';
  
  const prevBtn = document.createElement('button');
  prevBtn.textContent = '← Previous';
  prevBtn.onclick = () => navigateWeek(-1);
  
  const todayBtn = document.createElement('button');
  todayBtn.textContent = 'Today';
  todayBtn.onclick = () => {
    currentWeekStart = getWeekStart(new Date());
    loadAndRender();
  };
  
  const nextBtn = document.createElement('button');
  nextBtn.textContent = 'Next →';
  nextBtn.onclick = () => navigateWeek(1);
  
  nav.appendChild(prevBtn);
  nav.appendChild(todayBtn);
  nav.appendChild(nextBtn);
  
  header.appendChild(title);
  header.appendChild(nav);
  return header;
}

function navigateWeek(delta) {
  currentWeekStart.setDate(currentWeekStart.getDate() + delta * 7);
  loadAndRender();
}

function renderTimeAxis() {
  const axis = document.createElement('div');
  axis.className = 'time-axis';
  
  for (let h = 0; h < 24; h++) {
    const slot = document.createElement('div');
    slot.className = 'time-slot';
    slot.textContent = `${h.toString().padStart(2, '0')}:00`;
    axis.appendChild(slot);
  }
  return axis;
}

function renderDayHeader(date, dayIndex) {
  const header = document.createElement('div');
  header.className = 'day-header';
  if (isToday(date)) header.classList.add('today');
  
  const dayName = document.createElement('div');
  dayName.className = 'day-name';
  dayName.textContent = date.toLocaleDateString('en-US', { weekday: 'short' });
  
  const dayDate = document.createElement('div');
  dayDate.className = 'day-date';
  dayDate.textContent = date.getDate();
  
  header.appendChild(dayName);
  header.appendChild(dayDate);
  return header;
}

function renderHourLines() {
  const lines = document.createElement('div');
  lines.className = 'hour-lines';
  for (let h = 0; h < 24; h++) {
    const line = document.createElement('div');
    line.className = 'hour-line';
    lines.appendChild(line);
  }
  return lines;
}

// Overlap layout algorithm
function computeEventLayout(dayEvents) {
  if (dayEvents.length === 0) return [];
  
  // Sort by start time
  const sorted = [...dayEvents].sort((a, b) => 
    new Date(a.start_at) - new Date(b.start_at) || 
    new Date(b.end_at) - new Date(a.end_at)
  );
  
  // Find clusters: groups of transitively overlapping events
  const clusters = [];
  let currentCluster = [];
  
  for (const event of sorted) {
    const eventStart = new Date(event.start_at);
    const eventEnd = new Date(event.end_at);
    
    if (currentCluster.length === 0) {
      currentCluster.push(event);
    } else {
      // Check if overlaps with any in current cluster
      const overlaps = currentCluster.some(e => {
        const eStart = new Date(e.start_at);
        const eEnd = new Date(e.end_at);
        return eventStart < eEnd && eventEnd > eStart;
      });
      
      if (overlaps) {
        currentCluster.push(event);
      } else {
        clusters.push(currentCluster);
        currentCluster = [event];
      }
    }
  }
  if (currentCluster.length > 0) clusters.push(currentCluster);
  
  // For each cluster, assign columns greedily
  const layout = [];
  
  for (const cluster of clusters) {
    const clusterEvents = [...cluster].sort((a, b) => 
      new Date(a.start_at) - new Date(b.start_at)
    );
    
    const columns = []; // array of end times for each column
    const eventColumns = new Map();
    
    for (const event of clusterEvents) {
      const start = new Date(event.start_at);
      let col = 0;
      
      // Find first available column
      while (col < columns.length && columns[col] > start) {
        col++;
      }
      
      if (col === columns.length) {
        columns.push(new Date(event.end_at));
      } else {
        columns[col] = new Date(event.end_at);
      }
      
      eventColumns.set(event.id, col);
    }
    
    const numColumns = columns.length;
    
    for (const event of clusterEvents) {
      const col = eventColumns.get(event.id);
      layout.push({
        ...event,
        column: col,
        totalColumns: numColumns,
        clusterStart: Math.min(...cluster.map(e => new Date(e.start_at).getTime())),
        clusterEnd: Math.max(...cluster.map(e => new Date(e.end_at).getTime()))
      });
    }
  }
  
  return layout;
}

function renderEvent(eventLayout, dayStart, dayColumn, onClick) {
  const eventEl = document.createElement('div');
  eventEl.className = 'event';
  
  const start = new Date(eventLayout.start_at);
  const end = new Date(eventLayout.end_at);
  
  // Minutes from midnight
  const startMinutes = start.getHours() * 60 + start.getMinutes();
  const endMinutes = end.getHours() * 60 + end.getMinutes();
  
  const top = (startMinutes / 60) * HOUR_HEIGHT;
  const height = Math.max(((endMinutes - startMinutes) / 60) * HOUR_HEIGHT, 20);
  
  // Width and left offset within day column
  const colWidth = 100 / eventLayout.totalColumns;
  const left = colWidth * eventLayout.column;
  const width = colWidth;
  
  eventEl.style.top = `${top}px`;
  eventEl.style.height = `${height}px`;
  eventEl.style.left = `${left}%`;
  eventEl.style.width = `${width}%`;
  
  const title = document.createElement('div');
  title.className = 'event-title';
  title.textContent = eventLayout.title;
  
  const time = document.createElement('div');
  time.className = 'event-time';
  time.textContent = `${formatTime(start)} - ${formatTime(end)}`;
  
  eventEl.appendChild(title);
  eventEl.appendChild(time);
  
  eventEl.onclick = (e) => {
    e.stopPropagation();
    onClick(eventLayout);
  };
  
  return eventEl;
}

function renderDayColumn(weekStart, dayIndex, dayEvents, onEventClick, onTimeSelect) {
  const column = document.createElement('div');
  column.className = 'day-column';
  
  const date = getDayDate(weekStart, dayIndex);
  const header = renderDayHeader(date, dayIndex);
  column.appendChild(header);
  
  const hourLines = renderHourLines();
  column.appendChild(hourLines);
  
  const eventsLayer = document.createElement('div');
  eventsLayer.className = 'events-layer';
  
  // Layout events for this day
  const layoutEvents = computeEventLayout(dayEvents);
  
  for (const ev of layoutEvents) {
    const evEl = renderEvent(ev, date, column, onEventClick);
    eventsLayer.appendChild(evEl);
  }
  
  // Click to create - support simple click and basic drag
  let isDragging = false;
  let dragStartY = 0;
  let dragStartTime = null;
  
  eventsLayer.addEventListener('mousedown', (e) => {
    if (e.target.closest('.event')) return;
    
    isDragging = true;
    dragStartY = e.offsetY;
    const minutesFromMidnight = Math.floor((dragStartY / HOUR_HEIGHT) * 60);
    const roundedMinutes = Math.floor(minutesFromMidnight / 15) * 15; // 15 min snap
    dragStartTime = new Date(date);
    dragStartTime.setHours(0, roundedMinutes, 0, 0);
  });
  
  eventsLayer.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    // Could show preview, but for simplicity we use mouseup
  });
  
  eventsLayer.addEventListener('mouseup', (e) => {
    if (!isDragging) return;
    isDragging = false;
    
    const endY = e.offsetY;
    const startMinutes = Math.floor((dragStartY / HOUR_HEIGHT) * 60);
    let endMinutes = Math.floor((endY / HOUR_HEIGHT) * 60);
    
    if (Math.abs(endY - dragStartY) < 20) {
      // Treat as click: default 1 hour
      endMinutes = startMinutes + 60;
    } else {
      endMinutes = Math.max(endMinutes, startMinutes + 15);
      endMinutes = Math.ceil(endMinutes / 15) * 15;
    }
    
    const startTime = new Date(date);
    startTime.setHours(0, startMinutes, 0, 0);
    
    const endTime = new Date(date);
    endTime.setHours(0, endMinutes, 0, 0);
    
    // Clamp to day
    if (endTime.getHours() === 0 && endMinutes > 0) {
      endTime.setHours(23, 59, 0, 0);
    }
    
    showCreateModal(startTime, endTime);
  });
  
  // Also support simple click without drag
  eventsLayer.addEventListener('click', (e) => {
    if (e.target.closest('.event') || isDragging) return;
    
    const y = e.offsetY;
    const minutesFromMidnight = Math.floor((y / HOUR_HEIGHT) * 60);
    const roundedMinutes = Math.floor(minutesFromMidnight / 15) * 15;
    
    const startTime = new Date(date);
    startTime.setHours(0, roundedMinutes, 0, 0);
    
    const endTime = new Date(startTime);
    endTime.setHours(endTime.getHours() + 1);
    
    showCreateModal(startTime, endTime);
  });
  
  column.appendChild(eventsLayer);
  return column;
}

function showCreateModal(startTime, endTime) {
  const modal = document.createElement('div');
  modal.className = 'modal';
  
  modal.innerHTML = `
    <div class="modal-content">
      <h2>New Event</h2>
      <div class="form-group">
        <label>Title</label>
        <input type="text" id="event-title" placeholder="Event title" />
      </div>
      <div class="form-group">
        <label>Start</label>
        <input type="datetime-local" id="event-start" value="${startTime.toISOString().slice(0,16)}" />
      </div>
      <div class="form-group">
        <label>End</label>
        <input type="datetime-local" id="event-end" value="${endTime.toISOString().slice(0,16)}" />
      </div>
      <div class="error" id="form-error"></div>
      <div class="modal-actions">
        <button class="btn-secondary" id="cancel-btn">Cancel</button>
        <button class="btn-primary" id="save-btn">Create</button>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  const titleInput = modal.querySelector('#event-title');
  const startInput = modal.querySelector('#event-start');
  const endInput = modal.querySelector('#event-end');
  const errorEl = modal.querySelector('#form-error');
  
  titleInput.focus();
  
  modal.querySelector('#cancel-btn').onclick = () => modal.remove();
  
  modal.querySelector('#save-btn').onclick = async () => {
    const title = titleInput.value.trim();
    const start = new Date(startInput.value);
    const end = new Date(endInput.value);
    
    if (!title) {
      errorEl.textContent = 'Title is required';
      return;
    }
    if (end <= start) {
      errorEl.textContent = 'End must be after start';
      return;
    }
    
    try {
      await createEvent(title, start, end);
      modal.remove();
      await loadAndRender();
    } catch (err) {
      errorEl.textContent = err.message;
    }
  };
  
  // Close on outside click
  modal.onclick = (e) => {
    if (e.target === modal) modal.remove();
  };
}

function showEditModal(event) {
  const modal = document.createElement('div');
  modal.className = 'modal';
  
  const start = new Date(event.start_at);
  const end = new Date(event.end_at);
  
  modal.innerHTML = `
    <div class="modal-content">
      <h2>Edit Event</h2>
      <div class="form-group">
        <label>Title</label>
        <input type="text" id="event-title" value="${event.title}" />
      </div>
      <div class="form-group">
        <label>Start</label>
        <input type="datetime-local" id="event-start" value="${start.toISOString().slice(0,16)}" />
      </div>
      <div class="form-group">
        <label>End</label>
        <input type="datetime-local" id="event-end" value="${end.toISOString().slice(0,16)}" />
      </div>
      <div class="error" id="form-error"></div>
      <div class="modal-actions">
        <button class="btn-danger" id="delete-btn">Delete</button>
        <button class="btn-secondary" id="cancel-btn">Cancel</button>
        <button class="btn-primary" id="save-btn">Save</button>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  const titleInput = modal.querySelector('#event-title');
  const startInput = modal.querySelector('#event-start');
  const endInput = modal.querySelector('#event-end');
  const errorEl = modal.querySelector('#form-error');
  
  modal.querySelector('#cancel-btn').onclick = () => modal.remove();
  
  modal.querySelector('#save-btn').onclick = async () => {
    const title = titleInput.value.trim();
    const s = new Date(startInput.value);
    const e = new Date(endInput.value);
    
    if (!title) {
      errorEl.textContent = 'Title is required';
      return;
    }
    if (e <= s) {
      errorEl.textContent = 'End must be after start';
      return;
    }
    
    try {
      await updateEvent(event.id, title, s, e);
      modal.remove();
      await loadAndRender();
    } catch (err) {
      errorEl.textContent = err.message;
    }
  };
  
  modal.querySelector('#delete-btn').onclick = async () => {
    if (confirm('Delete this event?')) {
      try {
        await deleteEvent(event.id);
        modal.remove();
        await loadAndRender();
      } catch (err) {
        errorEl.textContent = err.message;
      }
    }
  };
  
  modal.onclick = (e) => {
    if (e.target === modal) modal.remove();
  };
}

function renderCalendar(weekStart, allEvents) {
  const app = document.getElementById('app');
  app.innerHTML = '';
  
  const header = renderHeader(weekStart);
  app.appendChild(header);
  
  const container = document.createElement('div');
  container.className = 'calendar-container';
  
  const timeAxis = renderTimeAxis();
  container.appendChild(timeAxis);
  
  const daysContainer = document.createElement('div');
  daysContainer.className = 'days-container';
  
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);
  
  // Filter events for the week
  const weekEvents = allEvents.filter(ev => {
    const evStart = new Date(ev.start_at);
    const evEnd = new Date(ev.end_at);
    return evStart < weekEnd && evEnd > weekStart;
  });
  
  for (let day = 0; day < 7; day++) {
    const dayDate = getDayDate(weekStart, day);
    const dayStart = new Date(dayDate);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayDate);
    dayEnd.setHours(24, 0, 0, 0);
    
    const dayEvents = weekEvents.filter(ev => {
      const s = new Date(ev.start_at);
      const e = new Date(ev.end_at);
      return s < dayEnd && e > dayStart;
    });
    
    const dayCol = renderDayColumn(
      weekStart, 
      day, 
      dayEvents, 
      (ev) => showEditModal(ev),
      () => {}
    );
    daysContainer.appendChild(dayCol);
  }
  
  container.appendChild(daysContainer);
  app.appendChild(container);
}

async function loadAndRender() {
  try {
    const weekEnd = new Date(currentWeekStart);
    weekEnd.setDate(weekEnd.getDate() + 7);
    
    events = await fetchEvents(currentWeekStart, weekEnd);
    renderCalendar(currentWeekStart, events);
  } catch (err) {
    console.error(err);
    const app = document.getElementById('app');
    app.innerHTML = `<p>Error loading calendar: ${err.message}</p>`;
  }
}

// Initial load
document.addEventListener('DOMContentLoaded', () => {
  loadAndRender();
});