const API_BASE = '/api';

let currentWeekStart = getStartOfWeek(new Date());
let events = [];

const HOUR_HEIGHT = 60; // pixels per hour
const DAY_START_OFFSET = 50; // pixels for day header

function getStartOfWeek(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // adjust when day is sunday
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function formatTime(date) {
  return date.toTimeString().substring(0, 5);
}

function toLocalISOString(date) {
  const tzOffset = date.getTimezoneOffset() * 60000;
  return (new Date(date.getTime() - tzOffset)).toISOString().slice(0, 16);
}

async function fetchEvents() {
  const start = currentWeekStart.toISOString();
  const end = addDays(currentWeekStart, 7).toISOString();
  const res = await fetch(`${API_BASE}/events?start=${start}&end=${end}`);
  if (!res.ok) throw new Error('Failed to fetch events');
  const data = await res.json();
  events = data.map(e => ({
    ...e,
    start_at: new Date(e.start_at),
    end_at: new Date(e.end_at)
  }));
  render();
}

async function saveEvent(eventData) {
  const method = eventData.id ? 'PUT' : 'POST';
  const url = eventData.id ? `${API_BASE}/events/${eventData.id}` : `${API_BASE}/events`;
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(eventData)
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to save event');
  }
  await fetchEvents();
}

async function deleteEvent(id) {
  const res = await fetch(`${API_BASE}/events/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete event');
  await fetchEvents();
}

function renderTimeAxis() {
  const axis = document.getElementById('time-axis');
  axis.innerHTML = '';
  // Add empty space for header
  const headerSpace = document.createElement('div');
  headerSpace.style.height = `${DAY_START_OFFSET}px`;
  axis.appendChild(headerSpace);

  for (let i = 0; i <= 24; i++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = `${DAY_START_OFFSET + i * HOUR_HEIGHT}px`;
    label.textContent = `${i.toString().padStart(2, '0')}:00`;
    axis.appendChild(label);
  }
}

function renderWeekGrid() {
  const grid = document.getElementById('week-grid');
  grid.innerHTML = '';

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 0; i < 7; i++) {
    const dayDate = addDays(currentWeekStart, i);
    const col = document.createElement('div');
    col.className = 'day-column';
    col.dataset.date = dayDate.toISOString();

    const header = document.createElement('div');
    header.className = 'day-header';
    if (dayDate.getTime() === today.getTime()) {
      header.classList.add('today');
    }
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    header.innerHTML = `<div>${dayNames[dayDate.getDay()]}</div><div>${dayDate.getDate()}</div>`;
    col.appendChild(header);

    // Hour lines
    for (let h = 0; h <= 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${DAY_START_OFFSET + h * HOUR_HEIGHT}px`;
      col.appendChild(line);
    }

    // Click to create event
    col.addEventListener('mousedown', (e) => {
      if (e.target !== col && !e.target.classList.contains('hour-line')) return;
      const rect = col.getBoundingClientRect();
      const y = e.clientY - rect.top + col.scrollTop;
      if (y < DAY_START_OFFSET) return;
      
      const minutes = ((y - DAY_START_OFFSET) / HOUR_HEIGHT) * 60;
      const start = new Date(dayDate);
      start.setMinutes(Math.floor(minutes / 30) * 30); // snap to 30 mins
      const end = new Date(start);
      end.setHours(end.getHours() + 1);

      openModal({ start_at: start, end_at: end });
    });

    grid.appendChild(col);
  }

  renderEvents();
}

function getMinutesFromMidnight(date, dayStart) {
  if (date <= dayStart) return 0;
  const dayEnd = addDays(dayStart, 1);
  if (date >= dayEnd) return 24 * 60;
  return date.getHours() * 60 + date.getMinutes();
}

function renderEvents() {
  const cols = document.querySelectorAll('.day-column');
  const eventsByDay = Array.from({ length: 7 }, () => []);

  events.forEach(event => {
    // Find which day(s) this event belongs to
    for (let i = 0; i < 7; i++) {
      const dayStart = addDays(currentWeekStart, i);
      const dayEnd = addDays(dayStart, 1);
      if (event.start_at < dayEnd && event.end_at > dayStart) {
        eventsByDay[i].push(event);
      }
    }
  });

  eventsByDay.forEach((dayEvents, dayIndex) => {
    const col = cols[dayIndex];
    const dayStart = addDays(currentWeekStart, dayIndex);
    const dayEnd = addDays(dayStart, 1);

    // Sort by start time, then end time
    dayEvents.sort((a, b) => {
      const aStart = Math.max(a.start_at.getTime(), dayStart.getTime());
      const bStart = Math.max(b.start_at.getTime(), dayStart.getTime());
      if (aStart !== bStart) {
        return aStart - bStart;
      }
      const aEnd = Math.min(a.end_at.getTime(), dayEnd.getTime());
      const bEnd = Math.min(b.end_at.getTime(), dayEnd.getTime());
      return bEnd - aEnd;
    });

    // Cluster overlap layout
    const clusters = [];
    let currentCluster = [];
    let clusterEnd = null;

    dayEvents.forEach(event => {
      const evStart = Math.max(event.start_at.getTime(), dayStart.getTime());
      if (clusterEnd === null || evStart < clusterEnd) {
        currentCluster.push(event);
        const evEnd = Math.min(event.end_at.getTime(), dayEnd.getTime());
        clusterEnd = clusterEnd === null ? evEnd : Math.max(clusterEnd, evEnd);
      } else {
        clusters.push(currentCluster);
        currentCluster = [event];
        clusterEnd = Math.min(event.end_at.getTime(), dayEnd.getTime());
      }
    });
    if (currentCluster.length > 0) {
      clusters.push(currentCluster);
    }

    clusters.forEach(cluster => {
      const columns = [];
      cluster.forEach(event => {
        let placed = false;
        const evStart = Math.max(event.start_at.getTime(), dayStart.getTime());
        for (let i = 0; i < columns.length; i++) {
          const lastEventInCol = columns[i][columns[i].length - 1];
          const lastEvEnd = Math.min(lastEventInCol.end_at.getTime(), dayEnd.getTime());
          if (lastEvEnd <= evStart) {
            columns[i].push(event);
            event._col = i;
            placed = true;
            break;
          }
        }
        if (!placed) {
          event._col = columns.length;
          columns.push([event]);
        }
      });

      const numCols = columns.length;
      cluster.forEach(event => {
        const startMins = getMinutesFromMidnight(event.start_at, dayStart);
        const endMins = getMinutesFromMidnight(event.end_at, dayStart);
        
        const top = DAY_START_OFFSET + (startMins / 60) * HOUR_HEIGHT;
        const height = ((endMins - startMins) / 60) * HOUR_HEIGHT;

        const block = document.createElement('div');
        block.className = 'event-block';
        block.style.top = `${top}px`;
        block.style.height = `${height}px`;
        block.style.left = `${(event._col / numCols) * 100}%`;
        block.style.width = `${(1 / numCols) * 100}%`;

        block.innerHTML = `
          <div class="event-title">${event.title}</div>
          <div class="event-time">${formatTime(event.start_at)} - ${formatTime(event.end_at)}</div>
        `;

        block.addEventListener('click', (e) => {
          e.stopPropagation();
          openModal(event);
        });

        col.appendChild(block);
      });
    });
  });
}

function updateHeader() {
  const endOfWeek = addDays(currentWeekStart, 6);
  document.getElementById('current-week-label').textContent = 
    `${currentWeekStart.toDateString()} - ${endOfWeek.toDateString()}`;
}

function render() {
  updateHeader();
  renderTimeAxis();
  renderWeekGrid();
}

// Modal logic
const modal = document.getElementById('event-modal');
const form = document.getElementById('event-form');
const titleInput = document.getElementById('event-title');
const startInput = document.getElementById('event-start');
const endInput = document.getElementById('event-end');
const idInput = document.getElementById('event-id');
const deleteBtn = document.getElementById('delete-btn');
const cancelBtn = document.getElementById('cancel-btn');

function openModal(event = null) {
  if (event && event.id) {
    document.getElementById('modal-title').textContent = 'Edit Event';
    idInput.value = event.id;
    titleInput.value = event.title;
    startInput.value = toLocalISOString(event.start_at);
    endInput.value = toLocalISOString(event.end_at);
    deleteBtn.classList.remove('hidden');
  } else {
    document.getElementById('modal-title').textContent = 'Create Event';
    idInput.value = '';
    titleInput.value = '';
    if (event && event.start_at && event.end_at) {
      startInput.value = toLocalISOString(event.start_at);
      endInput.value = toLocalISOString(event.end_at);
    } else {
      const now = new Date();
      now.setMinutes(0, 0, 0);
      startInput.value = toLocalISOString(now);
      now.setHours(now.getHours() + 1);
      endInput.value = toLocalISOString(now);
    }
    deleteBtn.classList.add('hidden');
  }
  modal.classList.remove('hidden');
  titleInput.focus();
}

function closeModal() {
  modal.classList.add('hidden');
  form.reset();
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const eventData = {
    title: titleInput.value,
    start_at: new Date(startInput.value).toISOString(),
    end_at: new Date(endInput.value).toISOString()
  };
  if (idInput.value) {
    eventData.id = idInput.value;
  }
  try {
    await saveEvent(eventData);
    closeModal();
  } catch (err) {
    alert(err.message);
  }
});

deleteBtn.addEventListener('click', async () => {
  if (idInput.value && confirm('Delete this event?')) {
    try {
      await deleteEvent(idInput.value);
      closeModal();
    } catch (err) {
      alert(err.message);
    }
  }
});

cancelBtn.addEventListener('click', closeModal);

// Navigation
document.getElementById('prev-week').addEventListener('click', () => {
  currentWeekStart = addDays(currentWeekStart, -7);
  fetchEvents();
});

document.getElementById('next-week').addEventListener('click', () => {
  currentWeekStart = addDays(currentWeekStart, 7);
  fetchEvents();
});

document.getElementById('today').addEventListener('click', () => {
  currentWeekStart = getStartOfWeek(new Date());
  fetchEvents();
});

// Init
render();
fetchEvents();
