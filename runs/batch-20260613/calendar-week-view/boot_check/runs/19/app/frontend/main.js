const API_URL = 'http://localhost:3001/api/events';
const PIXELS_PER_MINUTE = 1; // 60px per hour
const HEADER_HEIGHT = 40;

let currentWeekStart = getStartOfWeek(new Date());
let events = [];

// DOM Elements
const timeAxis = document.getElementById('time-axis');
const weekGrid = document.getElementById('week-grid');
const currentWeekLabel = document.getElementById('current-week-label');
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

// Initialization
function init() {
  renderTimeAxis();
  setupEventListeners();
  loadWeek();
}

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

function formatDate(date) {
  return date.toISOString().split('T')[0];
}

function formatDateTimeLocal(date) {
  const d = new Date(date);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function renderTimeAxis() {
  timeAxis.innerHTML = '';
  // Add empty space for header
  const headerSpace = document.createElement('div');
  headerSpace.style.height = `${HEADER_HEIGHT}px`;
  timeAxis.appendChild(headerSpace);

  for (let i = 0; i <= 24; i++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = `${HEADER_HEIGHT + i * 60}px`;
    label.textContent = `${i.toString().padStart(2, '0')}:00`;
    timeAxis.appendChild(label);
  }
}

async function loadWeek() {
  const endOfWeek = addDays(currentWeekStart, 7);
  currentWeekLabel.textContent = `${currentWeekStart.toLocaleDateString()} - ${addDays(currentWeekStart, 6).toLocaleDateString()}`;
  
  try {
    const res = await fetch(`${API_URL}?start=${currentWeekStart.toISOString()}&end=${endOfWeek.toISOString()}`);
    events = await res.json();
    renderWeek();
  } catch (err) {
    console.error('Failed to load events', err);
  }
}

function renderWeek() {
  weekGrid.innerHTML = '';
  
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
    // Monday is 1, Sunday is 0. We want Monday to Sunday.
    // Wait, getStartOfWeek sets to Monday.
    // So i=0 is Monday.
    header.textContent = `${dayNames[currentDay.getDay()]} ${currentDay.getDate()}`;
    dayCol.appendChild(header);

    const content = document.createElement('div');
    content.className = 'day-content';
    
    // Add hour lines
    for (let h = 0; h <= 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${h * 60}px`;
      content.appendChild(line);
    }

    // Handle clicks on empty space to create event
    content.addEventListener('click', (e) => {
      if (e.target !== content && !e.target.classList.contains('hour-line')) return;
      const rect = content.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const minutes = Math.floor(y / PIXELS_PER_MINUTE);
      
      const start = new Date(currentDay);
      start.setMinutes(minutes);
      const end = new Date(start);
      end.setHours(end.getHours() + 1);
      
      openModal(null, start, end);
    });

    // Filter events for this day
    const dayStart = currentDay.getTime();
    const dayEnd = dayStart + 24 * 60 * 60 * 1000;
    
    const dayEvents = events.filter(e => {
      const eStart = new Date(e.start_at).getTime();
      const eEnd = new Date(e.end_at).getTime();
      return eStart < dayEnd && eEnd > dayStart;
    }).map(e => {
      const eStart = new Date(e.start_at);
      const eEnd = new Date(e.end_at);
      
      // Clamp to day boundaries
      const start = eStart.getTime() < dayStart ? new Date(dayStart) : eStart;
      const end = eEnd.getTime() > dayEnd ? new Date(dayEnd) : eEnd;
      
      return { ...e, start, end, originalStart: eStart, originalEnd: eEnd };
    });

    // Layout algorithm
    const laidOutEvents = layoutEvents(dayEvents);
    
    laidOutEvents.forEach(e => {
      const startMins = e.start.getHours() * 60 + e.start.getMinutes();
      let endMins = e.end.getHours() * 60 + e.end.getMinutes();
      
      // If end is exactly midnight of next day, it's 24*60 minutes
      if (e.end.getTime() === dayEnd) {
        endMins = 24 * 60;
      }

      const durationMins = endMins - startMins;

      const block = document.createElement('div');
      block.className = 'event-block';
      block.style.top = `${startMins * PIXELS_PER_MINUTE}px`;
      block.style.height = `${durationMins * PIXELS_PER_MINUTE}px`;
      block.style.left = `${(e.col / e.maxCols) * 100}%`;
      block.style.width = `${(1 / e.maxCols) * 100}%`;
      
      const title = document.createElement('div');
      title.className = 'event-title';
      title.textContent = e.title;
      
      const time = document.createElement('div');
      time.className = 'event-time';
      time.textContent = `${formatTime(e.originalStart)} - ${formatTime(e.originalEnd)}`;
      
      block.appendChild(title);
      block.appendChild(time);
      
      block.addEventListener('click', (ev) => {
        ev.stopPropagation();
        openModal(e);
      });
      
      content.appendChild(block);
    });

    dayCol.appendChild(content);
    weekGrid.appendChild(dayCol);
  }
}

function formatTime(date) {
  return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
}

function layoutEvents(events) {
  if (events.length === 0) return [];
  
  // Sort by start time, then by end time (descending)
  events.sort((a, b) => {
    if (a.start.getTime() !== b.start.getTime()) {
      return a.start.getTime() - b.start.getTime();
    }
    return b.end.getTime() - a.end.getTime();
  });

  const clusters = [];
  let currentCluster = [];
  let clusterEnd = 0;

  events.forEach(e => {
    if (currentCluster.length === 0) {
      currentCluster.push(e);
      clusterEnd = e.end.getTime();
    } else {
      if (e.start.getTime() < clusterEnd) {
        currentCluster.push(e);
        clusterEnd = Math.max(clusterEnd, e.end.getTime());
      } else {
        clusters.push(currentCluster);
        currentCluster = [e];
        clusterEnd = e.end.getTime();
      }
    }
  });
  if (currentCluster.length > 0) {
    clusters.push(currentCluster);
  }

  const result = [];

  clusters.forEach(cluster => {
    const columns = [];
    cluster.forEach(e => {
      let placed = false;
      for (let i = 0; i < columns.length; i++) {
        const col = columns[i];
        const lastEvent = col[col.length - 1];
        if (lastEvent.end.getTime() <= e.start.getTime()) {
          col.push(e);
          e.col = i;
          placed = true;
          break;
        }
      }
      if (!placed) {
        e.col = columns.length;
        columns.push([e]);
      }
    });

    cluster.forEach(e => {
      e.maxCols = columns.length;
      result.push(e);
    });
  });

  return result;
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
    currentWeekStart = getStartOfWeek(new Date());
    loadWeek();
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
        alert(err.error);
        return;
      }
      
      closeModal();
      loadWeek();
    } catch (err) {
      console.error(err);
      alert('An error occurred');
    }
  });

  deleteBtn.addEventListener('click', async () => {
    const id = eventIdInput.value;
    if (!id) return;
    
    if (!confirm('Are you sure you want to delete this event?')) return;
    
    try {
      const res = await fetch(`${API_URL}/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json();
        alert(err.error);
        return;
      }
      closeModal();
      loadWeek();
    } catch (err) {
      console.error(err);
      alert('An error occurred');
    }
  });
}

function openModal(event = null, defaultStart = null, defaultEnd = null) {
  if (event) {
    modalTitle.textContent = 'Edit Event';
    eventIdInput.value = event.id;
    eventTitleInput.value = event.title;
    eventStartInput.value = formatDateTimeLocal(event.originalStart);
    eventEndInput.value = formatDateTimeLocal(event.originalEnd);
    deleteBtn.classList.remove('hidden');
  } else {
    modalTitle.textContent = 'Create Event';
    eventIdInput.value = '';
    eventTitleInput.value = '';
    eventStartInput.value = defaultStart ? formatDateTimeLocal(defaultStart) : '';
    eventEndInput.value = defaultEnd ? formatDateTimeLocal(defaultEnd) : '';
    deleteBtn.classList.add('hidden');
  }
  modal.classList.remove('hidden');
}

function closeModal() {
  modal.classList.add('hidden');
  eventForm.reset();
}

init();