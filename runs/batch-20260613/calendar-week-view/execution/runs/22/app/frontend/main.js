import { layoutEventsForDay } from './layout.js';
import { api } from './api.js';

// ── Constants ──
const HOUR_HEIGHT = 60; // pixels per hour
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const FULL_DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// ── State ──
let currentWeekStart = getMonday(new Date());
let events = [];
let editingEventId = null;

// ── DOM refs ──
const weekTitle = document.getElementById('week-title');
const timeGutter = document.getElementById('time-gutter');
const daysContainer = document.getElementById('days-container');
const modalOverlay = document.getElementById('modal-overlay');
const modalTitle = document.getElementById('modal-title');
const eventForm = document.getElementById('event-form');
const eventTitleInput = document.getElementById('event-title');
const eventStartInput = document.getElementById('event-start');
const eventEndInput = document.getElementById('event-end');
const formError = document.getElementById('form-error');
const btnSave = document.getElementById('btn-save');
const btnDelete = document.getElementById('btn-delete');
const btnCancel = document.getElementById('btn-cancel');
const btnPrev = document.getElementById('btn-prev');
const btnToday = document.getElementById('btn-today');
const btnNext = document.getElementById('btn-next');

// ── Date Utilities ──

function getMonday(d) {
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  const day = date.getDay(); // 0=Sun, 1=Mon, ...
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  return date;
}

function addDays(d, n) {
  const date = new Date(d);
  date.setDate(date.getDate() + n);
  return date;
}

function formatDate(d) {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatDateISO(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isSameDay(d1, d2) {
  return d1.getFullYear() === d2.getFullYear() &&
         d1.getMonth() === d2.getMonth() &&
         d1.getDate() === d2.getDate();
}

function formatTime(d) {
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function toLocalDatetimeString(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const mins = String(d.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${mins}`;
}

function minutesFromMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

// ── Rendering ──

function renderTimeGutter() {
  timeGutter.innerHTML = '';
  // Need a spacer for the header height
  const headerSpacer = document.createElement('div');
  headerSpacer.style.height = '54px'; // Match day-header height
  headerSpacer.style.flexShrink = '0';
  timeGutter.appendChild(headerSpacer);

  const gutterBody = document.createElement('div');
  gutterBody.style.position = 'relative';
  gutterBody.style.height = `${HOUR_HEIGHT * 24}px`;
  timeGutter.appendChild(gutterBody);

  for (let h = 0; h <= 24; h++) {
    const label = document.createElement('div');
    label.className = 'hour-label';
    label.style.top = `${h * HOUR_HEIGHT}px`;
    label.textContent = `${String(h).padStart(2, '0')}:00`;
    gutterBody.appendChild(label);
  }
}

function renderWeek() {
  const weekEnd = addDays(currentWeekStart, 6);
  const startStr = formatDate(currentWeekStart);
  const endStr = formatDate(weekEnd);
  const year = currentWeekStart.getFullYear();
  weekTitle.textContent = `${startStr} – ${endStr}, ${year}`;

  daysContainer.innerHTML = '';
  const today = new Date();

  for (let i = 0; i < 7; i++) {
    const dayDate = addDays(currentWeekStart, i);
    const col = document.createElement('div');
    col.className = 'day-column';
    col.dataset.dayIndex = i;

    if (isSameDay(dayDate, today)) {
      col.classList.add('today');
    }

    // Header
    const header = document.createElement('div');
    header.className = 'day-header';
    header.innerHTML = `
      <div class="day-name">${DAY_NAMES[i]}</div>
      <div class="day-number">${dayDate.getDate()}</div>
    `;
    col.appendChild(header);

    // Body with hour lines
    const body = document.createElement('div');
    body.className = 'day-body';
    body.style.height = `${HOUR_HEIGHT * 24}px`;
    body.dataset.date = formatDateISO(dayDate);

    for (let h = 0; h < 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${h * HOUR_HEIGHT}px`;
      body.appendChild(line);

      const halfLine = document.createElement('div');
      halfLine.className = 'hour-line half';
      halfLine.style.top = `${h * HOUR_HEIGHT + HOUR_HEIGHT / 2}px`;
      body.appendChild(halfLine);
    }

    // Bottom line at 24:00
    const bottomLine = document.createElement('div');
    bottomLine.className = 'hour-line';
    bottomLine.style.top = `${24 * HOUR_HEIGHT}px`;
    body.appendChild(bottomLine);

    // Attach mouse handlers for click-drag selection
    setupDayBodyInteraction(body, dayDate);

    col.appendChild(body);
    daysContainer.appendChild(col);
  }
}

function renderEvents() {
  // Remove existing event blocks
  document.querySelectorAll('.event-block').forEach(el => el.remove());

  // Group events by day
  for (let i = 0; i < 7; i++) {
    const dayDate = addDays(currentWeekStart, i);
    const dayStart = new Date(dayDate);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayDate);
    dayEnd.setHours(24, 0, 0, 0);

    // Filter events that overlap this day
    const dayEvents = events.filter(ev => {
      const evStart = new Date(ev.start_at);
      const evEnd = new Date(ev.end_at);
      return evStart < dayEnd && evEnd > dayStart;
    }).map(ev => {
      const evStart = new Date(ev.start_at);
      const evEnd = new Date(ev.end_at);
      // Clamp to day boundaries
      const clampedStart = evStart < dayStart ? dayStart : evStart;
      const clampedEnd = evEnd > dayEnd ? dayEnd : evEnd;
      return {
        ...ev,
        _clampedStart: clampedStart,
        _clampedEnd: clampedEnd,
        _startMinutes: minutesFromMidnight(clampedStart),
        _endMinutes: clampedEnd.getTime() === dayEnd.getTime() ? 24 * 60 : minutesFromMidnight(clampedEnd)
      };
    });

    if (dayEvents.length === 0) continue;

    // Run layout algorithm
    const layoutResult = layoutEventsForDay(dayEvents);

    // Find the day body
    const dayBody = daysContainer.children[i]?.querySelector('.day-body');
    if (!dayBody) continue;

    for (const item of layoutResult) {
      const ev = item.event;
      const block = document.createElement('div');
      block.className = `event-block event-color-${ev.id % 7}`;

      const top = (ev._startMinutes / (24 * 60)) * (HOUR_HEIGHT * 24);
      const height = ((ev._endMinutes - ev._startMinutes) / (24 * 60)) * (HOUR_HEIGHT * 24);

      block.style.top = `${top}px`;
      block.style.height = `${height}px`;
      block.style.left = `${item.leftPercent}%`;
      block.style.width = `${item.widthPercent}%`;

      const startTime = formatTime(new Date(ev.start_at));
      const endTime = formatTime(new Date(ev.end_at));

      block.innerHTML = `
        <div class="event-title">${escapeHtml(ev.title)}</div>
        <div class="event-time">${startTime} – ${endTime}</div>
      `;

      block.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditModal(ev);
      });

      dayBody.appendChild(block);
    }
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ── Day Body Interaction (click-drag to create) ──

function setupDayBodyInteraction(dayBody, dayDate) {
  let isDragging = false;
  let startY = 0;
  let selectionEl = null;

  function yToMinutes(y) {
    const totalHeight = HOUR_HEIGHT * 24;
    const ratio = Math.max(0, Math.min(1, y / totalHeight));
    // Snap to nearest 15 minutes
    const rawMinutes = ratio * 24 * 60;
    return Math.round(rawMinutes / 15) * 15;
  }

  dayBody.addEventListener('mousedown', (e) => {
    if (e.target.closest('.event-block')) return;
    isDragging = true;
    const rect = dayBody.getBoundingClientRect();
    startY = e.clientY - rect.top;

    selectionEl = document.createElement('div');
    selectionEl.className = 'selection-overlay';
    const top = startY;
    selectionEl.style.top = `${top}px`;
    selectionEl.style.height = '0px';
    dayBody.appendChild(selectionEl);

    e.preventDefault();
  });

  dayBody.addEventListener('mousemove', (e) => {
    if (!isDragging || !selectionEl) return;
    const rect = dayBody.getBoundingClientRect();
    const currentY = e.clientY - rect.top;

    const minY = Math.min(startY, currentY);
    const maxY = Math.max(startY, currentY);

    selectionEl.style.top = `${minY}px`;
    selectionEl.style.height = `${maxY - minY}px`;
  });

  const endDrag = (e) => {
    if (!isDragging) return;
    isDragging = false;

    if (selectionEl) {
      selectionEl.remove();
      selectionEl = null;
    }

    const rect = dayBody.getBoundingClientRect();
    const endY = e.clientY - rect.top;

    const startMinutes = yToMinutes(Math.min(startY, endY));
    let endMinutes = yToMinutes(Math.max(startY, endY));

    // If click (no drag), create a 1-hour event
    if (endMinutes - startMinutes < 15) {
      endMinutes = Math.min(startMinutes + 60, 24 * 60);
    }

    // Clamp
    const clampedEnd = Math.min(endMinutes, 24 * 60);

    if (clampedEnd <= startMinutes) return;

    const startDate = new Date(dayDate);
    startDate.setHours(0, 0, 0, 0);
    startDate.setMinutes(startMinutes);

    const endDate = new Date(dayDate);
    endDate.setHours(0, 0, 0, 0);
    endDate.setMinutes(clampedEnd);

    openCreateModal(startDate, endDate);
  };

  dayBody.addEventListener('mouseup', endDrag);
  dayBody.addEventListener('mouseleave', (e) => {
    if (isDragging) {
      // Clean up selection visual but don't open modal
      isDragging = false;
      if (selectionEl) {
        selectionEl.remove();
        selectionEl = null;
      }
    }
  });
}

// ── Modal Handling ──

function openCreateModal(startDate, endDate) {
  editingEventId = null;
  modalTitle.textContent = 'Create Event';
  eventTitleInput.value = '';
  eventStartInput.value = toLocalDatetimeString(startDate);
  eventEndInput.value = toLocalDatetimeString(endDate);
  formError.textContent = '';
  btnDelete.style.display = 'none';
  btnSave.textContent = 'Create';
  modalOverlay.classList.add('active');
  eventTitleInput.focus();
}

function openEditModal(ev) {
  editingEventId = ev.id;
  modalTitle.textContent = 'Edit Event';
  eventTitleInput.value = ev.title;
  eventStartInput.value = toLocalDatetimeString(new Date(ev.start_at));
  eventEndInput.value = toLocalDatetimeString(new Date(ev.end_at));
  formError.textContent = '';
  btnDelete.style.display = 'inline-block';
  btnSave.textContent = 'Save';
  modalOverlay.classList.add('active');
  eventTitleInput.focus();
}

function closeModal() {
  modalOverlay.classList.remove('active');
  editingEventId = null;
  formError.textContent = '';
}

// ── Event Handlers ──

eventForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  formError.textContent = '';

  const title = eventTitleInput.value.trim();
  const start_at = eventStartInput.value;
  const end_at = eventEndInput.value;

  if (!title) {
    formError.textContent = 'Title is required.';
    return;
  }

  if (!start_at || !end_at) {
    formError.textContent = 'Start and end times are required.';
    return;
  }

  const startDate = new Date(start_at);
  const endDate = new Date(end_at);

  if (endDate <= startDate) {
    formError.textContent = 'End time must be after start time.';
    return;
  }

  try {
    if (editingEventId) {
      await api.updateEvent(editingEventId, {
        title,
        start_at: startDate.toISOString(),
        end_at: endDate.toISOString()
      });
    } else {
      await api.createEvent({
        title,
        start_at: startDate.toISOString(),
        end_at: endDate.toISOString()
      });
    }
    closeModal();
    await loadEvents();
  } catch (err) {
    formError.textContent = err.message || 'Failed to save event.';
  }
});

btnDelete.addEventListener('click', async () => {
  if (!editingEventId) return;
  if (!confirm('Delete this event?')) return;

  try {
    await api.deleteEvent(editingEventId);
    closeModal();
    await loadEvents();
  } catch (err) {
    formError.textContent = err.message || 'Failed to delete event.';
  }
});

btnCancel.addEventListener('click', closeModal);

modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeModal();
});

// Navigation
btnPrev.addEventListener('click', () => {
  currentWeekStart = addDays(currentWeekStart, -7);
  renderWeek();
  loadEvents();
});

btnToday.addEventListener('click', () => {
  currentWeekStart = getMonday(new Date());
  renderWeek();
  loadEvents();
});

btnNext.addEventListener('click', () => {
  currentWeekStart = addDays(currentWeekStart, 7);
  renderWeek();
  loadEvents();
});

// ── Data Loading ──

async function loadEvents() {
  const weekStart = currentWeekStart;
  const weekEnd = addDays(weekStart, 7);

  try {
    events = await api.getEvents(weekStart.toISOString(), weekEnd.toISOString());
    renderEvents();
  } catch (err) {
    console.error('Failed to load events:', err);
  }
}

// ── Initialize ──

function init() {
  renderTimeGutter();
  renderWeek();
  loadEvents();
}

init();
