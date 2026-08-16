import { startOfWeek, endOfWeek, addWeeks, subWeeks, format, isSameDay, parseISO, startOfDay, differenceInMinutes } from 'date-fns';
import { fetchEvents, createEvent, updateEvent, deleteEvent } from './api.js';
import { layoutDayEvents } from './layout.js';

const HOUR_HEIGHT = 60; // pixels per hour
const MINUTE_HEIGHT = HOUR_HEIGHT / 60;

let currentWeekStart = startOfWeek(new Date(), { weekStarts: 1 }); // Monday
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
  currentWeekStart = subWeeks(currentWeekStart, 1);
  loadWeek();
});

document.getElementById('next-week').addEventListener('click', () => {
  currentWeekStart = addWeeks(currentWeekStart, 1);
  loadWeek();
});

document.getElementById('today').addEventListener('click', () => {
  currentWeekStart = startOfWeek(new Date(), { weekStarts: 1 });
  loadWeek();
});

cancelBtn.addEventListener('click', closeModal);

eventForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = eventIdInput.value;
  const title = eventTitleInput.value;
  const start_at = new Date(eventStartInput.value).toISOString();
  const end_at = new Date(eventEndInput.value).toISOString();

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

function openModal(event = null, defaultStart = null, defaultEnd = null) {
  modal.classList.remove('hidden');
  if (event) {
    modalTitle.textContent = 'Edit Event';
    eventIdInput.value = event.id;
    eventTitleInput.value = event.title;
    eventStartInput.value = formatForInput(new Date(event.start_at));
    eventEndInput.value = formatForInput(new Date(event.end_at));
    deleteBtn.classList.remove('hidden');
  } else {
    modalTitle.textContent = 'Create Event';
    eventIdInput.value = '';
    eventTitleInput.value = '';
    eventStartInput.value = defaultStart ? formatForInput(defaultStart) : '';
    eventEndInput.value = defaultEnd ? formatForInput(defaultEnd) : '';
    deleteBtn.classList.add('hidden');
  }
}

function closeModal() {
  modal.classList.add('hidden');
}

function formatForInput(date) {
  // format to YYYY-MM-DDThh:mm
  const pad = (n) => n.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function renderGrid() {
  timeAxisEl.innerHTML = '';
  daysGridEl.innerHTML = '';

  // Render time axis
  const timeHeaderSpacer = document.createElement('div');
  timeHeaderSpacer.className = 'time-header-spacer';
  timeAxisEl.appendChild(timeHeaderSpacer);

  const timeContent = document.createElement('div');
  timeContent.className = 'time-content';
  timeAxisEl.appendChild(timeContent);

  for (let i = 0; i < 24; i++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = `${i * HOUR_HEIGHT}px`;
    label.textContent = `${i.toString().padStart(2, '0')}:00`;
    timeContent.appendChild(label);
  }

  // Render days
  const today = new Date();
  for (let i = 0; i < 7; i++) {
    const dayDate = new Date(currentWeekStart);
    dayDate.setDate(dayDate.getDate() + i);

    const dayCol = document.createElement('div');
    dayCol.className = 'day-column';
    dayCol.dataset.date = dayDate.toISOString();

    const header = document.createElement('div');
    header.className = 'day-header';
    if (isSameDay(dayDate, today)) {
      header.classList.add('today');
    }
    header.textContent = format(dayDate, 'EEE M/d');
    dayCol.appendChild(header);

    const dayContent = document.createElement('div');
    dayContent.className = 'day-content';
    dayCol.appendChild(dayContent);

    // Hour lines
    for (let h = 0; h < 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${h * HOUR_HEIGHT}px`;
      dayContent.appendChild(line);
    }

    // Click to create event
    dayContent.addEventListener('click', (e) => {
      if (e.target !== dayContent && !e.target.classList.contains('hour-line')) return;
      const rect = dayContent.getBoundingClientRect();
      const y = e.clientY - rect.top;
      if (y < 0) return;

      const minutes = Math.floor(y / MINUTE_HEIGHT);
      const start = new Date(dayDate);
      start.setHours(0, minutes, 0, 0);
      const end = new Date(start);
      end.setHours(start.getHours() + 1); // default 1 hour

      openModal(null, start, end);
    });

    daysGridEl.appendChild(dayCol);
  }
}

function renderEvents() {
  // Clear existing events
  document.querySelectorAll('.event-block').forEach(el => el.remove());

  const dayColumns = daysGridEl.querySelectorAll('.day-column');
  
  for (let i = 0; i < 7; i++) {
    const dayDate = new Date(currentWeekStart);
    dayDate.setDate(dayDate.getDate() + i);
    const dayStart = startOfDay(dayDate);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);

    // Filter events for this day
    const dayEvents = events.filter(ev => {
      const evStart = new Date(ev.start_at);
      const evEnd = new Date(ev.end_at);
      return evStart < dayEnd && evEnd > dayStart;
    }).map(ev => {
      const evStart = new Date(ev.start_at);
      const evEnd = new Date(ev.end_at);
      
      // Clamp to day
      const clampedStart = evStart < dayStart ? dayStart : evStart;
      const clampedEnd = evEnd > dayEnd ? dayEnd : evEnd;

      return {
        ...ev,
        startMin: differenceInMinutes(clampedStart, dayStart),
        endMin: differenceInMinutes(clampedEnd, dayStart),
        originalStart: evStart,
        originalEnd: evEnd
      };
    });

    const positioned = layoutDayEvents(dayEvents);
    const dayCol = dayColumns[i];
    const dayContent = dayCol.querySelector('.day-content');

    for (const ev of positioned) {
      const block = document.createElement('div');
      block.className = 'event-block';
      block.style.top = `${ev.startMin * MINUTE_HEIGHT}px`;
      block.style.height = `${(ev.endMin - ev.startMin) * MINUTE_HEIGHT}px`;
      block.style.left = `${ev.leftPct}%`;
      block.style.width = `${ev.widthPct}%`;

      const titleEl = document.createElement('div');
      titleEl.className = 'event-title';
      titleEl.textContent = ev.title;

      const timeEl = document.createElement('div');
      timeEl.className = 'event-time';
      timeEl.textContent = `${format(ev.originalStart, 'HH:mm')} - ${format(ev.originalEnd, 'HH:mm')}`;

      block.appendChild(titleEl);
      block.appendChild(timeEl);

      block.addEventListener('click', (e) => {
        e.stopPropagation();
        openModal(ev);
      });

      dayContent.appendChild(block);
    }
  }
}

async function loadWeek() {
  const weekEndLabel = endOfWeek(currentWeekStart, { weekStarts: 1 });
  const weekEndFetch = addWeeks(currentWeekStart, 1);
  currentWeekLabel.textContent = `${format(currentWeekStart, 'MMM d')} - ${format(weekEndLabel, 'MMM d, yyyy')}`;
  
  renderGrid();

  try {
    events = await fetchEvents(currentWeekStart.toISOString(), weekEndFetch.toISOString());
    renderEvents();
  } catch (err) {
    console.error(err);
  }
}

// Init
loadWeek();