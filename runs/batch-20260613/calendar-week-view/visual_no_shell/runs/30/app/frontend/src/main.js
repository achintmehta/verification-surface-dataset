const API_BASE = '/api';
const HOUR_HEIGHT = 30; // pixels per hour
const TOTAL_HOURS = 24;
const CALENDAR_HEIGHT = HOUR_HEIGHT * TOTAL_HOURS;

let currentWeekStart = getWeekStart(new Date());
let events = [];

function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday start
  return new Date(d.setDate(diff));
}

function formatDateISO(date) {
  return date.toISOString().split('T')[0];
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

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function minutesFromMidnight(dateStr) {
  const date = new Date(dateStr);
  return date.getHours() * 60 + date.getMinutes();
}

function parseDate(dateStr) {
  return new Date(dateStr);
}

// Cluster-based overlap layout
function computeLayout(eventsForDay) {
  if (!eventsForDay.length) return [];

  // Sort by start time
  const sorted = [...eventsForDay].sort((a, b) => 
    new Date(a.start_at) - new Date(b.start_at)
  );

  // Find overlap clusters (transitive)
  const clusters = [];
  let currentCluster = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const event = sorted[i];
    const lastInCluster = currentCluster[currentCluster.length - 1];
    
    // Check if overlaps with any in current cluster (transitive via chain)
    let overlaps = false;
    for (const ce of currentCluster) {
      if (new Date(event.start_at) < new Date(ce.end_at) && 
          new Date(event.end_at) > new Date(ce.start_at)) {
        overlaps = true;
        break;
      }
    }
    
    if (overlaps) {
      currentCluster.push(event);
    } else {
      clusters.push(currentCluster);
      currentCluster = [event];
    }
  }
  clusters.push(currentCluster);

  const layouts = [];

  clusters.forEach(cluster => {
    // Greedy column assignment by start time
    const columns = []; // array of end times for each column
    const eventColumns = new Map();

    cluster.forEach(event => {
      const start = new Date(event.start_at);
      let assignedCol = 0;
      
      // Find first column where previous event ends before this starts
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
    const colWidth = 100 / numCols;

    cluster.forEach(event => {
      const col = eventColumns.get(event);
      const left = col * colWidth;
      const width = colWidth;

      const startMin = minutesFromMidnight(event.start_at);
      const endMin = minutesFromMidnight(event.end_at);
      
      // Clamp to 0-1440 minutes
      const top = Math.max(0, Math.min(1440, startMin)) / 60 * HOUR_HEIGHT;
      const height = Math.max(20, (Math.min(1440, endMin) - Math.max(0, startMin)) / 60 * HOUR_HEIGHT);

      layouts.push({
        ...event,
        left: `${left}%`,
        width: `${width}%`,
        top: `${top}px`,
        height: `${height}px`
      });
    });
  });

  return layouts;
}

async function fetchEvents(weekStart) {
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);
  
  const startISO = weekStart.toISOString();
  const endISO = weekEnd.toISOString();
  
  try {
    const res = await fetch(`${API_BASE}/events?start=${encodeURIComponent(startISO)}&end=${encodeURIComponent(endISO)}`);
    if (!res.ok) throw new Error('Failed to fetch');
    events = await res.json();
    return events;
  } catch (err) {
    console.error(err);
    events = [];
    return [];
  }
}

function renderCalendar() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="header">
      <h1>Week of ${currentWeekStart.toLocaleDateString()}</h1>
      <div class="nav-buttons">
        <button id="prev-week">Previous</button>
        <button id="today">Today</button>
        <button id="next-week">Next</button>
      </div>
    </div>
    <div class="calendar-container">
      <div class="time-axis">
        ${Array.from({length: 24}, (_, h) => `
          <div class="time-slot">${h.toString().padStart(2, '0')}:00</div>
        `).join('')}
      </div>
      <div class="days-container">
        ${getWeekDays(currentWeekStart).map((day, idx) => {
          const isToday = day.toDateString() === new Date().toDateString();
          const dayStr = day.toISOString().split('T')[0];
          return `
            <div class="day-column" data-day="${dayStr}">
              <div class="day-header ${isToday ? 'today' : ''}">
                <div class="day-name">${day.toLocaleDateString([], {weekday: 'short'})}</div>
                <div class="day-date">${day.getDate()}</div>
              </div>
              <div class="hour-lines">
                ${Array.from({length: 24}, (_, h) => `
                  <div class="hour-line ${h % 1 === 0 ? 'major' : ''}"></div>
                `).join('')}
              </div>
              <div class="events-layer" data-day="${dayStr}"></div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;

  // Attach nav listeners
  document.getElementById('prev-week').onclick = () => {
    currentWeekStart.setDate(currentWeekStart.getDate() - 7);
    loadAndRender();
  };
  document.getElementById('today').onclick = () => {
    currentWeekStart = getWeekStart(new Date());
    loadAndRender();
  };
  document.getElementById('next-week').onclick = () => {
    currentWeekStart.setDate(currentWeekStart.getDate() + 7);
    loadAndRender();
  };

  // Setup day columns for click-to-create
  setupDayInteractions();

  // Render events
  renderEvents();
}

function setupDayInteractions() {
  const dayColumns = document.querySelectorAll('.day-column');
  
  dayColumns.forEach(column => {
    const eventsLayer = column.querySelector('.events-layer');
    const day = column.dataset.day;
    
    // Click on empty area to create
    column.addEventListener('click', (e) => {
      if (e.target === column || e.target.classList.contains('hour-lines') || e.target.classList.contains('events-layer')) {
        // Calculate time from click position
        const rect = eventsLayer.getBoundingClientRect();
        const y = e.clientY - rect.top;
        const minutes = Math.floor((y / HOUR_HEIGHT) * 60);
        const startHour = Math.floor(minutes / 60);
        const startMin = minutes % 60;
        
        const startDate = new Date(day + 'T' + startHour.toString().padStart(2,'0') + ':' + startMin.toString().padStart(2,'0'));
        const endDate = new Date(startDate.getTime() + 60 * 60 * 1000); // 1 hour default
        
        openCreateModal(startDate, endDate, day);
      }
    });
    
    // Also support drag selection for range
    let isDragging = false;
    let startY = 0;
    
    eventsLayer.addEventListener('mousedown', (e) => {
      isDragging = true;
      startY = e.offsetY;
    });
    
    document.addEventListener('mouseup', (e) => {
      if (!isDragging) return;
      isDragging = false;
      
      const rect = eventsLayer.getBoundingClientRect();
      const endY = e.clientY - rect.top;
      
      if (Math.abs(endY - startY) < 10) {
        // treat as click, already handled
        return;
      }
      
      const startMin = Math.floor((Math.min(startY, endY) / HOUR_HEIGHT) * 60);
      const endMin = Math.floor((Math.max(startY, endY) / HOUR_HEIGHT) * 60);
      
      const startHour = Math.floor(startMin / 60);
      const startM = startMin % 60;
      const endHour = Math.floor(endMin / 60);
      const endM = endMin % 60;
      
      const startDate = new Date(`${day}T${startHour.toString().padStart(2,'0')}:${startM.toString().padStart(2,'0')}`);
      const endDate = new Date(`${day}T${endHour.toString().padStart(2,'0')}:${endM.toString().padStart(2,'0')}`);
      
      if (endDate > startDate) {
        openCreateModal(startDate, endDate, day);
      }
    });
  });
}

function renderEvents() {
  // Group events by day
  const eventsByDay = {};
  
  getWeekDays(currentWeekStart).forEach(day => {
    const dayStr = day.toISOString().split('T')[0];
    eventsByDay[dayStr] = [];
  });
  
  events.forEach(event => {
    const startDay = parseDate(event.start_at).toISOString().split('T')[0];
    if (eventsByDay[startDay]) {
      eventsByDay[startDay].push(event);
    } else {
      // Handle events starting previous day but overlapping? For simplicity, only render in start day
      // But to be complete, could clamp, but per spec clamp to day
    }
  });
  
  // For events crossing days, but since week view and clamp, we render only if start in week for simplicity
  // Actually, better: check overlap with each day
  events.forEach(event => {
    const start = parseDate(event.start_at);
    const end = parseDate(event.end_at);
    
    getWeekDays(currentWeekStart).forEach(day => {
      const dayStart = new Date(day);
      dayStart.setHours(0,0,0,0);
      const dayEnd = new Date(day);
      dayEnd.setHours(24,0,0,0);
      
      if (start < dayEnd && end > dayStart) {
        const dayStr = day.toISOString().split('T')[0];
        if (!eventsByDay[dayStr].some(e => e.id === event.id)) {
          eventsByDay[dayStr].push(event);
        }
      }
    });
  });
  
  Object.keys(eventsByDay).forEach(dayStr => {
    const layer = document.querySelector(`.events-layer[data-day="${dayStr}"]`);
    if (!layer) return;
    
    layer.innerHTML = '';
    
    const dayEvents = eventsByDay[dayStr];
    const laidOut = computeLayout(dayEvents);
    
    laidOut.forEach(layoutEvent => {
      const el = document.createElement('div');
      el.className = 'event';
      el.style.left = layoutEvent.left;
      el.style.width = layoutEvent.width;
      el.style.top = layoutEvent.top;
      el.style.height = layoutEvent.height;
      
      const start = parseDate(layoutEvent.start_at);
      const end = parseDate(layoutEvent.end_at);
      
      el.innerHTML = `
        <div class="event-title">${layoutEvent.title}</div>
        <div class="event-time">${formatTime(start)} - ${formatTime(end)}</div>
      `;
      
      el.onclick = (e) => {
        e.stopImmediatePropagation();
        openEditModal(layoutEvent);
      };
      
      layer.appendChild(el);
    });
  });
}

function openCreateModal(startDate, endDate, day) {
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
        <input type="datetime-local" id="event-start" value="${startDate.toISOString().slice(0,16)}">
      </div>
      <div class="form-group">
        <label>End</label>
        <input type="datetime-local" id="event-end" value="${endDate.toISOString().slice(0,16)}">
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
    const title = titleInput.value;
    const start_at = startInput.value ? new Date(startInput.value).toISOString() : '';
    const end_at = endInput.value ? new Date(endInput.value).toISOString() : '';
    
    if (!title || !start_at || !end_at) {
      errorEl.textContent = 'All fields required';
      return;
    }
    
    try {
      const res = await fetch(`${API_BASE}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, start_at, end_at })
      });
      
      if (!res.ok) {
        const data = await res.json();
        errorEl.textContent = data.error || 'Failed to create';
        return;
      }
      
      modal.remove();
      await loadAndRender();
    } catch (err) {
      errorEl.textContent = 'Network error';
    }
  };
  
  // Close on outside click
  modal.onclick = (e) => {
    if (e.target === modal) modal.remove();
  };
}

function openEditModal(event) {
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content">
      <h2>Edit Event</h2>
      <div class="form-group">
        <label>Title</label>
        <input type="text" id="event-title" value="${event.title}">
      </div>
      <div class="form-group">
        <label>Start</label>
        <input type="datetime-local" id="event-start" value="${new Date(event.start_at).toISOString().slice(0,16)}">
      </div>
      <div class="form-group">
        <label>End</label>
        <input type="datetime-local" id="event-end" value="${new Date(event.end_at).toISOString().slice(0,16)}">
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
    const title = titleInput.value;
    const start_at = startInput.value ? new Date(startInput.value).toISOString() : '';
    const end_at = endInput.value ? new Date(endInput.value).toISOString() : '';
    
    if (!title || !start_at || !end_at) {
      errorEl.textContent = 'All fields required';
      return;
    }
    
    try {
      const res = await fetch(`${API_BASE}/events/${event.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, start_at, end_at })
      });
      
      if (!res.ok) {
        const data = await res.json();
        errorEl.textContent = data.error || 'Failed to update';
        return;
      }
      
      modal.remove();
      await loadAndRender();
    } catch (err) {
      errorEl.textContent = 'Network error';
    }
  };
  
  modal.querySelector('#delete-btn').onclick = async () => {
    if (!confirm('Delete this event?')) return;
    
    try {
      const res = await fetch(`${API_BASE}/events/${event.id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) {
        errorEl.textContent = 'Failed to delete';
        return;
      }
      modal.remove();
      await loadAndRender();
    } catch (err) {
      errorEl.textContent = 'Network error';
    }
  };
  
  modal.onclick = (e) => {
    if (e.target === modal) modal.remove();
  };
}

async function loadAndRender() {
  await fetchEvents(currentWeekStart);
  renderCalendar();
}

async function init() {
  await loadAndRender();
}

init();