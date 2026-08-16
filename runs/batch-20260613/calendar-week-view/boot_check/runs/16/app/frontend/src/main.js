import { fetchEvents, createEvent, updateEvent, deleteEvent } from './api.js';
import { layoutEvents } from './layout.js';

const PIXELS_PER_MINUTE = 1; // 1px per minute -> 1440px total height

let currentWeekStart = getMonday(new Date());
let events = [];

const timeAxisEl = document.getElementById('time-axis');
const weekGridEl = document.getElementById('week-grid');
const currentWeekLabel = document.getElementById('current-week-label');

const modal = document.getElementById('event-modal');
const form = document.getElementById('event-form');
const modalTitle = document.getElementById('modal-title');
const eventIdInput = document.getElementById('event-id');
const eventTitleInput = document.getElementById('event-title');
const eventStartInput = document.getElementById('event-start');
const eventEndInput = document.getElementById('event-end');
const deleteBtn = document.getElementById('delete-btn');
const cancelBtn = document.getElementById('cancel-btn');

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

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function toLocalISOString(date) {
  const tzOffset = date.getTimezoneOffset() * 60000; // offset in milliseconds
  const localISOTime = (new Date(date.getTime() - tzOffset)).toISOString().slice(0, 16);
  return localISOTime;
}

function initGrid() {
  // Render time axis
  timeAxisEl.innerHTML = '';
  const dummyHeader = document.createElement('div');
  dummyHeader.className = 'day-header';
  dummyHeader.innerHTML = '&nbsp;';
  timeAxisEl.appendChild(dummyHeader);

  const timeContent = document.createElement('div');
  timeContent.style.position = 'relative';
  timeContent.style.height = `${24 * 60 * PIXELS_PER_MINUTE}px`;

  for (let i = 0; i < 24; i++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = `${i * 60 * PIXELS_PER_MINUTE}px`;
    label.textContent = `${i.toString().padStart(2, '0')}:00`;
    timeContent.appendChild(label);
  }
  timeAxisEl.appendChild(timeContent);
}

async function loadWeek() {
  const weekEnd = addDays(currentWeekStart, 7);
  currentWeekLabel.textContent = `${currentWeekStart.toLocaleDateString()} - ${addDays(currentWeekStart, 6).toLocaleDateString()}`;
  
  try {
    const rawEvents = await fetchEvents(currentWeekStart.toISOString(), weekEnd.toISOString());
    events = rawEvents.map(e => ({
      ...e,
      start_at: new Date(e.start_at),
      end_at: new Date(e.end_at)
    }));
    renderWeek();
  } catch (err) {
    console.error(err);
    alert('Failed to load events');
  }
}

function renderWeek() {
  weekGridEl.innerHTML = '';
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 0; i < 7; i++) {
    const dayDate = addDays(currentWeekStart, i);
    const isToday = dayDate.getTime() === today.getTime();

    const colEl = document.createElement('div');
    colEl.className = 'day-column';
    
    const headerEl = document.createElement('div');
    headerEl.className = `day-header ${isToday ? 'today' : ''}`;
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    headerEl.textContent = `${dayNames[dayDate.getDay()]} ${dayDate.getDate()}`;
    colEl.appendChild(headerEl);

    const contentEl = document.createElement('div');
    contentEl.className = 'day-content';
    contentEl.style.height = `${24 * 60 * PIXELS_PER_MINUTE}px`;
    
    // Add hour lines
    for (let h = 0; h < 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${h * 60 * PIXELS_PER_MINUTE}px`;
      contentEl.appendChild(line);
    }

    // Filter events for this day
    const dayStart = dayDate.getTime();
    const dayEnd = dayStart + 24 * 60 * 60 * 1000;
    
    const dayEvents = events.filter(e => {
      return e.start_at.getTime() < dayEnd && e.end_at.getTime() > dayStart;
    }).map(e => {
      // Clamp to day boundaries
      const start = new Date(Math.max(e.start_at.getTime(), dayStart));
      const end = new Date(Math.min(e.end_at.getTime(), dayEnd));
      return { ...e, start_at: start, end_at: end, original: e };
    });

    const layouted = layoutEvents(dayEvents);

    for (const { event, width, left } of layouted) {
      const startMinsFromDay = (event.start_at.getTime() - dayStart) / 60000;
      const endMinsFromDay = (event.end_at.getTime() - dayStart) / 60000;

      const block = document.createElement('div');
      block.className = 'event-block';
      block.style.top = `${startMinsFromDay * PIXELS_PER_MINUTE}px`;
      block.style.height = `${(endMinsFromDay - startMinsFromDay) * PIXELS_PER_MINUTE}px`;
      block.style.left = `${left * 100}%`;
      block.style.width = `${width * 100}%`;

      const titleEl = document.createElement('div');
      titleEl.className = 'event-title';
      titleEl.textContent = event.title;
      
      const timeEl = document.createElement('div');
      timeEl.className = 'event-time';
      timeEl.textContent = `${formatTime(event.original.start_at)} - ${formatTime(event.original.end_at)}`;

      block.appendChild(titleEl);
      block.appendChild(timeEl);

      block.addEventListener('click', (e) => {
        e.stopPropagation();
        openModal(event.original);
      });

      contentEl.appendChild(block);
    }

    // Click on empty space to create event
    contentEl.addEventListener('click', (e) => {
      const rect = contentEl.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const mins = Math.floor(y / PIXELS_PER_MINUTE);
      
      const start = new Date(dayStart + mins * 60000);
      const end = new Date(start.getTime() + 60 * 60000); // 1 hour default
      
      openModal({ title: '', start_at: start, end_at: end });
    });

    colEl.appendChild(contentEl);
    weekGridEl.appendChild(colEl);
  }
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
    eventTitleInput.value = event ? event.title : '';
    eventStartInput.value = event ? toLocalISOString(event.start_at) : '';
    eventEndInput.value = event ? toLocalISOString(event.end_at) : '';
    deleteBtn.classList.add('hidden');
  }
}

function closeModal() {
  modal.classList.add('hidden');
  form.reset();
}

cancelBtn.addEventListener('click', closeModal);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = eventIdInput.value;
  const payload = {
    title: eventTitleInput.value,
    start_at: new Date(eventStartInput.value).toISOString(),
    end_at: new Date(eventEndInput.value).toISOString()
  };

  try {
    if (id) {
      await updateEvent(id, payload);
    } else {
      await createEvent(payload);
    }
    closeModal();
    loadWeek();
  } catch (err) {
    alert(err.message);
  }
});

deleteBtn.addEventListener('click', async () => {
  const id = eventIdInput.value;
  if (!id) return;
  if (confirm('Delete this event?')) {
    try {
      await deleteEvent(id);
      closeModal();
      loadWeek();
    } catch (err) {
      alert(err.message);
    }
  }
});

document.getElementById('prev-week').addEventListener('click', () => {
  currentWeekStart = addDays(currentWeekStart, -7);
  loadWeek();
});

document.getElementById('next-week').addEventListener('click', () => {
  currentWeekStart = addDays(currentWeekStart, 7);
  loadWeek();
});

document.getElementById('today').addEventListener('click', () => {
  currentWeekStart = getMonday(new Date());
  loadWeek();
});

initGrid();
loadWeek();
