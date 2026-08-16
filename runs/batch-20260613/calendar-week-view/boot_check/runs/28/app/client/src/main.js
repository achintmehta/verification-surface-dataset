const API_BASE = '/api';
const HOUR_HEIGHT = 60; // pixels per hour
const TOTAL_HEIGHT = 24 * HOUR_HEIGHT;

let currentWeekStart = null; // Monday of current week
let events = [];

// Get Monday of the week for a given date
function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // adjust when day is sunday
  return new Date(d.setDate(diff));
}

function formatDateRange(start, end) {
  const opts = { month: 'short', day: 'numeric' };
  return `${start.toLocaleDateString(undefined, opts)} - ${end.toLocaleDateString(undefined, opts)}`;
}

function formatTime(dateStr) {
  return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDateTimeLocal(date) {
  const pad = n => n.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function fetchEvents(start, end) {
  const startIso = start.toISOString();
  const endIso = end.toISOString();
  const res = await fetch(`${API_BASE}/events?start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}`);
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
    throw new Error(err.error || 'Failed to create');
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
    throw new Error(err.error || 'Failed to update');
  }
  return res.json();
}

async function deleteEvent(id) {
  const res = await fetch(`${API_BASE}/events/${id}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 204) {
    throw new Error('Failed to delete');
  }
}

// Cluster overlap layout algorithm
function computeEventLayout(dayEvents) {
  if (dayEvents.length === 0) return [];

  // Sort by start time
  const sorted = [...dayEvents].sort((a, b) => new Date(a.start_at) - new Date(b.start_at));

  // Find overlap clusters (transitive)
  const clusters = [];
  let currentCluster = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const evt = sorted[i];
    const clusterEnd = Math.max(...currentCluster.map(e => new Date(e.end_at).getTime()));
    const evtStart = new Date(evt.start_at).getTime();
    if (evtStart < clusterEnd) {
      currentCluster.push(evt);
    } else {
      clusters.push(currentCluster);
      currentCluster = [evt];
    }
  }
  clusters.push(currentCluster);

  const layouts = [];

  clusters.forEach(cluster => {
    // Assign columns greedily
    const columns = []; // array of end times per column
    const eventCols = new Map();

    cluster.sort((a, b) => new Date(a.start_at) - new Date(b.start_at));

    cluster.forEach(evt => {
      const start = new Date(evt.start_at).getTime();
      let col = 0;
      for (; col < columns.length; col++) {
        if (columns[col] <= start) break;
      }
      if (col === columns.length) columns.push(0);
      columns[col] = new Date(evt.end_at).getTime();
      eventCols.set(evt.id, col);
    });

    const numCols = columns.length;
    const colWidth = 100 / numCols;

    cluster.forEach(evt => {
      const colIdx = eventCols.get(evt.id);
      const left = colIdx * colWidth;
      const width = colWidth;

      const start = new Date(evt.start_at);
      const end = new Date(evt.end_at);
      const dayStart = new Date(start);
      dayStart.setHours(0, 0, 0, 0);

      const topMin = (start - dayStart) / 60000;
      const durationMin = (end - start) / 60000;

      const top = (topMin / 60) * HOUR_HEIGHT;
      const height = (durationMin / 60) * HOUR_HEIGHT;

      layouts.push({
        ...evt,
        left: `${left}%`,
        width: `${width}%`,
        top: `${Math.max(0, top)}px`,
        height: `${Math.max(10, height)}px` // min height for visibility
      });
    });
  });

  return layouts;
}

function renderCalendar(weekStart, weekEvents) {
  const calendarEl = document.getElementById('calendar');
  calendarEl.innerHTML = '';

  // Time axis
  const timeAxis = document.createElement('div');
  timeAxis.className = 'time-axis';
  for (let h = 0; h < 24; h++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = `${h * HOUR_HEIGHT}px`;
    label.textContent = `${h.toString().padStart(2, '0')}:00`;
    timeAxis.appendChild(label);

    // hour line
    const line = document.createElement('div');
    line.className = 'hour-line';
    line.style.top = `${h * HOUR_HEIGHT}px`;
    timeAxis.appendChild(line);
  }
  calendarEl.appendChild(timeAxis);

  // 7 day columns
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const today = new Date();
  today.setHours(0,0,0,0);

  for (let i = 0; i < 7; i++) {
    const dayDate = new Date(weekStart);
    dayDate.setDate(weekStart.getDate() + i);

    const dayCol = document.createElement('div');
    dayCol.className = 'day-column';

    // Header
    const header = document.createElement('div');
    header.className = 'day-header';
    const isToday = dayDate.getTime() === today.getTime();
    if (isToday) header.classList.add('today');
    header.innerHTML = `${days[i]}<br>${dayDate.getMonth()+1}/${dayDate.getDate()}`;
    dayCol.appendChild(header);

    // Hour lines
    for (let h = 0; h < 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${h * HOUR_HEIGHT}px`;
      dayCol.appendChild(line);
    }

    // Filter events for this day
    const dayStart = new Date(dayDate);
    dayStart.setHours(0,0,0,0);
    const dayEnd = new Date(dayDate);
    dayEnd.setHours(24,0,0,0);

    const dayEvents = weekEvents.filter(e => {
      const s = new Date(e.start_at);
      const en = new Date(e.end_at);
      return s < dayEnd && en > dayStart;
    });

    // Compute layout
    const laidOut = computeEventLayout(dayEvents);

    laidOut.forEach(evt => {
      const eventEl = document.createElement('div');
      eventEl.className = 'event';
      eventEl.style.top = evt.top;
      eventEl.style.height = evt.height;
      eventEl.style.left = evt.left;
      eventEl.style.width = evt.width;

      const titleEl = document.createElement('div');
      titleEl.className = 'event-title';
      titleEl.textContent = evt.title;

      const timeEl = document.createElement('div');
      timeEl.className = 'event-time';
      timeEl.textContent = `${formatTime(evt.start_at)} - ${formatTime(evt.end_at)}`;

      eventEl.appendChild(titleEl);
      eventEl.appendChild(timeEl);

      // Click to edit
      eventEl.addEventListener('click', (ev) => {
        ev.stopPropagation();
        openEditModal(evt);
      });

      dayCol.appendChild(eventEl);
    });

    // Click on empty to create
    dayCol.addEventListener('click', (e) => {
      if (e.target === dayCol || e.target.classList.contains('hour-line')) {
        const rect = dayCol.getBoundingClientRect();
        const clickY = e.clientY - rect.top - 30; // header offset approx
        const minutesFromMidnight = Math.max(0, Math.min(1440, (clickY / HOUR_HEIGHT) * 60));
        const startHour = Math.floor(minutesFromMidnight / 60);
        const startMin = Math.floor(minutesFromMidnight % 60 / 15) * 15; // snap to 15min

        const start = new Date(dayDate);
        start.setHours(startHour, startMin, 0, 0);
        const end = new Date(start);
        end.setHours(startHour + 1, startMin, 0, 0);

        openCreateModal(start, end);
      }
    });

    calendarEl.appendChild(dayCol);
  }

  // Update range
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  document.getElementById('week-range').textContent = formatDateRange(weekStart, weekEnd);
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
  startInput.value = formatDateTimeLocal(start);
  endInput.value = formatDateTimeLocal(end);
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

  document.getElementById('cancel-btn').onclick = () => modal.classList.add('hidden');
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
  startInput.value = formatDateTimeLocal(new Date(event.start_at));
  endInput.value = formatDateTimeLocal(new Date(event.end_at));
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

  document.getElementById('cancel-btn').onclick = () => modal.classList.add('hidden');
}

async function loadAndRender() {
  if (!currentWeekStart) {
    currentWeekStart = getWeekStart(new Date());
  }
  const weekEnd = new Date(currentWeekStart);
  weekEnd.setDate(currentWeekStart.getDate() + 7);

  try {
    events = await fetchEvents(currentWeekStart, weekEnd);
    renderCalendar(currentWeekStart, events);
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
