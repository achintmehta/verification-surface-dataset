const API_BASE = '/api';
const HOUR_HEIGHT = 30; // pixels per hour
const TOTAL_HOURS = 24;
const CALENDAR_HEIGHT = TOTAL_HOURS * HOUR_HEIGHT;

let currentWeekStart = getWeekStart(new Date());

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

function formatDateTimeLocal(date) {
  const pad = n => n.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseDateTimeLocal(str) {
  return new Date(str);
}

async function fetchEvents(start, end) {
  const params = new URLSearchParams({
    start: start.toISOString(),
    end: end.toISOString()
  });
  const res = await fetch(`${API_BASE}/events?${params}`);
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

// Overlap layout algorithm
function computeEventLayout(events) {
  // Group events by day (0=Mon ... 6=Sun)
  const eventsByDay = Array.from({ length: 7 }, () => []);
  
  events.forEach(event => {
    const start = new Date(event.start_at);
    const end = new Date(event.end_at);
    
    // Handle events that span multiple days - split them
    let current = new Date(start);
    while (current < end) {
      const dayStart = new Date(current);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart);
      dayEnd.setHours(24, 0, 0, 0);
      
      const eventDayStart = current > dayStart ? current : dayStart;
      const eventDayEnd = end < dayEnd ? end : dayEnd;
      
      if (eventDayStart < eventDayEnd) {
        const dayIndex = (eventDayStart.getDay() + 6) % 7; // Mon=0
        eventsByDay[dayIndex].push({
          ...event,
          _start: eventDayStart,
          _end: eventDayEnd,
          _originalStart: start,
          _originalEnd: end,
          _isSplit: start.getDate() !== end.getDate()
        });
      }
      
      current = new Date(dayEnd);
    }
  });

  // For each day, compute clusters and columns
  return eventsByDay.map((dayEvents, dayIndex) => {
    if (dayEvents.length === 0) return { events: [], dayIndex };
    
    // Sort by start time
    dayEvents.sort((a, b) => a._start - b._start);
    
    // Find overlap clusters
    const clusters = [];
    let currentCluster = [dayEvents[0]];
    
    for (let i = 1; i < dayEvents.length; i++) {
      const event = dayEvents[i];
      const clusterEnd = Math.max(...currentCluster.map(e => e._end.getTime()));
      
      if (event._start.getTime() < clusterEnd) {
        currentCluster.push(event);
      } else {
        clusters.push(currentCluster);
        currentCluster = [event];
      }
    }
    clusters.push(currentCluster);
    
    // Assign columns within each cluster
    const laidOutEvents = [];
    
    clusters.forEach(cluster => {
      // Sort cluster by start time for greedy column assignment
      cluster.sort((a, b) => a._start - b._start);
      
      const columns = []; // end times of last event in each column
      
      cluster.forEach(event => {
        // Find first available column
        let col = 0;
        while (col < columns.length && columns[col] > event._start.getTime()) {
          col++;
        }
        
        if (col === columns.length) {
          columns.push(event._end.getTime());
        } else {
          columns[col] = event._end.getTime();
        }
        
        event._column = col;
        event._totalColumns = columns.length; // will be updated to max
      });
      
      const maxCols = columns.length;
      cluster.forEach(event => {
        event._totalColumns = maxCols;
        laidOutEvents.push(event);
      });
    });
    
    return { events: laidOutEvents, dayIndex };
  });
}

function renderWeek(weekStart, events) {
  const container = document.getElementById('days-container');
  container.innerHTML = '';
  
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);
  
  // Update week range display
  const rangeEl = document.getElementById('week-range');
  const endDisplay = new Date(weekEnd);
  endDisplay.setDate(endDisplay.getDate() - 1);
  rangeEl.textContent = `${weekStart.toLocaleDateString()} - ${endDisplay.toLocaleDateString()}`;
  
  // Create 7 day columns
  const dayLayouts = computeEventLayout(events);
  const dayCols = [];
  
  for (let i = 0; i < 7; i++) {
    const dayDate = new Date(weekStart);
    dayDate.setDate(dayDate.getDate() + i);
    
    const dayCol = document.createElement('div');
    dayCol.className = 'day-column';
    
    // Day header
    const header = document.createElement('div');
    header.className = 'day-header';
    
    const isToday = dayDate.toDateString() === new Date().toDateString();
    if (isToday) header.classList.add('today');
    
    header.innerHTML = `
      <div class="day-name">${dayDate.toLocaleDateString('en-US', { weekday: 'short' })}</div>
      <div class="day-date">${dayDate.getDate()}</div>
    `;
    dayCol.appendChild(header);
    
    // Hour lines background
    for (let h = 0; h <= 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${h * HOUR_HEIGHT}px`;
      dayCol.appendChild(line);
    }
    
    // Add click handler for creating events
    dayCol.addEventListener('click', (e) => {
      if (e.target === dayCol || e.target.classList.contains('hour-line')) {
        const rect = dayCol.getBoundingClientRect();
        const y = e.clientY - rect.top - 50; // account for header
        const hour = Math.max(0, Math.min(23, Math.floor(y / HOUR_HEIGHT)));
        const minute = Math.floor(((y % HOUR_HEIGHT) / HOUR_HEIGHT) * 60 / 15) * 15; // snap to 15min
        
        const start = new Date(dayDate);
        start.setHours(hour, minute, 0, 0);
        const end = new Date(start);
        end.setHours(end.getHours() + 1);
        
        openCreateModal(start, end);
      }
    });
    
    container.appendChild(dayCol);
    dayCols.push({ col: dayCol, layout: dayLayouts[i], date: dayDate });
  }
  
  // Now render events after columns are in DOM so offsetWidth is correct
  dayCols.forEach(({ col, layout }) => {
    const dayWidth = col.offsetWidth || 140;
    layout.events.forEach(event => {
      const eventEl = createEventElement(event, dayWidth);
      col.appendChild(eventEl);
    });
  });
}

function createEventElement(event, dayWidth) {
  const el = document.createElement('div');
  el.className = 'event';
  
  const start = event._start || new Date(event.start_at);
  const end = event._end || new Date(event.end_at);
  
  const startMinutes = start.getHours() * 60 + start.getMinutes();
  const endMinutes = end.getHours() * 60 + end.getMinutes();
  
  const top = (startMinutes / 60) * HOUR_HEIGHT;
  const height = Math.max(20, ((endMinutes - startMinutes) / 60) * HOUR_HEIGHT);
  
  // Layout positioning
  const col = event._column || 0;
  const totalCols = event._totalColumns || 1;
  const colWidth = dayWidth / totalCols;
  const left = col * colWidth;
  
  el.style.top = `${top}px`;
  el.style.height = `${height}px`;
  el.style.left = `${left + 2}px`;
  el.style.width = `${colWidth - 4}px`;
  
  const title = event.title || 'Untitled';
  const timeStr = `${formatTime(start)} - ${formatTime(end)}`;
  
  el.innerHTML = `
    <div class="event-title">${title}</div>
    <div class="event-time">${timeStr}</div>
  `;
  
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    openEditModal(event);
  });
  
  return el;
}

function openCreateModal(start, end) {
  const modal = document.getElementById('event-modal');
  const form = document.getElementById('event-form');
  const titleEl = document.getElementById('modal-title');
  const deleteBtn = document.getElementById('delete-btn');
  
  titleEl.textContent = 'Create Event';
  deleteBtn.classList.add('hidden');
  document.getElementById('event-id').value = '';
  
  document.getElementById('title').value = '';
  document.getElementById('start').value = formatDateTimeLocal(start);
  document.getElementById('end').value = formatDateTimeLocal(end);
  
  modal.classList.remove('hidden');
  
  form.onsubmit = async (e) => {
    e.preventDefault();
    await handleSaveEvent();
  };
  
  document.getElementById('cancel-btn').onclick = () => {
    modal.classList.add('hidden');
  };
}

function openEditModal(event) {
  const modal = document.getElementById('event-modal');
  const form = document.getElementById('event-form');
  const titleEl = document.getElementById('modal-title');
  const deleteBtn = document.getElementById('delete-btn');
  
  titleEl.textContent = 'Edit Event';
  deleteBtn.classList.remove('hidden');
  
  document.getElementById('event-id').value = event.id;
  document.getElementById('title').value = event.title;
  document.getElementById('start').value = formatDateTimeLocal(new Date(event.start_at));
  document.getElementById('end').value = formatDateTimeLocal(new Date(event.end_at));
  
  modal.classList.remove('hidden');
  
  form.onsubmit = async (e) => {
    e.preventDefault();
    await handleSaveEvent();
  };
  
  deleteBtn.onclick = async () => {
    if (confirm('Delete this event?')) {
      try {
        await deleteEvent(event.id);
        modal.classList.add('hidden');
        await loadAndRenderWeek();
      } catch (err) {
        alert(err.message);
      }
    }
  };
  
  document.getElementById('cancel-btn').onclick = () => {
    modal.classList.add('hidden');
  };
}

async function handleSaveEvent() {
  const modal = document.getElementById('event-modal');
  const id = document.getElementById('event-id').value;
  const title = document.getElementById('title').value.trim();
  const startStr = document.getElementById('start').value;
  const endStr = document.getElementById('end').value;
  
  if (!title) {
    alert('Title is required');
    return;
  }
  
  const start = parseDateTimeLocal(startStr);
  const end = parseDateTimeLocal(endStr);
  
  if (end <= start) {
    alert('End time must be after start time');
    return;
  }
  
  const eventData = {
    title,
    start_at: start.toISOString(),
    end_at: end.toISOString()
  };
  
  try {
    if (id) {
      await updateEvent(id, eventData);
    } else {
      await createEvent(eventData);
    }
    modal.classList.add('hidden');
    await loadAndRenderWeek();
  } catch (err) {
    alert(err.message);
  }
}

async function loadAndRenderWeek() {
  const weekStart = currentWeekStart;
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);
  
  try {
    const events = await fetchEvents(weekStart, weekEnd);
    renderWeek(weekStart, events);
  } catch (err) {
    console.error(err);
    alert('Failed to load events');
  }
}

function setupNavigation() {
  document.getElementById('prev-week').addEventListener('click', () => {
    currentWeekStart.setDate(currentWeekStart.getDate() - 7);
    loadAndRenderWeek();
  });
  
  document.getElementById('next-week').addEventListener('click', () => {
    currentWeekStart.setDate(currentWeekStart.getDate() + 7);
    loadAndRenderWeek();
  });
  
  document.getElementById('today').addEventListener('click', () => {
    currentWeekStart = getWeekStart(new Date());
    loadAndRenderWeek();
  });
}

function renderTimeAxis() {
  const axis = document.getElementById('time-axis');
  axis.style.height = `${CALENDAR_HEIGHT}px`;
  
  for (let h = 0; h < 24; h++) {
    const label = document.createElement('div');
    label.className = 'hour-label';
    label.style.top = `${h * HOUR_HEIGHT}px`;
    label.textContent = `${h.toString().padStart(2, '0')}:00`;
    axis.appendChild(label);
  }
}

async function init() {
  renderTimeAxis();
  setupNavigation();
  
  // Initial load
  await loadAndRenderWeek();
  
  // Make calendar container height match
  const container = document.getElementById('calendar-container');
  container.style.height = `${CALENDAR_HEIGHT + 50}px`; // + header
}

init();