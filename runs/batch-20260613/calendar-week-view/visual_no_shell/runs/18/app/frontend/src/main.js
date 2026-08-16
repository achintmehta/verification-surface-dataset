import { fetchEvents, createEvent, updateEvent, deleteEvent } from './api.js';
import { layoutEvents } from './layout.js';

const PIXELS_PER_MINUTE = 1;
const HOUR_HEIGHT = PIXELS_PER_MINUTE * 60;
const DAY_START_HOUR = 0;
const DAY_END_HOUR = 24;

let currentWeekStart = getStartOfWeek(new Date());
let events = [];

const timeAxisEl = document.getElementById('time-axis');
const daysGridEl = document.getElementById('days-grid');
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
  currentWeekStart.setDate(currentWeekStart.getDate() - 7);
  loadWeek();
});

document.getElementById('next-week').addEventListener('click', () => {
  currentWeekStart.setDate(currentWeekStart.getDate() + 7);
  loadWeek();
});

document.getElementById('today').addEventListener('click', () => {
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

  if (new Date(end_at) <= new Date(start_at)) {
    alert('End time must be after start time');
    return;
  }

  try {
    if (id) {
      await updateEvent(id, { title, start_at, end_at });
    } else {
      await createEvent({ title, start_at, end_at });
    }
    closeModal();
    loadWeek();
  } catch (err) {
    alert(err.message);
  }
});

deleteBtn.addEventListener('click', async () => {
  const id = eventIdInput.value;
  if (id) {
    try {
      await deleteEvent(id);
      closeModal();
      loadWeek();
    } catch (err) {
      alert(err.message);
    }
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
  const tzOffset = date.getTimezoneOffset() * 60000;
  return (new Date(date.getTime() - tzOffset)).toISOString().slice(0, 16);
}

async function loadWeek() {
  const endOfWeek = new Date(currentWeekStart);
  endOfWeek.setDate(endOfWeek.getDate() + 7);

  currentWeekLabel.textContent = `${formatDate(currentWeekStart)} - ${formatDate(new Date(endOfWeek.getTime() - 1))}`;

  try {
    events = await fetchEvents(currentWeekStart.toISOString(), endOfWeek.toISOString());
    render();
  } catch (err) {
    console.error(err);
  }
}

function render() {
  renderTimeAxis();
  renderDaysGrid();
}

function renderTimeAxis() {
  timeAxisEl.innerHTML = '';
  // Add a spacer for the header
  const headerSpacer = document.createElement('div');
  headerSpacer.style.height = '41px'; // Approximate header height
  timeAxisEl.appendChild(headerSpacer);

  const axisContainer = document.createElement('div');
  axisContainer.style.position = 'relative';
  axisContainer.style.height = `${(DAY_END_HOUR - DAY_START_HOUR) * HOUR_HEIGHT}px`;
  
  for (let i = DAY_START_HOUR; i <= DAY_END_HOUR; i++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.textContent = `${i.toString().padStart(2, '0')}:00`;
    label.style.top = `${(i - DAY_START_HOUR) * HOUR_HEIGHT}px`;
    axisContainer.appendChild(label);
  }
  timeAxisEl.appendChild(axisContainer);
}

function renderDaysGrid() {
  daysGridEl.innerHTML = '';
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 0; i < 7; i++) {
    const dayDate = new Date(currentWeekStart);
    dayDate.setDate(dayDate.getDate() + i);

    const col = document.createElement('div');
    col.className = 'day-column';

    const header = document.createElement('div');
    header.className = 'day-header';
    if (dayDate.getTime() === today.getTime()) {
      header.classList.add('today');
    }
    header.textContent = dayDate.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    col.appendChild(header);

    const content = document.createElement('div');
    content.style.position = 'relative';
    content.style.height = `${(DAY_END_HOUR - DAY_START_HOUR) * HOUR_HEIGHT}px`;
    
    // Add hour lines
    for (let h = DAY_START_HOUR; h <= DAY_END_HOUR; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${(h - DAY_START_HOUR) * HOUR_HEIGHT}px`;
      content.appendChild(line);
    }

    // Handle click to create event
    content.addEventListener('mousedown', (e) => {
      if (e.target !== content && !e.target.classList.contains('hour-line')) return;
      const rect = content.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const minutes = y / PIXELS_PER_MINUTE;
      
      const start = new Date(dayDate);
      start.setHours(0, Math.floor(minutes), 0, 0);
      
      const end = new Date(start);
      end.setHours(start.getHours() + 1);

      openModal({ start_at: start.toISOString(), end_at: end.toISOString() });
    });

    // Filter and layout events for this day
    const dayStart = new Date(dayDate);
    const dayEnd = new Date(dayDate);
    dayEnd.setDate(dayEnd.getDate() + 1);

    const dayEvents = events.filter(ev => {
      const evStart = new Date(ev.start_at);
      const evEnd = new Date(ev.end_at);
      return evStart < dayEnd && evEnd > dayStart;
    });

    const layoutedEvents = layoutEvents(dayEvents, dayStart);

    layoutedEvents.forEach(le => {
      const block = document.createElement('div');
      block.className = 'event-block';
      
      // Clamp to day
      let topMinutes = (new Date(le.event.start_at) - dayStart) / 60000;
      let bottomMinutes = (new Date(le.event.end_at) - dayStart) / 60000;
      
      if (topMinutes < 0) topMinutes = 0;
      if (bottomMinutes > 24 * 60) bottomMinutes = 24 * 60;
      
      const top = topMinutes * PIXELS_PER_MINUTE;
      const height = (bottomMinutes - topMinutes) * PIXELS_PER_MINUTE;

      block.style.top = `${top}px`;
      block.style.height = `${height}px`;
      block.style.left = `${le.left}%`;
      block.style.width = `${le.width}%`;

      const titleEl = document.createElement('div');
      titleEl.className = 'event-title';
      titleEl.textContent = le.event.title;
      
      const timeEl = document.createElement('div');
      timeEl.className = 'event-time';
      timeEl.textContent = `${formatTime(new Date(le.event.start_at))} - ${formatTime(new Date(le.event.end_at))}`;

      block.appendChild(titleEl);
      block.appendChild(timeEl);

      block.addEventListener('click', (e) => {
        e.stopPropagation();
        openModal(le.event);
      });

      content.appendChild(block);
    });

    col.appendChild(content);
    daysGridEl.appendChild(col);
  }
}

function openModal(event = null) {
  modal.classList.remove('hidden');
  if (event && event.id) {
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
    if (event && event.start_at) {
      eventStartInput.value = toLocalISOString(new Date(event.start_at));
      eventEndInput.value = toLocalISOString(new Date(event.end_at));
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
}

loadWeek();
