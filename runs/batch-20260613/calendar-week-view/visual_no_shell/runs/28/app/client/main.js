const API_BASE = '/api';
const HOUR_HEIGHT = 25; // pixels per hour
const DAY_HEADER_HEIGHT = 50;
const TIME_AXIS_WIDTH = 60;
const TOTAL_HOURS = 24;

let currentWeekStart = getWeekStart(new Date());
let events = [];

function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday start
  return new Date(d.setDate(diff));
}

function formatTime(date) {
  return date.toTimeString().slice(0, 5);
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

function getEventsForDay(day, allEvents) {
  const dayStart = new Date(day);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(day);
  dayEnd.setHours(24, 0, 0, 0);
  
  return allEvents.filter(event => {
    const start = new Date(event.start_at);
    const end = new Date(event.end_at);
    return start < dayEnd && end > dayStart;
  }).map(event => {
    const start = new Date(event.start_at);
    const end = new Date(event.end_at);
    // Clamp to day
    const effectiveStart = new Date(Math.max(start.getTime(), dayStart.getTime()));
    const effectiveEnd = new Date(Math.min(end.getTime(), dayEnd.getTime()));
    return {
      ...event,
      _start: effectiveStart,
      _end: effectiveEnd,
      _startMinutes: (effectiveStart.getHours() * 60 + effectiveStart.getMinutes()),
      _endMinutes: (effectiveEnd.getHours() * 60 + effectiveEnd.getMinutes())
    };
  });
}

// Cluster-based overlap layout
function layoutEvents(eventsForDay, columnWidth) {
  if (eventsForDay.length === 0) return [];
  
  // Sort by start time
  const sorted = [...eventsForDay].sort((a, b) => a._start - b._start);
  
  // Find overlap clusters
  const clusters = [];
  let currentCluster = [sorted[0]];
  
  for (let i = 1; i < sorted.length; i++) {
    const event = sorted[i];
    const clusterEnd = Math.max(...currentCluster.map(e => e._end.getTime()));
    if (event._start.getTime() < clusterEnd) {
      currentCluster.push(event);
    } else {
      clusters.push(currentCluster);
      currentCluster = [event];
    }
  }
  clusters.push(currentCluster);
  
  const layouts = [];
  
  for (const cluster of clusters) {
    // Greedy column assignment
    const columns = []; // array of end times for each column
    const eventColumns = new Map();
    
    const clusterSorted = [...cluster].sort((a, b) => 
      a._start.getTime() - b._start.getTime() || a._end.getTime() - b._end.getTime()
    );
    
    for (const event of clusterSorted) {
      let assignedCol = 0;
      let found = false;
      for (let c = 0; c < columns.length; c++) {
        if (columns[c] <= event._start.getTime()) {
          assignedCol = c;
          columns[c] = event._end.getTime();
          found = true;
          break;
        }
      }
      if (!found) {
        assignedCol = columns.length;
        columns.push(event._end.getTime());
      }
      eventColumns.set(event, assignedCol);
    }
    
    const numColumns = columns.length;
    const eventWidth = columnWidth / numColumns;
    
    for (const event of cluster) {
      const col = eventColumns.get(event);
      const left = col * eventWidth;
      const width = eventWidth;
      
      const top = (event._startMinutes / 60) * HOUR_HEIGHT;
      const height = ((event._endMinutes - event._startMinutes) / 60) * HOUR_HEIGHT;
      
      layouts.push({
        event,
        left,
        width,
        top,
        height
      });
    }
  }
  
  return layouts;
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
  if (!res.ok) throw new Error('Failed to delete event');
}

function renderCalendar(weekStart, allEvents) {
  const calendarEl = document.getElementById('calendar');
  calendarEl.innerHTML = '';
  calendarEl.style.position = 'relative';
  calendarEl.style.height = `${DAY_HEADER_HEIGHT + TOTAL_HOURS * HOUR_HEIGHT}px`;
  calendarEl.style.display = 'flex';
  
  const weekDays = getWeekDays(weekStart);
  
  // Set week range
  const rangeEl = document.getElementById('week-range');
  const startStr = weekDays[0].toLocaleDateString();
  const endStr = weekDays[6].toLocaleDateString();
  rangeEl.textContent = `${startStr} - ${endStr}`;
  
  // Time axis column
  const timeCol = document.createElement('div');
  timeCol.style.width = `${TIME_AXIS_WIDTH}px`;
  timeCol.style.flexShrink = '0';
  timeCol.style.borderRight = '1px solid #ddd';
  timeCol.style.position = 'relative';
  timeCol.style.height = `${TOTAL_HOURS * HOUR_HEIGHT}px`;
  timeCol.style.marginTop = `${DAY_HEADER_HEIGHT}px`;
  timeCol.style.background = '#fafafa';
  
  for (let h = 0; h <= TOTAL_HOURS; h++) {
    const label = document.createElement('div');
    label.className = 'hour-label';
    label.style.position = 'absolute';
    label.style.top = `${h * HOUR_HEIGHT - 6}px`;
    label.style.right = '8px';
    label.style.fontSize = '11px';
    label.style.color = '#666';
    label.textContent = h < 24 ? `${h.toString().padStart(2, '0')}:00` : '';
    timeCol.appendChild(label);
    
    if (h < TOTAL_HOURS) {
      const line = document.createElement('div');
      line.style.position = 'absolute';
      line.style.top = `${h * HOUR_HEIGHT}px`;
      line.style.left = `${TIME_AXIS_WIDTH}px`;
      line.style.right = '0';
      line.style.height = '1px';
      line.style.background = '#eee';
      timeCol.appendChild(line);
    }
  }
  
  calendarEl.appendChild(timeCol);
  
  const availableWidth = calendarEl.clientWidth - TIME_AXIS_WIDTH;
  const columnWidth = availableWidth / 7;
  
  weekDays.forEach((day, dayIndex) => {
    const dayCol = document.createElement('div');
    dayCol.className = 'day-column';
    dayCol.style.width = `${columnWidth}px`;
    dayCol.style.flexShrink = '0';
    dayCol.style.borderRight = dayIndex < 6 ? '1px solid #ddd' : 'none';
    dayCol.style.position = 'relative';
    
    // Day header
    const header = document.createElement('div');
    header.className = 'day-header';
    const isToday = day.toDateString() === new Date().toDateString();
    if (isToday) header.classList.add('today');
    header.style.height = `${DAY_HEADER_HEIGHT}px`;
    header.innerHTML = `
      <div>${day.toLocaleDateString('en-US', { weekday: 'short' })}</div>
      <div>${day.getDate()}</div>
    `;
    dayCol.appendChild(header);
    
    // Events container
    const eventsContainer = document.createElement('div');
    eventsContainer.style.position = 'relative';
    eventsContainer.style.height = `${TOTAL_HOURS * HOUR_HEIGHT}px`;
    eventsContainer.style.width = '100%';
    eventsContainer.style.background = 'white';
    
    const dayEvents = getEventsForDay(day, allEvents);
    const layouts = layoutEvents(dayEvents, columnWidth);
    
    layouts.forEach(layout => {
      const eventEl = document.createElement('div');
      eventEl.className = 'event';
      eventEl.style.position = 'absolute';
      eventEl.style.left = `${layout.left + 1}px`;
      eventEl.style.width = `${Math.max(layout.width - 3, 20)}px`;
      eventEl.style.top = `${layout.top}px`;
      eventEl.style.height = `${Math.max(layout.height, 22)}px`;
      
      const startTime = new Date(layout.event.start_at);
      const endTime = new Date(layout.event.end_at);
      
      eventEl.innerHTML = `
        <div class="event-title">${layout.event.title}</div>
        <div class="event-time">${formatTime(startTime)} - ${formatTime(endTime)}</div>
      `;
      
      eventEl.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditModal(layout.event);
      });
      
      eventsContainer.appendChild(eventEl);
    });
    
    // Click to create on empty space
    eventsContainer.addEventListener('click', (e) => {
      if (e.target !== eventsContainer) return;
      const rect = eventsContainer.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const minutesFromMidnight = Math.floor((y / HOUR_HEIGHT) * 60);
      const startHour = Math.floor(minutesFromMidnight / 60);
      const startMin = Math.floor(minutesFromMidnight % 60 / 15) * 15; // snap to 15min
      
      const start = new Date(day);
      start.setHours(startHour, startMin, 0, 0);
      
      const end = new Date(start);
      end.setHours(start.getHours() + 1, startMin, 0, 0);
      
      openCreateModal(start, end);
    });
    
    dayCol.appendChild(eventsContainer);
    calendarEl.appendChild(dayCol);
  });
}

function openCreateModal(start, end) {
  const modal = document.getElementById('modal');
  const form = document.getElementById('event-form');
  const titleEl = document.getElementById('modal-title');
  const idEl = document.getElementById('event-id');
  const titleInput = document.getElementById('event-title');
  const startInput = document.getElementById('event-start');
  const endInput = document.getElementById('event-end');
  const deleteBtn = document.getElementById('delete-btn');
  
  titleEl.textContent = 'Create Event';
  idEl.value = '';
  titleInput.value = '';
  startInput.value = start.toISOString().slice(0, 16);
  endInput.value = end.toISOString().slice(0, 16);
  deleteBtn.classList.add('hidden');
  
  modal.classList.remove('hidden');
  
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await createEvent({
        title: titleInput.value,
        start_at: new Date(startInput.value).toISOString(),
        end_at: new Date(endInput.value).toISOString()
      });
      modal.classList.add('hidden');
      await loadAndRender();
    } catch (err) {
      alert(err.message);
    }
  };
}

function openEditModal(event) {
  const modal = document.getElementById('modal');
  const form = document.getElementById('event-form');
  const titleEl = document.getElementById('modal-title');
  const idEl = document.getElementById('event-id');
  const titleInput = document.getElementById('event-title');
  const startInput = document.getElementById('event-start');
  const endInput = document.getElementById('event-end');
  const deleteBtn = document.getElementById('delete-btn');
  
  titleEl.textContent = 'Edit Event';
  idEl.value = event.id;
  titleInput.value = event.title;
  startInput.value = new Date(event.start_at).toISOString().slice(0, 16);
  endInput.value = new Date(event.end_at).toISOString().slice(0, 16);
  deleteBtn.classList.remove('hidden');
  
  modal.classList.remove('hidden');
  
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await updateEvent(event.id, {
        title: titleInput.value,
        start_at: new Date(startInput.value).toISOString(),
        end_at: new Date(endInput.value).toISOString()
      });
      modal.classList.add('hidden');
      await loadAndRender();
    } catch (err) {
      alert(err.message);
    }
  };
  
  deleteBtn.onclick = async () => {
    if (confirm('Delete this event?')) {
      try {
        await deleteEvent(event.id);
        modal.classList.add('hidden');
        await loadAndRender();
      } catch (err) {
        alert(err.message);
      }
    }
  };
}

function setupNavigation() {
  document.getElementById('prev-week').addEventListener('click', () => {
    currentWeekStart.setDate(currentWeekStart.getDate() - 7);
    loadAndRender();
  });
  
  document.getElementById('today').addEventListener('click', () => {
    currentWeekStart = getWeekStart(new Date());
    loadAndRender();
  });
  
  document.getElementById('next-week').addEventListener('click', () => {
    currentWeekStart.setDate(currentWeekStart.getDate() + 7);
    loadAndRender();
  });
  
  document.getElementById('cancel-btn').addEventListener('click', () => {
    document.getElementById('modal').classList.add('hidden');
  });
  
  // Close modal on outside click
  document.getElementById('modal').addEventListener('click', (e) => {
    if (e.target.id === 'modal') {
      document.getElementById('modal').classList.add('hidden');
    }
  });
}

async function loadAndRender() {
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

async function init() {
  setupNavigation();
  await loadAndRender();
}

init();