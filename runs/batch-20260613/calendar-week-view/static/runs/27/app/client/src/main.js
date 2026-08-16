const API_BASE = '/api';
const HOUR_HEIGHT = 25; // pixels per hour
const TOTAL_HOURS = 24;
const CALENDAR_HEIGHT = HOUR_HEIGHT * TOTAL_HOURS; // 600px

let currentWeekStart = getWeekStart(new Date());

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

function getWeekRange(start) {
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return `${start.toLocaleDateString()} - ${end.toLocaleDateString()}`;
}

async function fetchEvents(weekStart) {
  const start = new Date(weekStart);
  start.setHours(0, 0, 0, 0);
  const end = new Date(weekStart);
  end.setDate(end.getDate() + 7);
  end.setHours(0, 0, 0, 0);

  const params = new URLSearchParams({
    start: start.toISOString(),
    end: end.toISOString()
  });

  const res = await fetch(`${API_BASE}/events?${params}`);
  if (!res.ok) throw new Error('Failed to fetch events');
  return res.json();
}

function groupEventsByDay(events, weekStart) {
  const days = Array.from({ length: 7 }, (_, i) => {
    const dayDate = new Date(weekStart);
    dayDate.setDate(dayDate.getDate() + i);
    return {
      date: dayDate,
      events: []
    };
  });

  events.forEach(event => {
    const start = new Date(event.start_at);
    const end = new Date(event.end_at);
    // Find which day(s) it belongs to - clamp to week
    for (let i = 0; i < 7; i++) {
      const dayStart = new Date(days[i].date);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart);
      dayEnd.setHours(24, 0, 0, 0);

      // Check overlap with this day
      if (start < dayEnd && end > dayStart) {
        days[i].events.push({
          ...event,
          start_at: start.toISOString(),
          end_at: end.toISOString(),
          // Clamp for rendering
          renderStart: Math.max(start, dayStart),
          renderEnd: Math.min(end, dayEnd)
        });
      }
    }
  });

  return days;
}

// Cluster-based overlap layout
function computeEventLayout(dayEvents) {
  if (!dayEvents.length) return [];

  // Sort by start time
  const events = [...dayEvents].sort((a, b) => 
    new Date(a.renderStart) - new Date(b.renderStart)
  );

  // Find overlap clusters (transitive)
  const clusters = [];
  let currentCluster = [events[0]];

  for (let i = 1; i < events.length; i++) {
    const prevEnd = new Date(currentCluster[currentCluster.length - 1].renderEnd);
    const currStart = new Date(events[i].renderStart);

    // Check if overlaps with any in current cluster (transitive via chain)
    let overlapsCluster = false;
    for (const ev of currentCluster) {
      const evStart = new Date(ev.renderStart);
      const evEnd = new Date(ev.renderEnd);
      if (currStart < evEnd && new Date(events[i].renderEnd) > evStart) {
        overlapsCluster = true;
        break;
      }
    }

    if (overlapsCluster) {
      currentCluster.push(events[i]);
    } else {
      clusters.push(currentCluster);
      currentCluster = [events[i]];
    }
  }
  clusters.push(currentCluster);

  // For each cluster, assign columns greedily
  const layout = [];

  clusters.forEach(cluster => {
    // Sort cluster by start for greedy column assignment
    cluster.sort((a, b) => new Date(a.renderStart) - new Date(b.renderStart));

    const columns = []; // end time of last event in each column
    const eventColumns = new Map();

    cluster.forEach(event => {
      const start = new Date(event.renderStart);
      let assignedCol = 0;

      // Find first column where previous event ends before this starts
      for (let c = 0; c < columns.length; c++) {
        if (columns[c] <= start) {
          assignedCol = c;
          break;
        }
        assignedCol = c + 1;
      }

      if (assignedCol >= columns.length) {
        columns.push(null);
      }
      columns[assignedCol] = new Date(event.renderEnd);
      eventColumns.set(event, assignedCol);
    });

    const numCols = columns.length;
    const colWidth = 100 / numCols;

    cluster.forEach(event => {
      const colIndex = eventColumns.get(event);
      const start = new Date(event.renderStart);
      const end = new Date(event.renderEnd);

      const minutesFromMidnightStart = start.getHours() * 60 + start.getMinutes();
      const minutesFromMidnightEnd = end.getHours() * 60 + end.getMinutes();

      const top = (minutesFromMidnightStart / 60) * HOUR_HEIGHT;
      const height = ((minutesFromMidnightEnd - minutesFromMidnightStart) / 60) * HOUR_HEIGHT;

      layout.push({
        ...event,
        top: Math.max(0, top),
        height: Math.max(20, height), // min height for visibility
        left: colIndex * colWidth,
        width: colWidth,
        colIndex,
        numCols
      });
    });
  });

  return layout;
}

function renderCalendar(days, eventsLayout) {
  const container = document.getElementById('calendar-container');
  container.innerHTML = '';

  // Time axis
  const timeAxis = document.createElement('div');
  timeAxis.className = 'time-axis';

  for (let h = 0; h < 24; h++) {
    const slot = document.createElement('div');
    slot.className = 'time-slot';
    slot.style.top = `${h * HOUR_HEIGHT}px`;
    slot.textContent = `${h.toString().padStart(2, '0')}:00`;
    timeAxis.appendChild(slot);
  }
  container.appendChild(timeAxis);

  // Days header + content
  const daysWrapper = document.createElement('div');
  daysWrapper.style.display = 'flex';
  daysWrapper.style.flex = '1';
  daysWrapper.style.position = 'relative';

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  days.forEach((day, dayIndex) => {
    const dayCol = document.createElement('div');
    dayCol.className = 'day-column';
    if (day.date.getTime() === today.getTime()) {
      dayCol.classList.add('today');
    }

    // Header
    const header = document.createElement('div');
    header.className = 'day-header';
    if (day.date.getTime() === today.getTime()) header.classList.add('today');
    const dayName = day.date.toLocaleDateString('en-US', { weekday: 'short' });
    const dateNum = day.date.getDate();
    header.innerHTML = `${dayName}<br>${dateNum}`;
    dayCol.appendChild(header);

    // Content area for events and grid
    const content = document.createElement('div');
    content.className = 'day-content';
    content.style.height = `${CALENDAR_HEIGHT}px`;
    content.style.position = 'relative';

    // Hour lines
    for (let h = 0; h < 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${h * HOUR_HEIGHT}px`;
      content.appendChild(line);
    }

    // Add click/drag handlers for creating events
    setupTimeSelection(content, day.date, dayIndex);

    // Render events for this day
    const dayLayouts = eventsLayout[dayIndex] || [];
    dayLayouts.forEach(layout => {
      const eventEl = document.createElement('div');
      eventEl.className = 'event';
      eventEl.style.top = `${layout.top}px`;
      eventEl.style.height = `${layout.height}px`;
      eventEl.style.left = `${layout.left}%`;
      eventEl.style.width = `${layout.width}%`;

      const startTime = new Date(layout.start_at);
      const endTime = new Date(layout.end_at);

      eventEl.innerHTML = `
        <div class="event-title">${layout.title}</div>
        <div class="event-time">${formatTime(startTime)} - ${formatTime(endTime)}</div>
      `;

      eventEl.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditModal(layout);
      });

      content.appendChild(eventEl);
    });

    dayCol.appendChild(content);
    daysWrapper.appendChild(dayCol);
  });

  container.appendChild(daysWrapper);
}

function setupTimeSelection(contentEl, dayDate, dayIndex) {
  let isDragging = false;
  let startY = 0;
  let selectionEl = null;

  contentEl.addEventListener('mousedown', (e) => {
    if (e.target.classList.contains('event')) return;

    isDragging = true;
    startY = e.offsetY;

    // Remove previous selection if any
    if (selectionEl) selectionEl.remove();

    selectionEl = document.createElement('div');
    selectionEl.style.position = 'absolute';
    selectionEl.style.left = '0';
    selectionEl.style.right = '0';
    selectionEl.style.background = 'rgba(74, 144, 226, 0.3)';
    selectionEl.style.border = '1px solid #4a90e2';
    selectionEl.style.top = `${startY}px`;
    selectionEl.style.height = '0px';
    contentEl.appendChild(selectionEl);
  });

  contentEl.addEventListener('mousemove', (e) => {
    if (!isDragging || !selectionEl) return;

    const currentY = Math.max(0, Math.min(CALENDAR_HEIGHT, e.offsetY));
    const top = Math.min(startY, currentY);
    const height = Math.abs(currentY - startY);

    selectionEl.style.top = `${top}px`;
    selectionEl.style.height = `${height}px`;
  });

  document.addEventListener('mouseup', (e) => {
    if (!isDragging || !selectionEl) {
      isDragging = false;
      return;
    }

    const endY = Math.max(0, Math.min(CALENDAR_HEIGHT, e.offsetY || startY + 30));
    const top = Math.min(startY, endY);
    const height = Math.max(20, Math.abs(endY - startY)); // min 20px ~ 48min

    // Convert to times
    const startMinutes = Math.floor((top / HOUR_HEIGHT) * 60);
    const endMinutes = Math.floor(((top + height) / HOUR_HEIGHT) * 60);

    const startHour = Math.floor(startMinutes / 60);
    const startMin = startMinutes % 60;
    const endHour = Math.floor(endMinutes / 60);
    const endMin = endMinutes % 60;

    const startDate = new Date(dayDate);
    startDate.setHours(startHour, startMin, 0, 0);

    const endDate = new Date(dayDate);
    endDate.setHours(endHour, endMin, 0, 0);

    // Ensure end > start
    if (endDate <= startDate) {
      endDate.setHours(endDate.getHours() + 1);
    }

    selectionEl.remove();
    selectionEl = null;
    isDragging = false;

    openCreateModal(startDate, endDate);
  }, { once: true });
}

function openCreateModal(startDate, endDate) {
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
  startInput.value = startDate.toISOString().slice(0, 16);
  endInput.value = endDate.toISOString().slice(0, 16);
  deleteBtn.classList.add('hidden');

  modal.classList.remove('hidden');

  // Remove old listeners
  const newForm = form.cloneNode(true);
  form.parentNode.replaceChild(newForm, form);

  newForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    await createEvent(newForm);
  });

  document.getElementById('cancel-btn').onclick = () => modal.classList.add('hidden');
}

async function createEvent(form) {
  const title = form.querySelector('#event-title').value;
  const start = form.querySelector('#event-start').value;
  const end = form.querySelector('#event-end').value;

  try {
    const res = await fetch(`${API_BASE}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, start_at: new Date(start).toISOString(), end_at: new Date(end).toISOString() })
    });

    if (!res.ok) {
      const err = await res.json();
      alert(err.error || 'Failed to create event');
      return;
    }

    document.getElementById('event-modal').classList.add('hidden');
    await loadAndRenderWeek();
  } catch (err) {
    alert('Error creating event: ' + err.message);
  }
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
  startInput.value = new Date(event.start_at).toISOString().slice(0, 16);
  endInput.value = new Date(event.end_at).toISOString().slice(0, 16);
  deleteBtn.classList.remove('hidden');

  modal.classList.remove('hidden');

  const newForm = form.cloneNode(true);
  form.parentNode.replaceChild(newForm, form);

  newForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    await updateEvent(newForm);
  });

  document.getElementById('cancel-btn').onclick = () => modal.classList.add('hidden');
  document.getElementById('delete-btn').onclick = async () => {
    if (confirm('Delete this event?')) {
      await deleteEvent(event.id);
      modal.classList.add('hidden');
    }
  };
}

async function updateEvent(form) {
  const id = form.querySelector('#event-id').value;
  const title = form.querySelector('#event-title').value;
  const start = form.querySelector('#event-start').value;
  const end = form.querySelector('#event-end').value;

  try {
    const res = await fetch(`${API_BASE}/events/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, start_at: new Date(start).toISOString(), end_at: new Date(end).toISOString() })
    });

    if (!res.ok) {
      const err = await res.json();
      alert(err.error || 'Failed to update event');
      return;
    }

    document.getElementById('event-modal').classList.add('hidden');
    await loadAndRenderWeek();
  } catch (err) {
    alert('Error updating event');
  }
}

async function deleteEvent(id) {
  try {
    const res = await fetch(`${API_BASE}/events/${id}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 204) {
      alert('Failed to delete');
      return;
    }
    await loadAndRenderWeek();
  } catch (err) {
    alert('Error deleting event');
  }
}

async function loadAndRenderWeek() {
  try {
    const events = await fetchEvents(currentWeekStart);
    const days = groupEventsByDay(events, currentWeekStart);

    // Compute layouts per day
    const eventsLayout = days.map(day => computeEventLayout(day.events));

    renderCalendar(days, eventsLayout);

    // Update week range display
    document.getElementById('week-range').textContent = getWeekRange(currentWeekStart);
  } catch (err) {
    console.error(err);
    alert('Failed to load calendar data');
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
  setupNavigation();
  loadAndRenderWeek();
}

init();