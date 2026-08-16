const API_BASE = '/api';
const HOUR_HEIGHT = 30; // pixels per hour
const TOTAL_HOURS = 24;
const CALENDAR_HEIGHT = HOUR_HEIGHT * TOTAL_HOURS;

let currentWeekStart; // Monday of current week
let events = [];
let selectedRange = null;

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

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function toLocalISOString(date) {
  const pad = n => n.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromLocalInput(value) {
  return new Date(value);
}

async function fetchEvents(start, end) {
  const params = new URLSearchParams({
    start: start.toISOString(),
    end: end.toISOString()
  });
  const res = await fetch(`${API_BASE}/events?${params}`);
  if (!res.ok) throw new Error('Failed to fetch');
  return res.json();
}

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

async function deleteEvent(id) {
  const res = await fetch(`${API_BASE}/events/${id}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 204) {
    throw new Error('Failed to delete');
  }
}

function renderTimeAxis() {
  const axis = document.getElementById('time-axis');
  axis.innerHTML = '';
  axis.style.height = `${CALENDAR_HEIGHT}px`;

  for (let h = 0; h <= 24; h++) {
    const label = document.createElement('div');
    label.className = 'hour-label';
    label.style.top = `${h * HOUR_HEIGHT}px`;
    label.textContent = h === 24 ? '24:00' : `${h.toString().padStart(2, '0')}:00`;
    axis.appendChild(label);

    if (h < 24) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${h * HOUR_HEIGHT}px`;
      axis.appendChild(line);
    }
  }
}

function renderDayHeaders(daysContainer, weekStart) {
  const today = new Date();
  today.setHours(0,0,0,0);

  for (let i = 0; i < 7; i++) {
    const dayDate = new Date(weekStart);
    dayDate.setDate(weekStart.getDate() + i);

    const col = document.createElement('div');
    col.className = 'day-column';
    col.dataset.dayIndex = i;
    col.style.height = `${CALENDAR_HEIGHT}px`;

    const header = document.createElement('div');
    header.className = 'day-header';
    const dayName = dayDate.toLocaleDateString(undefined, { weekday: 'short' });
    const dateNum = dayDate.getDate();
    header.innerHTML = `${dayName} ${dateNum}`;
    if (dayDate.getTime() === today.getTime()) {
      header.classList.add('today');
    }
    col.appendChild(header);

    // Add hour lines for visual grid
    for (let h = 0; h < 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${h * HOUR_HEIGHT}px`;
      col.appendChild(line);
    }

    // Event container
    const eventsLayer = document.createElement('div');
    eventsLayer.className = 'events-layer';
    eventsLayer.style.position = 'absolute';
    eventsLayer.style.top = '0';
    eventsLayer.style.left = '0';
    eventsLayer.style.right = '0';
    eventsLayer.style.height = `${CALENDAR_HEIGHT}px`;
    col.appendChild(eventsLayer);

    daysContainer.appendChild(col);

    // Attach interaction handlers
    attachDayInteractions(col, dayDate);
  }
}

function attachDayInteractions(dayCol, dayDate) {
  const eventsLayer = dayCol.querySelector('.events-layer');
  let isDragging = false;
  let startY = 0;
  let startTime = null;

  dayCol.addEventListener('mousedown', (e) => {
    if (e.target.closest('.event')) return; // ignore on events

    isDragging = true;
    const rect = eventsLayer.getBoundingClientRect();
    startY = e.clientY - rect.top;
    const minutes = Math.floor((startY / HOUR_HEIGHT) * 60);
    const snappedMinutes = Math.floor(minutes / 15) * 15; // 15 min snap
    startTime = new Date(dayDate);
    startTime.setHours(0, 0, 0, 0);
    startTime.setMinutes(snappedMinutes);

    // visual feedback could be added
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    // could show preview range
  });

  document.addEventListener('mouseup', async (e) => {
    if (!isDragging) return;
    isDragging = false;

    const rect = eventsLayer.getBoundingClientRect();
    const endY = e.clientY - rect.top;
    let minutes = Math.floor((endY / HOUR_HEIGHT) * 60);
    const snappedMinutes = Math.ceil(minutes / 15) * 15;
    let endTime = new Date(dayDate);
    endTime.setHours(0, 0, 0, 0);
    endTime.setMinutes(snappedMinutes);

    if (endTime <= startTime) {
      endTime = new Date(startTime.getTime() + 60 * 60 * 1000); // default 1h
    }

    // Clamp to day
    const dayEnd = new Date(dayDate);
    dayEnd.setHours(24, 0, 0, 0);
    if (endTime > dayEnd) endTime = dayEnd;

    openCreateModal(startTime, endTime);
  });

  // Also support simple click for create
  dayCol.addEventListener('click', (e) => {
    if (e.target.closest('.event') || isDragging) return;
    const rect = eventsLayer.getBoundingClientRect();
    const clickY = e.clientY - rect.top;
    const minutes = Math.floor((clickY / HOUR_HEIGHT) * 60);
    const snapped = Math.floor(minutes / 30) * 30;
    const start = new Date(dayDate);
    start.setHours(0, 0, 0, 0);
    start.setMinutes(snapped);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    openCreateModal(start, end);
  });
}

function computeOverlapLayout(dayEvents, dayStart, dayEnd) {
  // dayEvents: events overlapping this day
  // Return list of {event, top, height, leftPercent, widthPercent}
  if (!dayEvents.length) return [];

  // Clip times to day
  const processed = dayEvents.map(ev => {
    const evStart = new Date(ev.start_at);
    const evEnd = new Date(ev.end_at);
    const clippedStart = evStart < dayStart ? dayStart : evStart;
    const clippedEnd = evEnd > dayEnd ? dayEnd : evEnd;
    const top = ((clippedStart - dayStart) / (1000 * 60 * 60)) * HOUR_HEIGHT;
    const height = Math.max(20, ((clippedEnd - clippedStart) / (1000 * 60 * 60)) * HOUR_HEIGHT);
    return { ...ev, clippedStart, clippedEnd, top, height };
  });

  // Sort by start
  processed.sort((a, b) => a.clippedStart - b.clippedStart || a.clippedEnd - b.clippedEnd);

  // Find clusters (transitive overlap)
  const clusters = [];
  let currentCluster = [];

  for (const ev of processed) {
    if (currentCluster.length === 0) {
      currentCluster.push(ev);
    } else {
      const last = currentCluster[currentCluster.length - 1];
      // Check if overlaps with any in cluster (transitive via chain)
      const overlapsAny = currentCluster.some(c => 
        c.clippedStart < ev.clippedEnd && c.clippedEnd > ev.clippedStart
      );
      if (overlapsAny) {
        currentCluster.push(ev);
      } else {
        clusters.push(currentCluster);
        currentCluster = [ev];
      }
    }
  }
  if (currentCluster.length) clusters.push(currentCluster);

  const laidOut = [];

  for (const cluster of clusters) {
    // Greedy column assignment
    const columns = []; // array of last end time per column
    const eventColumns = new Map();

    for (const ev of cluster) {
      let assignedCol = 0;
      for (let c = 0; c < columns.length; c++) {
        if (columns[c] <= ev.clippedStart) {
          assignedCol = c;
          break;
        }
        assignedCol = c + 1;
      }
      if (assignedCol >= columns.length) {
        columns.push(ev.clippedEnd);
      } else {
        columns[assignedCol] = ev.clippedEnd;
      }
      eventColumns.set(ev, assignedCol);
    }

    const numCols = columns.length;
    const colWidth = 100 / numCols;

    for (const ev of cluster) {
      const colIdx = eventColumns.get(ev);
      laidOut.push({
        ...ev,
        leftPercent: colIdx * colWidth,
        widthPercent: colWidth
      });
    }
  }

  return laidOut;
}

function renderEvents(daysContainer, weekStart, allEvents) {
  const dayCols = daysContainer.querySelectorAll('.day-column');

  dayCols.forEach((col, i) => {
    const eventsLayer = col.querySelector('.events-layer');
    eventsLayer.innerHTML = '';

    const dayStart = new Date(weekStart);
    dayStart.setDate(weekStart.getDate() + i);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setHours(24, 0, 0, 0);

    // Filter events overlapping this day
    const dayEvents = allEvents.filter(ev => {
      const s = new Date(ev.start_at);
      const e = new Date(ev.end_at);
      return s < dayEnd && e > dayStart;
    });

    const laidOut = computeOverlapLayout(dayEvents, dayStart, dayEnd);

    laidOut.forEach(item => {
      const evEl = document.createElement('div');
      evEl.className = 'event';
      evEl.style.top = `${item.top}px`;
      evEl.style.height = `${item.height}px`;
      evEl.style.left = `${item.leftPercent}%`;
      evEl.style.width = `${item.widthPercent}%`;

      const titleEl = document.createElement('div');
      titleEl.className = 'event-title';
      titleEl.textContent = item.title;

      const timeEl = document.createElement('div');
      timeEl.className = 'event-time';
      const startStr = formatTime(new Date(item.start_at));
      const endStr = formatTime(new Date(item.end_at));
      timeEl.textContent = `${startStr} - ${endStr}`;

      evEl.appendChild(titleEl);
      evEl.appendChild(timeEl);

      evEl.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditModal(item);
      });

      eventsLayer.appendChild(evEl);
    });
  });
}

function openCreateModal(start, end) {
  const modal = document.getElementById('event-modal');
  const form = document.getElementById('event-form');
  const titleEl = document.getElementById('modal-title');
  const idInput = document.getElementById('event-id');
  const titleInput = document.getElementById('event-title');
  const startInput = document.getElementById('event-start');
  const endInput = document.getElementById('event-end');
  const deleteBtn = document.getElementById('delete-btn');

  titleEl.textContent = 'Create Event';
  idInput.value = '';
  titleInput.value = '';
  startInput.value = toLocalISOString(start);
  endInput.value = toLocalISOString(end);
  deleteBtn.classList.add('hidden');

  modal.classList.remove('hidden');

  // Store for submit
  form.onsubmit = async (e) => {
    e.preventDefault();
    const title = titleInput.value.trim();
    const s = fromLocalInput(startInput.value);
    const en = fromLocalInput(endInput.value);
    if (!title || en <= s) {
      alert('Invalid input: title required and end must be after start');
      return;
    }
    try {
      await createEvent(title, s, en);
      modal.classList.add('hidden');
      await loadAndRenderWeek();
    } catch (err) {
      alert(err.message);
    }
  };

  document.getElementById('cancel-btn').onclick = () => modal.classList.add('hidden');
}

function openEditModal(event) {
  const modal = document.getElementById('event-modal');
  const form = document.getElementById('event-form');
  const titleEl = document.getElementById('modal-title');
  const idInput = document.getElementById('event-id');
  const titleInput = document.getElementById('event-title');
  const startInput = document.getElementById('event-start');
  const endInput = document.getElementById('event-end');
  const deleteBtn = document.getElementById('delete-btn');

  titleEl.textContent = 'Edit Event';
  idInput.value = event.id;
  titleInput.value = event.title;
  startInput.value = toLocalISOString(new Date(event.start_at));
  endInput.value = toLocalISOString(new Date(event.end_at));
  deleteBtn.classList.remove('hidden');

  modal.classList.remove('hidden');

  form.onsubmit = async (e) => {
    e.preventDefault();
    const title = titleInput.value.trim();
    const s = fromLocalInput(startInput.value);
    const en = fromLocalInput(endInput.value);
    if (!title || en <= s) {
      alert('Invalid input');
      return;
    }
    try {
      await updateEvent(event.id, title, s, en);
      modal.classList.add('hidden');
      await loadAndRenderWeek();
    } catch (err) {
      alert(err.message);
    }
  };

  deleteBtn.onclick = async () => {
    if (confirm('Delete this event?')) {
      try {
        await deleteEvent(event.id);
        modal.classList.add('hidden');
        await loadAndRenderWeek();
      } catch (err) {
        alert(err.message);
      }
    }
  };

  document.getElementById('cancel-btn').onclick = () => modal.classList.add('hidden');
}

async function loadAndRenderWeek() {
  const weekEnd = new Date(currentWeekStart);
  weekEnd.setDate(currentWeekStart.getDate() + 7);

  document.getElementById('week-range').textContent = formatDateRange(currentWeekStart, weekEnd);

  try {
    events = await fetchEvents(currentWeekStart, weekEnd);
    const daysContainer = document.getElementById('days-container');
    daysContainer.innerHTML = '';
    renderDayHeaders(daysContainer, currentWeekStart);
    renderEvents(daysContainer, currentWeekStart, events);
  } catch (err) {
    console.error(err);
    alert('Failed to load events');
  }
}

function setupNavigation() {
  document.getElementById('prev-week').addEventListener('click', () => {
    currentWeekStart.setDate(currentWeekStart.getDate() - 7);
    loadAndRenderWeek();
  });

  document.getElementById('today').addEventListener('click', () => {
    currentWeekStart = getWeekStart(new Date());
    loadAndRenderWeek();
  });

  document.getElementById('next-week').addEventListener('click', () => {
    currentWeekStart.setDate(currentWeekStart.getDate() + 7);
    loadAndRenderWeek();
  });
}

function init() {
  currentWeekStart = getWeekStart(new Date());
  renderTimeAxis();
  setupNavigation();
  loadAndRenderWeek();
}

init();