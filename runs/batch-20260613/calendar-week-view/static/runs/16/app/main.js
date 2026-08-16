const API_URL = 'http://localhost:3000/api/events';
const PIXELS_PER_MINUTE = 1; // 1 hour = 60px
const HEADER_HEIGHT = 30;

let currentDate = new Date();
let events = [];

// DOM Elements
const timeAxis = document.getElementById('time-axis');
const weekGrid = document.getElementById('week-grid');
const currentWeekLabel = document.getElementById('current-week-label');
const modal = document.getElementById('event-modal');
const eventForm = document.getElementById('event-form');
const modalTitle = document.getElementById('modal-title');
const eventIdInput = document.getElementById('event-id');
const eventTitleInput = document.getElementById('event-title');
const eventStartInput = document.getElementById('event-start');
const eventEndInput = document.getElementById('event-end');
const deleteBtn = document.getElementById('delete-btn');
const cancelBtn = document.getElementById('cancel-btn');

// Initialize
function init() {
  document.getElementById('prev-week').addEventListener('click', () => changeWeek(-1));
  document.getElementById('next-week').addEventListener('click', () => changeWeek(1));
  document.getElementById('today').addEventListener('click', () => {
    currentDate = new Date();
    render();
  });

  cancelBtn.addEventListener('click', closeModal);
  eventForm.addEventListener('submit', saveEvent);
  deleteBtn.addEventListener('click', deleteEvent);

  render();
}

function getStartOfWeek(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // adjust when day is sunday
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function changeWeek(offset) {
  currentDate.setDate(currentDate.getDate() + offset * 7);
  render();
}

async function fetchEvents(start, end) {
  const res = await fetch(`${API_URL}?start=${start.toISOString()}&end=${end.toISOString()}`);
  if (!res.ok) throw new Error('Failed to fetch events');
  return res.json();
}

async function render() {
  const startOfWeek = getStartOfWeek(currentDate);
  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(endOfWeek.getDate() + 7);

  currentWeekLabel.textContent = `Week of ${startOfWeek.toLocaleDateString()}`;

  try {
    events = await fetchEvents(startOfWeek, endOfWeek);
  } catch (err) {
    console.error(err);
    events = [];
  }

  renderTimeAxis();
  renderWeekGrid(startOfWeek);
}

function renderTimeAxis() {
  timeAxis.innerHTML = '';
  // Add empty space for header
  const headerSpace = document.createElement('div');
  headerSpace.style.height = `${HEADER_HEIGHT}px`;
  headerSpace.style.position = 'sticky';
  headerSpace.style.top = '0';
  headerSpace.style.backgroundColor = '#fafafa';
  headerSpace.style.zIndex = '10';
  headerSpace.style.borderBottom = '1px solid #ccc';
  timeAxis.appendChild(headerSpace);

  for (let i = 0; i <= 24; i++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.textContent = `${i.toString().padStart(2, '0')}:00`;
    label.style.top = `${HEADER_HEIGHT + i * 60 * PIXELS_PER_MINUTE}px`;
    timeAxis.appendChild(label);
  }
}

function renderWeekGrid(startOfWeek) {
  weekGrid.innerHTML = '';
  const today = new Date();

  for (let i = 0; i < 7; i++) {
    const dayDate = new Date(startOfWeek);
    dayDate.setDate(dayDate.getDate() + i);

    const col = document.createElement('div');
    col.className = 'day-column';
    col.dataset.date = dayDate.toISOString();

    const header = document.createElement('div');
    header.className = 'day-header';
    if (dayDate.toDateString() === today.toDateString()) {
      header.classList.add('today');
    }
    header.textContent = dayDate.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });
    col.appendChild(header);

    for (let h = 0; h <= 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${HEADER_HEIGHT + h * 60 * PIXELS_PER_MINUTE}px`;
      col.appendChild(line);
    }

    // Click to create event
    col.addEventListener('click', (e) => {
      if (e.target !== col && !e.target.classList.contains('hour-line')) return;
      const rect = col.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const minutes = (y - HEADER_HEIGHT) / PIXELS_PER_MINUTE;
      if (minutes < 0) return;

      const start = new Date(dayDate);
      start.setHours(0, Math.floor(minutes), 0, 0);
      const end = new Date(start);
      end.setHours(start.getHours() + 1);

      openModal({ start_at: start.toISOString(), end_at: end.toISOString() });
    });

    // Render events for this day
    const dayStart = new Date(dayDate);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayDate);
    dayEnd.setHours(24, 0, 0, 0);

    const dayEvents = events.filter(ev => {
      const evStart = new Date(ev.start_at);
      const evEnd = new Date(ev.end_at);
      return evStart < dayEnd && evEnd > dayStart;
    }).map(ev => {
      // Clamp to day
      const evStart = new Date(ev.start_at);
      const evEnd = new Date(ev.end_at);
      const start = evStart < dayStart ? dayStart : evStart;
      const end = evEnd > dayEnd ? dayEnd : evEnd;
      return { ...ev, clampedStart: start, clampedEnd: end };
    });

    // Layout algorithm
    dayEvents.sort((a, b) => a.clampedStart - b.clampedStart || a.clampedEnd - b.clampedEnd);

    const clusters = [];
    let currentCluster = [];
    let clusterEnd = null;

    for (const ev of dayEvents) {
      if (currentCluster.length === 0) {
        currentCluster.push(ev);
        clusterEnd = ev.clampedEnd;
      } else {
        if (ev.clampedStart < clusterEnd) {
          currentCluster.push(ev);
          if (ev.clampedEnd > clusterEnd) clusterEnd = ev.clampedEnd;
        } else {
          clusters.push(currentCluster);
          currentCluster = [ev];
          clusterEnd = ev.clampedEnd;
        }
      }
    }
    if (currentCluster.length > 0) clusters.push(currentCluster);

    for (const cluster of clusters) {
      const columns = [];
      for (const ev of cluster) {
        let placed = false;
        for (let c = 0; c < columns.length; c++) {
          const lastEv = columns[c][columns[c].length - 1];
          if (lastEv.clampedEnd <= ev.clampedStart) {
            columns[c].push(ev);
            ev.column = c;
            placed = true;
            break;
          }
        }
        if (!placed) {
          ev.column = columns.length;
          columns.push([ev]);
        }
      }

      const numColumns = columns.length;
      for (const ev of cluster) {
        const startMins = (ev.clampedStart - dayStart) / 60000;
        const endMins = (ev.clampedEnd - dayStart) / 60000;

        const top = HEADER_HEIGHT + startMins * PIXELS_PER_MINUTE;
        const height = (endMins - startMins) * PIXELS_PER_MINUTE;

        const block = document.createElement('div');
        block.className = 'event-block';
        block.style.top = `${top}px`;
        block.style.height = `${height}px`;
        block.style.left = `${(ev.column / numColumns) * 100}%`;
        block.style.width = `${(1 / numColumns) * 100}%`;

        const title = document.createElement('div');
        title.className = 'event-title';
        title.textContent = ev.title;
        block.appendChild(title);

        const time = document.createElement('div');
        time.className = 'event-time';
        const formatTime = d => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        time.textContent = `${formatTime(new Date(ev.start_at))} - ${formatTime(new Date(ev.end_at))}`;
        block.appendChild(time);

        block.addEventListener('click', (e) => {
          e.stopPropagation();
          openModal(ev);
        });

        col.appendChild(block);
      }
    }

    weekGrid.appendChild(col);
  }
}

function toLocalISOString(date) {
  const tzOffset = date.getTimezoneOffset() * 60000;
  return (new Date(date.getTime() - tzOffset)).toISOString().slice(0, 16);
}

function openModal(ev) {
  modal.classList.remove('hidden');
  if (ev.id) {
    modalTitle.textContent = 'Edit Event';
    eventIdInput.value = ev.id;
    eventTitleInput.value = ev.title;
    eventStartInput.value = toLocalISOString(new Date(ev.start_at));
    eventEndInput.value = toLocalISOString(new Date(ev.end_at));
    deleteBtn.classList.remove('hidden');
  } else {
    modalTitle.textContent = 'Create Event';
    eventIdInput.value = '';
    eventTitleInput.value = '';
    eventStartInput.value = toLocalISOString(new Date(ev.start_at));
    eventEndInput.value = toLocalISOString(new Date(ev.end_at));
    deleteBtn.classList.add('hidden');
  }
}

function closeModal() {
  modal.classList.add('hidden');
}

async function saveEvent(e) {
  e.preventDefault();
  const id = eventIdInput.value;
  const title = eventTitleInput.value.trim();
  const start_at = new Date(eventStartInput.value).toISOString();
  const end_at = new Date(eventEndInput.value).toISOString();

  if (!title || new Date(end_at) <= new Date(start_at)) {
    alert('Invalid input');
    return;
  }

  const method = id ? 'PUT' : 'POST';
  const url = id ? `${API_URL}/${id}` : API_URL;

  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, start_at, end_at })
    });
    if (!res.ok) throw new Error('Failed to save');
    closeModal();
    render();
  } catch (err) {
    alert(err.message);
  }
}

async function deleteEvent() {
  const id = eventIdInput.value;
  if (!id) return;
  try {
    const res = await fetch(`${API_URL}/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to delete');
    closeModal();
    render();
  } catch (err) {
    alert(err.message);
  }
}

init();
