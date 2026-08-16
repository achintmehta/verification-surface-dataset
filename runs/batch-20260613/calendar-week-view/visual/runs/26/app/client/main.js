const API_BASE = '/api';

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
  const d = new Date(weekStart);
  d.setDate(d.getDate() + dayIndex);
  return d;
}

function isToday(date) {
  const today = new Date();
  return date.toDateString() === today.toDateString();
}

async function fetchEvents() {
  const weekEnd = new Date(currentWeekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);
  const start = currentWeekStart.toISOString();
  const end = weekEnd.toISOString();
  
  const res = await fetch(`${API_BASE}/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
  if (!res.ok) throw new Error('Failed to fetch events');
  events = await res.json();
}

function renderHeader() {
  const header = document.createElement('div');
  header.className = 'calendar-header';
  
  const weekEnd = new Date(currentWeekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);
  const title = document.createElement('h1');
  title.textContent = `${currentWeekStart.toLocaleDateString()} - ${weekEnd.toLocaleDateString()}`;
  
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
  
  for (let hour = 0; hour < 24; hour++) {
    const slot = document.createElement('div');
    slot.className = 'time-slot';
    slot.textContent = `${hour.toString().padStart(2, '0')}:00`;
    axis.appendChild(slot);
  }
  return axis;
}

function renderDayHeader(dayDate, dayIndex) {
  const header = document.createElement('div');
  header.className = 'day-header';
  if (isToday(dayDate)) header.classList.add('today');
  
  const name = document.createElement('div');
  name.className = 'day-name';
  name.textContent = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][dayIndex];
  
  const date = document.createElement('div');
  date.className = 'day-date';
  date.textContent = dayDate.getDate();
  
  header.appendChild(name);
  header.appendChild(date);
  return header;
}

function minutesFromMidnight(dateStr) {
  const d = new Date(dateStr);
  return d.getHours() * 60 + d.getMinutes();
}

function computeEventLayout(dayEvents, dayStart, columnWidth) {
  // dayEvents: events that intersect this day
  if (dayEvents.length === 0) return [];
  
  // Sort by start time
  dayEvents.sort((a, b) => new Date(a.start_at) - new Date(b.start_at));
  
  // Find overlap clusters
  const clusters = [];
  let currentCluster = [dayEvents[0]];
  
  for (let i = 1; i < dayEvents.length; i++) {
    const prev = currentCluster[currentCluster.length - 1];
    const curr = dayEvents[i];
    const prevEnd = new Date(prev.end_at);
    const currStart = new Date(curr.start_at);
    
    if (currStart < prevEnd) {
      currentCluster.push(curr);
    } else {
      clusters.push(currentCluster);
      currentCluster = [curr];
    }
  }
  clusters.push(currentCluster);
  
  const layouts = [];
  
  clusters.forEach(cluster => {
    // Greedy column assignment
    const columns = []; // array of end times for each column
    const eventColumns = new Map();
    
    cluster.forEach(event => {
      const start = new Date(event.start_at);
      let assignedCol = 0;
      
      for (let c = 0; c < columns.length; c++) {
        if (new Date(columns[c]) <= start) {
          assignedCol = c;
          break;
        }
        assignedCol = c + 1;
      }
      
      if (assignedCol >= columns.length) {
        columns.push(event.end_at);
      } else {
        columns[assignedCol] = event.end_at;
      }
      
      eventColumns.set(event, assignedCol);
    });
    
    const numCols = columns.length;
    const colWidth = columnWidth / numCols;
    
    cluster.forEach(event => {
      const colIndex = eventColumns.get(event);
      const left = colIndex * colWidth;
      const width = colWidth;
      
      layouts.push({
        event,
        left,
        width,
        top: minutesFromMidnight(event.start_at),
        height: minutesFromMidnight(event.end_at) - minutesFromMidnight(event.start_at)
      });
    });
  });
  
  return layouts;
}

function renderEvents(dayColumn, dayEvents, dayDate, columnWidth) {
  const dayStart = new Date(dayDate);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayDate);
  dayEnd.setHours(24, 0, 0, 0);
  
  // Filter and clamp events for this day
  const relevantEvents = events.filter(ev => {
    const evStart = new Date(ev.start_at);
    const evEnd = new Date(ev.end_at);
    return evEnd > dayStart && evStart < dayEnd;
  });
  
  const layouts = computeEventLayout(relevantEvents, dayStart, columnWidth);
  
  const PIXELS_PER_MINUTE = 0.5; // 30px per hour = 0.5 per min
  
  layouts.forEach(layout => {
    const evEl = document.createElement('div');
    evEl.className = 'event';
    
    const startMin = Math.max(0, layout.top);
    const endMin = Math.min(1440, layout.top + layout.height);
    
    const topPx = startMin * PIXELS_PER_MINUTE;
    const heightPx = (endMin - startMin) * PIXELS_PER_MINUTE;
    
    evEl.style.top = `${50 + topPx}px`; // 50 for header
    evEl.style.height = `${Math.max(20, heightPx)}px`;
    evEl.style.left = `${layout.left}px`;
    evEl.style.width = `${layout.width - 2}px`; // small gap
    
    const title = document.createElement('div');
    title.className = 'event-title';
    title.textContent = layout.event.title;
    
    const time = document.createElement('div');
    time.className = 'event-time';
    const s = new Date(layout.event.start_at);
    const e = new Date(layout.event.end_at);
    time.textContent = `${formatTime(s)} - ${formatTime(e)}`;
    
    evEl.appendChild(title);
    evEl.appendChild(time);
    
    evEl.onclick = (e) => {
      e.stopPropagation();
      openEditModal(layout.event);
    };
    
    dayColumn.appendChild(evEl);
  });
}

function renderDayColumn(dayIndex) {
  const dayDate = getDayDate(currentWeekStart, dayIndex);
  const column = document.createElement('div');
  column.className = 'day-column';
  
  // Header
  const header = renderDayHeader(dayDate, dayIndex);
  column.appendChild(header);
  
  // Hour lines container
  const lines = document.createElement('div');
  lines.className = 'hour-lines';
  for (let h = 0; h < 24; h++) {
    const line = document.createElement('div');
    line.className = 'hour-line';
    lines.appendChild(line);
  }
  column.appendChild(lines);
  
  // Make column clickable for creating events
  column.onclick = (e) => {
    if (e.target === column || e.target.classList.contains('hour-line')) {
      const rect = column.getBoundingClientRect();
      const y = e.clientY - rect.top - 50; // subtract header
      const minutes = Math.floor(y / 0.5);
      const startMin = Math.max(0, Math.min(1439, minutes));
      
      // Default 1 hour duration
      const startDate = new Date(dayDate);
      startDate.setHours(0, 0, 0, 0);
      startDate.setMinutes(startMin);
      
      const endDate = new Date(startDate);
      endDate.setHours(endDate.getHours() + 1);
      
      openCreateModal(startDate, endDate);
    }
  };
  
  // Also support drag selection
  let isDragging = false;
  let startY = 0;
  let selectionEl = null;
  
  column.onmousedown = (e) => {
    if (e.target !== column && !e.target.classList.contains('hour-line')) return;
    isDragging = true;
    const rect = column.getBoundingClientRect();
    startY = e.clientY - rect.top - 50;
    
    selectionEl = document.createElement('div');
    selectionEl.className = 'selection';
    selectionEl.style.left = '0';
    selectionEl.style.width = '100%';
    column.appendChild(selectionEl);
  };
  
  document.onmousemove = (e) => {
    if (!isDragging || !selectionEl) return;
    const rect = column.getBoundingClientRect();
    const currentY = e.clientY - rect.top - 50;
    const top = Math.min(startY, currentY);
    const height = Math.abs(currentY - startY);
    selectionEl.style.top = `${50 + top}px`;
    selectionEl.style.height = `${height}px`;
  };
  
  document.onmouseup = (e) => {
    if (!isDragging) return;
    isDragging = false;
    
    if (selectionEl) {
      const rect = column.getBoundingClientRect();
      const endY = e.clientY - rect.top - 50;
      const topMin = Math.floor(Math.min(startY, endY) / 0.5);
      const bottomMin = Math.floor(Math.max(startY, endY) / 0.5);
      
      const startDate = new Date(dayDate);
      startDate.setMinutes(Math.max(0, topMin));
      
      const endDate = new Date(dayDate);
      endDate.setMinutes(Math.min(1440, bottomMin || topMin + 60));
      if (endDate <= startDate) endDate.setMinutes(startDate.getMinutes() + 30);
      
      column.removeChild(selectionEl);
      selectionEl = null;
      
      openCreateModal(startDate, endDate);
    }
  };
  
  // Render events
  const columnWidth = 100; // will be adjusted by flex, but for calc use relative
  // Actually since flex, we compute based on actual width later or use % 
  // For simplicity, use % in layout
  renderEvents(column, [], dayDate, 100); // pass 100 as base, layout uses relative
  
  return column;
}

function renderWeekGrid() {
  const grid = document.createElement('div');
  grid.className = 'week-grid';
  
  const timeAxis = renderTimeAxis();
  grid.appendChild(timeAxis);
  
  const dayColumns = document.createElement('div');
  dayColumns.className = 'day-columns';
  
  for (let i = 0; i < 7; i++) {
    const col = renderDayColumn(i);
    dayColumns.appendChild(col);
  }
  
  grid.appendChild(dayColumns);
  
  // Adjust event widths after render since flex
  setTimeout(() => {
    const cols = dayColumns.querySelectorAll('.day-column');
    cols.forEach((col, idx) => {
      const width = col.offsetWidth;
      const eventsInCol = col.querySelectorAll('.event');
      // Recompute layouts with actual width
      // For now, since we used relative in compute, but to fix, re-render events with actual width
      // Simpler: set width in % 
    });
  }, 0);
  
  return grid;
}

function openCreateModal(startDate, endDate) {
  const modal = document.createElement('div');
  modal.className = 'modal';
  
  modal.innerHTML = `
    <div class="modal-content">
      <h2>New Event</h2>
      <div class="form-group">
        <label>Title</label>
        <input type="text" id="title" placeholder="Event title" />
      </div>
      <div class="form-group">
        <label>Start</label>
        <input type="datetime-local" id="start" value="${startDate.toISOString().slice(0,16)}" />
      </div>
      <div class="form-group">
        <label>End</label>
        <input type="datetime-local" id="end" value="${endDate.toISOString().slice(0,16)}" />
      </div>
      <div class="form-actions">
        <button class="btn-secondary" id="cancel">Cancel</button>
        <button class="btn-primary" id="create">Create</button>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  modal.querySelector('#cancel').onclick = () => modal.remove();
  
  modal.querySelector('#create').onclick = async () => {
    const title = modal.querySelector('#title').value.trim();
    const start = modal.querySelector('#start').value;
    const end = modal.querySelector('#end').value;
    
    if (!title) {
      alert('Title is required');
      return;
    }
    if (!start || !end || new Date(end) <= new Date(start)) {
      alert('End must be after start');
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
        alert(err.error || 'Failed to create');
        return;
      }
      
      modal.remove();
      await loadAndRender();
    } catch (e) {
      alert('Error creating event');
    }
  };
  
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
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
        <input type="text" id="title" value="${event.title}" />
      </div>
      <div class="form-group">
        <label>Start</label>
        <input type="datetime-local" id="start" value="${startVal}" />
      </div>
      <div class="form-group">
        <label>End</label>
        <input type="datetime-local" id="end" value="${endVal}" />
      </div>
      <div class="form-actions">
        <button class="btn-danger" id="delete">Delete</button>
        <button class="btn-secondary" id="cancel">Cancel</button>
        <button class="btn-primary" id="save">Save</button>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  modal.querySelector('#cancel').onclick = () => modal.remove();
  
  modal.querySelector('#delete').onclick = async () => {
    if (!confirm('Delete this event?')) return;
    try {
      const res = await fetch(`${API_BASE}/events/${event.id}`, { method: 'DELETE' });
      if (res.ok || res.status === 204) {
        modal.remove();
        await loadAndRender();
      }
    } catch (e) {
      alert('Error deleting');
    }
  };
  
  modal.querySelector('#save').onclick = async () => {
    const title = modal.querySelector('#title').value.trim();
    const start = modal.querySelector('#start').value;
    const end = modal.querySelector('#end').value;
    
    if (!title) {
      alert('Title is required');
      return;
    }
    if (!start || !end || new Date(end) <= new Date(start)) {
      alert('End must be after start');
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
        alert(err.error || 'Failed to save');
        return;
      }
      
      modal.remove();
      await loadAndRender();
    } catch (e) {
      alert('Error saving');
    }
  };
  
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
}

async function loadAndRender() {
  const app = document.getElementById('app');
  app.innerHTML = '';
  
  await fetchEvents();
  
  const header = renderHeader();
  app.appendChild(header);
  
  const grid = renderWeekGrid();
  app.appendChild(grid);
  
  // Fix event positioning widths using actual column widths
  setTimeout(() => {
    const dayCols = grid.querySelectorAll('.day-column');
    dayCols.forEach((col, idx) => {
      const actualWidth = col.offsetWidth;
      const evs = col.querySelectorAll('.event');
      evs.forEach(ev => {
        // Recompute left/width based on stored data attrs or re-render
        // Since layout is done with 100, scale it
        const leftPct = parseFloat(ev.style.left) || 0;
        const widthPct = parseFloat(ev.style.width) || 100;
        ev.style.left = `${(leftPct / 100) * actualWidth}px`;
        ev.style.width = `${(widthPct / 100) * actualWidth - 2}px`;
      });
    });
  }, 50);
}

function init() {
  loadAndRender();
}

init();