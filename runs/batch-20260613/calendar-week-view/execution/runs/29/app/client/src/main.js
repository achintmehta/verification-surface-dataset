const API_BASE = '/api';

let currentWeekStart = getWeekStart(new Date());
let events = [];
let selectedEvent = null;

function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday
  return new Date(d.setDate(diff));
}

function getWeekEnd(weekStart) {
  const end = new Date(weekStart);
  end.setDate(end.getDate() + 6);
  end.setHours(23, 59, 59, 999);
  return end;
}

function formatDateHeader(date) {
  return {
    name: date.toLocaleDateString('en-US', { weekday: 'short' }),
    date: date.getDate()
  };
}

function formatTime(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function minutesFromMidnight(dateStr) {
  const d = new Date(dateStr);
  return d.getHours() * 60 + d.getMinutes();
}

function getDayIndex(dateStr, weekStart) {
  const d = new Date(dateStr);
  const start = new Date(weekStart);
  start.setHours(0,0,0,0);
  const diff = Math.floor((d.getTime() - start.getTime()) / (1000*3600*24));
  return Math.max(0, Math.min(6, diff));
}

async function fetchEvents() {
  const start = currentWeekStart.toISOString();
  const end = getWeekEnd(currentWeekStart).toISOString();
  const res = await fetch(`${API_BASE}/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
  if (!res.ok) throw new Error('Failed to fetch');
  events = await res.json();
}

function renderCalendar() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="calendar-header">
      <h1>Week of ${currentWeekStart.toLocaleDateString()}</h1>
      <div class="nav-buttons">
        <button id="prev-btn">Previous</button>
        <button id="today-btn">Today</button>
        <button id="next-btn">Next</button>
      </div>
    </div>
    <div class="week-grid" id="week-grid">
      <div class="time-axis">
        ${Array.from({length: 24}, (_, i) => `
          <div class="time-slot">${i === 0 ? '12 AM' : i < 12 ? i + ' AM' : (i === 12 ? '12 PM' : (i-12) + ' PM')}</div>
        `).join('')}
      </div>
      <div class="day-columns" id="day-columns"></div>
    </div>
  `;

  const dayColumns = document.getElementById('day-columns');
  const today = new Date();
  today.setHours(0,0,0,0);

  for (let i = 0; i < 7; i++) {
    const dayDate = new Date(currentWeekStart);
    dayDate.setDate(dayDate.getDate() + i);
    dayDate.setHours(0,0,0,0);

    const isToday = dayDate.getTime() === today.getTime();
    const header = formatDateHeader(dayDate);

    const column = document.createElement('div');
    column.className = `day-column ${isToday ? 'today' : ''}`;
    column.innerHTML = `
      <div class="day-header ${isToday ? 'today' : ''}">
        <div class="day-name">${header.name}</div>
        <div class="day-date">${header.date}</div>
      </div>
      <div class="hour-lines">
        ${Array.from({length: 24}, () => `<div class="hour-line"></div>`).join('')}
      </div>
      <div class="events-container" data-day-index="${i}"></div>
    `;

    // Add click handler for creating events
    const eventsContainer = column.querySelector('.events-container');
    eventsContainer.addEventListener('mousedown', (e) => startDragCreate(e, i, eventsContainer));

    dayColumns.appendChild(column);
  }

  renderEvents();

  // Navigation
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

function startDragCreate(e, dayIndex, container) {
  const rect = container.getBoundingClientRect();
  const startY = e.clientY - rect.top;
  const startMinutes = Math.floor((startY / rect.height) * 24 * 60 / 15) * 15; // snap to 15 min

  let endMinutes = startMinutes + 60;

  const dragOverlay = document.createElement('div');
  dragOverlay.style.position = 'absolute';
  dragOverlay.style.left = '0';
  dragOverlay.style.right = '0';
  dragOverlay.style.top = `${startY}px`;
  dragOverlay.style.height = `${(60 / (24*60)) * rect.height}px`;
  dragOverlay.style.background = 'rgba(74, 144, 226, 0.3)';
  dragOverlay.style.border = '2px dashed #4a90e2';
  dragOverlay.style.zIndex = '10';
  container.appendChild(dragOverlay);

  const onMouseMove = (moveEvent) => {
    const currentY = moveEvent.clientY - rect.top;
    const deltaY = currentY - startY;
    const deltaMin = Math.floor((deltaY / rect.height) * 24 * 60 / 15) * 15;
    endMinutes = Math.max(startMinutes + 15, startMinutes + deltaMin);
    const height = Math.max(15, (endMinutes - startMinutes) / (24*60) * rect.height);
    dragOverlay.style.height = `${height}px`;
  };

  const onMouseUp = () => {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    container.removeChild(dragOverlay);

    const dayDate = new Date(currentWeekStart);
    dayDate.setDate(dayDate.getDate() + dayIndex);
    const startTime = new Date(dayDate);
    startTime.setHours(0, 0, startMinutes, 0);
    const endTime = new Date(dayDate);
    endTime.setHours(0, 0, endMinutes, 0);

    openCreateModal(startTime.toISOString(), endTime.toISOString());
  };

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp, { once: true });
}

function renderEvents() {
  // Clear all containers
  document.querySelectorAll('.events-container').forEach(c => c.innerHTML = '');

  // Group events by day
  const eventsByDay = Array.from({ length: 7 }, () => []);
  events.forEach(event => {
    const dayIdx = getDayIndex(event.start_at, currentWeekStart);
    // Also check if ends on next day, but for simplicity clamp to start day, or split? For week view, if crosses, but rare, put in start day
    eventsByDay[dayIdx].push(event);
  });

  eventsByDay.forEach((dayEvents, dayIdx) => {
    if (dayEvents.length === 0) return;

    const container = document.querySelector(`.events-container[data-day-index="${dayIdx}"]`);
    if (!container) return;

    const containerHeight = 720;
    const containerWidth = container.offsetWidth || 150;

    // Compute clusters
    const clusters = computeClusters(dayEvents);

    clusters.forEach(cluster => {
      const maxColumns = assignColumns(cluster);
      const colWidth = containerWidth / maxColumns;

      cluster.forEach(event => {
        const eventEl = createEventElement(event, containerHeight, colWidth, containerWidth);
        container.appendChild(eventEl);
      });
    });
  });
}

function computeClusters(dayEvents) {
  const sorted = [...dayEvents].sort((a, b) => new Date(a.start_at) - new Date(b.start_at));
  const clusters = [];
  let currentCluster = [];

  sorted.forEach(event => {
    if (currentCluster.length === 0) {
      currentCluster.push(event);
    } else {
      const overlaps = currentCluster.some(e => 
        new Date(event.start_at) < new Date(e.end_at) && new Date(event.end_at) > new Date(e.start_at)
      );
      if (overlaps) {
        currentCluster.push(event);
      } else {
        clusters.push(currentCluster);
        currentCluster = [event];
      }
    }
  });
  if (currentCluster.length > 0) clusters.push(currentCluster);

  return clusters;
}

function assignColumns(cluster) {
  // Greedy column assignment
  const sorted = [...cluster].sort((a, b) => new Date(a.start_at) - new Date(b.start_at));
  const columnEnds = []; // end time per column

  sorted.forEach(event => {
    const start = new Date(event.start_at);
    let assignedCol = -1;
    for (let c = 0; c < columnEnds.length; c++) {
      if (new Date(columnEnds[c]) <= start) {
        assignedCol = c;
        break;
      }
    }
    if (assignedCol === -1) {
      assignedCol = columnEnds.length;
      columnEnds.push(event.end_at);
    } else {
      columnEnds[assignedCol] = event.end_at;
    }
    event._col = assignedCol;
  });

  const maxCols = columnEnds.length;
  cluster.forEach(e => e._maxCols = maxCols);
  return maxCols;
}

function createEventElement(event, containerHeight, colWidth, containerWidth) {
  const startMin = minutesFromMidnight(event.start_at);
  const endMin = minutesFromMidnight(event.end_at);
  const top = (startMin / (24 * 60)) * containerHeight;
  let height = ((endMin - startMin) / (24 * 60)) * containerHeight;
  height = Math.max(height, 20); // min height

  const col = event._col || 0;
  const maxCols = event._maxCols || 1;
  const width = containerWidth / maxCols;
  const left = col * width;

  const el = document.createElement('div');
  el.className = 'event';
  el.style.top = `${top}px`;
  el.style.height = `${height}px`;
  el.style.left = `${left}px`;
  el.style.width = `${width}px`;

  const title = document.createElement('div');
  title.className = 'event-title';
  title.textContent = event.title;

  const time = document.createElement('div');
  time.className = 'event-time';
  time.textContent = `${formatTime(event.start_at)} - ${formatTime(event.end_at)}`;

  el.appendChild(title);
  el.appendChild(time);

  el.addEventListener('click', (e) => {
    e.stopPropagation();
    openEditModal(event);
  });

  return el;
}

function openCreateModal(startIso, endIso) {
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content">
      <h2>New Event</h2>
      <div class="form-group">
        <label>Title</label>
        <input type="text" id="event-title" placeholder="Event title">
      </div>
      <div class="form-group">
        <label>Start</label>
        <input type="datetime-local" id="event-start" value="${startIso.slice(0,16)}">
      </div>
      <div class="form-group">
        <label>End</label>
        <input type="datetime-local" id="event-end" value="${endIso.slice(0,16)}">
      </div>
      <div class="modal-actions">
        <button class="btn-secondary" id="cancel-btn">Cancel</button>
        <button class="btn-primary" id="save-btn">Create</button>
      </div>
      <div id="form-error" class="error"></div>
    </div>
  `;
  document.body.appendChild(modal);

  const titleInput = modal.querySelector('#event-title');
  titleInput.focus();

  modal.querySelector('#cancel-btn').addEventListener('click', () => modal.remove());
  modal.querySelector('#save-btn').addEventListener('click', async () => {
    const title = titleInput.value.trim();
    const start = modal.querySelector('#event-start').value;
    const end = modal.querySelector('#event-end').value;
    const errorEl = modal.querySelector('#form-error');

    if (!title) {
      errorEl.textContent = 'Title is required';
      return;
    }
    if (!start || !end || new Date(end) <= new Date(start)) {
      errorEl.textContent = 'End must be after start';
      return;
    }

    try {
      const res = await fetch(`${API_BASE}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, start_at: new Date(start).toISOString(), end_at: new Date(end).toISOString() })
      });
      if (!res.ok) {
        const err = await res.json();
        errorEl.textContent = err.error || 'Failed to create';
        return;
      }
      modal.remove();
      await loadAndRender();
    } catch (e) {
      errorEl.textContent = 'Network error';
    }
  });
}

function openEditModal(event) {
  const modal = document.createElement('div');
  modal.className = 'modal';
  const startVal = new Date(event.start_at).toISOString().slice(0,16);
  const endVal = new Date(event.end_at).toISOString().slice(0,16);
  modal.innerHTML = `
    <div class="modal-content">
      <h2>Edit Event</h2>
      <div class="form-group">
        <label>Title</label>
        <input type="text" id="event-title" value="${event.title}">
      </div>
      <div class="form-group">
        <label>Start</label>
        <input type="datetime-local" id="event-start" value="${startVal}">
      </div>
      <div class="form-group">
        <label>End</label>
        <input type="datetime-local" id="event-end" value="${endVal}">
      </div>
      <div class="modal-actions">
        <button class="btn-danger" id="delete-btn">Delete</button>
        <button class="btn-secondary" id="cancel-btn">Cancel</button>
        <button class="btn-primary" id="save-btn">Save</button>
      </div>
      <div id="form-error" class="error"></div>
    </div>
  `;
  document.body.appendChild(modal);

  modal.querySelector('#cancel-btn').addEventListener('click', () => modal.remove());
  modal.querySelector('#delete-btn').addEventListener('click', async () => {
    if (!confirm('Delete this event?')) return;
    try {
      await fetch(`${API_BASE}/events/${event.id}`, { method: 'DELETE' });
      modal.remove();
      await loadAndRender();
    } catch (e) {}
  });
  modal.querySelector('#save-btn').addEventListener('click', async () => {
    const title = modal.querySelector('#event-title').value.trim();
    const start = modal.querySelector('#event-start').value;
    const end = modal.querySelector('#event-end').value;
    const errorEl = modal.querySelector('#form-error');

    if (!title) {
      errorEl.textContent = 'Title is required';
      return;
    }
    if (!start || !end || new Date(end) <= new Date(start)) {
      errorEl.textContent = 'End must be after start';
      return;
    }

    try {
      const res = await fetch(`${API_BASE}/events/${event.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, start_at: new Date(start).toISOString(), end_at: new Date(end).toISOString() })
      });
      if (!res.ok) {
        const err = await res.json();
        errorEl.textContent = err.error || 'Failed to save';
        return;
      }
      modal.remove();
      await loadAndRender();
    } catch (e) {
      errorEl.textContent = 'Network error';
    }
  });
}

async function loadAndRender() {
  try {
    await fetchEvents();
    renderCalendar();
  } catch (e) {
    console.error(e);
    const app = document.getElementById('app');
    app.innerHTML = '<p>Error loading calendar. Is the server running?</p>';
  }
}

// Initial load
loadAndRender();