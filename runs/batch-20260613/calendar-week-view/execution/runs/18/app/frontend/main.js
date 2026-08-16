const API_URL = 'http://localhost:3001/api/events';

let currentWeekStart = getMonday(new Date());
let events = [];

// DOM Elements
const daysHeader = document.getElementById('days-header');
const timeAxis = document.getElementById('time-axis');
const daysGrid = document.getElementById('days-grid');
const currentMonthYear = document.getElementById('current-month-year');
const prevWeekBtn = document.getElementById('prev-week');
const nextWeekBtn = document.getElementById('next-week');
const todayBtn = document.getElementById('today');

const modal = document.getElementById('event-modal');
const eventForm = document.getElementById('event-form');
const modalTitle = document.getElementById('modal-title');
const eventIdInput = document.getElementById('event-id');
const eventTitleInput = document.getElementById('event-title');
const eventStartInput = document.getElementById('event-start');
const eventEndInput = document.getElementById('event-end');
const deleteBtn = document.getElementById('delete-btn');
const cancelBtn = document.getElementById('cancel-btn');

// Constants
const MINUTES_IN_DAY = 24 * 60;
const PIXELS_PER_MINUTE = 1; // 1440px total height

// Utility: Get Monday of the week
function getMonday(d) {
  const date = new Date(d);
  const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1); // adjust when day is sunday
  date.setDate(diff);
  date.setHours(0, 0, 0, 0);
  return date;
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function formatDate(date) {
  return date.toISOString().split('T')[0];
}

function formatDateTimeLocal(date) {
  const pad = (n) => n.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Initialize
async function init() {
  setupEventListeners();
  renderGrid();
  await loadWeek();
}

function setupEventListeners() {
  prevWeekBtn.addEventListener('click', async () => {
    currentWeekStart = addDays(currentWeekStart, -7);
    await loadWeek();
  });

  nextWeekBtn.addEventListener('click', async () => {
    currentWeekStart = addDays(currentWeekStart, 7);
    await loadWeek();
  });

  todayBtn.addEventListener('click', async () => {
    currentWeekStart = getMonday(new Date());
    await loadWeek();
  });

  cancelBtn.addEventListener('click', closeModal);

  eventForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    await saveEvent();
  });

  deleteBtn.addEventListener('click', async () => {
    await deleteEvent();
  });
}

async function loadWeek() {
  updateHeader();
  renderDaysHeader();
  
  const startIso = currentWeekStart.toISOString();
  const endIso = addDays(currentWeekStart, 7).toISOString();
  
  try {
    const res = await fetch(`${API_URL}?start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}`);
    if (!res.ok) throw new Error('Failed to fetch events');
    events = await res.json();
    // Convert string dates to Date objects
    events.forEach(e => {
      e.start_at = new Date(e.start_at);
      e.end_at = new Date(e.end_at);
    });
    renderEvents();
  } catch (err) {
    console.error(err);
  }
}

function updateHeader() {
  const endOfWeek = addDays(currentWeekStart, 6);
  const options = { month: 'long', year: 'numeric' };
  let text = currentWeekStart.toLocaleDateString(undefined, options);
  if (currentWeekStart.getMonth() !== endOfWeek.getMonth()) {
    text += ' - ' + endOfWeek.toLocaleDateString(undefined, options);
  }
  currentMonthYear.textContent = text;
}

function renderDaysHeader() {
  daysHeader.innerHTML = '';
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  
  for (let i = 0; i < 7; i++) {
    const date = addDays(currentWeekStart, i);
    const div = document.createElement('div');
    div.className = 'day-header';
    if (date.getTime() === today.getTime()) {
      div.classList.add('today');
    }
    div.textContent = `${dayNames[i]} ${date.getDate()}`;
    daysHeader.appendChild(div);
  }
}

function renderGrid() {
  // Render time axis
  timeAxis.innerHTML = '';
  for (let i = 0; i < 24; i++) {
    const label = document.createElement('div');
    label.className = 'hour-label';
    label.style.top = `${i * 60}px`;
    label.textContent = `${i.toString().padStart(2, '0')}:00`;
    timeAxis.appendChild(label);
  }

  // Render days grid
  daysGrid.innerHTML = '';
  for (let i = 0; i < 7; i++) {
    const col = document.createElement('div');
    col.className = 'day-column';
    col.dataset.dayIndex = i;
    
    // Add hour lines
    for (let h = 0; h < 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${h * 60}px`;
      col.appendChild(line);
    }

    // Click to create event
    col.addEventListener('mousedown', (e) => {
      if (e.target !== col && !e.target.classList.contains('hour-line')) return;
      
      const rect = col.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const minutes = Math.floor(y / PIXELS_PER_MINUTE);
      
      // Snap to 30 mins for default creation
      const snappedMinutes = Math.floor(minutes / 30) * 30;
      
      const date = addDays(currentWeekStart, i);
      const start = new Date(date);
      start.setHours(0, snappedMinutes, 0, 0);
      
      const end = new Date(start);
      end.setMinutes(end.getMinutes() + 60); // default 1 hour
      
      openModal({ start_at: start, end_at: end });
    });

    daysGrid.appendChild(col);
  }
}

function renderEvents() {
  // Clear existing events
  document.querySelectorAll('.event').forEach(el => el.remove());

  // Group events by day
  const eventsByDay = Array.from({ length: 7 }, () => []);

  events.forEach(event => {
    // An event might span multiple days or be outside the week, but we only care about the parts within the week.
    // For simplicity, we assume events don't cross midnight as per non-goals, but we should clamp them.
    for (let i = 0; i < 7; i++) {
      const dayStart = addDays(currentWeekStart, i);
      const dayEnd = addDays(currentWeekStart, i + 1);
      
      if (event.start_at < dayEnd && event.end_at > dayStart) {
        eventsByDay[i].push(event);
      }
    }
  });

  eventsByDay.forEach((dayEvents, dayIndex) => {
    if (dayEvents.length === 0) return;

    // Sort by start time, then end time
    dayEvents.sort((a, b) => a.start_at - b.start_at || a.end_at - b.end_at);

    // Cluster overlap layout
    const clusters = [];
    let currentCluster = [];
    let clusterEnd = null;

    dayEvents.forEach(event => {
      if (currentCluster.length === 0) {
        currentCluster.push(event);
        clusterEnd = event.end_at;
      } else {
        if (event.start_at < clusterEnd) {
          currentCluster.push(event);
          if (event.end_at > clusterEnd) {
            clusterEnd = event.end_at;
          }
        } else {
          clusters.push(currentCluster);
          currentCluster = [event];
          clusterEnd = event.end_at;
        }
      }
    });
    if (currentCluster.length > 0) {
      clusters.push(currentCluster);
    }

    const colEl = daysGrid.children[dayIndex];
    const dayStart = addDays(currentWeekStart, dayIndex);
    const dayEnd = addDays(currentWeekStart, dayIndex + 1);

    clusters.forEach(cluster => {
      const columns = [];

      cluster.forEach(event => {
        let placed = false;
        for (let i = 0; i < columns.length; i++) {
          const col = columns[i];
          const lastEvent = col[col.length - 1];
          if (event.start_at >= lastEvent.end_at) {
            col.push(event);
            event._col = i;
            placed = true;
            break;
          }
        }
        if (!placed) {
          columns.push([event]);
          event._col = columns.length - 1;
        }
      });

      const numCols = columns.length;

      cluster.forEach(event => {
        // Clamp to day
        const start = new Date(Math.max(event.start_at, dayStart));
        const end = new Date(Math.min(event.end_at, dayEnd));

        const startMinutes = start.getHours() * 60 + start.getMinutes();
        const endMinutes = end.getHours() * 60 + end.getMinutes() + (end.getHours() === 0 && end > start ? 24 * 60 : 0);
        
        // If end is exactly midnight of next day, it's 24*60
        let actualEndMinutes = endMinutes;
        if (end.getTime() === dayEnd.getTime()) {
          actualEndMinutes = 24 * 60;
        } else if (end.getDate() !== start.getDate()) {
          // Crossed midnight but not exactly dayEnd? Clamp to 24*60
          actualEndMinutes = 24 * 60;
        }

        const top = startMinutes * PIXELS_PER_MINUTE;
        const height = (actualEndMinutes - startMinutes) * PIXELS_PER_MINUTE;

        const width = 100 / numCols;
        const left = event._col * width;

        const el = document.createElement('div');
        el.className = 'event';
        el.style.top = `${top}px`;
        el.style.height = `${height}px`;
        el.style.left = `${left}%`;
        el.style.width = `${width}%`;

        const titleEl = document.createElement('div');
        titleEl.className = 'event-title';
        titleEl.textContent = event.title;

        const timeEl = document.createElement('div');
        timeEl.className = 'event-time';
        const formatTime = (d, isEnd) => {
          if (isEnd && d.getHours() === 0 && d.getMinutes() === 0 && d > start) return '24:00';
          return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
        };
        timeEl.textContent = `${formatTime(start, false)} - ${formatTime(end, true)}`;

        el.appendChild(titleEl);
        el.appendChild(timeEl);

        el.addEventListener('click', (e) => {
          e.stopPropagation();
          openModal(event);
        });

        colEl.appendChild(el);
      });
    });
  });
}

function openModal(event = null) {
  modal.classList.remove('hidden');
  if (event && event.id) {
    modalTitle.textContent = 'Edit Event';
    eventIdInput.value = event.id;
    eventTitleInput.value = event.title;
    eventStartInput.value = formatDateTimeLocal(event.start_at);
    eventEndInput.value = formatDateTimeLocal(event.end_at);
    deleteBtn.classList.remove('hidden');
  } else {
    modalTitle.textContent = 'Create Event';
    eventIdInput.value = '';
    eventTitleInput.value = '';
    eventStartInput.value = event ? formatDateTimeLocal(event.start_at) : '';
    eventEndInput.value = event ? formatDateTimeLocal(event.end_at) : '';
    deleteBtn.classList.add('hidden');
  }
  eventTitleInput.focus();
}

function closeModal() {
  modal.classList.add('hidden');
  eventForm.reset();
}

async function saveEvent() {
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
      alert(err.error || 'Failed to save event');
      return;
    }

    closeModal();
    await loadWeek();
  } catch (err) {
    console.error(err);
    alert('An error occurred');
  }
}

async function deleteEvent() {
  const id = eventIdInput.value;
  if (!id) return;

  if (!confirm('Are you sure you want to delete this event?')) return;

  try {
    const res = await fetch(`${API_URL}/${id}`, {
      method: 'DELETE'
    });

    if (!res.ok) {
      const err = await res.json();
      alert(err.error || 'Failed to delete event');
      return;
    }

    closeModal();
    await loadWeek();
  } catch (err) {
    console.error(err);
    alert('An error occurred');
  }
}

init();
