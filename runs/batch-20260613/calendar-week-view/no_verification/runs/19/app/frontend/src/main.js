const API_BASE = '/api/events';

let currentWeekStart = getStartOfWeek(new Date());
let events = [];

const daysHeaderEl = document.getElementById('days-header');
const timeAxisEl = document.getElementById('time-axis');
const daysGridEl = document.getElementById('days-grid');
const currentWeekLabel = document.getElementById('current-week-label');

// Sync scroll between grid and time axis
daysGridEl.addEventListener('scroll', () => {
  timeAxisEl.style.transform = `translateY(-${daysGridEl.scrollTop}px)`;
});

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
  currentWeekStart.setDate(currentWeekStart.getDate() - 7);
  loadWeek();
});

document.getElementById('today').addEventListener('click', () => {
  currentWeekStart = getStartOfWeek(new Date());
  loadWeek();
});

document.getElementById('next-week').addEventListener('click', () => {
  currentWeekStart.setDate(currentWeekStart.getDate() + 7);
  loadWeek();
});

cancelBtn.addEventListener('click', closeModal);

eventForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = eventIdInput.value;
  const payload = {
    title: eventTitleInput.value,
    start_at: new Date(eventStartInput.value).toISOString(),
    end_at: new Date(eventEndInput.value).toISOString()
  };

  try {
    if (id) {
      const res = await fetch(`${API_BASE}/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error(await res.text());
    } else {
      const res = await fetch(API_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error(await res.text());
    }
    closeModal();
    loadWeek();
  } catch (err) {
    alert('Error saving event: ' + err.message);
  }
});

deleteBtn.addEventListener('click', async () => {
  const id = eventIdInput.value;
  if (!id) return;
  try {
    const res = await fetch(`${API_BASE}/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(await res.text());
    closeModal();
    loadWeek();
  } catch (err) {
    alert('Error deleting event: ' + err.message);
  }
});

function getStartOfWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // adjust when day is sunday
  return new Date(d.setDate(diff));
}

function formatDate(date) {
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatTime(date) {
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
}

function toLocalISOString(date) {
  const tzOffset = date.getTimezoneOffset() * 60000; // offset in milliseconds
  const localISOTime = (new Date(date.getTime() - tzOffset)).toISOString().slice(0, 16);
  return localISOTime;
}

async function loadWeek() {
  const endOfWeek = new Date(currentWeekStart);
  endOfWeek.setDate(endOfWeek.getDate() + 7);

  currentWeekLabel.textContent = `${formatDate(currentWeekStart)} - ${formatDate(new Date(endOfWeek.getTime() - 1))}`;

  try {
    const res = await fetch(`${API_BASE}?start=${currentWeekStart.toISOString()}&end=${endOfWeek.toISOString()}`);
    if (!res.ok) throw new Error('Failed to fetch events');
    events = await res.json();
    events.forEach(e => {
      e.start_at = new Date(e.start_at);
      e.end_at = new Date(e.end_at);
    });
    render();
  } catch (err) {
    console.error(err);
  }
}

function render() {
  renderHeaders();
  renderTimeAxis();
  renderGrid();
}

function renderHeaders() {
  daysHeaderEl.innerHTML = '';
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 0; i < 7; i++) {
    const d = new Date(currentWeekStart);
    d.setDate(d.getDate() + i);
    const el = document.createElement('div');
    el.className = 'day-header';
    if (d.getTime() === today.getTime()) {
      el.classList.add('today');
    }
    const dayName = d.toLocaleDateString(undefined, { weekday: 'short' });
    el.textContent = `${dayName} ${d.getDate()}`;
    daysHeaderEl.appendChild(el);
  }
}

function renderTimeAxis() {
  timeAxisEl.innerHTML = '';
  for (let i = 0; i < 24; i++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = `${i * 60}px`;
    label.textContent = `${i.toString().padStart(2, '0')}:00`;
    timeAxisEl.appendChild(label);
  }
}

function renderGrid() {
  daysGridEl.innerHTML = '';
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 0; i < 7; i++) {
    const dayStart = new Date(currentWeekStart);
    dayStart.setDate(dayStart.getDate() + i);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);

    const col = document.createElement('div');
    col.className = 'day-column';
    if (dayStart.getTime() === today.getTime()) {
      col.classList.add('today');
    }

    // Hour lines
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
      const minutes = Math.floor(y);
      
      const start = new Date(dayStart);
      start.setMinutes(minutes);
      const end = new Date(start);
      end.setHours(end.getHours() + 1);

      openModal({ start_at: start, end_at: end });
    });

    // Filter events for this day
    const dayEvents = events.filter(e => e.start_at < dayEnd && e.end_at > dayStart);
    
    // Layout events
    layoutDayEvents(dayEvents, dayStart).forEach(le => {
      const el = document.createElement('div');
      el.className = 'event';
      el.style.top = `${le.top}px`;
      el.style.height = `${le.height}px`;
      el.style.left = `${le.left}%`;
      el.style.width = `${le.width}%`;

      const title = document.createElement('div');
      title.className = 'event-title';
      title.textContent = le.event.title;
      
      const time = document.createElement('div');
      time.className = 'event-time';
      time.textContent = `${formatTime(le.event.start_at)} - ${formatTime(le.event.end_at)}`;

      el.appendChild(title);
      el.appendChild(time);

      el.addEventListener('click', (e) => {
        e.stopPropagation();
        openModal(le.event);
      });

      col.appendChild(el);
    });

    daysGridEl.appendChild(col);
  }
}

function layoutDayEvents(dayEvents, dayStart) {
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);

  // Clamp events to the current day for layout purposes
  const clampedEvents = dayEvents.map(ev => {
    return {
      ...ev,
      originalEvent: ev,
      clampedStart: new Date(Math.max(ev.start_at.getTime(), dayStart.getTime())),
      clampedEnd: new Date(Math.min(ev.end_at.getTime(), dayEnd.getTime()))
    };
  });

  // Sort by clamped start time, then clamped end time
  const sorted = clampedEvents.sort((a, b) => {
    if (a.clampedStart.getTime() !== b.clampedStart.getTime()) {
      return a.clampedStart.getTime() - b.clampedStart.getTime();
    }
    return a.clampedEnd.getTime() - b.clampedEnd.getTime();
  });

  const clusters = [];
  let currentCluster = [];
  let clusterEnd = null;

  sorted.forEach(ev => {
    if (currentCluster.length === 0) {
      currentCluster.push(ev);
      clusterEnd = ev.clampedEnd.getTime();
    } else {
      if (ev.clampedStart.getTime() < clusterEnd) {
        currentCluster.push(ev);
        clusterEnd = Math.max(clusterEnd, ev.clampedEnd.getTime());
      } else {
        clusters.push(currentCluster);
        currentCluster = [ev];
        clusterEnd = ev.clampedEnd.getTime();
      }
    }
  });
  if (currentCluster.length > 0) {
    clusters.push(currentCluster);
  }

  const layout = [];

  clusters.forEach(cluster => {
    const columns = [];
    cluster.forEach(ev => {
      let placed = false;
      for (let i = 0; i < columns.length; i++) {
        const col = columns[i];
        const lastEv = col[col.length - 1];
        if (ev.clampedStart.getTime() >= lastEv.clampedEnd.getTime()) {
          col.push(ev);
          placed = true;
          break;
        }
      }
      if (!placed) {
        columns.push([ev]);
      }
    });

    const numCols = columns.length;
    columns.forEach((col, colIdx) => {
      col.forEach(ev => {
        const startMins = (ev.clampedStart.getTime() - dayStart.getTime()) / 60000;
        const endMins = (ev.clampedEnd.getTime() - dayStart.getTime()) / 60000;

        layout.push({
          event: ev.originalEvent,
          top: startMins,
          height: endMins - startMins,
          left: (colIdx * 100) / numCols,
          width: 100 / numCols
        });
      });
    });
  });

  return layout;
}

function openModal(event = null) {
  modal.classList.remove('hidden');
  if (event && event.id) {
    modalTitle.textContent = 'Edit Event';
    eventIdInput.value = event.id;
    eventTitleInput.value = event.title;
    eventStartInput.value = toLocalISOString(event.start_at);
    eventEndInput.value = toLocalISOString(event.end_at);
    deleteBtn.classList.remove('hidden');
  } else {
    modalTitle.textContent = 'Create Event';
    eventIdInput.value = '';
    eventTitleInput.value = '';
    if (event && event.start_at && event.end_at) {
      eventStartInput.value = toLocalISOString(event.start_at);
      eventEndInput.value = toLocalISOString(event.end_at);
    } else {
      const now = new Date();
      now.setMinutes(0, 0, 0);
      const end = new Date(now);
      end.setHours(end.getHours() + 1);
      eventStartInput.value = toLocalISOString(now);
      eventEndInput.value = toLocalISOString(end);
    }
    deleteBtn.classList.add('hidden');
  }
}

function closeModal() {
  modal.classList.add('hidden');
  eventForm.reset();
}

loadWeek();
