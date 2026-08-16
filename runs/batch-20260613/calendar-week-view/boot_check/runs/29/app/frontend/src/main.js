const API_BASE = '/api';

let currentWeekStart = getStartOfWeek(new Date());

function getStartOfWeek(date) {
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

// Cluster-based overlap layout
function computeLayout(events, dayStart, columnWidth) {
  // events for one day
  if (events.length === 0) return [];

  // Sort by start time
  const sorted = [...events].sort((a, b) => new Date(a.start_at) - new Date(b.start_at));

  // Find overlap clusters (transitive)
  const clusters = [];
  let currentCluster = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const evt = sorted[i];
    const lastInCluster = currentCluster[currentCluster.length - 1];
    // Check if overlaps with any in current cluster (transitive via chain)
    let overlaps = false;
    for (const c of currentCluster) {
      if (new Date(evt.start_at) < new Date(c.end_at) && new Date(evt.end_at) > new Date(c.start_at)) {
        overlaps = true;
        break;
      }
    }
    if (overlaps) {
      currentCluster.push(evt);
    } else {
      clusters.push(currentCluster);
      currentCluster = [evt];
    }
  }
  clusters.push(currentCluster);

  const layouts = [];

  for (const cluster of clusters) {
    // Greedy column assignment by start time
    const columns = []; // array of end times for each column
    const eventColumns = new Map();

    for (const evt of cluster.sort((a,b) => new Date(a.start_at) - new Date(b.start_at))) {
      let assignedCol = 0;
      for (let c = 0; c < columns.length; c++) {
        if (new Date(evt.start_at) >= columns[c]) {
          assignedCol = c;
          columns[c] = new Date(evt.end_at);
          break;
        }
        assignedCol = c + 1;
      }
      if (assignedCol >= columns.length) {
        columns.push(new Date(evt.end_at));
      } else {
        columns[assignedCol] = new Date(evt.end_at);
      }
      eventColumns.set(evt, assignedCol);
    }

    const numCols = columns.length;
    const colWidth = columnWidth / numCols;

    for (const evt of cluster) {
      const colIdx = eventColumns.get(evt);
      const left = colIdx * colWidth;
      const width = colWidth;

      const start = new Date(evt.start_at);
      const end = new Date(evt.end_at);

      // Minutes from midnight of dayStart
      const startMin = (start - dayStart) / (1000 * 60);
      const endMin = (end - dayStart) / (1000 * 60);

      const top = Math.max(0, startMin);
      const height = Math.max(1, endMin - startMin); // at least 1px

      layouts.push({
        ...evt,
        left: left + '%', // relative to day column
        width: width + '%',
        top: top + 'px',
        height: height + 'px'
      });
    }
  }

  return layouts;
}

function renderWeek(events) {
  const container = document.getElementById('calendar-container');
  container.innerHTML = '';

  const weekStart = new Date(currentWeekStart);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);

  // Update week range display
  const rangeEl = document.getElementById('week-range');
  rangeEl.textContent = `${weekStart.toLocaleDateString()} - ${new Date(weekEnd.getTime() - 86400000).toLocaleDateString()}`;

  const grid = document.createElement('div');
  grid.className = 'calendar-grid';

  // Time axis column
  const timeCol = document.createElement('div');
  timeCol.className = 'time-axis';
  timeCol.style.position = 'relative';
  timeCol.style.height = '1440px'; // 24 hours * 60 min = 1440 px, 1px per minute

  for (let h = 0; h < 24; h++) {
    const line = document.createElement('div');
    line.className = 'hour-line';
    line.style.top = (h * 60) + 'px';
    timeCol.appendChild(line);

    const label = document.createElement('div');
    label.className = 'hour-label';
    label.style.top = (h * 60) + 'px';
    label.textContent = `${h.toString().padStart(2, '0')}:00`;
    timeCol.appendChild(label);
  }
  grid.appendChild(timeCol);

  // 7 day columns
  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const today = new Date();
  today.setHours(0,0,0,0);

  for (let d = 0; d < 7; d++) {
    const dayDate = new Date(weekStart);
    dayDate.setDate(dayDate.getDate() + d);
    dayDate.setHours(0,0,0,0);

    const dayCol = document.createElement('div');
    dayCol.className = 'day-column';
    dayCol.style.position = 'relative';
    dayCol.style.height = '1440px';

    // Header
    const header = document.createElement('div');
    header.className = 'day-header';
    if (dayDate.getTime() === today.getTime()) {
      header.classList.add('today');
    }
    header.innerHTML = `${dayNames[d]}<br>${dayDate.getMonth()+1}/${dayDate.getDate()}`;
    dayCol.appendChild(header);

    // Hour lines
    for (let h = 0; h < 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = (h * 60) + 'px';
      dayCol.appendChild(line);
    }

    // Filter events for this day
    const dayEvents = events.filter(e => {
      const start = new Date(e.start_at);
      const end = new Date(e.end_at);
      const dayEnd = new Date(dayDate);
      dayEnd.setHours(24,0,0,0);
      return start < dayEnd && end > dayDate;
    });

    // Compute layout
    const layouts = computeLayout(dayEvents, dayDate, 100);

    for (const layout of layouts) {
      const evtEl = document.createElement('div');
      evtEl.className = 'event';
      evtEl.style.top = layout.top;
      evtEl.style.height = layout.height;
      evtEl.style.left = layout.left;
      evtEl.style.width = layout.width;

      const startTime = new Date(layout.start_at).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
      const endTime = new Date(layout.end_at).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});

      evtEl.innerHTML = `
        <div class="event-title">${layout.title}</div>
        <div class="event-time">${startTime} - ${endTime}</div>
      `;

      evtEl.addEventListener('click', () => openEditModal(layout));
      dayCol.appendChild(evtEl);
    }

    // Click to create on empty space
    dayCol.addEventListener('click', (e) => {
      if (e.target.classList.contains('day-column') || e.target.classList.contains('hour-line')) {
        const rect = dayCol.getBoundingClientRect();
        const clickY = e.clientY - rect.top;
        const minutes = Math.floor(clickY);
        const startDate = new Date(dayDate);
        startDate.setMinutes(minutes);

        const endDate = new Date(startDate);
        endDate.setHours(endDate.getHours() + 1);

        openCreateModal(startDate, endDate);
      }
    });

    // Also support drag selection? For simplicity, click sets start, but to make range, perhaps simple click for now.
    // To support range selection better, we can add mousedown/mouseup but keep simple as per non-goals.

    grid.appendChild(dayCol);
  }

  container.appendChild(grid);
}

let modalMode = 'create';
let currentEventId = null;

function openCreateModal(start, end) {
  const modal = document.getElementById('event-modal');
  document.getElementById('modal-title').textContent = 'Create Event';
  document.getElementById('event-id').value = '';
  document.getElementById('event-title').value = '';
  document.getElementById('event-start').value = formatDateTimeLocal(start);
  document.getElementById('event-end').value = formatDateTimeLocal(end);
  document.getElementById('delete-btn').classList.add('hidden');
  modal.classList.remove('hidden');
  modalMode = 'create';
}

function openEditModal(event) {
  const modal = document.getElementById('event-modal');
  document.getElementById('modal-title').textContent = 'Edit Event';
  document.getElementById('event-id').value = event.id;
  document.getElementById('event-title').value = event.title;
  document.getElementById('event-start').value = formatDateTimeLocal(new Date(event.start_at));
  document.getElementById('event-end').value = formatDateTimeLocal(new Date(event.end_at));
  document.getElementById('delete-btn').classList.remove('hidden');
  modal.classList.remove('hidden');
  modalMode = 'edit';
  currentEventId = event.id;
}

function closeModal() {
  document.getElementById('event-modal').classList.add('hidden');
}

async function handleFormSubmit(e) {
  e.preventDefault();
  const title = document.getElementById('event-title').value.trim();
  const start = document.getElementById('event-start').value;
  const end = document.getElementById('event-end').value;
  const id = document.getElementById('event-id').value;

  if (!title) {
    alert('Title is required');
    return;
  }
  if (new Date(end) <= new Date(start)) {
    alert('End must be after start');
    return;
  }

  try {
    if (modalMode === 'create') {
      await createEvent({ title, start_at: new Date(start).toISOString(), end_at: new Date(end).toISOString() });
    } else {
      await updateEvent(id, { title, start_at: new Date(start).toISOString(), end_at: new Date(end).toISOString() });
    }
    closeModal();
    await loadAndRender();
  } catch (err) {
    alert(err.message);
  }
}

async function handleDelete() {
  if (!currentEventId) return;
  if (!confirm('Delete this event?')) return;
  try {
    await deleteEvent(currentEventId);
    closeModal();
    await loadAndRender();
  } catch (err) {
    alert(err.message);
  }
}

async function loadAndRender() {
  const weekStart = new Date(currentWeekStart);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);

  try {
    const events = await fetchEvents(weekStart, weekEnd);
    renderWeek(events);
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
    currentWeekStart = getStartOfWeek(new Date());
    loadAndRender();
  });

  document.getElementById('next-week').addEventListener('click', () => {
    currentWeekStart.setDate(currentWeekStart.getDate() + 7);
    loadAndRender();
  });
}

function setupModal() {
  const modal = document.getElementById('event-modal');
  document.getElementById('cancel-btn').addEventListener('click', closeModal);
  document.getElementById('delete-btn').addEventListener('click', handleDelete);
  document.getElementById('event-form').addEventListener('submit', handleFormSubmit);

  // Close on outside click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });
}

async function init() {
  setupNavigation();
  setupModal();
  await loadAndRender();
}

init();