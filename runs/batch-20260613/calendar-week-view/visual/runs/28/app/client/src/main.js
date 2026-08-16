const API_BASE = 'http://localhost:3000/api';

let currentWeekStart = null; // Monday of current week
let events = [];
let selectedEvent = null;
let isDragging = false;
let dragStartY = 0;
let dragStartTime = null;
let currentDayCol = null;

function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // adjust when day is sunday
  return new Date(d.setDate(diff));
}

function formatDateRange(start) {
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const opts = { month: 'short', day: 'numeric' };
  return `${start.toLocaleDateString(undefined, opts)} - ${end.toLocaleDateString(undefined, opts)}`;
}

function formatTime(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDateTimeLocal(date) {
  const pad = n => n.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function fetchEvents(start, end) {
  const url = `${API_BASE}/events?start=${start.toISOString()}&end=${end.toISOString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to fetch');
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

function renderTimeAxis() {
  const axis = document.getElementById('time-axis');
  axis.innerHTML = '';
  const height = 1440; // 24*60 px
  axis.style.height = `${height}px`;
  axis.style.position = 'relative';

  for (let h = 0; h <= 24; h++) {
    const label = document.createElement('div');
    label.className = 'hour-label';
    label.style.top = `${h * 60}px`;
    label.textContent = h === 24 ? '' : `${h.toString().padStart(2, '0')}:00`;
    axis.appendChild(label);

    if (h < 24) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${h * 60}px`;
      line.style.height = '60px';
      axis.appendChild(line);
    }
  }
}

function renderDayHeaders(daysContainer, weekStart) {
  daysContainer.innerHTML = '';
  const today = new Date();
  today.setHours(0,0,0,0);

  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  for (let i = 0; i < 7; i++) {
    const dayDate = new Date(weekStart);
    dayDate.setDate(dayDate.getDate() + i);

    const col = document.createElement('div');
    col.className = 'day-column';
    col.style.height = '1440px';
    col.style.position = 'relative';
    col.dataset.dayIndex = i;
    col.dataset.date = dayDate.toISOString().split('T')[0];

    const header = document.createElement('div');
    header.className = 'day-header';
    if (dayDate.getTime() === today.getTime()) {
      header.classList.add('today');
    }
    header.innerHTML = `${dayNames[i]}<br>${dayDate.getMonth()+1}/${dayDate.getDate()}`;
    col.appendChild(header);

    // Make column clickable for creating events
    col.addEventListener('mousedown', (e) => startDragCreate(e, col, dayDate));

    daysContainer.appendChild(col);
  }
}

function startDragCreate(e, col, dayDate) {
  if (e.target.closest('.event')) return; // ignore if clicking event

  isDragging = true;
  currentDayCol = col;
  const rect = col.getBoundingClientRect();
  const calendarRect = document.getElementById('calendar').getBoundingClientRect();
  const timeAxisWidth = 60;
  const relativeY = e.clientY - rect.top;

  dragStartY = relativeY;
  const minutesFromMidnight = Math.floor((relativeY / 60) * 60); // 60px = 60min => 1px = 1min
  const startHour = Math.floor(minutesFromMidnight / 60);
  const startMin = minutesFromMidnight % 60;

  dragStartTime = new Date(dayDate);
  dragStartTime.setHours(startHour, startMin, 0, 0);

  // Visual feedback: create temp selection
  const selection = document.createElement('div');
  selection.id = 'temp-selection';
  selection.style.position = 'absolute';
  selection.style.left = '0';
  selection.style.right = '0';
  selection.style.top = `${dragStartY}px`;
  selection.style.height = '20px';
  selection.style.background = 'rgba(66, 133, 244, 0.3)';
  selection.style.border = '1px dashed #4285f4';
  col.appendChild(selection);

  document.addEventListener('mousemove', onDragMove, { once: false });
  document.addEventListener('mouseup', onDragEnd, { once: true });
}

function onDragMove(e) {
  if (!isDragging || !currentDayCol) return;
  const selection = document.getElementById('temp-selection');
  if (!selection) return;

  const rect = currentDayCol.getBoundingClientRect();
  const currentY = e.clientY - rect.top;
  const height = Math.max(20, currentY - dragStartY);
  selection.style.height = `${height}px`;
}

function onDragEnd(e) {
  if (!isDragging || !currentDayCol) return;
  isDragging = false;

  const selection = document.getElementById('temp-selection');
  if (selection) selection.remove();

  const rect = currentDayCol.getBoundingClientRect();
  const endY = Math.max(dragStartY + 20, e.clientY - rect.top);
  const minutesFromMidnight = Math.floor((endY / 60) * 60);
  const endHour = Math.min(24, Math.floor(minutesFromMidnight / 60));
  const endMin = minutesFromMidnight % 60;

  const endTime = new Date(dragStartTime);
  endTime.setHours(endHour, endMin, 0, 0);

  if (endTime <= dragStartTime) {
    endTime.setHours(dragStartTime.getHours() + 1);
  }

  // Clamp to day
  if (endTime.getDate() !== dragStartTime.getDate()) {
    endTime.setHours(23, 59, 0, 0);
  }

  openCreateModal(dragStartTime, endTime);

  document.removeEventListener('mousemove', onDragMove);
  currentDayCol = null;
}

function openCreateModal(start, end) {
  const modal = document.getElementById('modal');
  const form = document.getElementById('event-form');
  const titleEl = document.getElementById('modal-title');
  const deleteBtn = document.getElementById('delete-btn');

  titleEl.textContent = 'Create Event';
  deleteBtn.classList.add('hidden');
  selectedEvent = null;

  document.getElementById('title').value = '';
  document.getElementById('start').value = formatDateTimeLocal(start);
  document.getElementById('end').value = formatDateTimeLocal(end);

  modal.classList.remove('hidden');

  form.onsubmit = async (ev) => {
    ev.preventDefault();
    await handleSaveEvent();
  };
}

function openEditModal(event) {
  const modal = document.getElementById('modal');
  const form = document.getElementById('event-form');
  const titleEl = document.getElementById('modal-title');
  const deleteBtn = document.getElementById('delete-btn');

  titleEl.textContent = 'Edit Event';
  deleteBtn.classList.remove('hidden');
  selectedEvent = event;

  document.getElementById('title').value = event.title;
  document.getElementById('start').value = formatDateTimeLocal(new Date(event.startAt));
  document.getElementById('end').value = formatDateTimeLocal(new Date(event.endAt));

  modal.classList.remove('hidden');

  form.onsubmit = async (ev) => {
    ev.preventDefault();
    await handleSaveEvent();
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
}

async function handleSaveEvent() {
  const modal = document.getElementById('modal');
  const title = document.getElementById('title').value.trim();
  const startVal = document.getElementById('start').value;
  const endVal = document.getElementById('end').value;

  if (!title) {
    alert('Title is required');
    return;
  }

  const startAt = new Date(startVal).toISOString();
  const endAt = new Date(endVal).toISOString();

  if (new Date(endAt) <= new Date(startAt)) {
    alert('End time must be after start time');
    return;
  }

  try {
    if (selectedEvent) {
      await updateEvent(selectedEvent.id, { title, startAt, endAt });
    } else {
      await createEvent({ title, startAt, endAt });
    }
    modal.classList.add('hidden');
    await loadAndRenderWeek();
  } catch (err) {
    alert(err.message);
  }
}

function closeModal() {
  const modal = document.getElementById('modal');
  modal.classList.add('hidden');
  document.getElementById('event-form').onsubmit = null;
}

function computeOverlapLayout(dayEvents, dayColWidth) {
  if (dayEvents.length === 0) return [];

  // Sort by start time
  const sorted = [...dayEvents].sort((a, b) => new Date(a.startAt) - new Date(b.startAt));

  // Find clusters: groups of transitively overlapping events
  const clusters = [];
  let currentCluster = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const evt = sorted[i];
    const clusterEnd = Math.max(...currentCluster.map(e => new Date(e.endAt).getTime()));
    const evtStart = new Date(evt.startAt).getTime();

    if (evtStart < clusterEnd) {
      currentCluster.push(evt);
    } else {
      clusters.push(currentCluster);
      currentCluster = [evt];
    }
  }
  clusters.push(currentCluster);

  const placed = [];

  clusters.forEach(cluster => {
    // Greedy column assignment
    const columns = []; // array of end times per column
    const eventCols = new Map();

    cluster.forEach(evt => {
      const start = new Date(evt.startAt).getTime();
      let assignedCol = 0;
      for (let c = 0; c < columns.length; c++) {
        if (columns[c] <= start) {
          assignedCol = c;
          break;
        }
        assignedCol = c + 1;
      }
      if (assignedCol >= columns.length) {
        columns.push(new Date(evt.endAt).getTime());
      } else {
        columns[assignedCol] = new Date(evt.endAt).getTime();
      }
      eventCols.set(evt, assignedCol);
    });

    const numCols = columns.length;
    const colWidth = dayColWidth / numCols;

    cluster.forEach(evt => {
      const colIdx = eventCols.get(evt);
      placed.push({
        ...evt,
        left: colIdx * colWidth,
        width: colWidth,
        numCols
      });
    });
  });

  return placed;
}

function renderEvents(daysContainer, weekEvents) {
  // Clear existing events
  document.querySelectorAll('.event').forEach(el => el.remove());

  const dayCols = daysContainer.querySelectorAll('.day-column');
  const colWidth = dayCols[0] ? dayCols[0].getBoundingClientRect().width : 120;
  const pxPerMinute = 1; // 60px per hour => 1px per minute

  // Group events by day
  const eventsByDay = {};
  for (let i = 0; i < 7; i++) {
    const col = dayCols[i];
    const dateStr = col.dataset.date;
    eventsByDay[dateStr] = [];
  }

  weekEvents.forEach(evt => {
    const start = new Date(evt.startAt);
    const dateStr = start.toISOString().split('T')[0];
    if (eventsByDay[dateStr]) {
      eventsByDay[dateStr].push(evt);
    } else {
      // Handle events starting on previous days but overlapping? For simplicity, use start day
      // But to be complete, we should also consider if crosses days, but per spec clamp to day
    }
  });

  Object.keys(eventsByDay).forEach((dateStr, dayIdx) => {
    const col = dayCols[dayIdx];
    if (!col) return;

    const dayEvents = eventsByDay[dateStr];
    const laidOut = computeOverlapLayout(dayEvents, colWidth);

    laidOut.forEach(evt => {
      const start = new Date(evt.startAt);
      const end = new Date(evt.endAt);

      // Minutes from midnight
      const startMin = start.getHours() * 60 + start.getMinutes();
      const endMin = Math.min(24 * 60, end.getHours() * 60 + end.getMinutes());

      const top = startMin * pxPerMinute;
      const height = Math.max(20, (endMin - startMin) * pxPerMinute);

      const eventEl = document.createElement('div');
      eventEl.className = 'event';
      eventEl.style.top = `${top}px`;
      eventEl.style.height = `${height}px`;
      eventEl.style.left = `${evt.left + 2}px`;
      eventEl.style.width = `${evt.width - 4}px`;

      const titleDiv = document.createElement('div');
      titleDiv.className = 'event-title';
      titleDiv.textContent = evt.title;

      const timeDiv = document.createElement('div');
      timeDiv.className = 'event-time';
      timeDiv.textContent = `${formatTime(evt.startAt)} - ${formatTime(evt.endAt)}`;

      eventEl.appendChild(titleDiv);
      eventEl.appendChild(timeDiv);

      eventEl.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditModal(evt);
      });

      col.appendChild(eventEl);
    });
  });
}

async function loadAndRenderWeek() {
  if (!currentWeekStart) {
    currentWeekStart = getWeekStart(new Date());
  }

  const weekEnd = new Date(currentWeekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);

  try {
    events = await fetchEvents(currentWeekStart, weekEnd);
  } catch (err) {
    console.error(err);
    events = [];
  }

  // Render headers
  const daysContainer = document.getElementById('days-container');
  renderDayHeaders(daysContainer, currentWeekStart);

  // Set week range
  document.getElementById('week-range').textContent = formatDateRange(currentWeekStart);

  // Render time axis once
  renderTimeAxis();

  // Render events
  renderEvents(daysContainer, events);

  // Re-attach resize observer or handle dynamic width? For simplicity, re-render on nav
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

function setupModal() {
  const modal = document.getElementById('modal');
  const cancelBtn = document.getElementById('cancel-btn');

  cancelBtn.addEventListener('click', () => {
    modal.classList.add('hidden');
  });

  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.classList.add('hidden');
    }
  });
}

async function init() {
  setupNavigation();
  setupModal();

  // Initial load
  await loadAndRenderWeek();

  // Make calendar container have proper height for time axis
  const calendar = document.getElementById('calendar');
  calendar.style.height = '1440px';
  calendar.style.overflowY = 'auto';
}

// Start app
init();