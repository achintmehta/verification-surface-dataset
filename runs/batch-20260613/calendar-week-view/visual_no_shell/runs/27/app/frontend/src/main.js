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

function formatDateRange(start) {
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const opts = { month: 'short', day: 'numeric' };
  return `${start.toLocaleDateString(undefined, opts)} – ${end.toLocaleDateString(undefined, opts)}`;
}

function getDaysOfWeek(weekStart) {
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    days.push(d);
  }
  return days;
}

async function fetchEvents(start, end) {
  const startIso = start.toISOString();
  const endIso = end.toISOString();
  const res = await fetch(`${API_BASE}/events?start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}`);
  if (!res.ok) throw new Error('Failed to fetch events');
  return res.json();
}

function groupEventsByDay(events, days) {
  const dayEvents = Array.from({ length: 7 }, () => []);
  events.forEach(event => {
    const start = new Date(event.start_at);
    const end = new Date(event.end_at);
    // Find which day(s) it belongs to - clamp to week
    for (let i = 0; i < 7; i++) {
      const dayStart = new Date(days[i]);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart);
      dayEnd.setHours(24, 0, 0, 0);
      
      // Check if event overlaps this day
      if (start < dayEnd && end > dayStart) {
        dayEvents[i].push({
          ...event,
          start_at: start.toISOString(),
          end_at: end.toISOString(),
          _dayIndex: i,
          _dayStart: dayStart
        });
      }
    }
  });
  return dayEvents;
}

// Cluster-based overlap layout algorithm
function computeEventLayout(eventsForDay) {
  if (!eventsForDay.length) return [];

  // Sort by start time
  const events = [...eventsForDay].sort((a, b) => 
    new Date(a.start_at) - new Date(b.start_at)
  );

  // Find overlap clusters (transitive)
  const clusters = [];
  let currentCluster = [events[0]];

  for (let i = 1; i < events.length; i++) {
    const ev = events[i];
    const clusterEnd = Math.max(...currentCluster.map(e => new Date(e.end_at).getTime()));
    if (new Date(ev.start_at).getTime() < clusterEnd) {
      currentCluster.push(ev);
    } else {
      clusters.push(currentCluster);
      currentCluster = [ev];
    }
  }
  clusters.push(currentCluster);

  const layouts = [];

  clusters.forEach(cluster => {
    // Assign columns greedily
    const columns = []; // array of end times per column
    const eventColumns = new Map();

    cluster.forEach(ev => {
      const startTime = new Date(ev.start_at).getTime();
      let assignedCol = 0;
      for (let c = 0; c < columns.length; c++) {
        if (columns[c] <= startTime) {
          assignedCol = c;
          break;
        }
        assignedCol = c + 1;
      }
      if (assignedCol >= columns.length) {
        columns.push(0);
      }
      columns[assignedCol] = new Date(ev.end_at).getTime();
      eventColumns.set(ev, assignedCol);
    });

    const numCols = columns.length;
    const colWidth = 100 / numCols;

    cluster.forEach(ev => {
      const col = eventColumns.get(ev);
      const start = new Date(ev.start_at);
      const end = new Date(ev.end_at);
      
      // Compute top and height clamped to day
      const dayStart = ev._dayStart;
      const minutesFromMidnightStart = Math.max(0, (start - dayStart) / 60000);
      const minutesFromMidnightEnd = Math.min(24 * 60, (end - dayStart) / 60000);
      
      const top = (minutesFromMidnightStart / 60) * HOUR_HEIGHT;
      const height = ((minutesFromMidnightEnd - minutesFromMidnightStart) / 60) * HOUR_HEIGHT;

      layouts.push({
        ...ev,
        left: col * colWidth,
        width: colWidth,
        top: Math.max(0, top),
        height: Math.max(1, height) // min height
      });
    });
  });

  return layouts;
}

function renderTimeAxis() {
  const axis = document.getElementById('time-axis');
  axis.innerHTML = '';
  axis.style.height = `${CALENDAR_HEIGHT}px`;

  for (let h = 0; h <= 24; h++) {
    const label = document.createElement('div');
    label.className = 'hour-label';
    label.style.top = `${h * HOUR_HEIGHT}px`;
    label.textContent = h === 24 ? '' : `${h.toString().padStart(2, '0')}:00`;
    axis.appendChild(label);
  }
}

function renderDayHeaders(daysContainer, days) {
  days.forEach((day, index) => {
    const col = document.createElement('div');
    col.className = 'day-column';
    col.dataset.dayIndex = index;

    const header = document.createElement('div');
    header.className = 'day-header';
    
    const isToday = day.toDateString() === new Date().toDateString();
    if (isToday) header.classList.add('today');

    const dayName = day.toLocaleDateString(undefined, { weekday: 'short' });
    const dateNum = day.getDate();
    header.innerHTML = `${dayName}<br><small>${dateNum}</small>`;
    
    col.appendChild(header);

    // Add hour lines
    for (let h = 0; h <= 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${h * HOUR_HEIGHT}px`;
      col.appendChild(line);
    }

    // Click to create event
    col.addEventListener('click', (e) => {
      if (e.target.classList.contains('event')) return;
      
      const rect = col.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const minutes = Math.floor((y / HOUR_HEIGHT) * 60);
      const roundedMinutes = Math.floor(minutes / 15) * 15; // snap to 15 min
      
      const startTime = new Date(day);
      startTime.setHours(0, 0, 0, 0);
      startTime.setMinutes(roundedMinutes);
      
      const endTime = new Date(startTime);
      endTime.setHours(startTime.getHours() + 1);

      openCreateModal(startTime, endTime, index);
    });

    daysContainer.appendChild(col);
  });
}

function renderEvents(daysContainer, dayEventsLayouts) {
  dayEventsLayouts.forEach((layouts, dayIndex) => {
    const col = daysContainer.children[dayIndex];
    if (!col) return;

    // Remove existing events
    col.querySelectorAll('.event').forEach(el => el.remove());

    layouts.forEach(layout => {
      const eventEl = document.createElement('div');
      eventEl.className = 'event';
      eventEl.style.top = `${layout.top}px`;
      eventEl.style.height = `${layout.height}px`;
      eventEl.style.left = `${layout.left}%`;
      eventEl.style.width = `${layout.width}%`;

      const start = new Date(layout.start_at);
      const end = new Date(layout.end_at);
      const timeStr = `${start.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})} - ${end.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}`;

      eventEl.innerHTML = `
        <div class="event-title">${layout.title}</div>
        <div class="event-time">${timeStr}</div>
      `;

      eventEl.addEventListener('click', (e) => {
        e.stopImmediatePropagation();
        openEditModal(layout);
      });

      col.appendChild(eventEl);
    });
  });
}

async function renderWeek() {
  const weekEnd = new Date(currentWeekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);

  document.getElementById('week-range').textContent = formatDateRange(currentWeekStart);

  const days = getDaysOfWeek(currentWeekStart);

  const daysContainer = document.getElementById('days-container');
  daysContainer.innerHTML = '';
  daysContainer.style.height = `${CALENDAR_HEIGHT}px`;

  renderDayHeaders(daysContainer, days);

  try {
    const events = await fetchEvents(currentWeekStart, weekEnd);
    const dayEvents = groupEventsByDay(events, days);
    
    const dayLayouts = dayEvents.map(eventsForDay => computeEventLayout(eventsForDay));
    
    renderEvents(daysContainer, dayLayouts);
  } catch (err) {
    console.error('Error rendering week:', err);
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

  // Close on outside click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });
}

function openCreateModal(startTime, endTime, dayIndex) {
  document.getElementById('modal-title').textContent = 'Create Event';
  document.getElementById('event-id').value = '';
  document.getElementById('title').value = '';
  document.getElementById('start').value = toDateTimeLocal(startTime);
  document.getElementById('end').value = toDateTimeLocal(endTime);
  document.getElementById('delete-btn').classList.add('hidden');
  modal.classList.remove('hidden');
}

function openEditModal(event) {
  document.getElementById('modal-title').textContent = 'Edit Event';
  document.getElementById('event-id').value = event.id;
  document.getElementById('title').value = event.title;
  document.getElementById('start').value = toDateTimeLocal(new Date(event.start_at));
  document.getElementById('end').value = toDateTimeLocal(new Date(event.end_at));
  document.getElementById('delete-btn').classList.remove('hidden');
  modal.classList.remove('hidden');
}

function closeModal() {
  modal.classList.add('hidden');
}

function toDateTimeLocal(date) {
  const pad = n => n.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function handleFormSubmit(e) {
  e.preventDefault();

  const id = document.getElementById('event-id').value;
  const title = document.getElementById('title').value.trim();
  const start = document.getElementById('start').value;
  const end = document.getElementById('end').value;

  if (!title) {
    alert('Title is required');
    return;
  }

  const payload = {
    title,
    start_at: new Date(start).toISOString(),
    end_at: new Date(end).toISOString()
  };

  try {
    let res;
    if (id) {
      res = await fetch(`${API_BASE}/events/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } else {
      res = await fetch(`${API_BASE}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }

    if (!res.ok) {
      const err = await res.json();
      alert(err.error || 'Invalid event');
      return;
    }

    closeModal();
    await renderWeek();
  } catch (err) {
    alert('Error saving event: ' + err.message);
  }
}

async function handleDelete() {
  const id = document.getElementById('event-id').value;
  if (!id || !confirm('Delete this event?')) return;

  try {
    const res = await fetch(`${API_BASE}/events/${id}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 204) {
      throw new Error('Delete failed');
    }
    closeModal();
    await renderWeek();
  } catch (err) {
    alert('Error deleting: ' + err.message);
  }
}

function setupNavigation() {
  document.getElementById('prev-week').addEventListener('click', () => {
    currentWeekStart.setDate(currentWeekStart.getDate() - 7);
    renderWeek();
  });

  document.getElementById('next-week').addEventListener('click', () => {
    currentWeekStart.setDate(currentWeekStart.getDate() + 7);
    renderWeek();
  });

  document.getElementById('today').addEventListener('click', () => {
    currentWeekStart = getWeekStart(new Date());
    renderWeek();
  });
}

function init() {
  renderTimeAxis();
  setupModal();
  setupNavigation();
  renderWeek();
}

init();