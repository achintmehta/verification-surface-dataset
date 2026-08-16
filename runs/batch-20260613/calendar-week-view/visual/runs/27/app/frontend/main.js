const API_BASE = '/api';
const HOUR_HEIGHT = 30; // pixels per hour
const TOTAL_HOURS = 24;
const AXIS_HEIGHT = TOTAL_HOURS * HOUR_HEIGHT;

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
  const url = `${API_BASE}/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to fetch events');
  return res.json();
}

async function createEvent(event) {
  const res = await fetch(`${API_BASE}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event)
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to create');
  }
  return res.json();
}

async function updateEvent(id, event) {
  const res = await fetch(`${API_BASE}/events/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event)
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to update');
  }
  return res.json();
}

async function deleteEvent(id) {
  const res = await fetch(`${API_BASE}/events/${id}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 204) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to delete');
  }
}

function renderTimeAxis() {
  const axis = document.getElementById('time-axis');
  axis.innerHTML = '';
  axis.style.height = `${AXIS_HEIGHT}px`;
  
  for (let h = 0; h < 24; h++) {
    const line = document.createElement('div');
    line.className = 'hour-line';
    line.style.top = `${h * HOUR_HEIGHT}px`;
    line.style.height = `${HOUR_HEIGHT}px`;
    line.textContent = `${h.toString().padStart(2, '0')}:00`;
    axis.appendChild(line);
  }
}

function getDayName(date) {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()];
}

function renderDayHeaders(daysContainer, weekStart, today) {
  daysContainer.innerHTML = '';
  for (let i = 0; i < 7; i++) {
    const dayDate = new Date(weekStart);
    dayDate.setDate(weekStart.getDate() + i);
    
    const column = document.createElement('div');
    column.className = 'day-column';
    column.dataset.date = formatDate(dayDate);
    
    const header = document.createElement('div');
    header.className = 'day-header';
    if (formatDate(dayDate) === formatDate(today)) {
      header.classList.add('today');
    }
    header.textContent = `${getDayName(dayDate)} ${dayDate.getDate()}`;
    
    column.appendChild(header);
    
    // Make column clickable for creating events
    column.addEventListener('click', (e) => {
      if (e.target === column || e.target.classList.contains('day-column')) {
        const rect = column.getBoundingClientRect();
        const y = e.clientY - rect.top - 40; // subtract header
        const hour = Math.max(0, Math.min(23, Math.floor(y / HOUR_HEIGHT)));
        const start = new Date(dayDate);
        start.setHours(hour, 0, 0, 0);
        const end = new Date(start);
        end.setHours(hour + 1, 0, 0, 0);
        openCreateModal(start, end);
      }
    });
    
    // Also support drag to select range, but for simplicity, click sets 1h
    daysContainer.appendChild(column);
  }
}

function computeOverlapLayout(events, dayStart, dayEnd, columnWidth) {
  // Filter events for this day
  const dayEvents = events.filter(ev => {
    const evStart = new Date(ev.start_at);
    const evEnd = new Date(ev.end_at);
    return evEnd > dayStart && evStart < dayEnd;
  }).map(ev => ({
    ...ev,
    start: Math.max(dayStart, new Date(ev.start_at)),
    end: Math.min(dayEnd, new Date(ev.end_at))
  })).sort((a, b) => a.start - b.start || a.end - b.end);

  if (dayEvents.length === 0) return [];

  // Cluster-based overlap layout
  const clusters = [];
  let currentCluster = [dayEvents[0]];
  
  for (let i = 1; i < dayEvents.length; i++) {
    const ev = dayEvents[i];
    const lastInCluster = currentCluster[currentCluster.length - 1];
    // Check if overlaps with any in current cluster (transitive via max end)
    const clusterMaxEnd = Math.max(...currentCluster.map(e => e.end));
    if (ev.start < clusterMaxEnd) {
      currentCluster.push(ev);
    } else {
      clusters.push(currentCluster);
      currentCluster = [ev];
    }
  }
  clusters.push(currentCluster);

  const layouts = [];
  
  clusters.forEach(cluster => {
    // Greedy column assignment
    const columns = []; // array of end times for each column
    const eventColumns = new Map();
    
    cluster.forEach(ev => {
      let assignedCol = 0;
      for (let c = 0; c < columns.length; c++) {
        if (columns[c] <= ev.start) {
          assignedCol = c;
          columns[c] = ev.end;
          break;
        }
        assignedCol = c + 1;
      }
      if (assignedCol >= columns.length) {
        columns.push(ev.end);
      } else {
        columns[assignedCol] = ev.end;
      }
      eventColumns.set(ev, assignedCol);
    });
    
    const numCols = columns.length;
    const colWidth = columnWidth / numCols;
    
    cluster.forEach(ev => {
      const colIdx = eventColumns.get(ev);
      const left = colIdx * colWidth;
      const width = colWidth;
      
      const top = ((ev.start - dayStart) / (1000 * 60 * 60)) * HOUR_HEIGHT;
      const height = ((ev.end - ev.start) / (1000 * 60 * 60)) * HOUR_HEIGHT;
      
      layouts.push({
        event: ev,
        left,
        width,
        top,
        height
      });
    });
  });
  
  return layouts;
}

function renderEvents(events, weekStart) {
  const daysContainer = document.getElementById('days-container');
  const columns = daysContainer.querySelectorAll('.day-column');
  
  // Clear existing events
  columns.forEach(col => {
    const existingEvents = col.querySelectorAll('.event');
    existingEvents.forEach(e => e.remove());
  });
  
  const today = new Date();
  
  columns.forEach((column, dayIdx) => {
    const dayDate = new Date(weekStart);
    dayDate.setDate(weekStart.getDate() + dayIdx);
    dayDate.setHours(0, 0, 0, 0);
    
    const dayEnd = new Date(dayDate);
    dayEnd.setHours(24, 0, 0, 0);
    
    const columnWidth = column.clientWidth || 100; // fallback
    
    const layouts = computeOverlapLayout(events, dayDate, dayEnd, columnWidth);
    
    layouts.forEach(layout => {
      const evEl = document.createElement('div');
      evEl.className = 'event';
      evEl.style.top = `${layout.top + 40}px`; // + header height
      evEl.style.left = `${layout.left}px`;
      evEl.style.width = `${layout.width}px`;
      evEl.style.height = `${Math.max(20, layout.height)}px`;
      
      const startTime = new Date(layout.event.start_at);
      const endTime = new Date(layout.event.end_at);
      
      evEl.innerHTML = `
        <div class="event-title">${layout.event.title}</div>
        <div class="event-time">${startTime.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})} - ${endTime.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</div>
      `;
      
      evEl.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditModal(layout.event);
      });
      
      column.appendChild(evEl);
    });
  });
}

function updateWeekRange(weekStart) {
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  const rangeEl = document.getElementById('week-range');
  rangeEl.textContent = `${weekStart.toLocaleDateString()} - ${weekEnd.toLocaleDateString()}`;
}

async function loadAndRenderWeek(weekStart) {
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 7);
  
  const startIso = weekStart.toISOString();
  const endIso = weekEnd.toISOString();
  
  try {
    const events = await fetchEvents(startIso, endIso);
    renderEvents(events, weekStart);
  } catch (err) {
    console.error(err);
    alert('Failed to load events');
  }
  
  updateWeekRange(weekStart);
}

function openCreateModal(start, end) {
  const modal = document.getElementById('event-modal');
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
  startInput.value = formatDateTimeLocal(start);
  endInput.value = formatDateTimeLocal(end);
  deleteBtn.style.display = 'none';
  
  modal.classList.add('show');
  
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await createEvent({
        title: titleInput.value,
        start_at: new Date(startInput.value).toISOString(),
        end_at: new Date(endInput.value).toISOString()
      });
      modal.classList.remove('show');
      await loadAndRenderWeek(currentWeekStart);
    } catch (err) {
      alert(err.message);
    }
  };
}

function openEditModal(event) {
  const modal = document.getElementById('event-modal');
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
  startInput.value = formatDateTimeLocal(new Date(event.start_at));
  endInput.value = formatDateTimeLocal(new Date(event.end_at));
  deleteBtn.style.display = 'inline-block';
  
  modal.classList.add('show');
  
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await updateEvent(event.id, {
        title: titleInput.value,
        start_at: new Date(startInput.value).toISOString(),
        end_at: new Date(endInput.value).toISOString()
      });
      modal.classList.remove('show');
      await loadAndRenderWeek(currentWeekStart);
    } catch (err) {
      alert(err.message);
    }
  };
  
  deleteBtn.onclick = async () => {
    if (confirm('Delete this event?')) {
      try {
        await deleteEvent(event.id);
        modal.classList.remove('show');
        await loadAndRenderWeek(currentWeekStart);
      } catch (err) {
        alert(err.message);
      }
    }
  };
}

function setupNavigation() {
  document.getElementById('prev-week').addEventListener('click', () => {
    currentWeekStart.setDate(currentWeekStart.getDate() - 7);
    loadAndRenderWeek(currentWeekStart);
  });
  
  document.getElementById('today').addEventListener('click', () => {
    currentWeekStart = getWeekStart(new Date());
    loadAndRenderWeek(currentWeekStart);
  });
  
  document.getElementById('next-week').addEventListener('click', () => {
    currentWeekStart.setDate(currentWeekStart.getDate() + 7);
    loadAndRenderWeek(currentWeekStart);
  });
  
  // Close modal on outside click
  const modal = document.getElementById('event-modal');
  document.getElementById('cancel-btn').addEventListener('click', () => {
    modal.classList.remove('show');
  });
  
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.classList.remove('show');
    }
  });
}

function setupResizeHandler() {
  window.addEventListener('resize', () => {
    // Re-render events on resize to adjust widths
    if (currentWeekStart) {
      loadAndRenderWeek(currentWeekStart);
    }
  });
}

async function init() {
  renderTimeAxis();
  
  const daysContainer = document.getElementById('days-container');
  const today = new Date();
  renderDayHeaders(daysContainer, currentWeekStart, today);
  
  setupNavigation();
  setupResizeHandler();
  
  await loadAndRenderWeek(currentWeekStart);
}

init();