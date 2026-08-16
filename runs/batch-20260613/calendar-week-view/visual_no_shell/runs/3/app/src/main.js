import './style.css';
import { fetchEvents, createEvent, updateEvent, deleteEvent } from './api.js';
import { computeDayLayout, getMinutesStart, getMinutesEnd } from './layout.js';
import {
  getWeekStart, getWeekEnd, getWeekDays,
  formatWeekLabel, toDatetimeLocal, formatTime,
  isToday, pixelToTime, snapMinutes,
} from './dates.js';

// ===== Constants =====
const HOUR_HEIGHT  = 60;   // px per hour — must match CSS --hour-height
const TOTAL_HOURS  = 24;
const TOTAL_HEIGHT = HOUR_HEIGHT * TOTAL_HOURS;
const DAY_NAMES    = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ===== State =====
let currentWeekStart = getWeekStart(new Date());
let events           = [];
let firstLoad        = true;

// ===== DOM refs =====
const weekLabel       = document.getElementById('week-label');
const headerDays      = document.getElementById('header-days');
const timeGutter      = document.getElementById('time-gutter');
const daysGrid        = document.getElementById('days-grid');
const scrollArea      = document.getElementById('scroll-area');
const modalOverlay    = document.getElementById('modal-overlay');
const modalTitle      = document.getElementById('modal-title');
const eventForm       = document.getElementById('event-form');
const eventIdInput    = document.getElementById('event-id');
const eventTitleInput = document.getElementById('event-title');
const eventStartInput = document.getElementById('event-start');
const eventEndInput   = document.getElementById('event-end');
const formError       = document.getElementById('form-error');
const btnDelete       = document.getElementById('btn-delete');
const btnCancel       = document.getElementById('btn-cancel');

// ===== Navigation =====
document.getElementById('btn-prev').addEventListener('click', () => {
  currentWeekStart = new Date(currentWeekStart);
  currentWeekStart.setDate(currentWeekStart.getDate() - 7);
  loadWeek();
});
document.getElementById('btn-today').addEventListener('click', () => {
  currentWeekStart = getWeekStart(new Date());
  loadWeek();
});
document.getElementById('btn-next').addEventListener('click', () => {
  currentWeekStart = new Date(currentWeekStart);
  currentWeekStart.setDate(currentWeekStart.getDate() + 7);
  loadWeek();
});

// ===== Load & Render =====
async function loadWeek() {
  const weekEnd = getWeekEnd(currentWeekStart);
  weekLabel.textContent = formatWeekLabel(currentWeekStart, weekEnd);

  try {
    events = await fetchEvents(currentWeekStart.toISOString(), weekEnd.toISOString());
  } catch (err) {
    console.error('Failed to load events:', err);
    events = [];
  }

  renderGrid();
}

function renderGrid() {
  renderTimeGutter();
  renderDayHeaders();
  renderDayColumns();
}

// ===== Time Gutter =====
function renderTimeGutter() {
  timeGutter.innerHTML = '';
  timeGutter.style.height = `${TOTAL_HEIGHT}px`;

  for (let h = 1; h <= TOTAL_HOURS; h++) {
    const label = document.createElement('div');
    label.className = 'hour-label';
    label.style.top = `${h * HOUR_HEIGHT}px`;
    // h=24 wraps to midnight label
    label.textContent = formatHourLabel(h < 24 ? h : 0);
    timeGutter.appendChild(label);
  }
}

function formatHourLabel(h) {
  if (h === 0)  return '12 AM';
  if (h === 12) return '12 PM';
  if (h < 12)   return `${h} AM`;
  return `${h - 12} PM`;
}

// ===== Day Headers (sticky) =====
function renderDayHeaders() {
  headerDays.innerHTML = '';
  const weekDays = getWeekDays(currentWeekStart);

  weekDays.forEach((day, i) => {
    const hdr = document.createElement('div');
    hdr.className = 'day-header';
    if (isToday(day)) hdr.classList.add('today');

    const nameEl = document.createElement('div');
    nameEl.className   = 'day-name';
    nameEl.textContent = DAY_NAMES[i];

    const numEl = document.createElement('div');
    numEl.className   = 'day-number';
    numEl.textContent = day.getDate();

    hdr.appendChild(nameEl);
    hdr.appendChild(numEl);
    headerDays.appendChild(hdr);
  });
}

// ===== Day Columns =====
function renderDayColumns() {
  daysGrid.innerHTML = '';
  const weekDays = getWeekDays(currentWeekStart);

  weekDays.forEach((day) => {
    const col = document.createElement('div');
    col.className = 'day-column';
    if (isToday(day)) col.classList.add('today');

    const body = document.createElement('div');
    body.className = 'day-body';

    // Hour and half-hour grid lines
    for (let h = 0; h <= TOTAL_HOURS; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${h * HOUR_HEIGHT}px`;
      body.appendChild(line);

      if (h < TOTAL_HOURS) {
        const half = document.createElement('div');
        half.className = 'half-hour-line';
        half.style.top = `${h * HOUR_HEIGHT + HOUR_HEIGHT / 2}px`;
        body.appendChild(half);
      }
    }

    // Render events for this day
    const dayEvents = getEventsForDay(day);
    renderDayEvents(body, day, dayEvents);

    // Drag-to-create interaction
    setupDragToCreate(body, day);

    col.appendChild(body);
    daysGrid.appendChild(col);
  });

  // Scroll to appropriate position on first load
  if (firstLoad) {
    firstLoad = false;
    requestAnimationFrame(() => {
      const params = new URLSearchParams(window.location.search);
      const scrollHour = parseInt(params.get('scroll') || '6', 10);
      scrollArea.scrollTop = Math.max(0, scrollHour * HOUR_HEIGHT);
    });
  }
}

// ===== Event Filtering =====
function getEventsForDay(day) {
  const dayStart = new Date(day); dayStart.setHours(0, 0, 0, 0);
  const dayEnd   = new Date(day); dayEnd.setHours(24, 0, 0, 0);

  return events.filter(ev => {
    const s = new Date(ev.start_at);
    const e = new Date(ev.end_at);
    return s < dayEnd && e > dayStart;
  });
}

// ===== Event Rendering =====
function renderDayEvents(bodyEl, day, dayEvents) {
  bodyEl.querySelectorAll('.event-block').forEach(el => el.remove());
  if (dayEvents.length === 0) return;

  const dayStart = new Date(day); dayStart.setHours(0, 0, 0, 0);
  const dayEnd   = new Date(day); dayEnd.setHours(24, 0, 0, 0);

  // Clamp event times to this day's boundaries for layout computation
  const clampedEvents = dayEvents.map(ev => ({
    ...ev,
    start_at: new Date(Math.max(new Date(ev.start_at).getTime(), dayStart.getTime())).toISOString(),
    end_at:   new Date(Math.min(new Date(ev.end_at).getTime(),   dayEnd.getTime())).toISOString(),
  }));

  const layout = computeDayLayout(clampedEvents);

  layout.forEach(({ event: clampedEv, left, width }) => {
    const origEv = dayEvents.find(e => e.id === clampedEv.id);
    const block  = createEventBlock(origEv, clampedEv, left, width);
    bodyEl.appendChild(block);
  });
}

function createEventBlock(originalEvent, clampedEvent, left, width) {
  const startMin = getMinutesStart(clampedEvent.start_at);
  const endMin   = getMinutesEnd(clampedEvent.end_at);

  const top    = (startMin / 60) * HOUR_HEIGHT;
  const height = Math.max(((endMin - startMin) / 60) * HOUR_HEIGHT, 18);

  const block = document.createElement('div');
  block.className     = 'event-block';
  block.dataset.id    = originalEvent.id;
  block.dataset.color = String(originalEvent.id % 8);

  // 1px gap on each side for visual separation between adjacent columns
  block.style.top    = `${top}px`;
  block.style.height = `${height}px`;
  block.style.left   = `calc(${left * 100}% + 1px)`;
  block.style.width  = `calc(${width * 100}% - 2px)`;
  block.style.zIndex = '10';

  const titleEl = document.createElement('div');
  titleEl.className   = 'event-title';
  titleEl.textContent = originalEvent.title;
  block.appendChild(titleEl);

  if (height >= 28) {
    const timeEl = document.createElement('div');
    timeEl.className   = 'event-time';
    timeEl.textContent = `${formatTime(originalEvent.start_at)} – ${formatTime(originalEvent.end_at)}`;
    block.appendChild(timeEl);
  }

  block.addEventListener('click', e => {
    e.stopPropagation();
    openEditModal(originalEvent);
  });

  return block;
}

// ===== Drag-to-create =====
function setupDragToCreate(bodyEl, day) {
  let dragStartY = null;
  let ghost      = null;
  let hasMoved   = false;

  bodyEl.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    if (e.target.closest('.event-block')) return;
    e.preventDefault();

    const y    = getBodyY(e, bodyEl);
    dragStartY = snapToGrid(clampY(y));
    hasMoved   = false;

    ghost = document.createElement('div');
    ghost.className    = 'drag-ghost';
    ghost.style.left   = '2px';
    ghost.style.right  = '2px';
    ghost.style.top    = `${dragStartY}px`;
    ghost.style.height = '1px';
    bodyEl.appendChild(ghost);

    const onMove = e2 => {
      hasMoved = true;
      const y2  = getBodyY(e2, bodyEl);
      const cur = snapToGrid(clampY(y2));
      const top = Math.min(dragStartY, cur);
      const h   = Math.abs(cur - dragStartY);
      ghost.style.top    = `${top}px`;
      ghost.style.height = `${Math.max(h, 1)}px`;
    };

    const onUp = e2 => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);

      if (ghost) { ghost.remove(); ghost = null; }

      const y2     = getBodyY(e2, bodyEl);
      const endY   = snapToGrid(clampY(y2));
      const startY = dragStartY;
      dragStartY   = null;

      const topY = Math.min(startY, endY);
      const botY = Math.max(startY, endY);

      const startTime = pixelToTime(day, topY, HOUR_HEIGHT);
      let   endTime   = pixelToTime(day, botY, HOUR_HEIGHT);

      // Short click (no meaningful drag) → default 1-hour event
      if (!hasMoved || botY - topY < HOUR_HEIGHT / 4) {
        endTime = new Date(startTime.getTime() + 60 * 60 * 1000);
      }

      // Clamp end to end of day (midnight)
      const midnight = new Date(day); midnight.setHours(24, 0, 0, 0);
      if (endTime > midnight) endTime = midnight;
      if (endTime <= startTime) return;

      openCreateModal(startTime, endTime);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });
}

function getBodyY(e, bodyEl) {
  const rect = bodyEl.getBoundingClientRect();
  return e.clientY - rect.top;
}

function clampY(y) {
  return Math.max(0, Math.min(TOTAL_HEIGHT, y));
}

function snapToGrid(y) {
  const minutes = (y / HOUR_HEIGHT) * 60;
  const snapped = snapMinutes(minutes, 15);
  return (snapped / 60) * HOUR_HEIGHT;
}

// ===== Modal =====
function openCreateModal(startTime, endTime) {
  modalTitle.textContent = 'New Event';
  eventIdInput.value     = '';
  eventTitleInput.value  = '';
  eventStartInput.value  = toDatetimeLocal(startTime);
  eventEndInput.value    = toDatetimeLocal(endTime);
  btnDelete.classList.add('hidden');
  hideFormError();
  modalOverlay.classList.remove('hidden');
  setTimeout(() => eventTitleInput.focus(), 50);
}

function openEditModal(event) {
  modalTitle.textContent = 'Edit Event';
  eventIdInput.value     = event.id;
  eventTitleInput.value  = event.title;
  eventStartInput.value  = toDatetimeLocal(new Date(event.start_at));
  eventEndInput.value    = toDatetimeLocal(new Date(event.end_at));
  btnDelete.classList.remove('hidden');
  hideFormError();
  modalOverlay.classList.remove('hidden');
  setTimeout(() => eventTitleInput.focus(), 50);
}

function closeModal() {
  modalOverlay.classList.add('hidden');
  eventForm.reset();
  hideFormError();
}

function showFormError(msg) {
  formError.textContent = msg;
  formError.classList.remove('hidden');
}

function hideFormError() {
  formError.textContent = '';
  formError.classList.add('hidden');
}

btnCancel.addEventListener('click', closeModal);
modalOverlay.addEventListener('click', e => {
  if (e.target === modalOverlay) closeModal();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModal();
});

// ===== Form Submit =====
eventForm.addEventListener('submit', async e => {
  e.preventDefault();
  hideFormError();

  const id       = eventIdInput.value;
  const title    = eventTitleInput.value.trim();
  const startVal = eventStartInput.value;
  const endVal   = eventEndInput.value;

  if (!title) { showFormError('Title is required.'); return; }
  if (!startVal || !endVal) { showFormError('Start and end times are required.'); return; }

  const startDate = new Date(startVal);
  const endDate   = new Date(endVal);

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    showFormError('Invalid date/time.'); return;
  }
  if (endDate <= startDate) {
    showFormError('End time must be after start time.'); return;
  }

  const payload = {
    title,
    start_at: startDate.toISOString(),
    end_at:   endDate.toISOString(),
  };

  try {
    if (id) {
      await updateEvent(id, payload);
    } else {
      await createEvent(payload);
    }
    closeModal();
    await loadWeek();
  } catch (err) {
    showFormError(err.message || 'Failed to save event.');
  }
});

// ===== Delete =====
btnDelete.addEventListener('click', async () => {
  const id = eventIdInput.value;
  if (!id) return;
  if (!confirm('Delete this event?')) return;

  try {
    await deleteEvent(id);
    closeModal();
    await loadWeek();
  } catch (err) {
    showFormError(err.message || 'Failed to delete event.');
  }
});

// ===== Boot =====
loadWeek();
