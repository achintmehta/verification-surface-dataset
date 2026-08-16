const API_BASE = '/api';
const HOUR_HEIGHT = 30; // pixels per hour
const TOTAL_HOURS = 24;
const CALENDAR_HEIGHT = HOUR_HEIGHT * TOTAL_HOURS;

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
    const err = await res.json().catch(() => ({}));
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
    const err = await res.json().catch(() => ({}));
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

function getWeekDays(weekStart) {
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    days.push(d);
  }
  return days;
}

function getEventsForDay(events, day) {
  const dayStart = new Date(day);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(day);
  dayEnd.setHours(24, 0, 0, 0);
  
  return events.filter(e => {
    const eStart = new Date(e.start_at);
    const eEnd = new Date(e.end_at);
    return eStart < dayEnd && eEnd > dayStart;
  }).map(e => {
    // Clamp to day
    const eStart = new Date(e.start_at);
    const eEnd = new Date(e.end_at);
    const start = Math.max(eStart, dayStart);
    const end = Math.min(eEnd, dayEnd);
    return {
      ...e,
      _start: start,
      _end: end,
      _dayStart: dayStart,
      _dayEnd: dayEnd
    };
  });
}

// Cluster-based overlap layout
function layoutEvents(eventsForDay) {
  if (eventsForDay.length === 0) return [];
  
  // Sort by start time
  const sorted = [...eventsForDay].sort((a, b) => a._start - b._start);
  
  // Find overlap clusters
  const clusters = [];
  let currentCluster = [sorted[0]];
  
  for (let i = 1; i < sorted.length; i++) {
    const event = sorted[i];
    const clusterEnd = Math.max(...currentCluster.map(e => e._end));
    if (event._start < clusterEnd) {
      currentCluster.push(event);
    } else {
      clusters.push(currentCluster);
      currentCluster = [event];
    }
  }
  clusters.push(currentCluster);
  
  const laidOut = [];
  
  for (const cluster of clusters) {
    // Assign columns greedily
    const columns = []; // array of end times for each column
    const eventColumns = new Map();
    
    const clusterSorted = [...cluster].sort((a, b) => a._start - b._start);
    
    for (const event of clusterSorted) {
      // Find first available column
      let col = 0;
      for (; col < columns.length; col++) {
        if (columns[col] <= event._start) {
          break;
        }
      }
      if (col === columns.length) {
        columns.push(event._end);
      } else {
        columns[col] = event._end;
      }
      eventColumns.set(event, col);
    }
    
    const numCols = columns.length;
    const colWidth = 100 / numCols;
    
    for (const event of cluster) {
      const col = eventColumns.get(event);
      const left = col * colWidth;
      const width = colWidth;
      
      // Calculate top and height
      const minutesFromMidnight = (event._start.getHours() * 60 + event._start.getMinutes());
      const durationMinutes = (event._end - event._start) / (1000 * 60);
      
      const top = (minutesFromMidnight / 60) * HOUR_HEIGHT;
      const height = (durationMinutes / 60) * HOUR_HEIGHT;
      
      laidOut.push({
        ...event,
        left: `${left}%`,
        width: `${width}%`,
        top: `${top}px`,
        height: `${Math.max(height, 20)}px` // min height for visibility
      });
    }
  }
  
  return laidOut;
}

function renderCalendar(events, weekStart) {
  const calendarEl = document.getElementById('calendar');
  calendarEl.innerHTML = '';
  calendarEl.style.height = `${CALENDAR_HEIGHT}px`;
  
  const days = getWeekDays(weekStart);
  const today = new Date();
  today.setHours(0,0,0,0);
  
  // Time axis
  const timeAxis = document.createElement('div');
  timeAxis.className = 'time-axis';
  timeAxis.style.height = `${CALENDAR_HEIGHT}px`;
  
  for (let h = 0; h <= 24; h++) {
    const label = document.createElement('div');
    label.className = 'hour-label';
    label.style.top = `${h * HOUR_HEIGHT}px`;
    label.textContent = h === 24 ? '' : `${h.toString().padStart(2, '0')}:00`;
    timeAxis.appendChild(label);
    
    // Hour lines will be in day columns
  }
  calendarEl.appendChild(timeAxis);
  
  // Day columns
  days.forEach((day, dayIndex) => {
    const dayCol = document.createElement('div');
    dayCol.className = 'day-column';
    dayCol.style.height = `${CALENDAR_HEIGHT}px`;
    
    // Header
    const header = document.createElement('div');
    header.className = 'day-header';
    const dayName = day.toLocaleDateString('en-US', { weekday: 'short' });
    const dateStr = day.getDate();
    header.innerHTML = `${dayName}<br>${dateStr}`;
    
    const dayStart = new Date(day);
    dayStart.setHours(0,0,0,0);
    if (dayStart.getTime() === today.getTime()) {
      header.classList.add('today');
    }
    dayCol.appendChild(header);
    
    // Content wrapper for lines and events
    const content = document.createElement('div');
    content.className = 'day-content';
    content.style.height = `${CALENDAR_HEIGHT}px`;
    
    // Hour lines
    for (let h = 0; h < 24; h++) {
      const line = document.createElement('div');
      line.className = `hour-line ${h % 1 === 0 ? 'major' : ''}`;
      line.style.top = `${h * HOUR_HEIGHT}px`;
      content.appendChild(line);
    }
    
    // Events for this day
    const dayEvents = getEventsForDay(events, day);
    const laidOutEvents = layoutEvents(dayEvents);
    
    laidOutEvents.forEach(event => {
      const eventEl = document.createElement('div');
      eventEl.className = 'event';
      eventEl.style.top = event.top;
      eventEl.style.height = event.height;
      eventEl.style.left = event.left;
      eventEl.style.width = event.width;
      
      const startTime = new Date(event.start_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const endTime = new Date(event.end_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      
      eventEl.innerHTML = `
        <div class="event-title">${event.title}</div>
        <div class="event-time">${startTime} - ${endTime}</div>
      `;
      
      eventEl.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditModal(event);
      });
      
      dayCol.appendChild(eventEl);
    });
    
    // Click to create
    dayCol.addEventListener('click', (e) => {
      if (e.target.classList.contains('day-column') || e.target.classList.contains('hour-line')) {
        const rect = dayCol.getBoundingClientRect();
        const y = e.clientY - rect.top - 50; // account for header? wait header is inside
        // Actually header is 50px but since absolute? Better calculate from top of column excluding header? No, events start after header but positions are from top of column.
        // Our hour lines start right after header? No, header is first child, lines are positioned absolute? Wait, need fix.
        // For simplicity, calculate minutes from y relative to column top, but subtract header height.
        const headerHeight = 50;
        const clickY = e.clientY - rect.top - headerHeight;
        const minutes = Math.floor((clickY / HOUR_HEIGHT) * 60);
        const startHour = Math.floor(minutes / 60);
        const startMin = minutes % 60;
        
        const startDate = new Date(day);
        startDate.setHours(startHour, startMin, 0, 0);
        const endDate = new Date(startDate);
        endDate.setHours(startHour + 1, startMin, 0, 0);
        
        openCreateModal(startDate, endDate);
      }
    });
    
    calendarEl.appendChild(dayCol);
  });
  
  // Update week range
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);
  document.getElementById('week-range').textContent = 
    `${weekStart.toLocaleDateString()} - ${weekEnd.toLocaleDateString()}`;
}

function openCreateModal(start, end) {
  const modal = document.getElementById('event-modal');
  const form = document.getElementById('event-form');
  const titleEl = document.getElementById('modal-title');
  const deleteBtn = document.getElementById('delete-btn');
  
  titleEl.textContent = 'Create Event';
  deleteBtn.classList.add('hidden');
  
  document.getElementById('title').value = '';
  document.getElementById('start').value = formatDateTimeLocal(start);
  document.getElementById('end').value = formatDateTimeLocal(end);
  
  modal.classList.remove('hidden');
  
  const handleSubmit = async (e) => {
    e.preventDefault();
    const title = document.getElementById('title').value.trim();
    const startVal = document.getElementById('start').value;
    const endVal = document.getElementById('end').value;
    
    if (!title) {
      alert('Title is required');
      return;
    }
    
    try {
      await createEvent({
        title,
        start_at: new Date(startVal).toISOString(),
        end_at: new Date(endVal).toISOString()
      });
      modal.classList.add('hidden');
      form.removeEventListener('submit', handleSubmit);
      await loadAndRender();
    } catch (err) {
      alert(err.message);
    }
  };
  
  form.onsubmit = handleSubmit;
  
  document.getElementById('cancel-btn').onclick = () => {
    modal.classList.add('hidden');
    form.onsubmit = null;
  };
}

function openEditModal(event) {
  const modal = document.getElementById('event-modal');
  const form = document.getElementById('event-form');
  const titleEl = document.getElementById('modal-title');
  const deleteBtn = document.getElementById('delete-btn');
  
  titleEl.textContent = 'Edit Event';
  deleteBtn.classList.remove('hidden');
  
  document.getElementById('title').value = event.title;
  document.getElementById('start').value = formatDateTimeLocal(new Date(event.start_at));
  document.getElementById('end').value = formatDateTimeLocal(new Date(event.end_at));
  
  modal.classList.remove('hidden');
  
  const handleSubmit = async (e) => {
    e.preventDefault();
    const title = document.getElementById('title').value.trim();
    const startVal = document.getElementById('start').value;
    const endVal = document.getElementById('end').value;
    
    if (!title) {
      alert('Title is required');
      return;
    }
    
    try {
      await updateEvent(event.id, {
        title,
        start_at: new Date(startVal).toISOString(),
        end_at: new Date(endVal).toISOString()
      });
      modal.classList.add('hidden');
      form.removeEventListener('submit', handleSubmit);
      await loadAndRender();
    } catch (err) {
      alert(err.message);
    }
  };
  
  form.onsubmit = handleSubmit;
  
  document.getElementById('cancel-btn').onclick = () => {
    modal.classList.add('hidden');
    form.onsubmit = null;
  };
  
  deleteBtn.onclick = async () => {
    if (confirm('Delete this event?')) {
      try {
        await deleteEvent(event.id);
        modal.classList.add('hidden');
        form.onsubmit = null;
        await loadAndRender();
      } catch (err) {
        alert(err.message);
      }
    }
  };
}

async function loadAndRender() {
  const weekStart = currentWeekStart;
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);
  
  try {
    const events = await fetchEvents(weekStart, weekEnd);
    renderCalendar(events, weekStart);
  } catch (err) {
    console.error(err);
    alert('Failed to load events');
  }
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
}

function init() {
  setupNavigation();
  loadAndRender();
}

init();