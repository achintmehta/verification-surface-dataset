const API_URL = 'http://localhost:3000/api/events';

// Constants
const PIXELS_PER_MINUTE = 1;
const HOUR_HEIGHT = 60 * PIXELS_PER_MINUTE;
const DAY_HEIGHT = 24 * HOUR_HEIGHT;

// State
let currentDate = new Date();
let events = [];

// DOM Elements
const timeAxis = document.getElementById('time-axis');
const daysContainer = document.getElementById('days-container');
const currentMonthYear = document.getElementById('current-month-year');
const prevWeekBtn = document.getElementById('prev-week');
const todayBtn = document.getElementById('today');
const nextWeekBtn = document.getElementById('next-week');

const modal = document.getElementById('event-modal');
const modalTitle = document.getElementById('modal-title');
const eventForm = document.getElementById('event-form');
const eventIdInput = document.getElementById('event-id');
const eventTitleInput = document.getElementById('event-title');
const eventStartInput = document.getElementById('event-start');
const eventEndInput = document.getElementById('event-end');
const deleteBtn = document.getElementById('delete-btn');
const cancelBtn = document.getElementById('cancel-btn');

// Initialization
function init() {
  setupEventListeners();
  renderTimeAxis();
  renderWeek();
}

function setupEventListeners() {
  prevWeekBtn.addEventListener('click', () => {
    currentDate.setDate(currentDate.getDate() - 7);
    renderWeek();
  });

  todayBtn.addEventListener('click', () => {
    currentDate = new Date();
    renderWeek();
  });

  nextWeekBtn.addEventListener('click', () => {
    currentDate.setDate(currentDate.getDate() + 7);
    renderWeek();
  });

  cancelBtn.addEventListener('click', closeModal);

  eventForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = eventIdInput.value;
    const title = eventTitleInput.value;
    const start_at = new Date(eventStartInput.value).toISOString();
    const end_at = new Date(eventEndInput.value).toISOString();

    const payload = { title, start_at, end_at };

    try {
      let res;
      if (id) {
        res = await fetch(`${API_URL}/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      } else {
        res = await fetch(API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      }
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || 'Error saving event');
        return;
      }
      closeModal();
      fetchEventsAndRender();
    } catch (err) {
      alert('Error saving event');
    }
  });

  deleteBtn.addEventListener('click', async () => {
    const id = eventIdInput.value;
    if (id) {
      try {
        const res = await fetch(`${API_URL}/${id}`, { method: 'DELETE' });
        if (!res.ok) {
          const err = await res.json();
          alert(err.error || 'Error deleting event');
          return;
        }
        closeModal();
        fetchEventsAndRender();
      } catch (err) {
        alert('Error deleting event');
      }
    }
  });
}

function getStartOfWeek(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // adjust when day is sunday
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function renderTimeAxis() {
  timeAxis.innerHTML = '';
  // Add a spacer for the header
  const headerSpacer = document.createElement('div');
  headerSpacer.style.height = '60px'; // Fixed header height
  headerSpacer.style.position = 'sticky';
  headerSpacer.style.top = '0';
  headerSpacer.style.background = '#fafafa';
  headerSpacer.style.zIndex = '30';
  headerSpacer.style.borderBottom = '1px solid #ccc';
  timeAxis.appendChild(headerSpacer);

  const axisGrid = document.createElement('div');
  axisGrid.style.position = 'relative';
  axisGrid.style.height = `${DAY_HEIGHT}px`;

  for (let i = 0; i <= 24; i++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = `${i * HOUR_HEIGHT}px`;
    label.textContent = `${i.toString().padStart(2, '0')}:00`;
    axisGrid.appendChild(label);
  }
  timeAxis.appendChild(axisGrid);
}

async function renderWeek() {
  const startOfWeek = getStartOfWeek(currentDate);
  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(endOfWeek.getDate() + 7);

  currentMonthYear.textContent = `${startOfWeek.toLocaleString('default', { month: 'long' })} ${startOfWeek.getFullYear()}`;

  daysContainer.innerHTML = '';

  for (let i = 0; i < 7; i++) {
    const dayDate = new Date(startOfWeek);
    dayDate.setDate(dayDate.getDate() + i);

    const col = document.createElement('div');
    col.className = 'day-column';
    col.dataset.date = dayDate.toISOString();

    const header = document.createElement('div');
    header.className = 'day-header';
    const isToday = dayDate.toDateString() === new Date().toDateString();
    if (isToday) {
      header.classList.add('today');
      col.classList.add('today');
    }
    
    const dayName = dayDate.toLocaleString('default', { weekday: 'short' });
    const dayNum = dayDate.getDate();
    header.innerHTML = `<div>${dayName}</div><div>${dayNum}</div>`;
    col.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'day-grid';
    grid.style.height = `${DAY_HEIGHT}px`;

    // Hour lines
    for (let h = 0; h <= 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${h * HOUR_HEIGHT}px`;
      grid.appendChild(line);
    }

    // Click to create
    grid.addEventListener('mousedown', (e) => {
      if (e.target !== grid && !e.target.classList.contains('hour-line')) return;
      
      const rect = grid.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const minutes = Math.floor(y / PIXELS_PER_MINUTE);
      
      // Snap to 30 mins
      const snappedMinutes = Math.floor(minutes / 30) * 30;
      
      const start = new Date(dayDate);
      start.setHours(0, snappedMinutes, 0, 0);
      
      const end = new Date(start);
      end.setMinutes(end.getMinutes() + 60); // Default 1 hour

      openModal(null, start, end);
    });

    col.appendChild(grid);
    daysContainer.appendChild(col);
  }

  await fetchEventsAndRender();
}

async function fetchEventsAndRender() {
  const startOfWeek = getStartOfWeek(currentDate);
  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(endOfWeek.getDate() + 7);

  try {
    const res = await fetch(`${API_URL}?start=${startOfWeek.toISOString()}&end=${endOfWeek.toISOString()}`);
    events = await res.json();
    renderEvents();
  } catch (err) {
    console.error('Failed to fetch events', err);
  }
}

function renderEvents() {
  // Clear existing events
  document.querySelectorAll('.event-block').forEach(el => el.remove());

  const startOfWeek = getStartOfWeek(currentDate);

  // Group events by day
  const eventsByDay = Array.from({ length: 7 }, () => []);

  events.forEach(event => {
    const start = new Date(event.start_at);
    const end = new Date(event.end_at);
    
    // Find which days this event spans
    for (let i = 0; i < 7; i++) {
      const dayStart = new Date(startOfWeek);
      dayStart.setDate(dayStart.getDate() + i);
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1);

      if (start < dayEnd && end > dayStart) {
        eventsByDay[i].push({
          ...event,
          start: new Date(Math.max(start, dayStart)),
          end: new Date(Math.min(end, dayEnd))
        });
      }
    }
  });

  const dayColumns = document.querySelectorAll('.day-column');

  eventsByDay.forEach((dayEvents, dayIndex) => {
    if (dayEvents.length === 0) return;

    // Sort by start time, then end time (descending)
    dayEvents.sort((a, b) => {
      if (a.start.getTime() !== b.start.getTime()) {
        return a.start.getTime() - b.start.getTime();
      }
      return b.end.getTime() - a.end.getTime();
    });

    // Cluster overlap layout
    const clusters = [];
    let currentCluster = [];
    let clusterEnd = null;

    dayEvents.forEach(event => {
      if (currentCluster.length === 0) {
        currentCluster.push(event);
        clusterEnd = event.end;
      } else {
        if (event.start < clusterEnd) {
          currentCluster.push(event);
          if (event.end > clusterEnd) {
            clusterEnd = event.end;
          }
        } else {
          clusters.push(currentCluster);
          currentCluster = [event];
          clusterEnd = event.end;
        }
      }
    });
    if (currentCluster.length > 0) {
      clusters.push(currentCluster);
    }

    const grid = dayColumns[dayIndex].querySelector('.day-grid');

    clusters.forEach(cluster => {
      const columns = [];

      cluster.forEach(event => {
        let placed = false;
        for (let i = 0; i < columns.length; i++) {
          const col = columns[i];
          const lastEvent = col[col.length - 1];
          if (lastEvent.end <= event.start) {
            col.push(event);
            event.colIndex = i;
            placed = true;
            break;
          }
        }
        if (!placed) {
          columns.push([event]);
          event.colIndex = columns.length - 1;
        }
      });

      const numColumns = columns.length;

      cluster.forEach(event => {
        const startMins = event.start.getHours() * 60 + event.start.getMinutes();
        let endMins = event.end.getHours() * 60 + event.end.getMinutes();
        if (event.end.getHours() === 0 && event.end.getMinutes() === 0 && event.end > event.start) {
          endMins = 24 * 60;
        }

        const top = startMins * PIXELS_PER_MINUTE;
        const height = (endMins - startMins) * PIXELS_PER_MINUTE;

        const width = 100 / numColumns;
        const left = event.colIndex * width;

        const block = document.createElement('div');
        block.className = 'event-block';
        block.style.top = `${top}px`;
        block.style.height = `${height}px`;
        block.style.left = `${left}%`;
        block.style.width = `${width}%`;

        const title = document.createElement('div');
        title.className = 'event-title';
        title.textContent = event.title;

        const time = document.createElement('div');
        time.className = 'event-time';
        const formatTime = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        time.textContent = `${formatTime(new Date(event.start_at))} - ${formatTime(new Date(event.end_at))}`;

        block.appendChild(title);
        block.appendChild(time);

        block.addEventListener('click', (e) => {
          e.stopPropagation();
          openModal(event);
        });

        grid.appendChild(block);
      });
    });
  });
}

function toLocalISOString(date) {
  const tzOffset = date.getTimezoneOffset() * 60000; // offset in milliseconds
  const localISOTime = (new Date(date.getTime() - tzOffset)).toISOString().slice(0, 16);
  return localISOTime;
}

function openModal(event = null, start = null, end = null) {
  modal.classList.remove('hidden');
  if (event) {
    modalTitle.textContent = 'Edit Event';
    eventIdInput.value = event.id;
    eventTitleInput.value = event.title;
    eventStartInput.value = toLocalISOString(new Date(event.start_at));
    eventEndInput.value = toLocalISOString(new Date(event.end_at));
    deleteBtn.classList.remove('hidden');
  } else {
    modalTitle.textContent = 'Create Event';
    eventIdInput.value = '';
    eventTitleInput.value = '';
    eventStartInput.value = toLocalISOString(start);
    eventEndInput.value = toLocalISOString(end);
    deleteBtn.classList.add('hidden');
  }
}

function closeModal() {
  modal.classList.add('hidden');
  eventForm.reset();
}

init();
