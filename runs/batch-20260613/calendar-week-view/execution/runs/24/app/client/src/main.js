import { computeDayLayout } from './layout.js';
import { fetchEvents, createEvent, updateEvent, deleteEvent } from './api.js';

// Constants
const HOUR_HEIGHT = 60; // px per hour
const TOTAL_HOURS = 24;
const AXIS_HEIGHT = HOUR_HEIGHT * TOTAL_HOURS; // 1440px
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// State
let currentWeekStart = getWeekStart(new Date());
let events = [];

// DOM References
const weekTitle = document.getElementById('week-title');
const timeGutter = document.getElementById('time-gutter');
const daysContainer = document.getElementById('days-container');
const modalOverlay = document.getElementById('modal-overlay');
const modalTitle = document.getElementById('modal-title');
const eventForm = document.getElementById('event-form');
const eventIdInput = document.getElementById('event-id');
const eventTitleInput = document.getElementById('event-title');
const eventStartInput = document.getElementById('event-start');
const eventEndInput = document.getElementById('event-end');
const formError = document.getElementById('form-error');
const btnSave = document.getElementById('btn-save');
const btnCancel = document.getElementById('btn-cancel');
const btnDelete = document.getElementById('btn-delete');
const btnPrev = document.getElementById('btn-prev');
const btnToday = document.getElementById('btn-today');
const btnNext = document.getElementById('btn-next');

/**
 * Get the Monday of the week containing the given date.
 */
function getWeekStart(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0=Sunday, 1=Monday, ...
  const diff = day === 0 ? -6 : 1 - day; // Monday
  d.setDate(d.getDate() + diff);
  return d;
}

function getWeekEnd(weekStart) {
  const end = new Date(weekStart);
  end.setDate(end.getDate() + 7);
  return end;
}

function getDayStart(weekStart, dayIndex) {
  const d = new Date(weekStart);
  d.setDate(d.getDate() + dayIndex);
  return d;
}

function formatTime(hours, minutes) {
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function formatDateForInput(date) {
  const d = new Date(date);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
}

function formatTimeShort(date) {
  const d = new Date(date);
  return formatTime(d.getHours(), d.getMinutes());
}

// Build time gutter
function buildTimeGutter() {
  // Add spacer for day header alignment
  const spacer = document.createElement('div');
  spacer.style.height = '50px'; // matches day-header-height
  spacer.style.borderBottom = '1px solid var(--border-color)';
  timeGutter.appendChild(spacer);

  const gutterBody = document.createElement('div');
  gutterBody.style.position = 'relative';
  gutterBody.style.height = `${AXIS_HEIGHT}px`;
  timeGutter.appendChild(gutterBody);

  for (let h = 0; h <= 24; h++) {
    const label = document.createElement('div');
    label.className = 'hour-label';
    label.style.top = `${h * HOUR_HEIGHT}px`;
    label.textContent = h === 0 ? '' : formatTime(h, 0);
    gutterBody.appendChild(label);
  }
}

// Build day columns
function buildDayColumns() {
  daysContainer.innerHTML = '';
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 0; i < 7; i++) {
    const dayDate = getDayStart(currentWeekStart, i);
    const col = document.createElement('div');
    col.className = 'day-column';
    col.dataset.dayIndex = i;

    // Check if today
    if (dayDate.getTime() === today.getTime()) {
      col.classList.add('today');
    }

    // Header
    const header = document.createElement('div');
    header.className = 'day-header';

    const dayName = document.createElement('span');
    dayName.className = 'day-name';
    dayName.textContent = DAY_NAMES[i];

    const dayNumber = document.createElement('span');
    dayNumber.className = 'day-number';
    dayNumber.textContent = dayDate.getDate();

    header.appendChild(dayName);
    header.appendChild(dayNumber);
    col.appendChild(header);

    // Body
    const body = document.createElement('div');
    body.className = 'day-body';
    body.dataset.dayIndex = i;
    body.style.height = `${AXIS_HEIGHT}px`;

    // Hour lines
    for (let h = 0; h < 24; h++) {
      const hourLine = document.createElement('div');
      hourLine.className = 'hour-line';
      hourLine.style.top = `${h * HOUR_HEIGHT}px`;
      body.appendChild(hourLine);

      const halfLine = document.createElement('div');
      halfLine.className = 'half-hour-line';
      halfLine.style.top = `${h * HOUR_HEIGHT + HOUR_HEIGHT / 2}px`;
      body.appendChild(halfLine);
    }

    // Bottom line
    const bottomLine = document.createElement('div');
    bottomLine.className = 'hour-line';
    bottomLine.style.top = `${24 * HOUR_HEIGHT}px`;
    body.appendChild(bottomLine);

    // Drag to create
    setupDragToCreate(body, i);

    col.appendChild(body);
    daysContainer.appendChild(col);
  }
}

// Update week title
function updateWeekTitle() {
  const start = currentWeekStart;
  const end = new Date(start);
  end.setDate(end.getDate() + 6);

  if (start.getMonth() === end.getMonth()) {
    weekTitle.textContent = `${MONTH_NAMES[start.getMonth()]} ${start.getDate()} – ${end.getDate()}, ${start.getFullYear()}`;
  } else if (start.getFullYear() === end.getFullYear()) {
    weekTitle.textContent = `${MONTH_NAMES[start.getMonth()]} ${start.getDate()} – ${MONTH_NAMES[end.getMonth()]} ${end.getDate()}, ${start.getFullYear()}`;
  } else {
    weekTitle.textContent = `${MONTH_NAMES[start.getMonth()]} ${start.getDate()}, ${start.getFullYear()} – ${MONTH_NAMES[end.getMonth()]} ${end.getDate()}, ${end.getFullYear()}`;
  }
}

// Render events
function renderEvents() {
  // Clear existing event blocks
  document.querySelectorAll('.event-block').forEach(el => el.remove());

  // Group events by day
  const eventsByDay = {};
  for (let i = 0; i < 7; i++) {
    eventsByDay[i] = [];
  }

  for (const event of events) {
    const eventStart = new Date(event.start_at);
    const eventEnd = new Date(event.end_at);

    // An event can span multiple days (clamp to each day)
    for (let i = 0; i < 7; i++) {
      const dayStart = getDayStart(currentWeekStart, i);
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1);

      // Check if event overlaps with this day
      if (eventStart < dayEnd && eventEnd > dayStart) {
        eventsByDay[i].push(event);
      }
    }
  }

  // Layout and render each day's events
  for (let i = 0; i < 7; i++) {
    const dayStart = getDayStart(currentWeekStart, i);
    const dayEvents = eventsByDay[i];
    const layoutItems = computeDayLayout(dayEvents, dayStart);

    const dayBody = document.querySelector(`.day-body[data-day-index="${i}"]`);
    if (!dayBody) continue;

    for (const item of layoutItems) {
      const block = document.createElement('div');
      block.className = 'event-block';

      // Position: top and height from fractions of the day
      const topPx = item.top * AXIS_HEIGHT;
      const heightPx = Math.max(item.height * AXIS_HEIGHT, 2); // minimum 2px height

      // Width and left from column assignment
      const widthPercent = 100 / item.totalColumns;
      const leftPercent = item.column * widthPercent;

      block.style.top = `${topPx}px`;
      block.style.height = `${heightPx}px`;
      block.style.left = `${leftPercent}%`;
      block.style.width = `calc(${widthPercent}% - 2px)`; // 2px gap for visual separation
      block.style.right = 'auto';

      // Content
      const titleEl = document.createElement('div');
      titleEl.className = 'event-title';
      titleEl.textContent = item.event.title;

      const timeEl = document.createElement('div');
      timeEl.className = 'event-time';
      timeEl.textContent = `${formatTimeShort(item.event.start_at)} – ${formatTimeShort(item.event.end_at)}`;

      block.appendChild(titleEl);
      block.appendChild(timeEl);

      // Click to edit
      block.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditModal(item.event);
      });

      dayBody.appendChild(block);
    }
  }
}

// Drag-to-create on a day body
function setupDragToCreate(dayBody, dayIndex) {
  let isDragging = false;
  let dragStartY = 0;
  let dragCurrentY = 0;
  let selectionEl = null;

  dayBody.addEventListener('mousedown', (e) => {
    if (e.target.closest('.event-block')) return;
    e.preventDefault();
    isDragging = true;
    const rect = dayBody.getBoundingClientRect();
    dragStartY = e.clientY - rect.top;
    dragCurrentY = dragStartY;

    selectionEl = document.createElement('div');
    selectionEl.className = 'drag-selection';
    dayBody.appendChild(selectionEl);
    updateSelection();
  });

  dayBody.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const rect = dayBody.getBoundingClientRect();
    dragCurrentY = Math.max(0, Math.min(e.clientY - rect.top, AXIS_HEIGHT));
    updateSelection();
  });

  const finishDrag = (e) => {
    if (!isDragging) return;
    isDragging = false;

    if (selectionEl) {
      selectionEl.remove();
      selectionEl = null;
    }

    const minY = Math.min(dragStartY, dragCurrentY);
    const maxY = Math.max(dragStartY, dragCurrentY);

    // Minimum drag distance for creation (at least 5px, otherwise treat as click)
    const dragDistance = maxY - minY;

    // Convert Y to minutes
    const startMinutes = Math.round((minY / AXIS_HEIGHT) * 24 * 60);
    let endMinutes = Math.round((maxY / AXIS_HEIGHT) * 24 * 60);

    // If it's a click (no significant drag), create a 1-hour event
    if (dragDistance < 5) {
      // Snap to nearest 15 minutes
      const snappedStart = Math.round(startMinutes / 15) * 15;
      const snappedEnd = Math.min(snappedStart + 60, 24 * 60);
      openCreateModal(dayIndex, snappedStart, snappedEnd);
    } else {
      // Snap to 5-minute intervals
      const snappedStart = Math.round(startMinutes / 5) * 5;
      const snappedEnd = Math.min(Math.round(endMinutes / 5) * 5, 24 * 60);
      if (snappedEnd > snappedStart) {
        openCreateModal(dayIndex, snappedStart, snappedEnd);
      }
    }
  };

  dayBody.addEventListener('mouseup', finishDrag);
  dayBody.addEventListener('mouseleave', (e) => {
    if (isDragging) {
      const rect = dayBody.getBoundingClientRect();
      dragCurrentY = Math.max(0, Math.min(e.clientY - rect.top, AXIS_HEIGHT));
      finishDrag(e);
    }
  });

  function updateSelection() {
    if (!selectionEl) return;
    const top = Math.min(dragStartY, dragCurrentY);
    const height = Math.abs(dragCurrentY - dragStartY);
    selectionEl.style.top = `${top}px`;
    selectionEl.style.height = `${height}px`;
  }
}

// Modal functions
function openCreateModal(dayIndex, startMinutes, endMinutes) {
  const dayStart = getDayStart(currentWeekStart, dayIndex);

  const startDate = new Date(dayStart);
  startDate.setMinutes(startMinutes);

  const endDate = new Date(dayStart);
  endDate.setMinutes(endMinutes);

  modalTitle.textContent = 'Create Event';
  eventIdInput.value = '';
  eventTitleInput.value = '';
  eventStartInput.value = formatDateForInput(startDate);
  eventEndInput.value = formatDateForInput(endDate);
  formError.textContent = '';
  btnDelete.style.display = 'none';
  btnSave.textContent = 'Create';

  modalOverlay.style.display = 'flex';
  eventTitleInput.focus();
}

function openEditModal(event) {
  modalTitle.textContent = 'Edit Event';
  eventIdInput.value = event.id;
  eventTitleInput.value = event.title;
  eventStartInput.value = formatDateForInput(new Date(event.start_at));
  eventEndInput.value = formatDateForInput(new Date(event.end_at));
  formError.textContent = '';
  btnDelete.style.display = 'inline-block';
  btnSave.textContent = 'Save';

  modalOverlay.style.display = 'flex';
  eventTitleInput.focus();
}

function closeModal() {
  modalOverlay.style.display = 'none';
  formError.textContent = '';
}

// Event handlers
eventForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  formError.textContent = '';

  const title = eventTitleInput.value.trim();
  const start_at = eventStartInput.value;
  const end_at = eventEndInput.value;
  const id = eventIdInput.value;

  if (!title) {
    formError.textContent = 'Title is required';
    return;
  }

  if (!start_at || !end_at) {
    formError.textContent = 'Start and end times are required';
    return;
  }

  const startDate = new Date(start_at);
  const endDate = new Date(end_at);

  if (endDate <= startDate) {
    formError.textContent = 'End time must be after start time';
    return;
  }

  try {
    if (id) {
      await updateEvent(parseInt(id), {
        title,
        start_at: startDate.toISOString(),
        end_at: endDate.toISOString()
      });
    } else {
      await createEvent({
        title,
        start_at: startDate.toISOString(),
        end_at: endDate.toISOString()
      });
    }
    closeModal();
    await loadEvents();
  } catch (err) {
    formError.textContent = err.message;
  }
});

btnCancel.addEventListener('click', closeModal);

modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeModal();
});

btnDelete.addEventListener('click', async () => {
  const id = eventIdInput.value;
  if (!id) return;

  if (confirm('Delete this event?')) {
    try {
      await deleteEvent(parseInt(id));
      closeModal();
      await loadEvents();
    } catch (err) {
      formError.textContent = err.message;
    }
  }
});

// Navigation
btnPrev.addEventListener('click', () => {
  currentWeekStart.setDate(currentWeekStart.getDate() - 7);
  refreshWeek();
});

btnNext.addEventListener('click', () => {
  currentWeekStart.setDate(currentWeekStart.getDate() + 7);
  refreshWeek();
});

btnToday.addEventListener('click', () => {
  currentWeekStart = getWeekStart(new Date());
  refreshWeek();
});

async function loadEvents() {
  const weekEnd = getWeekEnd(currentWeekStart);
  try {
    events = await fetchEvents(currentWeekStart, weekEnd);
  } catch (err) {
    console.error('Failed to load events:', err);
    events = [];
  }
  renderEvents();
}

async function refreshWeek() {
  updateWeekTitle();
  buildDayColumns();
  await loadEvents();
}

// Keyboard shortcut: Escape to close modal
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modalOverlay.style.display !== 'none') {
    closeModal();
  }
});

// Initialize
buildTimeGutter();
refreshWeek();
