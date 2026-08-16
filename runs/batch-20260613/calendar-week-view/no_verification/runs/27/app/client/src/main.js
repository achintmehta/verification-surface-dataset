const API_BASE = 'http://localhost:3000/api';
const HOUR_HEIGHT = 30; // pixels per hour
const TOTAL_HOURS = 24;
const CALENDAR_HEIGHT = HOUR_HEIGHT * TOTAL_HOURS;

let currentWeekStart = null; // Monday of current week
let events = [];

// Get Monday of the week for a given date
function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // adjust when day is sunday
  return new Date(d.setDate(diff));
}

function formatDate(date) {
  return date.toISOString().split('T')[0];
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
  const startIso = new Date(start).toISOString();
  const endIso = new Date(end).toISOString();
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
    throw new Error(err.error || 'Failed to create');
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
    throw new Error(err.error || 'Failed to update');
  }
  return res.json();
}

// Delete event
async function deleteEvent(id) {
  const res = await fetch(`${API_BASE}/events/${id}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 204) {
    throw new Error('Failed to delete');
  }
}

// Overlap detection
function eventsOverlap(e1, e2) {
  const s1 = new Date(e1.start_at), e1end = new Date(e1.end_at);
  const s2 = new Date(e2.start_at), e2end = new Date(e2.end_at);
  return s1 < e2end && s2 < e1end;
}

// Build clusters: groups of transitively overlapping events
function buildClusters(dayEvents) {
  const clusters = [];
  const used = new Set();
  
  for (let i = 0; i < dayEvents.length; i++) {
    if (used.has(i)) continue;
    const cluster = [dayEvents[i]];
    used.add(i);
    
    let added = true;
    while (added) {
      added = false;
      for (let j = 0; j < dayEvents.length; j++) {
        if (used.has(j)) continue;
        const ev = dayEvents[j];
        if (cluster.some(c => eventsOverlap(c, ev))) {
          cluster.push(ev);
          used.add(j);
          added = true;
        }
      }
    }
    clusters.push(cluster);
  }
  return clusters;
}

// Greedy column assignment for events in a cluster, sorted by start time
function assignColumns(cluster) {
  const sorted = [...cluster].sort((a, b) => new Date(a.start_at) - new Date(b.start_at));
  const columns = []; // array of end times per column
  const assignment = new Map(); // event -> col index
  
  for (const ev of sorted) {
    const start = new Date(ev.start_at);
    let col = 0;
    for (; col < columns.length; col++) {
      if (columns[col] <= start) {
        break;
      }
    }
    if (col === columns.length) {
      columns.push(null);
    }
    assignment.set(ev, col);
    columns[col] = new Date(ev.end_at);
  }
  
  const numCols = columns.length;
  return { assignment, numCols };
}

// Main layout function: returns map of event id to {left, width} percent
function computeLayout(dayEvents) {
  if (!dayEvents.length) return new Map();
  
  const clusters = buildClusters(dayEvents);
  const layout = new Map();
  
  for (const cluster of clusters) {
    const { assignment, numCols } = assignColumns(cluster);
    const colWidth = 100 / numCols;
    
    for (const ev of cluster) {
      const col = assignment.get(ev);
      const left = col * colWidth;
      const width = colWidth;
      layout.set(ev.id, { left, width });
    }
  }
  
  return layout;
}

// Render the calendar for the week
async function renderWeek(weekStart) {
  currentWeekStart = new Date(weekStart);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);
  
  // Update header
  const rangeEl = document.getElementById('week-range');
  const startStr = weekStart.toLocaleDateString([], { month: 'short', day: 'numeric' });
  const endStr = new Date(weekStart.getTime() + 6*86400000).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  rangeEl.textContent = `${startStr} – ${endStr}`;
  
  // Fetch events
  try {
    events = await fetchEvents(weekStart, weekEnd);
  } catch (e) {
    console.error(e);
    events = [];
  }
  
  // Render time axis
  renderTimeAxis();
  
  // Render day columns
  renderDays(weekStart);
}

function renderTimeAxis() {
  const axis = document.getElementById('time-axis');
  axis.innerHTML = '';
  axis.style.height = `${CALENDAR_HEIGHT}px`;
  
  for (let h = 0; h < 24; h++) {
    const label = document.createElement('div');
    label.className = 'hour-label';
    label.style.top = `${h * HOUR_HEIGHT}px`;
    label.textContent = h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h-12} PM`;
    axis.appendChild(label);
  }
}

function renderDays(weekStart) {
  const container = document.getElementById('days-container');
  container.innerHTML = '';
  container.style.height = `${CALENDAR_HEIGHT}px`;
  
  const today = new Date();
  today.setHours(0,0,0,0);
  
  for (let i = 0; i < 7; i++) {
    const dayDate = new Date(weekStart);
    dayDate.setDate(dayDate.getDate() + i);
    dayDate.setHours(0,0,0,0);
    
    const col = document.createElement('div');
    col.className = 'day-column';
    col.style.height = `${CALENDAR_HEIGHT}px`;
    
    // Header
    const header = document.createElement('div');
    header.className = 'day-header';
    if (dayDate.getTime() === today.getTime()) {
      header.classList.add('today');
    }
    header.innerHTML = `
      <div class="day-name">${dayDate.toLocaleDateString([], { weekday: 'short' })}</div>
      <div class="day-date">${dayDate.getDate()}</div>
    `;
    col.appendChild(header);
    
    // Hour lines (for visual)
    for (let h = 1; h < 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${h * HOUR_HEIGHT}px`;
      col.appendChild(line);
    }
    
    // Filter events for this day
    const dayStart = new Date(dayDate);
    const dayEnd = new Date(dayDate);
    dayEnd.setDate(dayEnd.getDate() + 1);
    
    const dayEvents = events.filter(ev => {
      const s = new Date(ev.start_at);
      const e = new Date(ev.end_at);
      return s < dayEnd && e > dayStart;
    }).map(ev => ({
      ...ev,
      // Clamp for rendering if needed
      renderStart: Math.max(new Date(ev.start_at), dayStart),
      renderEnd: Math.min(new Date(ev.end_at), dayEnd)
    }));
    
    // Compute layout
    const layout = computeLayout(dayEvents);
    
    // Render events
    dayEvents.forEach(ev => {
      const pos = layout.get(ev.id);
      if (!pos) return;
      
      const startMin = (new Date(ev.start_at).getTime() - dayStart.getTime()) / 60000;
      const endMin = (new Date(ev.end_at).getTime() - dayStart.getTime()) / 60000;
      
      const top = Math.max(0, startMin * (HOUR_HEIGHT / 60));
      let height = (endMin - startMin) * (HOUR_HEIGHT / 60);
      height = Math.max(20, height); // min height for visibility
      
      const eventEl = document.createElement('div');
      eventEl.className = 'event';
      eventEl.style.top = `${top}px`;
      eventEl.style.left = `${pos.left}%`;
      eventEl.style.width = `${pos.width}%`;
      eventEl.style.height = `${height}px`;
      
      const title = ev.title || 'Untitled';
      const timeRange = `${formatTime(new Date(ev.start_at))} – ${formatTime(new Date(ev.end_at))}`;
      
      eventEl.innerHTML = `
        <div class="event-title">${title}</div>
        <div class="event-time">${timeRange}</div>
      `;
      
      eventEl.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditModal(ev);
      });
      
      col.appendChild(eventEl);
    });
    
    // Click handler for creating new event (simple click for now, at clicked time)
    col.addEventListener('click', (e) => {
      if (e.target.classList.contains('event')) return;
      
      const rect = col.getBoundingClientRect();
      const headerHeight = 50;
      const y = e.clientY - rect.top - headerHeight;
      if (y < 0) return;
      
      const minutesFromMidnight = Math.floor((y / HOUR_HEIGHT) * 60);
      const startHour = Math.floor(minutesFromMidnight / 60);
      const startMin = minutesFromMidnight % 60;
      
      const start = new Date(dayDate);
      start.setHours(startHour, startMin, 0, 0);
      
      const end = new Date(start);
      end.setHours(start.getHours() + 1);
      
      openCreateModal(start, end);
    });
    
    // Bonus: support drag to select range
    let dragStartY = null;
    col.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('event')) return;
      const rect = col.getBoundingClientRect();
      const headerH = 50;
      dragStartY = e.clientY - rect.top - headerH;
    });
    
    col.addEventListener('mouseup', (e) => {
      if (dragStartY === null) return;
      const rect = col.getBoundingClientRect();
      const headerH = 50;
      const dragEndY = e.clientY - rect.top - headerH;
      
      const y1 = Math.min(dragStartY, dragEndY);
      const y2 = Math.max(dragStartY, dragEndY);
      
      const min1 = Math.floor((y1 / HOUR_HEIGHT) * 60);
      const min2 = Math.floor((y2 / HOUR_HEIGHT) * 60);
      
      const startMin = Math.max(0, min1);
      const endMin = Math.min(24*60, min2);
      
      if (endMin - startMin < 15) {
        // too small, treat as click
        const startH = Math.floor(startMin / 60);
        const startM = startMin % 60;
        const s = new Date(dayDate); s.setHours(startH, startM);
        const en = new Date(s); en.setHours(s.getHours()+1);
        openCreateModal(s, en);
      } else {
        const sh = Math.floor(startMin/60), sm = startMin%60;
        const eh = Math.floor(endMin/60), em = endMin%60;
        const s = new Date(dayDate); s.setHours(sh, sm);
        const en = new Date(dayDate); en.setHours(eh, em);
        if (en <= s) en.setHours(s.getHours()+1);
        openCreateModal(s, en);
      }
      dragStartY = null;
    });
    
    container.appendChild(col);
  }
}

// Modal handling
let modal = null;
let form = null;

function setupModal() {
  modal = document.getElementById('modal');
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
  document.getElementById('start').value = formatDateTimeLocal(start);
  document.getElementById('end').value = formatDateTimeLocal(end);
  document.getElementById('delete-btn').classList.add('hidden');
  modal.classList.remove('hidden');
}

function openEditModal(ev) {
  document.getElementById('modal-title').textContent = 'Edit Event';
  document.getElementById('event-id').value = ev.id;
  document.getElementById('title').value = ev.title;
  document.getElementById('start').value = formatDateTimeLocal(new Date(ev.start_at));
  document.getElementById('end').value = formatDateTimeLocal(new Date(ev.end_at));
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
  
  try {
    if (id) {
      await updateEvent(id, title, start, end);
    } else {
      await createEvent(title, start, end);
    }
    closeModal();
    await renderWeek(currentWeekStart);
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
    await renderWeek(currentWeekStart);
  } catch (err) {
    alert(err.message);
  }
}

// Navigation
function setupNavigation() {
  document.getElementById('prev-week').addEventListener('click', () => {
    const prev = new Date(currentWeekStart);
    prev.setDate(prev.getDate() - 7);
    renderWeek(prev);
  });
  
  document.getElementById('today').addEventListener('click', () => {
    const today = new Date();
    const weekStart = getWeekStart(today);
    renderWeek(weekStart);
  });
  
  document.getElementById('next-week').addEventListener('click', () => {
    const next = new Date(currentWeekStart);
    next.setDate(next.getDate() + 7);
    renderWeek(next);
  });
}

// Initial load
function init() {
  setupModal();
  setupNavigation();
  
  const today = new Date();
  const weekStart = getWeekStart(today);
  renderWeek(weekStart);
}

init();