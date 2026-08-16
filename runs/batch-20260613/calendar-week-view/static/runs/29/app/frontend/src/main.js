const API_BASE = '/api';
const HOUR_HEIGHT = 30; // px per hour
const TOTAL_HEIGHT = 24 * HOUR_HEIGHT; // 720px

let currentWeekStart = getWeekStart(new Date());
let events = [];

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

function getWeekRange(weekStart) {
  const start = new Date(weekStart);
  const end = new Date(weekStart);
  end.setDate(end.getDate() + 6);
  return { start, end };
}

function updateWeekRangeDisplay(weekStart) {
  const { start, end } = getWeekRange(weekStart);
  const rangeEl = document.getElementById('week-range');
  rangeEl.textContent = `${start.toLocaleDateString()} - ${end.toLocaleDateString()}`;
}

async function fetchEvents(weekStart) {
  const { start, end } = getWeekRange(weekStart);
  const startStr = start.toISOString();
  const endStr = end.toISOString();
  const res = await fetch(`${API_BASE}/events?start=${encodeURIComponent(startStr)}&end=${encodeURIComponent(endStr)}`);
  if (!res.ok) throw new Error('Failed to fetch events');
  events = await res.json();
}

function renderCalendar() {
  const calendarEl = document.getElementById('calendar');
  calendarEl.innerHTML = '';
  calendarEl.style.height = `${TOTAL_HEIGHT}px`;

  // Time axis
  const timeAxis = document.createElement('div');
  timeAxis.className = 'time-axis';
  timeAxis.style.height = `${TOTAL_HEIGHT}px`;
  for (let h = 0; h < 24; h++) {
    const line = document.createElement('div');
    line.className = 'hour-line';
    line.style.top = `${h * HOUR_HEIGHT}px`;
    line.style.height = `${HOUR_HEIGHT}px`;
    line.textContent = `${h.toString().padStart(2, '0')}:00`;
    timeAxis.appendChild(line);
  }
  calendarEl.appendChild(timeAxis);

  // Day columns
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const today = new Date();
  const weekStart = new Date(currentWeekStart);

  for (let i = 0; i < 7; i++) {
    const dayDate = new Date(weekStart);
    dayDate.setDate(dayDate.getDate() + i);
    const isToday = dayDate.toDateString() === today.toDateString();

    const col = document.createElement('div');
    col.className = 'day-column';
    col.style.height = `${TOTAL_HEIGHT}px`;
    col.dataset.dayIndex = i;
    col.dataset.date = formatDate(dayDate);

    // Header
    const header = document.createElement('div');
    header.className = `day-header ${isToday ? 'today' : ''}`;
    header.innerHTML = `${days[i]}<br>${dayDate.getDate()}`;
    col.appendChild(header);

    // Events for this day
    const dayEvents = getEventsForDay(dayDate);
    const clusters = computeOverlapClusters(dayEvents);
    renderEventsInColumn(col, dayEvents, clusters, dayDate);

    // Click handlers for creating events
    setupDayColumnInteraction(col, dayDate);

    calendarEl.appendChild(col);
  }

  updateWeekRangeDisplay(currentWeekStart);
}

function getEventsForDay(dayDate) {
  const dayStart = new Date(dayDate);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayDate);
  dayEnd.setHours(24, 0, 0, 0);

  return events
    .filter(ev => {
      const evStart = new Date(ev.start_at);
      const evEnd = new Date(ev.end_at);
      return evStart < dayEnd && evEnd > dayStart;
    })
    .map(ev => {
      // Clamp to day
      const evStart = new Date(ev.start_at);
      const evEnd = new Date(ev.end_at);
      const clampedStart = new Date(Math.max(evStart.getTime(), dayStart.getTime()));
      const clampedEnd = new Date(Math.min(evEnd.getTime(), dayEnd.getTime()));
      return {
        ...ev,
        clampedStart,
        clampedEnd,
        originalStart: evStart,
        originalEnd: evEnd
      };
    });
}

function computeOverlapClusters(dayEvents) {
  // Sort by start time
  const sorted = [...dayEvents].sort((a, b) => a.clampedStart - b.clampedStart);
  const clusters = [];
  let currentCluster = [];

  for (const ev of sorted) {
    if (currentCluster.length === 0) {
      currentCluster.push(ev);
    } else {
      const lastEnd = Math.max(...currentCluster.map(e => e.clampedEnd.getTime()));
      if (ev.clampedStart.getTime() < lastEnd) {
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

function renderEventsInColumn(column, dayEvents, clusters, dayDate) {
  const dayStart = new Date(dayDate);
  dayStart.setHours(0, 0, 0, 0);

  clusters.forEach(cluster => {
    const numCols = cluster.length; // worst case, but we use actual max needed
    const eventCols = assignEventColumns(cluster);
    const maxCol = Math.max(...eventCols) + 1;

    cluster.forEach((ev, idx) => {
      const colIdx = eventCols[idx];

      const top = ((ev.clampedStart.getTime() - dayStart.getTime()) / 60000) * (HOUR_HEIGHT / 60);
      const height = ((ev.clampedEnd.getTime() - ev.clampedStart.getTime()) / 60000) * (HOUR_HEIGHT / 60);

      const eventEl = document.createElement('div');
      eventEl.className = 'event';
      eventEl.style.top = `${Math.max(0, top)}px`;
      eventEl.style.height = `${Math.max(20, height)}px`;

      const widthPct = 100 / maxCol;
      eventEl.style.left = `${colIdx * widthPct}%`;
      eventEl.style.width = `${widthPct}%`;

      const titleEl = document.createElement('div');
      titleEl.className = 'event-title';
      titleEl.textContent = ev.title;
      eventEl.appendChild(titleEl);

      const timeEl = document.createElement('div');
      timeEl.className = 'event-time';
      timeEl.textContent = `${formatTime(ev.originalStart)} - ${formatTime(ev.originalEnd)}`;
      eventEl.appendChild(timeEl);

      eventEl.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditModal(ev);
      });

      column.appendChild(eventEl);
    });
  });
}

function assignEventColumns(cluster) {
  const sorted = [...cluster].sort((a, b) => a.clampedStart - b.clampedStart);
  const colEndTimes = [];
  const assignment = new Map();

  sorted.forEach((ev) => {
    let assignedCol = 0;
    for (let c = 0; c < colEndTimes.length; c++) {
      if (colEndTimes[c] <= ev.clampedStart.getTime()) {
        assignedCol = c;
        colEndTimes[c] = ev.clampedEnd.getTime();
        break;
      }
      assignedCol = c + 1;
    }
    if (assignedCol >= colEndTimes.length) {
      colEndTimes.push(ev.clampedEnd.getTime());
    } else {
      colEndTimes[assignedCol] = ev.clampedEnd.getTime();
    }
    assignment.set(ev, assignedCol);
  });

  return cluster.map(ev => assignment.get(ev));
}

function setupDayColumnInteraction(column, dayDate) {
  let isDragging = false;
  let startY = 0;
  let startTime = null;

  column.addEventListener('mousedown', (e) => {
    if (e.target.classList.contains('event')) return;
    isDragging = true;
    const rect = column.getBoundingClientRect();
    startY = e.clientY - rect.top;
    startTime = yToTime(startY, dayDate);
  });

  document.addEventListener('mouseup', (e) => {
    if (!isDragging) return;
    isDragging = false;
    const rect = column.getBoundingClientRect();
    const endY = Math.max(0, Math.min(TOTAL_HEIGHT, e.clientY - rect.top));
    let endTime = yToTime(endY, dayDate);

    if (!startTime || endTime <= startTime) {
      endTime = new Date(startTime.getTime() + 60 * 60 * 1000);
    }

    openCreateModal(startTime, endTime);
  });

  // Simple click support
  column.addEventListener('click', (e) => {
    if (e.target.classList.contains('event') || isDragging) return;
    const rect = column.getBoundingClientRect();
    const clickY = e.clientY - rect.top;
    const clickTime = yToTime(clickY, dayDate);
    const endTime = new Date(clickTime.getTime() + 60 * 60 * 1000);
    openCreateModal(clickTime, endTime);
  });
}

function yToTime(y, dayDate) {
  const minutes = Math.floor((y / HOUR_HEIGHT) * 60);
  const clampedMinutes = Math.max(0, Math.min(24 * 60 - 1, minutes));
  const time = new Date(dayDate);
  time.setHours(0, 0, 0, 0);
  time.setMinutes(clampedMinutes);
  return time;
}

function openCreateModal(start, end) {
  const modal = document.getElementById('event-modal');
  const form = document.getElementById('event-form');
  const titleEl = document.getElementById('modal-title');
  const idInput = document.getElementById('event-id');
  const titleInput = document.getElementById('title');
  const startInput = document.getElementById('start');
  const endInput = document.getElementById('end');
  const deleteBtn = document.getElementById('delete-btn');

  titleEl.textContent = 'Create Event';
  idInput.value = '';
  titleInput.value = '';
  startInput.value = toDateTimeLocal(start);
  endInput.value = toDateTimeLocal(end);
  deleteBtn.classList.add('hidden');

  modal.classList.remove('hidden');

  form.onsubmit = async (e) => {
    e.preventDefault();
    await createEvent(titleInput.value, startInput.value, endInput.value);
    modal.classList.add('hidden');
  };

  document.getElementById('cancel-btn').onclick = () => modal.classList.add('hidden');
}

function openEditModal(event) {
  const modal = document.getElementById('event-modal');
  const form = document.getElementById('event-form');
  const titleEl = document.getElementById('modal-title');
  const idInput = document.getElementById('event-id');
  const titleInput = document.getElementById('title');
  const startInput = document.getElementById('start');
  const endInput = document.getElementById('end');
  const deleteBtn = document.getElementById('delete-btn');

  titleEl.textContent = 'Edit Event';
  idInput.value = event.id;
  titleInput.value = event.title;
  startInput.value = toDateTimeLocal(new Date(event.start_at));
  endInput.value = toDateTimeLocal(new Date(event.end_at));
  deleteBtn.classList.remove('hidden');

  modal.classList.remove('hidden');

  form.onsubmit = async (e) => {
    e.preventDefault();
    await updateEvent(idInput.value, titleInput.value, startInput.value, endInput.value);
    modal.classList.add('hidden');
  };

  deleteBtn.onclick = async () => {
    await deleteEvent(idInput.value);
    modal.classList.add('hidden');
  };

  document.getElementById('cancel-btn').onclick = () => modal.classList.add('hidden');
}

function toDateTimeLocal(date) {
  const pad = n => n.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function createEvent(title, start, end) {
  if (!title.trim()) {
    alert('Title is required');
    return;
  }
  const res = await fetch(`${API_BASE}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: title.trim(), start_at: start, end_at: end })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(err.error || 'Failed to create event');
    return;
  }
  await refreshCalendar();
}

async function updateEvent(id, title, start, end) {
  if (!title.trim()) {
    alert('Title is required');
    return;
  }
  const res = await fetch(`${API_BASE}/events/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: title.trim(), start_at: start, end_at: end })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(err.error || 'Failed to update event');
    return;
  }
  await refreshCalendar();
}

async function deleteEvent(id) {
  if (!confirm('Delete this event?')) return;
  const res = await fetch(`${API_BASE}/events/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    alert('Failed to delete');
    return;
  }
  await refreshCalendar();
}

async function refreshCalendar() {
  await fetchEvents(currentWeekStart);
  renderCalendar();
}

function setupNavigation() {
  document.getElementById('prev-week').addEventListener('click', async () => {
    currentWeekStart.setDate(currentWeekStart.getDate() - 7);
    await refreshCalendar();
  });

  document.getElementById('today').addEventListener('click', async () => {
    currentWeekStart = getWeekStart(new Date());
    await refreshCalendar();
  });

  document.getElementById('next-week').addEventListener('click', async () => {
    currentWeekStart.setDate(currentWeekStart.getDate() + 7);
    await refreshCalendar();
  });
}

async function init() {
  setupNavigation();
  await fetchEvents(currentWeekStart);
  renderCalendar();
}

init();