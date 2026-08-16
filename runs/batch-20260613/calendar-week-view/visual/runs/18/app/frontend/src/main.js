import { startOfWeek, addDays, format, parseISO, isSameDay, startOfDay, differenceInMinutes } from 'date-fns';

const PIXELS_PER_MINUTE = 1; // 1px per minute -> 1440px per day
const DAY_START_HOUR = 0;
const DAY_END_HOUR = 24;

let currentWeekStart = startOfWeek(new Date(), { weekStartsOn: 1 }); // Monday
let events = [];

const daysHeaderEl = document.getElementById('days-header');
const timeAxisEl = document.getElementById('time-axis');
const daysGridEl = document.getElementById('days-grid');
const currentMonthEl = document.getElementById('current-month');

const modal = document.getElementById('event-modal');
const modalTitle = document.getElementById('modal-title');
const eventForm = document.getElementById('event-form');
const eventIdInput = document.getElementById('event-id');
const eventTitleInput = document.getElementById('event-title');
const eventStartInput = document.getElementById('event-start');
const eventEndInput = document.getElementById('event-end');
const deleteBtn = document.getElementById('delete-event');
const closeModalBtn = document.getElementById('close-modal');

function init() {
  document.getElementById('prev-week').addEventListener('click', () => {
    currentWeekStart = addDays(currentWeekStart, -7);
    render();
  });
  document.getElementById('next-week').addEventListener('click', () => {
    currentWeekStart = addDays(currentWeekStart, 7);
    render();
  });
  document.getElementById('today').addEventListener('click', () => {
    currentWeekStart = startOfWeek(new Date(), { weekStartsOn: 1 });
    render();
  });

  eventForm.addEventListener('submit', handleSaveEvent);
  deleteBtn.addEventListener('click', handleDeleteEvent);
  closeModalBtn.addEventListener('click', closeEventModal);

  render();
}

async function fetchEvents() {
  const start = currentWeekStart.toISOString();
  const end = addDays(currentWeekStart, 7).toISOString();
  try {
    const res = await fetch(`/api/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
    if (res.ok) {
      const data = await res.json();
      events = data.map(e => ({
        ...e,
        start_at: new Date(e.start_at),
        end_at: new Date(e.end_at)
      }));
    }
  } catch (err) {
    console.error('Failed to fetch events', err);
  }
}

async function render() {
  await fetchEvents();
  
  currentMonthEl.textContent = format(currentWeekStart, 'MMMM yyyy');
  
  renderHeaders();
  renderTimeAxis();
  renderGrid();
}

function renderHeaders() {
  daysHeaderEl.innerHTML = '';
  const today = new Date();
  for (let i = 0; i < 7; i++) {
    const day = addDays(currentWeekStart, i);
    const el = document.createElement('div');
    el.className = 'day-header';
    if (isSameDay(day, today)) {
      el.classList.add('today');
    }
    el.textContent = format(day, 'EEE M/d');
    daysHeaderEl.appendChild(el);
  }
}

function renderTimeAxis() {
  timeAxisEl.innerHTML = '';
  timeAxisEl.style.height = `${24 * 60 * PIXELS_PER_MINUTE}px`;
  for (let i = 0; i <= 24; i++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = `${i * 60 * PIXELS_PER_MINUTE}px`;
    label.textContent = `${i.toString().padStart(2, '0')}:00`;
    timeAxisEl.appendChild(label);
  }
}

function renderGrid() {
  daysGridEl.innerHTML = '';
  daysGridEl.style.height = `${24 * 60 * PIXELS_PER_MINUTE}px`;

  for (let i = 0; i < 7; i++) {
    const day = addDays(currentWeekStart, i);
    const col = document.createElement('div');
    col.className = 'day-column';
    if (isSameDay(day, new Date())) {
      col.classList.add('today-col');
    }
    col.dataset.date = day.toISOString();
    
    // Add hour lines
    for (let h = 0; h <= 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${h * 60 * PIXELS_PER_MINUTE}px`;
      col.appendChild(line);
    }

    // Handle click to create event
    col.addEventListener('click', (e) => {
      if (e.target !== col && !e.target.classList.contains('hour-line')) return;
      const rect = col.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const minutes = Math.floor(y / PIXELS_PER_MINUTE);
      const startHour = Math.floor(minutes / 60);
      const startMinute = minutes % 60;
      
      const start = new Date(day);
      start.setHours(startHour, startMinute, 0, 0);
      const end = new Date(start);
      end.setHours(startHour + 1, startMinute, 0, 0);
      
      openEventModal(null, start, end);
    });

    // Filter events for this day
    const dayStart = startOfDay(day);
    const dayEnd = addDays(dayStart, 1);
    
    const dayEvents = events.filter(ev => ev.start_at < dayEnd && ev.end_at > dayStart).map(ev => {
      // Clamp to day
      const start = ev.start_at < dayStart ? dayStart : ev.start_at;
      const end = ev.end_at > dayEnd ? dayEnd : ev.end_at;
      return { ...ev, renderStart: start, renderEnd: end };
    });

    layoutEvents(dayEvents);

    for (let ev of dayEvents) {
      const el = document.createElement('div');
      el.className = 'event';
      
      const top = differenceInMinutes(ev.renderStart, dayStart) * PIXELS_PER_MINUTE;
      const height = differenceInMinutes(ev.renderEnd, ev.renderStart) * PIXELS_PER_MINUTE;
      
      el.style.top = `${top}px`;
      el.style.height = `${height}px`;
      
      const widthPct = 100 / ev.numCols;
      el.style.width = `${widthPct}%`;
      el.style.left = `${ev.colIdx * widthPct}%`;

      const title = document.createElement('div');
      title.className = 'event-title';
      title.textContent = ev.title;
      
      const time = document.createElement('div');
      time.className = 'event-time';
      time.textContent = `${format(ev.start_at, 'HH:mm')} - ${format(ev.end_at, 'HH:mm')}`;
      
      el.appendChild(title);
      el.appendChild(time);

      el.addEventListener('click', (e) => {
        e.stopPropagation();
        openEventModal(ev);
      });

      col.appendChild(el);
    }

    daysGridEl.appendChild(col);
  }
}

function layoutEvents(dayEvents) {
  dayEvents.sort((a, b) => {
    if (a.renderStart.getTime() !== b.renderStart.getTime()) {
      return a.renderStart.getTime() - b.renderStart.getTime();
    }
    return b.renderEnd.getTime() - a.renderEnd.getTime();
  });

  let clusters = [];
  let currentCluster = [];
  let clusterEnd = null;

  for (let ev of dayEvents) {
    if (currentCluster.length === 0) {
      currentCluster.push(ev);
      clusterEnd = ev.renderEnd;
    } else {
      if (ev.renderStart < clusterEnd) {
        currentCluster.push(ev);
        if (ev.renderEnd > clusterEnd) {
          clusterEnd = ev.renderEnd;
        }
      } else {
        clusters.push(currentCluster);
        currentCluster = [ev];
        clusterEnd = ev.renderEnd;
      }
    }
  }
  if (currentCluster.length > 0) {
    clusters.push(currentCluster);
  }

  for (let cluster of clusters) {
    let columns = [];
    for (let ev of cluster) {
      let placed = false;
      for (let i = 0; i < columns.length; i++) {
        let col = columns[i];
        let lastEv = col[col.length - 1];
        if (lastEv.renderEnd <= ev.renderStart) {
          col.push(ev);
          ev.colIdx = i;
          placed = true;
          break;
        }
      }
      if (!placed) {
        ev.colIdx = columns.length;
        columns.push([ev]);
      }
    }
    let numCols = columns.length;
    for (let ev of cluster) {
      ev.numCols = numCols;
    }
  }
}

function toLocalISOString(date) {
  const tzOffset = date.getTimezoneOffset() * 60000;
  const localISOTime = (new Date(date.getTime() - tzOffset)).toISOString().slice(0, 16);
  return localISOTime;
}

function openEventModal(ev = null, start = null, end = null) {
  modal.classList.remove('hidden');
  if (ev) {
    modalTitle.textContent = 'Edit Event';
    eventIdInput.value = ev.id;
    eventTitleInput.value = ev.title;
    eventStartInput.value = toLocalISOString(ev.start_at);
    eventEndInput.value = toLocalISOString(ev.end_at);
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

function closeEventModal() {
  modal.classList.add('hidden');
}

async function handleSaveEvent(e) {
  e.preventDefault();
  const id = eventIdInput.value;
  const title = eventTitleInput.value;
  const start_at = new Date(eventStartInput.value).toISOString();
  const end_at = new Date(eventEndInput.value).toISOString();

  const payload = { title, start_at, end_at };

  try {
    let res;
    if (id) {
      res = await fetch(`/api/events/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } else {
      res = await fetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }

    if (res.ok) {
      closeEventModal();
      render();
    } else {
      const err = await res.json();
      alert(err.error || 'Failed to save event');
    }
  } catch (err) {
    console.error(err);
    alert('Error saving event');
  }
}

async function handleDeleteEvent() {
  const id = eventIdInput.value;
  if (!id) return;
  if (!confirm('Are you sure you want to delete this event?')) return;

  try {
    const res = await fetch(`/api/events/${id}`, { method: 'DELETE' });
    if (res.ok) {
      closeEventModal();
      render();
    } else {
      const err = await res.json();
      alert(err.error || 'Failed to delete event');
    }
  } catch (err) {
    console.error(err);
    alert('Error deleting event');
  }
}

init();