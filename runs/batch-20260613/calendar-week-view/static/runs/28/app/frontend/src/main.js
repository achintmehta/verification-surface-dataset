const API_BASE = '/api';
const HOUR_HEIGHT = 30; // px per hour
const TOTAL_HOURS = 24;
const CALENDAR_HEIGHT = TOTAL_HOURS * HOUR_HEIGHT;

let currentWeekStart = getMonday(new Date());
let events = [];
let selectedRange = null;

function getMonday(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(d.setDate(diff));
  monday.setHours(0, 0, 0, 0);
  return monday;
}

function formatDate(date) {
  return date.toISOString().split('T')[0];
}

function formatTime(date) {
  return date.toTimeString().slice(0, 5);
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function getWeekRange(start) {
  const end = addDays(start, 6);
  return { start, end };
}

async function fetchEvents(weekStart, weekEnd) {
  const startISO = weekStart.toISOString();
  const endISO = addDays(weekEnd, 1).toISOString(); // include full Sunday
  const res = await fetch(`${API_BASE}/events?start=${startISO}&end=${endISO}`);
  if (!res.ok) throw new Error('Failed to fetch events');
  return res.json();
}

function renderTimeAxis() {
  const axis = document.getElementById('time-axis');
  axis.innerHTML = '';
  axis.style.height = `${CALENDAR_HEIGHT}px`;

  for (let h = 0; h <= 24; h++) {
    const label = document.createElement('div');
    label.className = 'hour-label';
    label.style.top = `${h * HOUR_HEIGHT}px`;
    label.textContent = `${h.toString().padStart(2, '0')}:00`;
    axis.appendChild(label);

    if (h < 24) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${h * HOUR_HEIGHT}px`;
      axis.appendChild(line);
    }
  }
}

function renderDayHeaders(weekStart) {
  const container = document.getElementById('days-container');
  container.innerHTML = '';
  container.style.height = `${CALENDAR_HEIGHT}px`;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  for (let i = 0; i < 7; i++) {
    const dayDate = addDays(weekStart, i);
    const col = document.createElement('div');
    col.className = 'day-column';
    col.dataset.dayIndex = i;
    col.style.height = `${CALENDAR_HEIGHT}px`;

    const header = document.createElement('div');
    header.className = 'day-header';
    if (dayDate.getTime() === today.getTime()) {
      header.classList.add('today');
    }
    header.innerHTML = `${dayNames[i]}<br>${dayDate.getMonth() + 1}/${dayDate.getDate()}`;
    col.appendChild(header);

    // Add click area for creating events
    const clickArea = document.createElement('div');
    clickArea.style.position = 'absolute';
    clickArea.style.top = '30px'; // below header
    clickArea.style.left = '0';
    clickArea.style.right = '0';
    clickArea.style.bottom = '0';
    clickArea.style.cursor = 'crosshair';
    col.appendChild(clickArea);

    setupDayInteraction(col, clickArea, dayDate);

    container.appendChild(col);
  }
}

function setupDayInteraction(dayCol, clickArea, dayDate) {
  let isDragging = false;
  let startY = 0;

  clickArea.addEventListener('mousedown', (e) => {
    isDragging = true;
    startY = e.offsetY;
    selectedRange = { day: dayDate, startY, endY: startY };
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const rect = clickArea.getBoundingClientRect();
    const currentY = Math.max(0, Math.min(CALENDAR_HEIGHT - 30, e.clientY - rect.top));
    selectedRange.endY = currentY;
    // Could show preview but skip for simplicity
  });

  document.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;

    if (!selectedRange) return;

    const { day, startY, endY } = selectedRange;
    const startMinutes = Math.floor((startY / HOUR_HEIGHT) * 60);
    let endMinutes = Math.floor((endY / HOUR_HEIGHT) * 60);

    if (Math.abs(endY - startY) < 10) {
      // Click: default 1 hour
      endMinutes = startMinutes + 60;
    }

    const startTime = new Date(day);
    startTime.setHours(0, 0, 0, 0);
    startTime.setMinutes(startMinutes);

    const endTime = new Date(day);
    endTime.setHours(0, 0, 0, 0);
    endTime.setMinutes(Math.max(endMinutes, startMinutes + 15));

    openCreateModal(startTime, endTime);
    selectedRange = null;
  });
}

function getEventsForDay(dayDate, allEvents) {
  const dayStart = new Date(dayDate);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayDate);
  dayEnd.setHours(24, 0, 0, 0);

  return allEvents.filter(ev => {
    const evStart = new Date(ev.start_at);
    const evEnd = new Date(ev.end_at);
    return evStart < dayEnd && evEnd > dayStart;
  });
}

function computeLayout(eventsForDay, dayWidth) {
  if (eventsForDay.length === 0) return [];

  // Sort by start time
  const sorted = [...eventsForDay].sort((a, b) => 
    new Date(a.start_at) - new Date(b.start_at)
  );

  // Find clusters (transitive overlap)
  const clusters = [];
  let currentCluster = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const ev = sorted[i];
    const clusterEnd = Math.max(...currentCluster.map(e => new Date(e.end_at).getTime()));
    const evStart = new Date(ev.start_at).getTime();
    if (evStart < clusterEnd) {
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
    const columns = []; // each column's last end time
    const eventCols = new Map();

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
      eventCols.set(ev, assignedCol);
    });

    const numCols = columns.length;
    const colWidth = dayWidth / numCols;

    cluster.forEach(ev => {
      const col = eventCols.get(ev);
      const left = col * colWidth;
      const width = colWidth;

      const start = new Date(ev.start_at);
      const end = new Date(ev.end_at);

      // Clamp to day
      const dayStart = new Date(start);
      dayStart.setHours(0, 0, 0, 0);
      const minutesFromMidnightStart = Math.max(0, 
        (start - dayStart) / (1000 * 60)
      );
      const minutesFromMidnightEnd = Math.min(24 * 60, 
        (end - dayStart) / (1000 * 60)
      );

      const top = (minutesFromMidnightStart / 60) * HOUR_HEIGHT;
      const height = Math.max(20, ((minutesFromMidnightEnd - minutesFromMidnightStart) / 60) * HOUR_HEIGHT);

      layouts.push({
        event: ev,
        top,
        height,
        left,
        width,
        col,
        numCols
      });
    });
  });

  return layouts;
}

function renderEvents(weekStart, allEvents) {
  const container = document.getElementById('days-container');
  const dayColumns = container.querySelectorAll('.day-column');

  // Clear existing events
  dayColumns.forEach(col => {
    const existingEvents = col.querySelectorAll('.event');
    existingEvents.forEach(el => el.remove());
  });

  const dayWidth = container.offsetWidth / 7;

  for (let i = 0; i < 7; i++) {
    const dayDate = addDays(weekStart, i);
    const dayCol = dayColumns[i];
    const eventsForDay = getEventsForDay(dayDate, allEvents);

    const layouts = computeLayout(eventsForDay, dayWidth);

    layouts.forEach(layout => {
      const evEl = document.createElement('div');
      evEl.className = 'event';
      evEl.style.top = `${layout.top}px`;
      evEl.style.height = `${layout.height}px`;
      evEl.style.left = `${layout.left}px`;
      evEl.style.width = `${layout.width - 2}px`; // small gap

      const start = new Date(layout.event.start_at);
      const end = new Date(layout.event.end_at);

      evEl.innerHTML = `
        <div class="event-title">${layout.event.title}</div>
        <div class="event-time">${formatTime(start)} - ${formatTime(end)}</div>
      `;

      evEl.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditModal(layout.event);
      });

      dayCol.appendChild(evEl);
    });
  }
}

function updateWeekRangeDisplay(weekStart) {
  const end = addDays(weekStart, 6);
  const rangeEl = document.getElementById('week-range');
  rangeEl.textContent = `${weekStart.toLocaleDateString()} - ${end.toLocaleDateString()}`;
}

async function loadAndRenderWeek(weekStart) {
  currentWeekStart = weekStart;
  const { end } = getWeekRange(weekStart);

  try {
    events = await fetchEvents(weekStart, end);
    updateWeekRangeDisplay(weekStart);
    renderDayHeaders(weekStart);
    renderEvents(weekStart, events);
  } catch (err) {
    console.error(err);
    alert('Failed to load events');
  }
}

function openCreateModal(startTime, endTime) {
  const modal = document.getElementById('modal');
  const form = document.getElementById('event-form');
  const titleEl = document.getElementById('modal-title');
  const deleteBtn = document.getElementById('delete-btn');
  const idEl = document.getElementById('event-id');

  titleEl.textContent = 'Create Event';
  deleteBtn.classList.add('hidden');
  idEl.value = '';

  document.getElementById('title').value = '';
  document.getElementById('start').value = startTime.toISOString().slice(0, 16);
  document.getElementById('end').value = endTime.toISOString().slice(0, 16);

  modal.classList.remove('hidden');

  form.onsubmit = async (e) => {
    e.preventDefault();
    await createEvent();
  };
}

async function createEvent() {
  const title = document.getElementById('title').value;
  const start = document.getElementById('start').value;
  const end = document.getElementById('end').value;

  try {
    const res = await fetch(`${API_BASE}/events`, {
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
    await loadAndRenderWeek(currentWeekStart);
  } catch (err) {
    alert('Error creating event');
  }
}

function openEditModal(event) {
  const modal = document.getElementById('modal');
  const form = document.getElementById('event-form');
  const titleEl = document.getElementById('modal-title');
  const deleteBtn = document.getElementById('delete-btn');
  const idEl = document.getElementById('event-id');

  titleEl.textContent = 'Edit Event';
  deleteBtn.classList.remove('hidden');
  idEl.value = event.id;

  document.getElementById('title').value = event.title;
  document.getElementById('start').value = new Date(event.start_at).toISOString().slice(0, 16);
  document.getElementById('end').value = new Date(event.end_at).toISOString().slice(0, 16);

  modal.classList.remove('hidden');

  form.onsubmit = async (e) => {
    e.preventDefault();
    await updateEvent();
  };

  deleteBtn.onclick = async () => {
    if (confirm('Delete this event?')) {
      await deleteEvent(event.id);
    }
  };
}

async function updateEvent() {
  const id = document.getElementById('event-id').value;
  const title = document.getElementById('title').value;
  const start = document.getElementById('start').value;
  const end = document.getElementById('end').value;

  try {
    const res = await fetch(`${API_BASE}/events/${id}`, {
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
    await loadAndRenderWeek(currentWeekStart);
  } catch (err) {
    alert('Error updating event');
  }
}

async function deleteEvent(id) {
  try {
    const res = await fetch(`${API_BASE}/events/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      alert('Failed to delete');
      return;
    }
    closeModal();
    await loadAndRenderWeek(currentWeekStart);
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

function setupNavigation() {
  document.getElementById('prev-week').addEventListener('click', () => {
    const newStart = addDays(currentWeekStart, -7);
    loadAndRenderWeek(newStart);
  });

  document.getElementById('today').addEventListener('click', () => {
    loadAndRenderWeek(getMonday(new Date()));
  });

  document.getElementById('next-week').addEventListener('click', () => {
    const newStart = addDays(currentWeekStart, 7);
    loadAndRenderWeek(newStart);
  });

  // Close modal on outside click
  document.getElementById('modal').addEventListener('click', (e) => {
    if (e.target.id === 'modal') {
      closeModal();
    }
  });

  document.getElementById('cancel-btn').addEventListener('click', closeModal);
}

async function init() {
  renderTimeAxis();
  setupNavigation();
  await loadAndRenderWeek(currentWeekStart);
}

init();