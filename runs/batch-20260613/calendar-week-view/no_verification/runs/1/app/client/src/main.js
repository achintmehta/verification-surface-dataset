import './style.css';
import { computeDayLayout } from './layout.js';
import { fetchEvents, createEvent, updateEvent, deleteEvent } from './api.js';
import {
  getWeekStart,
  getWeekDays,
  addWeeks,
  toLocalIso,
  toInputDatetime,
  formatTime,
  formatDayHeader,
  formatWeekLabel,
  isSameDay,
  minutesFromMidnight,
  snapMinutes,
} from './dates.js';

// ── Constants ─────────────────────────────────────────────────────────────────
// These must match the CSS custom properties.
const HOUR_HEIGHT   = 60;          // px per hour  (--hour-height)
const AXIS_HEIGHT   = HOUR_HEIGHT * 24; // 1440px total
const TOTAL_MINUTES = 24 * 60;    // 1440
const SNAP          = 15;          // minute snap for drag-create

// ── State ─────────────────────────────────────────────────────────────────────
let weekStart = getWeekStart(new Date());
let events    = [];

// ── DOM refs ──────────────────────────────────────────────────────────────────
const weekLabel    = document.getElementById('week-label');
const btnPrev      = document.getElementById('btn-prev');
const btnToday     = document.getElementById('btn-today');
const btnNext      = document.getElementById('btn-next');
const scrollArea   = document.getElementById('scroll-area');
const timeGutter   = document.getElementById('time-gutter');
const daysGrid     = document.getElementById('days-grid');
const dayHeaders   = document.getElementById('day-headers');
const modalOverlay = document.getElementById('modal-overlay');
const modalTitle   = document.getElementById('modal-title');
const eventForm    = document.getElementById('event-form');
const fTitle       = document.getElementById('f-title');
const fStart       = document.getElementById('f-start');
const fEnd         = document.getElementById('f-end');
const formError    = document.getElementById('form-error');
const btnSave      = document.getElementById('btn-save');
const btnDelete    = document.getElementById('btn-delete');
const btnCancel    = document.getElementById('btn-cancel');

// ── Navigation ────────────────────────────────────────────────────────────────
btnPrev.addEventListener('click', () => {
  weekStart = addWeeks(weekStart, -1);
  loadWeek();
});
btnToday.addEventListener('click', () => {
  weekStart = getWeekStart(new Date());
  loadWeek();
});
btnNext.addEventListener('click', () => {
  weekStart = addWeeks(weekStart, 1);
  loadWeek();
});

// ── Load & Render ─────────────────────────────────────────────────────────────
async function loadWeek() {
  weekLabel.textContent = formatWeekLabel(weekStart);

  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);

  try {
    events = await fetchEvents(toLocalIso(weekStart), toLocalIso(weekEnd));
  } catch (err) {
    console.error('Failed to load events:', err);
    events = [];
  }

  renderWeek();
}

function renderWeek() {
  const today    = new Date();
  const weekDays = getWeekDays(weekStart);

  // ── Time gutter ─────────────────────────────────────────────────────────
  timeGutter.innerHTML = '';
  // Hour labels at each hour mark (1–23; skip 0 and 24 to avoid clutter)
  for (let h = 1; h < 24; h++) {
    const label = document.createElement('div');
    label.className = 'gutter-label';
    label.style.top = `${h * HOUR_HEIGHT}px`;
    label.textContent = `${String(h).padStart(2, '0')}:00`;
    timeGutter.appendChild(label);
  }

  // ── Day header cells ─────────────────────────────────────────────────────
  dayHeaders.innerHTML = '';
  weekDays.forEach(day => {
    const isToday = isSameDay(day, today);
    const { dayName, dayNum } = formatDayHeader(day);

    const hdr = document.createElement('div');
    hdr.className = 'day-header' + (isToday ? ' today' : '');
    hdr.innerHTML = `
      <span class="day-name">${dayName}</span>
      <span class="day-date">${dayNum}</span>
    `;
    dayHeaders.appendChild(hdr);
  });

  // ── Day columns ──────────────────────────────────────────────────────────
  daysGrid.innerHTML = '';
  weekDays.forEach(day => {
    const isToday = isSameDay(day, today);

    const col = document.createElement('div');
    col.className = 'day-col' + (isToday ? ' today' : '');

    // Hour and half-hour grid lines
    for (let h = 0; h < 24; h++) {
      const hourLine = document.createElement('div');
      hourLine.className = 'hour-line';
      hourLine.style.top = `${h * HOUR_HEIGHT}px`;
      col.appendChild(hourLine);

      const halfLine = document.createElement('div');
      halfLine.className = 'half-line';
      halfLine.style.top = `${h * HOUR_HEIGHT + HOUR_HEIGHT / 2}px`;
      col.appendChild(halfLine);
    }
    // Bottom boundary line
    const bottomLine = document.createElement('div');
    bottomLine.className = 'hour-line';
    bottomLine.style.top = `${AXIS_HEIGHT}px`;
    col.appendChild(bottomLine);

    // Drag-to-create interaction
    attachDragCreate(col, day);

    // Events for this day
    const dayEvents = events.filter(ev => isSameDay(new Date(ev.start_at), day));
    const layoutItems = computeDayLayout(dayEvents);
    layoutItems.forEach(item => {
      col.appendChild(createEventBlock(item));
    });

    daysGrid.appendChild(col);
  });

  // Scroll to 07:00 on initial render (only if at top)
  if (scrollArea.scrollTop === 0) {
    scrollArea.scrollTop = 7 * HOUR_HEIGHT;
  }
}

// ── Event Block ───────────────────────────────────────────────────────────────
function createEventBlock({ event, colIndex, colCount }) {
  const startDate = new Date(event.start_at);
  const endDate   = new Date(event.end_at);

  // Compute minutes-from-midnight for the day column this event belongs to.
  // The event's start day is the column day.
  // For end time: if the end is on a different (later) day, clamp to 1440
  // (bottom of the column). This handles events ending at midnight of the
  // next day (stored as 00:00:00 of the next day).
  const startMin = Math.max(0, Math.min(TOTAL_MINUTES, minutesFromMidnight(startDate)));

  let endMin;
  if (isSameDay(startDate, endDate)) {
    endMin = Math.max(0, Math.min(TOTAL_MINUTES, minutesFromMidnight(endDate)));
  } else {
    // End is on a different day → clamp to end of this day column
    endMin = TOTAL_MINUTES;
  }

  // Pixel geometry
  const top    = (startMin / TOTAL_MINUTES) * AXIS_HEIGHT;
  const height = Math.max(4, ((endMin - startMin) / TOTAL_MINUTES) * AXIS_HEIGHT);

  // Horizontal geometry (percentage-based, with 1px inset on each side)
  const leftPct  = (colIndex / colCount) * 100;
  const widthPct = (1 / colCount) * 100;

  const block = document.createElement('div');
  block.className = 'event-block';
  block.style.top    = `${top}px`;
  block.style.height = `${height}px`;
  block.style.left   = `calc(${leftPct}% + 1px)`;
  block.style.width  = `calc(${widthPct}% - 2px)`;

  const timeStr = `${formatTime(startDate)} – ${formatTime(endDate)}`;
  block.innerHTML = `
    <div class="ev-title">${escapeHtml(event.title)}</div>
    <div class="ev-time">${timeStr}</div>
  `;

  block.addEventListener('click', e => {
    e.stopPropagation();
    openEditModal(event);
  });

  return block;
}

// ── Drag-to-Create ────────────────────────────────────────────────────────────
function attachDragCreate(col, day) {
  let dragStartMin = null;
  let selectionEl  = null;

  /**
   * Convert a mouse clientY to minutes-from-midnight within this column,
   * snapped to SNAP-minute intervals.
   */
  function clientYToMinutes(clientY) {
    const rect = col.getBoundingClientRect();
    const y    = clientY - rect.top;
    const raw  = (y / AXIS_HEIGHT) * TOTAL_MINUTES;
    return Math.max(0, Math.min(TOTAL_MINUTES, snapMinutes(raw, SNAP)));
  }

  function minutesToPx(min) {
    return (min / TOTAL_MINUTES) * AXIS_HEIGHT;
  }

  col.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    // Only trigger on the column background / grid lines, not on event blocks
    if (
      e.target !== col &&
      !e.target.classList.contains('hour-line') &&
      !e.target.classList.contains('half-line')
    ) return;

    e.preventDefault();
    dragStartMin = clientYToMinutes(e.clientY);

    selectionEl = document.createElement('div');
    selectionEl.className = 'drag-selection';
    selectionEl.style.top    = `${minutesToPx(dragStartMin)}px`;
    selectionEl.style.height = `${minutesToPx(dragStartMin + SNAP) - minutesToPx(dragStartMin)}px`;
    col.appendChild(selectionEl);
  });

  // Use document-level listeners so drag works even if mouse leaves the column
  function onMouseMove(e) {
    if (dragStartMin === null || !selectionEl) return;
    const currentMin = clientYToMinutes(e.clientY);
    const startMin   = Math.min(dragStartMin, currentMin);
    const endMin     = Math.max(dragStartMin, currentMin);
    const finalEnd   = endMin === startMin ? startMin + SNAP : endMin;

    selectionEl.style.top    = `${minutesToPx(startMin)}px`;
    selectionEl.style.height = `${minutesToPx(finalEnd) - minutesToPx(startMin)}px`;
  }

  function onMouseUp(e) {
    if (dragStartMin === null || !selectionEl) return;

    const currentMin = clientYToMinutes(e.clientY);
    let startMin = Math.min(dragStartMin, currentMin);
    let endMin   = Math.max(dragStartMin, currentMin);
    if (endMin === startMin) endMin = startMin + SNAP;

    // Clamp to valid range
    startMin = Math.max(0, Math.min(TOTAL_MINUTES - SNAP, startMin));
    endMin   = Math.max(startMin + SNAP, Math.min(TOTAL_MINUTES, endMin));

    selectionEl.remove();
    selectionEl  = null;
    dragStartMin = null;

    // Build Date objects for the selected time range
    const startDate = new Date(day);
    startDate.setHours(Math.floor(startMin / 60), startMin % 60, 0, 0);
    const endDate = new Date(day);
    endDate.setHours(Math.floor(endMin / 60), endMin % 60, 0, 0);

    openCreateModal(startDate, endDate);
  }

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup',   onMouseUp);
}

// ── Modal ─────────────────────────────────────────────────────────────────────
let editingEventId = null;

function showModal() {
  modalOverlay.classList.remove('hidden');
  setTimeout(() => fTitle.focus(), 50);
}

function hideModal() {
  modalOverlay.classList.add('hidden');
  editingEventId = null;
  formError.classList.add('hidden');
  formError.textContent = '';
}

function openCreateModal(startDate, endDate) {
  editingEventId = null;
  modalTitle.textContent = 'New Event';
  fTitle.value = '';
  fStart.value = toInputDatetime(startDate);
  fEnd.value   = toInputDatetime(endDate);
  btnDelete.classList.add('hidden');
  formError.classList.add('hidden');
  showModal();
}

function openEditModal(event) {
  editingEventId = event.id;
  modalTitle.textContent = 'Edit Event';
  fTitle.value = event.title;
  fStart.value = toInputDatetime(new Date(event.start_at));
  fEnd.value   = toInputDatetime(new Date(event.end_at));
  btnDelete.classList.remove('hidden');
  formError.classList.add('hidden');
  showModal();
}

function showFormError(msg) {
  formError.textContent = msg;
  formError.classList.remove('hidden');
}

// ── Form Submission ───────────────────────────────────────────────────────────
eventForm.addEventListener('submit', async e => {
  e.preventDefault();
  formError.classList.add('hidden');

  const title    = fTitle.value.trim();
  const startVal = fStart.value;
  const endVal   = fEnd.value;

  // Client-side validation
  if (!title) {
    showFormError('Title is required.');
    return;
  }
  if (!startVal || !endVal) {
    showFormError('Start and end times are required.');
    return;
  }
  const startDate = new Date(startVal);
  const endDate   = new Date(endVal);
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    showFormError('Invalid date/time values.');
    return;
  }
  if (endDate <= startDate) {
    showFormError('End time must be after start time.');
    return;
  }

  const payload = {
    title,
    start_at: toLocalIso(startDate),
    end_at:   toLocalIso(endDate),
  };

  btnSave.disabled = true;
  try {
    if (editingEventId !== null) {
      await updateEvent(editingEventId, payload);
    } else {
      await createEvent(payload);
    }
    hideModal();
    await loadWeek();
  } catch (err) {
    showFormError(err.message || 'Failed to save event.');
  } finally {
    btnSave.disabled = false;
  }
});

// ── Delete ────────────────────────────────────────────────────────────────────
btnDelete.addEventListener('click', async () => {
  if (editingEventId === null) return;
  if (!confirm('Delete this event?')) return;

  btnDelete.disabled = true;
  try {
    await deleteEvent(editingEventId);
    hideModal();
    await loadWeek();
  } catch (err) {
    showFormError(err.message || 'Failed to delete event.');
  } finally {
    btnDelete.disabled = false;
  }
});

// ── Modal Dismiss ─────────────────────────────────────────────────────────────
btnCancel.addEventListener('click', hideModal);

modalOverlay.addEventListener('click', e => {
  if (e.target === modalOverlay) hideModal();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !modalOverlay.classList.contains('hidden')) {
    hideModal();
  }
});

// ── Utilities ─────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Boot ──────────────────────────────────────────────────────────────────────
loadWeek();
