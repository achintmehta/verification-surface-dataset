const API_BASE = 'http://localhost:3000';
const HOUR_HEIGHT = 30;
const TOTAL_HOURS = 24;
const CALENDAR_HEIGHT = TOTAL_HOURS * HOUR_HEIGHT;
const DAY_WIDTH = 160;

let currentWeekStart = getWeekStart(new Date());
let events = [];
let currentEventId = null;

function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday start
  return new Date(d.setDate(diff));
}

function getWeekEnd(weekStart) {
  const end = new Date(weekStart);
  end.setDate(end.getDate() + 7);
  return end;
}

function formatDate(date) {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatWeekRange(weekStart) {
  const end = new Date(weekStart);
  end.setDate(end.getDate() + 6);
  return `${formatDate(weekStart)} – ${formatDate(end)}`;
}

function toISO(date) {
  return date.toISOString();
}

function fromISO(iso) {
  return new Date(iso);
}

async function fetchEvents(weekStart) {
  const start = toISO(weekStart);
  const end = toISO(getWeekEnd(weekStart));
  const res = await fetch(`${API_BASE}/api/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
  if (!res.ok) throw new Error('Failed to fetch');
  return res.json();
}

function isToday(date) {
  const today = new Date();
  return date.toDateString() === today.toDateString();
}

function renderTimeAxis() {
  const axis = document.getElementById('time-axis');
  axis.innerHTML = '';
  axis.style.height = `${CALENDAR_HEIGHT}px`;
  for (let h = 0; h < TOTAL_HOURS; h++) {
    const label = document.createElement('div');
    label.className = 'hour-label';
    label.style.top = `${h * HOUR_HEIGHT}px`;
    label.textContent = `${h.toString().padStart(2, '0')}:00`;
    axis.appendChild(label);
  }
}

function createDayColumn(date, dayIndex, weekStart, allEvents) {
  const col = document.createElement('div');
  col.className = 'day-column';
  col.style.height = `${CALENDAR_HEIGHT}px`;

  // Header
  const header = document.createElement('div');
  header.className = 'day-header';
  if (isToday(date)) header.classList.add('today');
  const dayName = date.toLocaleDateString('en-US', { weekday: 'short' });
  const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  header.innerHTML = `${dayName}<br>${dateStr}`;
  col.appendChild(header);

  // Hour lines
  for (let h = 0; h <= TOTAL_HOURS; h++) {
    const line = document.createElement('div');
    line.className = 'hour-line';
    line.style.top = `${h * HOUR_HEIGHT}px`;
    col.appendChild(line);
  }

  // Get events overlapping this day
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(date);
  dayEnd.setHours(24, 0, 0, 0);

  const dayEvents = allEvents
    .map(ev => {
      const start = fromISO(ev.start_at);
      const end = fromISO(ev.end_at);
      const visibleStart = start < dayStart ? dayStart : start;
      const visibleEnd = end > dayEnd ? dayEnd : end;
      if (visibleEnd <= visibleStart) return null;
      return {
        ...ev,
        visibleStart,
        visibleEnd,
        originalStart: start,
        originalEnd: end
      };
    })
    .filter(Boolean);

  // Layout clusters
  const laidOutEvents = layoutDayEvents(dayEvents, DAY_WIDTH);

  // Render events
  laidOutEvents.forEach(layout => {
    const evEl = document.createElement('div');
    evEl.className = 'event';
    const top = ((layout.visibleStart.getHours() * 60 + layout.visibleStart.getMinutes()) / 60) * HOUR_HEIGHT;
    const height = ((layout.visibleEnd.getHours() * 60 + layout.visibleEnd.getMinutes()) / 60) * HOUR_HEIGHT - top;
    evEl.style.top = `${Math.max(0, top)}px`;
    evEl.style.height = `${Math.max(20, height)}px`;
    evEl.style.left = `${layout.left}px`;
    evEl.style.width = `${layout.width}px`;

    const titleEl = document.createElement('div');
    titleEl.className = 'event-title';
    titleEl.textContent = layout.title;

    const timeEl = document.createElement('div');
    timeEl.className = 'event-time';
    const startStr = layout.originalStart.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const endStr = layout.originalEnd.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    timeEl.textContent = `${startStr} - ${endStr}`;

    evEl.appendChild(titleEl);
    evEl.appendChild(timeEl);

    evEl.addEventListener('click', (e) => {
      e.stopPropagation();
      openEditModal(layout);
    });

    col.appendChild(evEl);
  });

  // Interaction for create
  setupDayInteraction(col, date);

  return col;
}

function layoutDayEvents(dayEvents, dayWidth) {
  if (dayEvents.length === 0) return [];

  // Sort by start
  dayEvents.sort((a, b) => a.visibleStart - b.visibleStart);

  // Find clusters (transitive overlap)
  const clusters = [];
  let currentCluster = [dayEvents[0]];

  for (let i = 1; i < dayEvents.length; i++) {
    const ev = dayEvents[i];
    const last = currentCluster[currentCluster.length - 1];
    if (ev.visibleStart < last.visibleEnd) {
      currentCluster.push(ev);
    } else {
      clusters.push(currentCluster);
      currentCluster = [ev];
    }
  }
  clusters.push(currentCluster);

  const result = [];

  clusters.forEach(cluster => {
    // Assign columns greedily
    const columns = []; // end time of last event in each column
    const assignments = new Map();

    cluster.forEach(ev => {
      let assignedCol = 0;
      for (let c = 0; c < columns.length; c++) {
        if (columns[c] <= ev.visibleStart) {
          assignedCol = c;
          break;
        }
        assignedCol = c + 1;
      }
      if (assignedCol >= columns.length) {
        columns.push(ev.visibleEnd);
      } else {
        columns[assignedCol] = ev.visibleEnd;
      }
      assignments.set(ev, assignedCol);
    });

    const numCols = columns.length;
    const colWidth = dayWidth / numCols;

    cluster.forEach(ev => {
      const col = assignments.get(ev);
      result.push({
        ...ev,
        left: col * colWidth,
        width: colWidth
      });
    });
  });

  return result;
}

function setupDayInteraction(col, date) {
  let isDragging = false;
  let startY = 0;
  let startTime = null;

  col.addEventListener('mousedown', (e) => {
    if (e.target.classList.contains('event')) return;
    isDragging = true;
    startY = e.offsetY;
    const minutes = Math.floor((startY / HOUR_HEIGHT) * 60);
    const hour = Math.floor(minutes / 60);
    const min = minutes % 60;
    startTime = new Date(date);
    startTime.setHours(hour, min, 0, 0);
  });

  col.addEventListener('mousemove', (e) => {
    // Could add visual feedback, but for simplicity skip
  });

  document.addEventListener('mouseup', (e) => {
    if (!isDragging) return;
    isDragging = false;

    const rect = col.getBoundingClientRect();
    const endY = e.clientY - rect.top;
    const minutes = Math.floor((Math.max(0, endY) / HOUR_HEIGHT) * 60);
    let hour = Math.floor(minutes / 60);
    let min = minutes % 60;

    let endTime = new Date(date);
    endTime.setHours(hour, min, 0, 0);

    if (endTime <= startTime) {
      endTime = new Date(startTime);
      endTime.setHours(startTime.getHours() + 1);
    }

    openCreateModal(startTime, endTime);
  }, { once: false }); // keep listener? but ok, or attach to col

  // Also support simple click for 1h event
  col.addEventListener('click', (e) => {
    if (e.target.classList.contains('event')) return;
    const rect = col.getBoundingClientRect();
    const clickY = e.clientY - rect.top;
    const minutes = Math.floor((clickY / HOUR_HEIGHT) * 60);
    const hour = Math.floor(minutes / 60);
    const min = Math.floor(minutes % 60 / 15) * 15; // snap to 15min? or 0
    const start = new Date(date);
    start.setHours(hour, min, 0, 0);
    const end = new Date(start);
    end.setHours(start.getHours() + 1);
    openCreateModal(start, end);
  });
}

function openCreateModal(start, end) {
  const modal = document.getElementById('modal');
  const form = document.getElementById('event-form');
  const titleEl = document.getElementById('modal-title');
  const deleteBtn = document.getElementById('delete-btn');

  titleEl.textContent = 'Create Event';
  deleteBtn.classList.add('hidden');
  currentEventId = null;

  document.getElementById('title').value = '';
  document.getElementById('start').value = toDateTimeLocal(start);
  document.getElementById('end').value = toDateTimeLocal(end);

  modal.classList.remove('hidden');

  form.onsubmit = async (e) => {
    e.preventDefault();
    await createEvent();
  };
}

function toDateTimeLocal(date) {
  const pad = n => n.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function createEvent() {
  const title = document.getElementById('title').value;
  const start = document.getElementById('start').value;
  const end = document.getElementById('end').value;

  try {
    const res = await fetch(`${API_BASE}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, start_at: new Date(start).toISOString(), end_at: new Date(end).toISOString() })
    });
    if (!res.ok) {
      const err = await res.json();
      alert(err.error || 'Failed to create');
      return;
    }
    closeModal();
    await loadAndRender();
  } catch (err) {
    alert('Error creating event');
  }
}

function openEditModal(event) {
  const modal = document.getElementById('modal');
  const form = document.getElementById('event-form');
  const titleEl = document.getElementById('modal-title');
  const deleteBtn = document.getElementById('delete-btn');

  titleEl.textContent = 'Edit Event';
  deleteBtn.classList.remove('hidden');
  currentEventId = event.id;

  document.getElementById('title').value = event.title;
  document.getElementById('start').value = toDateTimeLocal(event.originalStart);
  document.getElementById('end').value = toDateTimeLocal(event.originalEnd);

  modal.classList.remove('hidden');

  form.onsubmit = async (e) => {
    e.preventDefault();
    await updateEvent();
  };

  deleteBtn.onclick = async () => {
    if (confirm('Delete this event?')) {
      await deleteEvent();
    }
  };
}

async function updateEvent() {
  const title = document.getElementById('title').value;
  const start = document.getElementById('start').value;
  const end = document.getElementById('end').value;

  try {
    const res = await fetch(`${API_BASE}/api/events/${currentEventId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, start_at: new Date(start).toISOString(), end_at: new Date(end).toISOString() })
    });
    if (!res.ok) {
      const err = await res.json();
      alert(err.error || 'Failed to update');
      return;
    }
    closeModal();
    await loadAndRender();
  } catch (err) {
    alert('Error updating event');
  }
}

async function deleteEvent() {
  try {
    const res = await fetch(`${API_BASE}/api/events/${currentEventId}`, {
      method: 'DELETE'
    });
    if (!res.ok && res.status !== 204) {
      alert('Failed to delete');
      return;
    }
    closeModal();
    await loadAndRender();
  } catch (err) {
    alert('Error deleting event');
  }
}

function closeModal() {
  const modal = document.getElementById('modal');
  modal.classList.add('hidden');
  document.getElementById('event-form').onsubmit = null;
  document.getElementById('delete-btn').onclick = null;
}

async function loadAndRender() {
  try {
    events = await fetchEvents(currentWeekStart);
    renderCalendar();
  } catch (err) {
    console.error(err);
    alert('Failed to load events');
  }
}

function renderCalendar() {
  const container = document.getElementById('days-container');
  container.innerHTML = '';
  container.style.height = `${CALENDAR_HEIGHT}px`;

  document.getElementById('week-range').textContent = formatWeekRange(currentWeekStart);

  for (let i = 0; i < 7; i++) {
    const date = new Date(currentWeekStart);
    date.setDate(date.getDate() + i);
    const col = createDayColumn(date, i, currentWeekStart, events);
    container.appendChild(col);
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

  // Close modal on outside click
  document.getElementById('modal').addEventListener('click', (e) => {
    if (e.target.id === 'modal') closeModal();
  });

  document.getElementById('cancel-btn').addEventListener('click', closeModal);
}

async function init() {
  renderTimeAxis();
  setupNavigation();
  await loadAndRender();
}

init();