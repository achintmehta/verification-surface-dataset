const API_URL = '/api/events';
const PIXELS_PER_MINUTE = 1;
const DAY_START_HOUR = 0;
const DAY_END_HOUR = 24;
const HEADER_HEIGHT = 40;

let currentWeekStart = getMonday(new Date());
let events = [];

// DOM Elements
const prevWeekBtn = document.getElementById('prev-week');
const nextWeekBtn = document.getElementById('next-week');
const todayBtn = document.getElementById('today');
const currentWeekLabel = document.getElementById('current-week-label');
const timeAxis = document.getElementById('time-axis');
const daysGrid = document.getElementById('days-grid');

const modal = document.getElementById('event-modal');
const modalTitle = document.getElementById('modal-title');
const eventForm = document.getElementById('event-form');
const eventIdInput = document.getElementById('event-id');
const eventTitleInput = document.getElementById('event-title');
const eventStartInput = document.getElementById('event-start');
const eventEndInput = document.getElementById('event-end');
const deleteBtn = document.getElementById('delete-btn');
const cancelBtn = document.getElementById('cancel-btn');

// Utility functions
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
  const tzOffset = date.getTimezoneOffset() * 60000;
  const localISOTime = (new Date(date.getTime() - tzOffset)).toISOString().slice(0, 16);
  return localISOTime;
}

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Initialization
async function init() {
  setupEventListeners();
  renderTimeAxis();
  await loadWeek();
}

function setupEventListeners() {
  prevWeekBtn.addEventListener('click', () => {
    currentWeekStart = addDays(currentWeekStart, -7);
    loadWeek();
  });
  
  nextWeekBtn.addEventListener('click', () => {
    currentWeekStart = addDays(currentWeekStart, 7);
    loadWeek();
  });
  
  todayBtn.addEventListener('click', () => {
    currentWeekStart = getMonday(new Date());
    loadWeek();
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
  const weekEnd = addDays(currentWeekStart, 7);
  currentWeekLabel.textContent = `${currentWeekStart.toLocaleDateString()} - ${addDays(currentWeekStart, 6).toLocaleDateString()}`;
  
  try {
    const res = await fetch(`${API_URL}?start=${currentWeekStart.toISOString()}&end=${weekEnd.toISOString()}`);
    if (!res.ok) throw new Error('Failed to fetch events');
    events = await res.json();
    events.forEach(e => {
      e.start_at = new Date(e.start_at);
      e.end_at = new Date(e.end_at);
    });
    renderGrid();
  } catch (err) {
    console.error(err);
  }
}

function renderTimeAxis() {
  timeAxis.innerHTML = '';
  // Add empty space for header
  const headerSpace = document.createElement('div');
  headerSpace.style.height = `${HEADER_HEIGHT}px`;
  timeAxis.appendChild(headerSpace);

  for (let i = DAY_START_HOUR; i <= DAY_END_HOUR; i++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.textContent = `${i.toString().padStart(2, '0')}:00`;
    label.style.top = `${HEADER_HEIGHT + i * 60 * PIXELS_PER_MINUTE}px`;
    timeAxis.appendChild(label);
  }
}

function renderGrid() {
  daysGrid.innerHTML = '';
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 0; i < 7; i++) {
    const currentDay = addDays(currentWeekStart, i);
    const isToday = currentDay.getTime() === today.getTime();
    
    const dayCol = document.createElement('div');
    dayCol.className = 'day-column';
    
    const header = document.createElement('div');
    header.className = `day-header ${isToday ? 'today' : ''}`;
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    header.textContent = `${dayNames[currentDay.getDay()]} ${currentDay.getDate()}`;
    dayCol.appendChild(header);

    const content = document.createElement('div');
    content.className = 'day-content';
    content.style.height = `${24 * 60 * PIXELS_PER_MINUTE}px`;
    
    // Add hour lines
    for (let h = DAY_START_HOUR; h <= DAY_END_HOUR; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${h * 60 * PIXELS_PER_MINUTE}px`;
      content.appendChild(line);
    }

    // Handle click to create event
    content.addEventListener('mousedown', (e) => {
      if (e.target !== content && !e.target.classList.contains('hour-line')) return;
      
      const rect = content.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const minutes = Math.floor(y / PIXELS_PER_MINUTE);
      
      const start = new Date(currentDay);
      start.setHours(0, minutes, 0, 0);
      
      const end = new Date(start);
      end.setHours(start.getHours() + 1); // Default 1 hour duration
      
      openModal({ start_at: start, end_at: end });
    });

    // Filter events for this day
    const dayStart = new Date(currentDay);
    const dayEnd = addDays(currentDay, 1);
    
    const dayEvents = events.filter(e => e.start_at < dayEnd && e.end_at > dayStart);
    
    renderEvents(content, dayEvents, dayStart);
    
    dayCol.appendChild(content);
    daysGrid.appendChild(dayCol);
  }
}

function renderEvents(container, dayEvents, dayStart) {
  // Sort events by start time, then by end time (descending)
  dayEvents.sort((a, b) => {
    if (a.start_at.getTime() !== b.start_at.getTime()) {
      return a.start_at.getTime() - b.start_at.getTime();
    }
    return b.end_at.getTime() - a.end_at.getTime();
  });

  // Cluster overlapping events
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

  // Layout each cluster
  clusters.forEach(cluster => {
    const columns = [];
    
    cluster.forEach(event => {
      let placed = false;
      for (let i = 0; i < columns.length; i++) {
        const col = columns[i];
        const lastEvent = col[col.length - 1];
        if (lastEvent.end_at <= event.start_at) {
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
      const el = document.createElement('div');
      el.className = 'event-block';
      
      // Calculate top and height
      let startMins = (event.start_at.getTime() - dayStart.getTime()) / 60000;
      let endMins = (event.end_at.getTime() - dayStart.getTime()) / 60000;
      
      // Clamp to day
      if (startMins < 0) startMins = 0;
      if (endMins > 24 * 60) endMins = 24 * 60;
      
      const top = startMins * PIXELS_PER_MINUTE;
      const height = (endMins - startMins) * PIXELS_PER_MINUTE;
      
      el.style.top = `${top}px`;
      el.style.height = `${height}px`;
      
      // Calculate width and left
      const width = 100 / numCols;
      const left = event._col * width;
      
      el.style.width = `${width}%`;
      el.style.left = `${left}%`;
      
      el.innerHTML = `
        <div class="event-title">${escapeHtml(event.title)}</div>
        <div class="event-time">${formatTime(event.start_at)} - ${formatTime(event.end_at)}</div>
      `;
      
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        openModal(event);
      });
      
      container.appendChild(el);
    });
  });
}

function escapeHtml(unsafe) {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
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
    if (event && event.start_at && event.end_at) {
      eventStartInput.value = formatDateTimeLocal(event.start_at);
      eventEndInput.value = formatDateTimeLocal(event.end_at);
    } else {
      const now = new Date();
      now.setMinutes(0, 0, 0);
      const end = new Date(now);
      end.setHours(now.getHours() + 1);
      eventStartInput.value = formatDateTimeLocal(now);
      eventEndInput.value = formatDateTimeLocal(end);
    }
    deleteBtn.classList.add('hidden');
  }
}

function closeModal() {
  modal.classList.add('hidden');
  eventForm.reset();
}

async function saveEvent() {
  const id = eventIdInput.value;
  const title = eventTitleInput.value;
  const start_at = new Date(eventStartInput.value);
  const end_at = new Date(eventEndInput.value);
  
  if (end_at <= start_at) {
    alert('End time must be after start time');
    return;
  }
  
  const payload = { title, start_at: start_at.toISOString(), end_at: end_at.toISOString() };
  
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
      throw new Error(err.error || 'Failed to save event');
    }
    
    closeModal();
    await loadWeek();
  } catch (err) {
    alert(err.message);
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
    
    if (!res.ok) throw new Error('Failed to delete event');
    
    closeModal();
    await loadWeek();
  } catch (err) {
    alert(err.message);
  }
}

init();
