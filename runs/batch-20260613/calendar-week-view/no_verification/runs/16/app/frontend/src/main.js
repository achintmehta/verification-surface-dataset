import { startOfWeek, endOfWeek, addDays, subWeeks, addWeeks, format, isSameDay, startOfDay, differenceInMinutes } from 'date-fns';
import { fetchEvents, createEvent, updateEvent, deleteEvent } from './api.js';
import { layoutEvents } from './layout.js';

let currentDate = new Date();
let events = [];

const timeAxisEl = document.getElementById('time-axis');
const daysGridEl = document.getElementById('days-grid');
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

const PIXELS_PER_MINUTE = 1; // 1 minute = 1 pixel, so 24 hours = 1440 pixels

function init() {
  document.getElementById('prev-week').addEventListener('click', () => {
    currentDate = subWeeks(currentDate, 1);
    render();
  });
  document.getElementById('today').addEventListener('click', () => {
    currentDate = new Date();
    render();
  });
  document.getElementById('next-week').addEventListener('click', () => {
    currentDate = addWeeks(currentDate, 1);
    render();
  });

  cancelBtn.addEventListener('click', closeModal);
  form.addEventListener('submit', handleFormSubmit);
  deleteBtn.addEventListener('click', handleDelete);

  render();
}

async function render() {
  const start = startOfWeek(currentDate, { weekStartsOn: 1 });
  const end = endOfWeek(currentDate, { weekStartsOn: 1 });

  currentWeekLabel.textContent = `${format(start, 'MMM d, yyyy')} - ${format(end, 'MMM d, yyyy')}`;

  renderGrid(start);

  try {
    events = await fetchEvents(start.toISOString(), end.toISOString());
    renderEvents(start);
  } catch (err) {
    console.error(err);
  }
}

function renderGrid(weekStart) {
  timeAxisEl.innerHTML = '';
  daysGridEl.innerHTML = '';

  // Render time axis
  const timeHeader = document.createElement('div');
  timeHeader.className = 'day-header';
  timeHeader.style.borderBottom = '1px solid transparent';
  timeHeader.style.background = 'transparent';
  timeHeader.innerHTML = '&nbsp;';
  timeAxisEl.appendChild(timeHeader);

  const timeGridContent = document.createElement('div');
  timeGridContent.className = 'day-grid-content';
  timeAxisEl.appendChild(timeGridContent);

  for (let i = 0; i < 24; i++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = `${i * 60 * PIXELS_PER_MINUTE}px`;
    label.textContent = `${i.toString().padStart(2, '0')}:00`;
    timeGridContent.appendChild(label);
  }

  const today = new Date();

  // Render days
  for (let i = 0; i < 7; i++) {
    const dayDate = addDays(weekStart, i);
    const col = document.createElement('div');
    col.className = 'day-column';
    col.dataset.date = dayDate.toISOString();

    const header = document.createElement('div');
    header.className = 'day-header';
    if (isSameDay(dayDate, today)) {
      header.classList.add('today');
    }
    header.textContent = format(dayDate, 'EEE, MMM d');
    col.appendChild(header);

    const gridContent = document.createElement('div');
    gridContent.className = 'day-grid-content';
    col.appendChild(gridContent);

    // Hour lines
    for (let h = 0; h < 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${h * 60 * PIXELS_PER_MINUTE}px`;
      gridContent.appendChild(line);
    }

    // Click to create event
    gridContent.addEventListener('click', (e) => {
      if (e.target.closest('.event-block')) return; // Ignore clicks on events
      
      const rect = gridContent.getBoundingClientRect();
      const clickY = e.clientY - rect.top;
      
      if (clickY < 0) return;

      const minutes = Math.floor(clickY / PIXELS_PER_MINUTE);
      const startAt = new Date(dayDate);
      startAt.setHours(0, minutes, 0, 0);
      
      const endAt = new Date(startAt);
      endAt.setHours(startAt.getHours() + 1);

      openModal({ start_at: startAt, end_at: endAt });
    });

    daysGridEl.appendChild(col);
  }
}

function renderEvents(weekStart) {
  // Group events by day
  const eventsByDay = Array.from({ length: 7 }, () => []);

  for (const ev of events) {
    const evStart = new Date(ev.start_at);
    const evEnd = new Date(ev.end_at);
    
    // Find which day(s) this event belongs to
    for (let i = 0; i < 7; i++) {
      const dayDate = addDays(weekStart, i);
      const dayStart = startOfDay(dayDate);
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1);

      if (evStart < dayEnd && evEnd > dayStart) {
        // Event overlaps with this day
        // Clamp to day boundaries
        const clampedStart = evStart < dayStart ? dayStart : evStart;
        const clampedEnd = evEnd > dayEnd ? dayEnd : evEnd;
        
        eventsByDay[i].push({
          ...ev,
          _clampedStart: clampedStart,
          _clampedEnd: clampedEnd
        });
      }
    }
  }

  const columns = daysGridEl.querySelectorAll('.day-column');

  for (let i = 0; i < 7; i++) {
    const dayEvents = eventsByDay[i];
    // Layout needs to use clamped times for this day
    const layoutInput = dayEvents.map(ev => ({
      ...ev,
      start_at: ev._clampedStart.toISOString(),
      end_at: ev._clampedEnd.toISOString()
    }));

    const layouted = layoutEvents(layoutInput);
    const colEl = columns[i];
    const gridContent = colEl.querySelector('.day-grid-content');

    for (const ev of layouted) {
      const startMins = differenceInMinutes(new Date(ev.start_at), startOfDay(new Date(ev.start_at)));
      const endMins = differenceInMinutes(new Date(ev.end_at), startOfDay(new Date(ev.start_at)));
      
      const top = startMins * PIXELS_PER_MINUTE;
      const height = (endMins - startMins) * PIXELS_PER_MINUTE;

      const block = document.createElement('div');
      block.className = 'event-block';
      block.style.top = `${top}px`;
      block.style.height = `${height}px`;
      block.style.left = `calc(${ev._left * 100}% + 1px)`;
      block.style.width = `calc(${ev._width * 100}% - 2px)`;

      const titleEl = document.createElement('div');
      titleEl.className = 'event-title';
      titleEl.textContent = ev.title;

      const timeEl = document.createElement('div');
      timeEl.className = 'event-time';
      timeEl.textContent = `${format(new Date(ev.start_at), 'HH:mm')} - ${format(new Date(ev.end_at), 'HH:mm')}`;

      block.appendChild(titleEl);
      block.appendChild(timeEl);

      block.addEventListener('click', (e) => {
        e.stopPropagation();
        openModal(ev);
      });

      gridContent.appendChild(block);
    }
  }
}

function toLocalISOString(date) {
  const tzOffset = date.getTimezoneOffset() * 60000;
  const localISOTime = (new Date(date.getTime() - tzOffset)).toISOString().slice(0, 16);
  return localISOTime;
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
    eventStartInput.value = event ? toLocalISOString(new Date(event.start_at)) : '';
    eventEndInput.value = event ? toLocalISOString(new Date(event.end_at)) : '';
    deleteBtn.classList.add('hidden');
  }
}

function closeModal() {
  modal.classList.add('hidden');
}

async function handleFormSubmit(e) {
  e.preventDefault();
  const id = eventIdInput.value;
  const title = eventTitleInput.value.trim();
  
  if (!eventStartInput.value || !eventEndInput.value) {
    alert('Start and end times are required');
    return;
  }

  const start_at = new Date(eventStartInput.value).toISOString();
  const end_at = new Date(eventEndInput.value).toISOString();

  try {
    if (id) {
      await updateEvent(id, { title, start_at, end_at });
    } else {
      await createEvent({ title, start_at, end_at });
    }
    closeModal();
    render();
  } catch (err) {
    alert(err.message);
  }
}

async function handleDelete() {
  const id = eventIdInput.value;
  if (!id) return;
  try {
    await deleteEvent(id);
    closeModal();
    render();
  } catch (err) {
    alert(err.message);
  }
}

init();
