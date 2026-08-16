const API_URL = 'http://localhost:3000/api/events';
const HOUR_HEIGHT = 60;
const DAY_HEIGHT = 24 * HOUR_HEIGHT;

let currentDate = new Date();
let events = [];

const timeAxisEl = document.getElementById('time-axis');
const weekGridEl = document.getElementById('week-grid');
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

document.getElementById('prev-week').addEventListener('click', () => {
  currentDate.setDate(currentDate.getDate() - 7);
  render();
});

document.getElementById('today').addEventListener('click', () => {
  currentDate = new Date();
  render();
});

document.getElementById('next-week').addEventListener('click', () => {
  currentDate.setDate(currentDate.getDate() + 7);
  render();
});

cancelBtn.addEventListener('click', closeModal);

eventForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = eventIdInput.value;
  const title = eventTitleInput.value;
  const start_at = new Date(eventStartInput.value).toISOString();
  const end_at = new Date(eventEndInput.value).toISOString();

  if (new Date(end_at) <= new Date(start_at)) {
    alert('End time must be after start time');
    return;
  }

  const payload = { title, start_at, end_at };

  try {
    if (id) {
      const res = await fetch(`${API_URL}/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error('Failed to update');
    } else {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error('Failed to create');
    }
    closeModal();
    fetchEvents();
  } catch (err) {
    alert(err.message);
  }
});

deleteBtn.addEventListener('click', async () => {
  const id = eventIdInput.value;
  if (!id) return;
  try {
    const res = await fetch(`${API_URL}/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to delete');
    closeModal();
    fetchEvents();
  } catch (err) {
    alert(err.message);
  }
});

function getStartOfWeek(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // adjust when day is sunday
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function formatLocalISO(date) {
  const tzOffset = date.getTimezoneOffset() * 60000;
  const localISOTime = (new Date(date.getTime() - tzOffset)).toISOString().slice(0, 16);
  return localISOTime;
}

function openModal(event = null, defaultStart = null, defaultEnd = null) {
  modal.classList.remove('hidden');
  if (event) {
    modalTitle.textContent = 'Edit Event';
    eventIdInput.value = event.id;
    eventTitleInput.value = event.title;
    eventStartInput.value = formatLocalISO(new Date(event.start_at));
    eventEndInput.value = formatLocalISO(new Date(event.end_at));
    deleteBtn.classList.remove('hidden');
  } else {
    modalTitle.textContent = 'Create Event';
    eventIdInput.value = '';
    eventTitleInput.value = '';
    eventStartInput.value = defaultStart ? formatLocalISO(defaultStart) : formatLocalISO(new Date());
    eventEndInput.value = defaultEnd ? formatLocalISO(defaultEnd) : formatLocalISO(new Date(Date.now() + 3600000));
    deleteBtn.classList.add('hidden');
  }
}

function closeModal() {
  modal.classList.add('hidden');
}

async function fetchEvents() {
  const startOfWeek = getStartOfWeek(currentDate);
  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(endOfWeek.getDate() + 7);

  try {
    const res = await fetch(`${API_URL}?start=${startOfWeek.toISOString()}&end=${endOfWeek.toISOString()}`);
    if (!res.ok) throw new Error('Failed to fetch events');
    events = await res.json();
    renderWeek();
  } catch (err) {
    console.error(err);
  }
}

function renderTimeAxis() {
  timeAxisEl.innerHTML = '';
  const header = document.createElement('div');
  header.className = 'time-axis-header';
  timeAxisEl.appendChild(header);

  const content = document.createElement('div');
  content.className = 'time-axis-content';
  content.style.height = `${DAY_HEIGHT}px`;
  content.style.position = 'relative';

  for (let i = 0; i < 24; i++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = `${i * HOUR_HEIGHT}px`;
    label.textContent = `${i.toString().padStart(2, '0')}:00`;
    content.appendChild(label);
  }
  timeAxisEl.appendChild(content);
}

function renderWeek() {
  weekGridEl.innerHTML = '';
  const startOfWeek = getStartOfWeek(currentDate);
  
  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(endOfWeek.getDate() + 6);
  currentWeekLabel.textContent = `${startOfWeek.toLocaleDateString()} - ${endOfWeek.toLocaleDateString()}`;

  const today = new Date();

  for (let i = 0; i < 7; i++) {
    const currentDay = new Date(startOfWeek);
    currentDay.setDate(currentDay.getDate() + i);

    const col = document.createElement('div');
    col.className = 'day-column';

    const header = document.createElement('div');
    header.className = 'day-header';
    if (currentDay.toDateString() === today.toDateString()) {
      header.classList.add('today');
    }
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    header.textContent = `${dayNames[currentDay.getDay()]} ${currentDay.getDate()}`;
    col.appendChild(header);

    const content = document.createElement('div');
    content.className = 'day-content';
    content.style.height = `${DAY_HEIGHT}px`;
    content.style.backgroundSize = `100% ${HOUR_HEIGHT}px`;

    content.addEventListener('click', (e) => {
      if (e.target !== content) return;
      const rect = content.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const minutes = (y / HOUR_HEIGHT) * 60;
      const start = new Date(currentDay);
      start.setHours(0, Math.floor(minutes), 0, 0);
      const end = new Date(start);
      end.setHours(start.getHours() + 1);
      openModal(null, start, end);
    });

    // Filter events for this day
    const dayStart = new Date(currentDay);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(currentDay);
    dayEnd.setHours(24, 0, 0, 0);

    const dayEvents = events.filter(ev => {
      const evStart = new Date(ev.start_at);
      const evEnd = new Date(ev.end_at);
      return evStart < dayEnd && evEnd > dayStart;
    }).map(ev => {
      const evStart = new Date(ev.start_at);
      const evEnd = new Date(ev.end_at);
      const start = evStart < dayStart ? dayStart : evStart;
      const end = evEnd > dayEnd ? dayEnd : evEnd;
      return { ...ev, start, end, originalStart: evStart, originalEnd: evEnd };
    });

    dayEvents.sort((a, b) => a.start - b.start || a.end - b.end);

    // Cluster layout
    const clusters = [];
    let currentCluster = [];
    let clusterEnd = null;

    for (const ev of dayEvents) {
      if (clusterEnd === null || ev.start < clusterEnd) {
        currentCluster.push(ev);
        clusterEnd = clusterEnd === null ? ev.end : new Date(Math.max(clusterEnd, ev.end));
      } else {
        clusters.push(currentCluster);
        currentCluster = [ev];
        clusterEnd = ev.end;
      }
    }
    if (currentCluster.length > 0) {
      clusters.push(currentCluster);
    }

    for (const cluster of clusters) {
      const columns = [];
      for (const ev of cluster) {
        let placed = false;
        for (let j = 0; j < columns.length; j++) {
          const colEvents = columns[j];
          const lastEv = colEvents[colEvents.length - 1];
          if (ev.start >= lastEv.end) {
            colEvents.push(ev);
            ev.colIdx = j;
            placed = true;
            break;
          }
        }
        if (!placed) {
          columns.push([ev]);
          ev.colIdx = columns.length - 1;
        }
      }

      const numCols = columns.length;
      for (const ev of cluster) {
        const top = (ev.start.getHours() * 60 + ev.start.getMinutes()) * (HOUR_HEIGHT / 60);
        let bottom = (ev.end.getHours() * 60 + ev.end.getMinutes()) * (HOUR_HEIGHT / 60);
        if (ev.end.getHours() === 0 && ev.end.getMinutes() === 0 && ev.end > ev.start) {
          bottom = DAY_HEIGHT;
        }
        const height = bottom - top;

        const block = document.createElement('div');
        block.className = 'event-block';
        block.style.top = `${top}px`;
        block.style.height = `${height}px`;
        block.style.width = `${100 / numCols}%`;
        block.style.left = `${(ev.colIdx * 100) / numCols}%`;

        const titleEl = document.createElement('div');
        titleEl.className = 'event-title';
        titleEl.textContent = ev.title;

        const timeEl = document.createElement('div');
        timeEl.className = 'event-time';
        const formatTime = (d) => `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
        timeEl.textContent = `${formatTime(ev.originalStart)} - ${formatTime(ev.originalEnd)}`;

        block.appendChild(titleEl);
        block.appendChild(timeEl);

        block.addEventListener('click', (e) => {
          e.stopPropagation();
          openModal(ev);
        });

        content.appendChild(block);
      }
    }

    col.appendChild(content);
    weekGridEl.appendChild(col);
  }
}

function render() {
  renderTimeAxis();
  fetchEvents();
}

render();
