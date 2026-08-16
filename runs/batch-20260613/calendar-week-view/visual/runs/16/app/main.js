const API_URL = 'http://localhost:3000/api/events';

let currentWeekStart = getStartOfWeek(new Date());
let events = [];

const timeAxis = document.getElementById('time-axis');
const daysGrid = document.getElementById('days-grid');
const currentWeekLabel = document.getElementById('current-week-label');

const modal = document.getElementById('event-modal');
const eventForm = document.getElementById('event-form');
const eventIdInput = document.getElementById('event-id');
const eventTitleInput = document.getElementById('event-title');
const eventStartInput = document.getElementById('event-start');
const eventEndInput = document.getElementById('event-end');
const deleteBtn = document.getElementById('delete-btn');
const cancelBtn = document.getElementById('cancel-btn');

const PIXELS_PER_MINUTE = 1; // 60px per hour

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
  const pad = (n) => n.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatDateTimeLocal(date) {
  const pad = (n) => n.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function fetchEvents() {
  const start = currentWeekStart.toISOString();
  const end = addDays(currentWeekStart, 7).toISOString();
  try {
    const res = await fetch(`${API_URL}?start=${start}&end=${end}`);
    events = await res.json();
    renderCalendar();
  } catch (err) {
    console.error('Failed to fetch events', err);
  }
}

function renderGrid() {
  timeAxis.innerHTML = '';
  daysGrid.innerHTML = '';

  const headerSpacer = document.createElement('div');
  headerSpacer.style.height = '41px';
  timeAxis.appendChild(headerSpacer);

  for (let i = 0; i <= 24; i++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = `${41 + i * 60 * PIXELS_PER_MINUTE}px`;
    label.textContent = `${i.toString().padStart(2, '0')}:00`;
    timeAxis.appendChild(label);
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 0; i < 7; i++) {
    const dayDate = addDays(currentWeekStart, i);
    const col = document.createElement('div');
    col.className = 'day-column';
    col.dataset.date = formatDate(dayDate);

    const header = document.createElement('div');
    header.className = 'day-header';
    if (dayDate.getTime() === today.getTime()) {
      header.classList.add('today');
    }
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    header.textContent = `${dayNames[dayDate.getDay()]} ${dayDate.getDate()}`;
    col.appendChild(header);

    for (let h = 0; h <= 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${41 + h * 60 * PIXELS_PER_MINUTE}px`;
      col.appendChild(line);
    }

    col.addEventListener('click', (e) => {
      if (e.target !== col && !e.target.classList.contains('hour-line')) return;
      const rect = col.getBoundingClientRect();
      const y = e.clientY - rect.top + col.scrollTop;
      const minutes = (y - 41) / PIXELS_PER_MINUTE;
      if (minutes < 0) return;
      
      const startHour = Math.floor(minutes / 60);
      const startMinute = Math.floor((minutes % 60) / 15) * 15;
      
      const start = new Date(dayDate);
      start.setHours(startHour, startMinute, 0, 0);
      
      const end = new Date(start);
      end.setHours(start.getHours() + 1);

      openModal({ start_at: start.toISOString(), end_at: end.toISOString() });
    });

    daysGrid.appendChild(col);
  }

  const endOfWeek = addDays(currentWeekStart, 6);
  currentWeekLabel.textContent = `${currentWeekStart.toLocaleDateString()} - ${endOfWeek.toLocaleDateString()}`;
}

function renderCalendar() {
  renderGrid();

  const eventsByDay = {};
  for (let i = 0; i < 7; i++) {
    eventsByDay[formatDate(addDays(currentWeekStart, i))] = [];
  }

  events.forEach(ev => {
    const start = new Date(ev.start_at);
    const end = new Date(ev.end_at);
    
    for (let i = 0; i < 7; i++) {
      const dayDate = addDays(currentWeekStart, i);
      const dayStart = new Date(dayDate);
      const dayEnd = new Date(dayDate);
      dayEnd.setDate(dayEnd.getDate() + 1);

      if (start < dayEnd && end > dayStart) {
        eventsByDay[formatDate(dayDate)].push({
          ...ev,
          clampedStart: new Date(Math.max(start, dayStart)),
          clampedEnd: new Date(Math.min(end, dayEnd))
        });
      }
    }
  });

  for (let i = 0; i < 7; i++) {
    const dateStr = formatDate(addDays(currentWeekStart, i));
    const dayEvents = eventsByDay[dateStr];
    if (!dayEvents || dayEvents.length === 0) continue;

    dayEvents.sort((a, b) => a.clampedStart - b.clampedStart || b.clampedEnd - a.clampedEnd);

    const clusters = [];
    let currentCluster = [];
    let clusterEnd = null;

    dayEvents.forEach(ev => {
      if (currentCluster.length === 0) {
        currentCluster.push(ev);
        clusterEnd = ev.clampedEnd;
      } else {
        if (ev.clampedStart < clusterEnd) {
          currentCluster.push(ev);
          if (ev.clampedEnd > clusterEnd) {
            clusterEnd = ev.clampedEnd;
          }
        } else {
          clusters.push(currentCluster);
          currentCluster = [ev];
          clusterEnd = ev.clampedEnd;
        }
      }
    });
    if (currentCluster.length > 0) {
      clusters.push(currentCluster);
    }

    const colEl = daysGrid.querySelector(`.day-column[data-date="${dateStr}"]`);

    clusters.forEach(cluster => {
      const columns = [];
      cluster.forEach(ev => {
        let placed = false;
        for (let c = 0; c < columns.length; c++) {
          const lastEventInCol = columns[c][columns[c].length - 1];
          if (lastEventInCol.clampedEnd <= ev.clampedStart) {
            columns[c].push(ev);
            ev.colIdx = c;
            placed = true;
            break;
          }
        }
        if (!placed) {
          columns.push([ev]);
          ev.colIdx = columns.length - 1;
        }
      });

      const numCols = columns.length;
      cluster.forEach(ev => {
        const startMins = ev.clampedStart.getHours() * 60 + ev.clampedStart.getMinutes();
        const durationMins = (ev.clampedEnd - ev.clampedStart) / 60000;

        const top = 41 + startMins * PIXELS_PER_MINUTE;
        const height = durationMins * PIXELS_PER_MINUTE;

        const width = 100 / numCols;
        const left = ev.colIdx * width;

        const block = document.createElement('div');
        block.className = 'event-block';
        block.style.top = `${top}px`;
        block.style.height = `${height}px`;
        block.style.left = `${left}%`;
        block.style.width = `${width}%`;

        const title = document.createElement('div');
        title.className = 'event-title';
        title.textContent = ev.title;

        const time = document.createElement('div');
        time.className = 'event-time';
        const formatTime = (d) => `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
        time.textContent = `${formatTime(new Date(ev.start_at))} - ${formatTime(new Date(ev.end_at))}`;

        block.appendChild(title);
        block.appendChild(time);

        block.addEventListener('click', (e) => {
          e.stopPropagation();
          openModal(ev);
        });

        colEl.appendChild(block);
      });
    });
  }
}

function openModal(ev = null) {
  modal.classList.remove('hidden');
  if (ev && ev.id) {
    document.getElementById('modal-title').textContent = 'Edit Event';
    eventIdInput.value = ev.id;
    eventTitleInput.value = ev.title;
    eventStartInput.value = formatDateTimeLocal(new Date(ev.start_at));
    eventEndInput.value = formatDateTimeLocal(new Date(ev.end_at));
    deleteBtn.classList.remove('hidden');
  } else {
    document.getElementById('modal-title').textContent = 'Create Event';
    eventIdInput.value = '';
    eventTitleInput.value = '';
    if (ev && ev.start_at) {
      eventStartInput.value = formatDateTimeLocal(new Date(ev.start_at));
      eventEndInput.value = formatDateTimeLocal(new Date(ev.end_at));
    } else {
      const now = new Date();
      now.setMinutes(0, 0, 0);
      eventStartInput.value = formatDateTimeLocal(now);
      now.setHours(now.getHours() + 1);
      eventEndInput.value = formatDateTimeLocal(now);
    }
    deleteBtn.classList.add('hidden');
  }
}

function closeModal() {
  modal.classList.add('hidden');
  eventForm.reset();
}

eventForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = eventIdInput.value;
  const payload = {
    title: eventTitleInput.value,
    start_at: new Date(eventStartInput.value).toISOString(),
    end_at: new Date(eventEndInput.value).toISOString()
  };

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
    fetchEvents();
  } catch (err) {
    alert(err.message);
  }
});

deleteBtn.addEventListener('click', async () => {
  const id = eventIdInput.value;
  if (!id) return;
  if (!confirm('Delete this event?')) return;

  try {
    const res = await fetch(`${API_URL}/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json();
      alert(err.error || 'Error deleting event');
      return;
    }
    closeModal();
    fetchEvents();
  } catch (err) {
    alert(err.message);
  }
});

cancelBtn.addEventListener('click', closeModal);

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

fetchEvents();
