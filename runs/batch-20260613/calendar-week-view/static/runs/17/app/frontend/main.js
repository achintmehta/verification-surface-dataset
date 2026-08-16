import { fetchEvents, createEvent, updateEvent, deleteEvent } from './api.js';
import { layoutEvents } from './layout.js';

// State
let currentWeekStart = getMonday(new Date());
let events = [];

// DOM Elements
const prevWeekBtn = document.getElementById('prev-week');
const nextWeekBtn = document.getElementById('next-week');
const todayBtn = document.getElementById('today');
const currentWeekLabel = document.getElementById('current-week-label');
const calendarHeader = document.getElementById('calendar-header');
const timeAxis = document.getElementById('time-axis');
const weekGrid = document.getElementById('week-grid');

const modal = document.getElementById('event-modal');
const modalTitle = document.getElementById('modal-title');
const eventForm = document.getElementById('event-form');
const eventIdInput = document.getElementById('event-id');
const eventTitleInput = document.getElementById('event-title');
const eventStartInput = document.getElementById('event-start');
const eventEndInput = document.getElementById('event-end');
const deleteBtn = document.getElementById('delete-btn');
const cancelBtn = document.getElementById('cancel-btn');

// Constants
const HOURS_IN_DAY = 24;
const PIXELS_PER_HOUR = 60;
const PIXELS_PER_MINUTE = PIXELS_PER_HOUR / 60;

// Date Utilities
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
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function toLocalISOString(date) {
  const tzOffset = date.getTimezoneOffset() * 60000; // offset in milliseconds
  const localISOTime = (new Date(date.getTime() - tzOffset)).toISOString().slice(0, 16);
  return localISOTime;
}

// Initialization
function init() {
  renderGrid();
  setupEventListeners();
  loadWeek();
}

function renderGrid() {
  // Render Time Axis
  timeAxis.innerHTML = '';
  for (let i = 0; i <= HOURS_IN_DAY; i++) {
    const label = document.createElement('div');
    label.className = 'hour-label';
    label.style.top = `${i * PIXELS_PER_HOUR}px`;
    label.textContent = `${i.toString().padStart(2, '0')}:00`;
    timeAxis.appendChild(label);
  }

  // Render Day Columns
  weekGrid.innerHTML = '';
  // Remove old day headers
  const oldHeaders = calendarHeader.querySelectorAll('.day-header');
  oldHeaders.forEach(h => h.remove());

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 0; i < 7; i++) {
    const dayDate = addDays(currentWeekStart, i);
    
    // Header
    const header = document.createElement('div');
    header.className = 'day-header';
    if (dayDate.getTime() === today.getTime()) {
      header.classList.add('today');
    }
    header.textContent = formatDate(dayDate);
    calendarHeader.appendChild(header);

    // Column
    const col = document.createElement('div');
    col.className = 'day-column';
    col.dataset.date = dayDate.toISOString();
    
    // Hour lines
    for (let h = 0; h <= HOURS_IN_DAY; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${h * PIXELS_PER_HOUR}px`;
      col.appendChild(line);
    }

    // Click to create event
    col.addEventListener('click', (e) => {
      if (e.target.closest('.event')) return; // Ignore clicks on events
      
      const rect = col.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const minutes = Math.floor(y / PIXELS_PER_MINUTE);
      
      const start = new Date(dayDate);
      start.setMinutes(minutes);
      
      const end = new Date(start);
      end.setHours(end.getHours() + 1); // Default 1 hour duration

      openModal({ start_at: start.toISOString(), end_at: end.toISOString() });
    });

    weekGrid.appendChild(col);
  }

  const endOfWeek = addDays(currentWeekStart, 6);
  currentWeekLabel.textContent = `${formatDate(currentWeekStart)} - ${formatDate(endOfWeek)}`;
}

async function loadWeek() {
  const startIso = currentWeekStart.toISOString();
  const endIso = addDays(currentWeekStart, 7).toISOString();
  
  try {
    events = await fetchEvents(startIso, endIso);
    renderEvents();
  } catch (err) {
    console.error(err);
    alert('Failed to load events');
  }
}

function renderEvents() {
  // Clear existing events
  document.querySelectorAll('.event').forEach(el => el.remove());

  // Group events by day
  const eventsByDay = Array.from({ length: 7 }, () => []);
  
  events.forEach(event => {
    const start = new Date(event.start_at);
    const end = new Date(event.end_at);
    
    // Find which day(s) this event belongs to
    for (let i = 0; i < 7; i++) {
      const dayStart = addDays(currentWeekStart, i);
      const dayEnd = addDays(currentWeekStart, i + 1);
      
      if (start < dayEnd && end > dayStart) {
        // Event overlaps with this day
        // Clamp to day boundaries
        const clampedStart = start < dayStart ? dayStart : start;
        const clampedEnd = end > dayEnd ? dayEnd : end;
        
        eventsByDay[i].push({
          ...event,
          _clampedStart: clampedStart,
          _clampedEnd: clampedEnd
        });
      }
    }
  });

  const columns = weekGrid.querySelectorAll('.day-column');

  eventsByDay.forEach((dayEvents, i) => {
    const layouted = layoutEvents(dayEvents.map(e => ({
      ...e,
      start_at: e._clampedStart.toISOString(),
      end_at: e._clampedEnd.toISOString()
    })));

    const col = columns[i];
    const dayStart = addDays(currentWeekStart, i);

    layouted.forEach(event => {
      const start = new Date(event.start_at);
      const end = new Date(event.end_at);
      
      const startMinutes = start.getHours() * 60 + start.getMinutes();
      let endMinutes = end.getHours() * 60 + end.getMinutes();
      if (endMinutes === 0 && end.getTime() > start.getTime()) {
        endMinutes = 24 * 60;
      }
      
      const top = startMinutes * PIXELS_PER_MINUTE;
      const height = (endMinutes - startMinutes) * PIXELS_PER_MINUTE;

      const el = document.createElement('div');
      el.className = 'event';
      el.style.top = `${top}px`;
      el.style.height = `${height}px`;
      el.style.left = `${event._left}%`;
      el.style.width = `${event._width}%`;
      
      const titleEl = document.createElement('div');
      titleEl.className = 'event-title';
      titleEl.textContent = event.title;
      
      const timeEl = document.createElement('div');
      timeEl.className = 'event-time';
      timeEl.textContent = `${formatTime(start)} - ${formatTime(end)}`;
      
      el.appendChild(titleEl);
      el.appendChild(timeEl);

      el.addEventListener('click', (e) => {
        e.stopPropagation();
        openModal(events.find(ev => ev.id === event.id));
      });

      col.appendChild(el);
    });
  });
}

function formatTime(date) {
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
}

function setupEventListeners() {
  prevWeekBtn.addEventListener('click', () => {
    currentWeekStart = addDays(currentWeekStart, -7);
    renderGrid();
    loadWeek();
  });

  nextWeekBtn.addEventListener('click', () => {
    currentWeekStart = addDays(currentWeekStart, 7);
    renderGrid();
    loadWeek();
  });

  todayBtn.addEventListener('click', () => {
    currentWeekStart = getMonday(new Date());
    renderGrid();
    loadWeek();
  });

  cancelBtn.addEventListener('click', closeModal);

  eventForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const id = eventIdInput.value;
    const eventData = {
      title: eventTitleInput.value,
      start_at: new Date(eventStartInput.value).toISOString(),
      end_at: new Date(eventEndInput.value).toISOString()
    };

    try {
      if (id) {
        await updateEvent(id, eventData);
      } else {
        await createEvent(eventData);
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
    
    if (confirm('Are you sure you want to delete this event?')) {
      try {
        await deleteEvent(id);
        closeModal();
        loadWeek();
      } catch (err) {
        alert(err.message);
      }
    }
  });
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
      eventStartInput.value = toLocalISOString(now);
      const end = new Date(now);
      end.setHours(end.getHours() + 1);
      eventEndInput.value = toLocalISOString(end);
    }
    deleteBtn.classList.add('hidden');
  }
}

function closeModal() {
  modal.classList.add('hidden');
  eventForm.reset();
}

init();
