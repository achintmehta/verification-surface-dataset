import { fetchEvents, createEvent, updateEvent, deleteEvent } from './api.js';
import { computeLayout, minutesInDay } from './layout.js';

// Constants
const HOUR_HEIGHT = 60; // pixels per hour
const TOTAL_HEIGHT = HOUR_HEIGHT * 24; // total day body height
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// State
let currentWeekStart = getMonday(new Date());
let events = [];
let editingEventId = null;

// DOM elements
const weekTitle = document.getElementById('week-title');
const weekGrid = document.getElementById('week-grid');
const timeGutter = document.getElementById('time-gutter');
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

// ---- Date Utilities ----

function getMonday(d) {
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  const day = date.getDay();
  // JS: 0=Sun, 1=Mon, ..., 6=Sat
  // We want Monday. If day=0 (Sunday), go back 6 days.
  const diff = day === 0 ? 6 : day - 1;
  date.setDate(date.getDate() - diff);
  return date;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function formatDate(date) {
  return date.getDate();
}

function formatMonth(date) {
  return MONTH_NAMES[date.getMonth()];
}

function formatYear(date) {
  return date.getFullYear();
}

function isSameDay(d1, d2) {
  return d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate();
}

function formatTime(hours, minutes) {
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function formatDateTimeLocal(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${d}T${h}:${mi}`;
}

// Format ISO string for API (local time, no timezone offset)
function toLocalISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${d}T${h}:${mi}:${s}`;
}

function parseEventDate(str) {
  // Parse "YYYY-MM-DDTHH:MM:SS" as local time
  const parts = str.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!parts) return new Date(str);
  return new Date(
    parseInt(parts[1]),
    parseInt(parts[2]) - 1,
    parseInt(parts[3]),
    parseInt(parts[4]),
    parseInt(parts[5]),
    parseInt(parts[6])
  );
}

// ---- Time Gutter ----

function renderTimeGutter() {
  timeGutter.innerHTML = '';
  // Add a spacer for the header area
  const spacer = document.createElement('div');
  spacer.style.height = '60px'; // Match day header height
  spacer.style.borderBottom = '2px solid #ddd';
  spacer.style.background = '#fafafa';
  timeGutter.appendChild(spacer);

  const gutterBody = document.createElement('div');
  gutterBody.style.position = 'relative';
  gutterBody.style.height = TOTAL_HEIGHT + 'px';
  timeGutter.appendChild(gutterBody);

  for (let h = 0; h <= 24; h++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.textContent = formatTime(h % 24, 0);
    label.style.top = (h * HOUR_HEIGHT) + 'px';
    gutterBody.appendChild(label);
  }
}

// ---- Week Grid ----

function renderWeekGrid() {
  weekGrid.innerHTML = '';
  const today = new Date();

  // Update title
  const weekEnd = addDays(currentWeekStart, 6);
  const startMonth = formatMonth(currentWeekStart);
  const endMonth = formatMonth(weekEnd);
  const startYear = formatYear(currentWeekStart);
  const endYear = formatYear(weekEnd);

  let titleStr = '';
  if (startYear !== endYear) {
    titleStr = `${startMonth} ${formatDate(currentWeekStart)}, ${startYear} – ${endMonth} ${formatDate(weekEnd)}, ${endYear}`;
  } else if (startMonth !== endMonth) {
    titleStr = `${startMonth} ${formatDate(currentWeekStart)} – ${endMonth} ${formatDate(weekEnd)}, ${startYear}`;
  } else {
    titleStr = `${startMonth} ${formatDate(currentWeekStart)} – ${formatDate(weekEnd)}, ${startYear}`;
  }
  weekTitle.textContent = titleStr;

  for (let i = 0; i < 7; i++) {
    const dayDate = addDays(currentWeekStart, i);
    const col = document.createElement('div');
    col.className = 'day-column';
    if (isSameDay(dayDate, today)) {
      col.classList.add('is-today');
    }

    // Header
    const header = document.createElement('div');
    header.className = 'day-header';
    header.innerHTML = `
      <span class="day-name">${DAY_NAMES[i]}</span>
      <span class="day-date">${formatDate(dayDate)}</span>
    `;
    col.appendChild(header);

    // Body
    const body = document.createElement('div');
    body.className = 'day-body';
    body.style.height = TOTAL_HEIGHT + 'px';
    body.dataset.dayIndex = i;
    body.dataset.dayDate = toLocalISO(dayDate);

    // Hour lines
    for (let h = 0; h < 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = (h * HOUR_HEIGHT) + 'px';
      body.appendChild(line);

      // Half-hour line
      const halfLine = document.createElement('div');
      halfLine.className = 'hour-line half';
      halfLine.style.top = (h * HOUR_HEIGHT + HOUR_HEIGHT / 2) + 'px';
      body.appendChild(halfLine);
    }
    // Bottom line at 24:00
    const bottomLine = document.createElement('div');
    bottomLine.className = 'hour-line';
    bottomLine.style.top = TOTAL_HEIGHT + 'px';
    body.appendChild(bottomLine);

    // Current time line for today
    if (isSameDay(dayDate, today)) {
      const now = new Date();
      const mins = now.getHours() * 60 + now.getMinutes();
      const timeLine = document.createElement('div');
      timeLine.className = 'current-time-line';
      timeLine.style.top = (mins / 60 * HOUR_HEIGHT) + 'px';
      body.appendChild(timeLine);
    }

    col.appendChild(body);
    weekGrid.appendChild(col);

    // Attach drag-to-select handlers
    setupDayBodyInteraction(body, dayDate);
  }
}

// ---- Event Rendering ----

function renderEvents() {
  // Clear existing event blocks
  document.querySelectorAll('.event-block').forEach(el => el.remove());

  const dayBodies = document.querySelectorAll('.day-body');

  for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
    const dayStart = addDays(currentWeekStart, dayIdx);
    const dayEnd = addDays(dayStart, 1);
    const dayBody = dayBodies[dayIdx];

    // Filter events for this day
    const dayEvents = events
      .map(ev => {
        const start = parseEventDate(ev.start_at);
        const end = parseEventDate(ev.end_at);
        // Clamp to this day
        const clampedStart = new Date(Math.max(start.getTime(), dayStart.getTime()));
        const clampedEnd = new Date(Math.min(end.getTime(), dayEnd.getTime()));

        if (clampedStart >= clampedEnd) return null; // doesn't actually appear this day

        return {
          id: ev.id,
          title: ev.title,
          originalStart: start,
          originalEnd: end,
          startMin: minutesInDay(clampedStart, dayStart),
          endMin: minutesInDay(clampedEnd, dayStart),
        };
      })
      .filter(Boolean);

    if (dayEvents.length === 0) continue;

    // Compute layout
    const layoutMap = computeLayout(dayEvents);

    // Render each event
    for (const ev of dayEvents) {
      const layout = layoutMap.get(ev.id);
      if (!layout) continue;

      const top = (ev.startMin / 60) * HOUR_HEIGHT;
      const height = ((ev.endMin - ev.startMin) / 60) * HOUR_HEIGHT;

      const widthPercent = 100 / layout.totalColumns;
      const leftPercent = layout.column * widthPercent;

      const block = document.createElement('div');
      block.className = 'event-block';
      block.style.top = top + 'px';
      block.style.height = Math.max(height, 2) + 'px'; // minimum 2px visibility
      block.style.left = leftPercent + '%';
      block.style.width = `calc(${widthPercent}% - 2px)`; // small gap between events
      block.style.right = 'auto';
      block.dataset.eventId = ev.id;

      const startH = Math.floor(ev.startMin / 60);
      const startM = ev.startMin % 60;
      const endH = Math.floor(ev.endMin / 60);
      const endM = ev.endMin % 60;

      // Use the clamped start/end for display within this day column
      const displayStartH = Math.floor(ev.startMin / 60);
      const displayStartM = Math.round(ev.startMin % 60);
      const displayEndH = Math.floor(ev.endMin / 60);
      const displayEndM = Math.round(ev.endMin % 60);

      block.innerHTML = `
        <div class="event-title">${escapeHtml(ev.title)}</div>
        <div class="event-time">${formatTime(displayStartH, displayStartM)} – ${formatTime(displayEndH, displayEndM)}</div>
      `;

      block.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditForm(ev.id);
      });

      dayBody.appendChild(block);
    }
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---- Drag-to-select on day body ----

function setupDayBodyInteraction(dayBody, dayDate) {
  let isDragging = false;
  let startMinutes = 0;
  let selectionEl = null;

  function clientYToMinutes(clientY) {
    const rect = dayBody.getBoundingClientRect();
    const relY = clientY - rect.top;
    const minutes = (relY / TOTAL_HEIGHT) * 1440;
    // Snap to 15-minute intervals
    return Math.max(0, Math.min(1440, Math.round(minutes / 15) * 15));
  }

  function clientYToPixelOffset(clientY) {
    const rect = dayBody.getBoundingClientRect();
    return Math.max(0, Math.min(TOTAL_HEIGHT, clientY - rect.top));
  }

  let startPixel = 0;

  dayBody.addEventListener('mousedown', (e) => {
    if (e.target.closest('.event-block')) return;
    if (e.button !== 0) return;

    isDragging = true;
    startMinutes = clientYToMinutes(e.clientY);
    startPixel = clientYToPixelOffset(e.clientY);

    selectionEl = document.createElement('div');
    selectionEl.className = 'selection-overlay';
    dayBody.appendChild(selectionEl);

    updateSelection(e.clientY);
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging || !selectionEl) return;
    updateSelection(e.clientY);
  });

  document.addEventListener('mouseup', (e) => {
    if (!isDragging || !selectionEl) return;
    isDragging = false;

    const endMinutes = clientYToMinutes(e.clientY);

    const actualStart = Math.min(startMinutes, endMinutes);
    let actualEnd = Math.max(startMinutes, endMinutes);

    // If click (no drag), default to 1-hour event
    if (actualEnd === actualStart) {
      actualEnd = Math.min(actualStart + 60, 1440);
    }

    if (selectionEl && selectionEl.parentNode) {
      selectionEl.remove();
    }
    selectionEl = null;

    if (actualEnd > actualStart) {
      const startDate = new Date(dayDate);
      startDate.setHours(0, actualStart, 0, 0);
      const endDate = new Date(dayDate);
      endDate.setHours(0, actualEnd, 0, 0);
      openCreateForm(startDate, endDate);
    }
  });

  function updateSelection(currentY) {
    const currentPixel = clientYToPixelOffset(currentY);
    const top = Math.min(startPixel, currentPixel);
    const bottom = Math.max(startPixel, currentPixel);
    selectionEl.style.top = top + 'px';
    selectionEl.style.height = (bottom - top) + 'px';
  }
}

// ---- Modal / Form ----

function openCreateForm(startDate, endDate) {
  editingEventId = null;
  modalTitle.textContent = 'Create Event';
  eventTitleInput.value = '';
  eventStartInput.value = formatDateTimeLocal(startDate);
  eventEndInput.value = formatDateTimeLocal(endDate);
  btnDelete.style.display = 'none';
  btnSave.textContent = 'Create';
  formError.style.display = 'none';
  modalOverlay.style.display = 'flex';
  eventTitleInput.focus();
}

function openEditForm(eventId) {
  const ev = events.find(e => e.id === eventId);
  if (!ev) return;

  editingEventId = eventId;
  modalTitle.textContent = 'Edit Event';
  eventTitleInput.value = ev.title;
  eventStartInput.value = formatDateTimeLocal(parseEventDate(ev.start_at));
  eventEndInput.value = formatDateTimeLocal(parseEventDate(ev.end_at));
  btnDelete.style.display = 'inline-block';
  btnSave.textContent = 'Save';
  formError.style.display = 'none';
  modalOverlay.style.display = 'flex';
  eventTitleInput.focus();
}

function closeModal() {
  modalOverlay.style.display = 'none';
  editingEventId = null;
  formError.style.display = 'none';
}

function showFormError(msg) {
  formError.textContent = msg;
  formError.style.display = 'block';
}

// ---- Form Submission ----

eventForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const title = eventTitleInput.value.trim();
  const startStr = eventStartInput.value;
  const endStr = eventEndInput.value;

  if (!title) {
    showFormError('Title is required.');
    return;
  }

  const start = new Date(startStr);
  const end = new Date(endStr);

  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    showFormError('Invalid date/time.');
    return;
  }

  if (end <= start) {
    showFormError('End time must be after start time.');
    return;
  }

  const payload = {
    title,
    start_at: toLocalISO(start),
    end_at: toLocalISO(end),
  };

  try {
    if (editingEventId) {
      await updateEvent(editingEventId, payload);
    } else {
      await createEvent(payload);
    }
    closeModal();
    await loadAndRender();
  } catch (err) {
    showFormError(err.message);
  }
});

btnDelete.addEventListener('click', async () => {
  if (!editingEventId) return;
  try {
    await deleteEvent(editingEventId);
    closeModal();
    await loadAndRender();
  } catch (err) {
    showFormError(err.message);
  }
});

btnCancel.addEventListener('click', closeModal);

modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeModal();
});

// Close on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modalOverlay.style.display !== 'none') {
    closeModal();
  }
});

// ---- Navigation ----

document.getElementById('btn-prev').addEventListener('click', () => {
  currentWeekStart = addDays(currentWeekStart, -7);
  loadAndRender();
});

document.getElementById('btn-today').addEventListener('click', () => {
  currentWeekStart = getMonday(new Date());
  loadAndRender();
});

document.getElementById('btn-next').addEventListener('click', () => {
  currentWeekStart = addDays(currentWeekStart, 7);
  loadAndRender();
});

// ---- Data Loading ----

async function loadAndRender() {
  const weekEnd = addDays(currentWeekStart, 7);
  try {
    events = await fetchEvents(currentWeekStart, weekEnd);
  } catch (err) {
    console.error('Failed to load events:', err);
    events = [];
  }
  renderWeekGrid();
  renderEvents();
}

// ---- Init ----

renderTimeGutter();
loadAndRender();

// Update current time line every minute
setInterval(() => {
  const timeLine = document.querySelector('.current-time-line');
  if (timeLine) {
    const now = new Date();
    const mins = now.getHours() * 60 + now.getMinutes();
    timeLine.style.top = (mins / 60 * HOUR_HEIGHT) + 'px';
  }
}, 60000);
