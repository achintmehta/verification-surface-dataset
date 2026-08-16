const API_BASE = 'http://localhost:3000/api';

let currentWeekStart = getWeekStart(new Date());
let events = [];
let isDragging = false;
let dragStartY = 0;
let dragDayCol = null;
let selectionStart = null;

function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday start
  return new Date(d.setDate(diff));
}

function getWeekEnd(weekStart) {
  const end = new Date(weekStart);
  end.setDate(end.getDate() + 6);
  end.setHours(23, 59, 59, 999);
  return end;
}

function formatDateRange(start, end) {
  const opts = { month: 'short', day: 'numeric' };
  return `${start.toLocaleDateString(undefined, opts)} - ${end.toLocaleDateString(undefined, opts)}`;
}

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
    const err = await res.json();
    throw new Error(err.error || 'Failed to delete');
  }
}

function renderWeekHeader(weekStart) {
  const rangeEl = document.getElementById('week-range');
  const end = new Date(weekStart);
  end.setDate(end.getDate() + 6);
  rangeEl.textContent = formatDateRange(weekStart, end);
}

function renderTimeAxis() {
  const axis = document.getElementById('time-axis');
  axis.innerHTML = '';
  for (let h = 0; h < 24; h++) {
    const line = document.createElement('div');
    line.className = 'hour-line';
    line.style.top = `${h * 60}px`;
    line.textContent = `${h.toString().padStart(2, '0')}:00`;
    axis.appendChild(line);
  }
}

function renderDayColumns(weekStart, allEvents) {
  const container = document.getElementById('days-container');
  container.innerHTML = '';

  const today = new Date();
  today.setHours(0,0,0,0);

  for (let i = 0; i < 7; i++) {
    const dayDate = new Date(weekStart);
    dayDate.setDate(dayDate.getDate() + i);
    dayDate.setHours(0,0,0,0);

    const col = document.createElement('div');
    col.className = 'day-column';
    col.dataset.date = dayDate.toISOString().split('T')[0];

    // Header
    const header = document.createElement('div');
    header.className = 'day-header';
    if (dayDate.getTime() === today.getTime()) {
      header.classList.add('today');
    }
    const dayName = dayDate.toLocaleDateString(undefined, { weekday: 'short' });
    const dateNum = dayDate.getDate();
    header.innerHTML = `${dayName} ${dateNum}`;
    col.appendChild(header);

    // Grid lines
    const grid = document.createElement('div');
    grid.className = 'hour-grid';
    for (let h = 0; h < 24; h++) {
      const hr = document.createElement('div');
      hr.className = 'hour';
      hr.style.top = `${h * 60}px`;
      grid.appendChild(hr);
    }
    col.appendChild(grid);

    // Events for this day: any that overlap the day
    const dayStartMs = dayDate.getTime();
    const dayEndMs = dayStartMs + 24 * 60 * 60 * 1000;
    const dayEvents = allEvents.filter(ev => {
      const s = new Date(ev.start_at).getTime();
      const e = new Date(ev.end_at).getTime();
      return s < dayEndMs && e > dayStartMs;
    });

    if (dayEvents.length > 0) {
      renderEventsInDay(col, dayEvents, dayDate);
    }

    // Interaction for create
    setupDayInteraction(col, dayDate);

    container.appendChild(col);
  }
}

function renderEventsInDay(dayCol, dayEvents, dayDate) {
  // Sort by start
  dayEvents.sort((a, b) => new Date(a.start_at) - new Date(b.start_at));

  // Find clusters
  const clusters = findOverlapClusters(dayEvents);

  clusters.forEach(cluster => {
    const numCols = assignColumnsToEvents(cluster);
    const colWidth = 100 / numCols;

    cluster.forEach((event, idx) => {
      const colIndex = event._colIndex;
      const evEl = createEventElement(event, dayDate);
      evEl.style.left = `${colIndex * colWidth}%`;
      evEl.style.width = `${colWidth}%`;
      dayCol.appendChild(evEl);
    });
  });
}

function findOverlapClusters(events) {
  const clusters = [];
  let currentCluster = [];

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const evStart = new Date(ev.start_at);
    const evEnd = new Date(ev.end_at);

    if (currentCluster.length === 0) {
      currentCluster.push(ev);
    } else {
      // Check if overlaps with any in current cluster (transitive via max end)
      const maxEnd = Math.max(...currentCluster.map(e => new Date(e.end_at).getTime()));
      if (evStart.getTime() < maxEnd) {
        currentCluster.push(ev);
      } else {
        clusters.push(currentCluster);
        currentCluster = [ev];
      }
    }
  }
  if (currentCluster.length > 0) {
    clusters.push(currentCluster);
  }
  return clusters;
}

function assignColumnsToEvents(cluster) {
  // Greedy column assignment by start time
  const columns = []; // end time of last event in each column

  cluster.forEach(ev => {
    const start = new Date(ev.start_at).getTime();
    let assignedCol = 0;
    for (let c = 0; c < columns.length; c++) {
      if (columns[c] <= start) {
        assignedCol = c;
        break;
      }
      assignedCol = c + 1;
    }
    if (assignedCol >= columns.length) {
      columns.push(0);
    }
    columns[assignedCol] = new Date(ev.end_at).getTime();
    ev._colIndex = assignedCol;
  });

  return columns.length;
}

function createEventElement(event, dayDate) {
  const el = document.createElement('div');
  el.className = 'event';

  const start = new Date(event.start_at);
  const end = new Date(event.end_at);

  // Compute top and height, clamp to day 00:00-24:00
  const dayStart = new Date(dayDate);
  dayStart.setHours(0,0,0,0);
  const dayEnd = new Date(dayDate);
  dayEnd.setHours(24,0,0,0);

  const effectiveStart = Math.max(start.getTime(), dayStart.getTime());
  const effectiveEnd = Math.min(end.getTime(), dayEnd.getTime());

  const minutesFromMidnightStart = (effectiveStart - dayStart.getTime()) / 60000;
  const durationMinutes = (effectiveEnd - effectiveStart) / 60000;

  const pxPerMin = 60 / 60; // 60px per hour = 1px per min
  el.style.top = `${minutesFromMidnightStart * pxPerMin}px`;
  el.style.height = `${Math.max(durationMinutes * pxPerMin, 20)}px`; // min height

  // Content
  const title = document.createElement('div');
  title.className = 'event-title';
  title.textContent = event.title;
  el.appendChild(title);

  const time = document.createElement('div');
  time.className = 'event-time';
  time.textContent = `${formatTime(start)} - ${formatTime(end)}`;
  el.appendChild(time);

  // Click to edit
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    openEditModal(event);
  });

  return el;
}

function setupDayInteraction(dayCol, dayDate) {
  const gridHeight = 1440; // px

  dayCol.addEventListener('mousedown', (e) => {
    if (e.target.classList.contains('event')) return;

    isDragging = true;
    dragDayCol = dayCol;
    const rect = dayCol.getBoundingClientRect();
    dragStartY = e.clientY - rect.top;

    // Create temp selection indicator
    const sel = document.createElement('div');
    sel.className = 'event';
    sel.style.background = 'rgba(76, 175, 80, 0.3)';
    sel.style.border = '1px dashed #388e3c';
    sel.style.left = '0';
    sel.style.width = '100%';
    sel.style.top = `${dragStartY}px`;
    sel.style.height = '20px';
    sel.id = 'temp-selection';
    dayCol.appendChild(sel);

    selectionStart = calculateTimeFromY(dayDate, dragStartY);
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging || !dragDayCol) return;

    const rect = dragDayCol.getBoundingClientRect();
    const currentY = Math.max(0, Math.min(gridHeight, e.clientY - rect.top));
    const sel = document.getElementById('temp-selection');
    if (sel) {
      const top = Math.min(dragStartY, currentY);
      const height = Math.abs(currentY - dragStartY);
      sel.style.top = `${top}px`;
      sel.style.height = `${Math.max(height, 20)}px`;
    }
  });

  document.addEventListener('mouseup', async (e) => {
    if (!isDragging || !dragDayCol) return;

    const sel = document.getElementById('temp-selection');
    if (sel) {
      const rect = dragDayCol.getBoundingClientRect();
      const endY = Math.max(0, Math.min(gridHeight, e.clientY - rect.top));
      const startY = dragStartY;
      const top = Math.min(startY, endY);
      const height = Math.abs(endY - startY) || 60; // default 1h

      const startTime = calculateTimeFromY(dayDate, top);
      const endTime = calculateTimeFromY(dayDate, top + height);

      sel.remove();

      // Open create modal
      openCreateModal(startTime, endTime);
    }

    isDragging = false;
    dragDayCol = null;
    selectionStart = null;
  });
}

function calculateTimeFromY(dayDate, y) {
  const minutes = Math.floor(y); // since 1px = 1min
  const time = new Date(dayDate);
  time.setHours(0, 0, 0, 0);
  time.setMinutes(minutes);
  return time;
}

function openCreateModal(startTime, endTime) {
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
  startInput.value = formatDateTimeLocal(startTime);
  endInput.value = formatDateTimeLocal(endTime);
  deleteBtn.classList.add('hidden');

  modal.classList.remove('hidden');

  form.onsubmit = async (e) => {
    e.preventDefault();
    await handleSaveEvent();
  };

  document.getElementById('cancel-btn').onclick = () => closeModal();
  deleteBtn.onclick = null;
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
  deleteBtn.classList.remove('hidden');

  modal.classList.remove('hidden');

  form.onsubmit = async (e) => {
    e.preventDefault();
    await handleSaveEvent();
  };

  deleteBtn.onclick = async () => {
    if (confirm('Delete this event?')) {
      try {
        await deleteEvent(event.id);
        closeModal();
        await loadAndRender();
      } catch (err) {
        alert(err.message);
      }
    }
  };

  document.getElementById('cancel-btn').onclick = () => closeModal();
}

function closeModal() {
  const modal = document.getElementById('event-modal');
  modal.classList.add('hidden');
}

async function handleSaveEvent() {
  const id = document.getElementById('event-id').value;
  const title = document.getElementById('event-title').value.trim();
  const start = document.getElementById('event-start').value;
  const end = document.getElementById('event-end').value;

  if (!title || !start || !end) {
    alert('All fields required');
    return;
  }

  const data = {
    title,
    start_at: new Date(start).toISOString(),
    end_at: new Date(end).toISOString()
  };

  try {
    if (id) {
      await updateEvent(id, data);
    } else {
      await createEvent(data);
    }
    closeModal();
    await loadAndRender();
  } catch (err) {
    alert(err.message);
  }
}

async function loadAndRender() {
  const weekEnd = getWeekEnd(currentWeekStart);
  try {
    events = await fetchEvents(currentWeekStart, weekEnd);
    renderWeekHeader(currentWeekStart);
    renderTimeAxis();
    renderDayColumns(currentWeekStart, events);
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
  renderTimeAxis(); // initial empty
  setupNavigation();
  loadAndRender();
}

init();