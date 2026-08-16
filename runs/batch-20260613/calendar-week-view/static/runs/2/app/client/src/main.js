import { api } from './api.js';
import { computeDayLayout } from './layout.js';
import {
  getWeekStart,
  getWeekDays,
  formatDayHeader,
  toDatetimeLocal,
  fromDatetimeLocal,
  minutesFromMidnight,
  formatTime,
  isToday,
  formatWeekLabel,
} from './dateUtils.js';

/* ============================================================
   Constants
   ============================================================ */

/** Total height of the time axis in pixels (24 hours × 64 px/hr). */
const AXIS_HEIGHT = 1536;

/** Pixels per minute. */
const PX_PER_MIN = AXIS_HEIGHT / (24 * 60);

/** Minimum rendered event height so tiny events remain clickable. */
const MIN_EVENT_HEIGHT = 18;

/** Gap in pixels between adjacent event columns within a day. */
const EVENT_COL_GAP = 2;

/** CSS colour classes, cycled by event id. */
const COLOR_CLASSES = [
  'event-color-0',
  'event-color-1',
  'event-color-2',
  'event-color-3',
  'event-color-4',
  'event-color-5',
  'event-color-6',
];

/* ============================================================
   Application state
   ============================================================ */

let currentWeekStart = getWeekStart(new Date());
let events = [];

/* ============================================================
   DOM references
   ============================================================ */

const weekLabel    = /** @type {HTMLElement} */ (document.getElementById('week-label'));
const dayHeaders   = /** @type {HTMLElement} */ (document.getElementById('day-headers'));
const timeGutter   = /** @type {HTMLElement} */ (document.getElementById('time-gutter'));
const dayColumns   = /** @type {HTMLElement} */ (document.getElementById('day-columns'));
const modalOverlay = /** @type {HTMLElement} */ (document.getElementById('modal-overlay'));
const modalTitle   = /** @type {HTMLElement} */ (document.getElementById('modal-title'));
const eventForm    = /** @type {HTMLFormElement} */ (document.getElementById('event-form'));
const fieldTitle   = /** @type {HTMLInputElement} */ (document.getElementById('field-title'));
const fieldStart   = /** @type {HTMLInputElement} */ (document.getElementById('field-start'));
const fieldEnd     = /** @type {HTMLInputElement} */ (document.getElementById('field-end'));
const formError    = /** @type {HTMLElement} */ (document.getElementById('form-error'));
const btnDelete    = /** @type {HTMLButtonElement} */ (document.getElementById('btn-delete'));
const btnCancel    = /** @type {HTMLButtonElement} */ (document.getElementById('btn-cancel'));
const btnPrev      = /** @type {HTMLButtonElement} */ (document.getElementById('btn-prev'));
const btnToday     = /** @type {HTMLButtonElement} */ (document.getElementById('btn-today'));
const btnNext      = /** @type {HTMLButtonElement} */ (document.getElementById('btn-next'));

/* ============================================================
   Modal state
   ============================================================ */

/** null = create mode; number = edit mode (event id) */
let editingEventId = null;

/* ============================================================
   Week navigation
   ============================================================ */

btnPrev.addEventListener('click', () => {
  currentWeekStart = new Date(currentWeekStart);
  currentWeekStart.setDate(currentWeekStart.getDate() - 7);
  loadWeek();
});

btnToday.addEventListener('click', () => {
  currentWeekStart = getWeekStart(new Date());
  loadWeek();
});

btnNext.addEventListener('click', () => {
  currentWeekStart = new Date(currentWeekStart);
  currentWeekStart.setDate(currentWeekStart.getDate() + 7);
  loadWeek();
});

/* ============================================================
   Load & render the current week
   ============================================================ */

async function loadWeek() {
  const weekDays  = getWeekDays(currentWeekStart);
  const rangeStart = weekDays[0];
  const rangeEnd   = new Date(weekDays[6]);
  rangeEnd.setDate(rangeEnd.getDate() + 1); // exclusive: Monday 00:00

  weekLabel.textContent = formatWeekLabel(currentWeekStart);

  try {
    events = await api.getEvents(rangeStart.toISOString(), rangeEnd.toISOString());
  } catch (err) {
    console.error('Failed to load events:', err);
    events = [];
  }

  renderGrid(weekDays);
  renderEvents(weekDays);
  updateNowLine(weekDays);
}

/* ============================================================
   Render the static grid skeleton
   ============================================================ */

function renderGrid(weekDays) {
  // ---- Day headers ----
  dayHeaders.innerHTML = '';
  for (const day of weekDays) {
    const { dayName, dayNum } = formatDayHeader(day);
    const div = document.createElement('div');
    div.className = 'day-header' + (isToday(day) ? ' today' : '');
    div.innerHTML =
      `<div class="day-name">${dayName}</div>` +
      `<div class="day-date">${dayNum}</div>`;
    dayHeaders.appendChild(div);
  }

  // ---- Time gutter ----
  timeGutter.innerHTML = '';
  for (let h = 0; h <= 24; h++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = `${h * 64}px`;
    label.textContent = h < 24 ? `${String(h).padStart(2, '0')}:00` : '';
    timeGutter.appendChild(label);
  }

  // ---- Day columns ----
  dayColumns.innerHTML = '';
  for (let i = 0; i < 7; i++) {
    const col = document.createElement('div');
    col.className = 'day-col' + (isToday(weekDays[i]) ? ' today-col' : '');
    col.dataset.dayIndex = String(i);

    // Hour and half-hour lines
    for (let h = 0; h <= 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line' + (h === 0 || h === 24 ? ' midnight' : '');
      line.style.top = `${h * 64}px`;
      col.appendChild(line);

      if (h < 24) {
        const half = document.createElement('div');
        half.className = 'half-hour-line';
        half.style.top = `${h * 64 + 32}px`;
        col.appendChild(half);
      }
    }

    attachDragCreate(col, weekDays[i]);
    dayColumns.appendChild(col);
  }
}

/* ============================================================
   Render event blocks
   ============================================================ */

function renderEvents(weekDays) {
  // Remove stale event blocks and drag ghosts
  dayColumns.querySelectorAll('.event-block').forEach(el => el.remove());
  dayColumns.querySelectorAll('.drag-ghost').forEach(el => el.remove());

  // Bucket events by day index (keyed on start date)
  const byDay = Array.from({ length: 7 }, () => []);
  for (const ev of events) {
    const evStart = new Date(ev.start_at);
    for (let i = 0; i < 7; i++) {
      if (isSameDayLocal(evStart, weekDays[i])) {
        byDay[i].push(ev);
        break;
      }
    }
  }

  const colEls = dayColumns.querySelectorAll('.day-col');
  for (let i = 0; i < 7; i++) {
    const dayEvs = byDay[i];
    if (!dayEvs.length) continue;

    const layouts = computeDayLayout(dayEvs);
    const colEl   = colEls[i];

    for (let j = 0; j < dayEvs.length; j++) {
      renderEventBlock(dayEvs[j], layouts[j], colEl);
    }
  }
}

function renderEventBlock(ev, layout, colEl) {
  const startDate = new Date(ev.start_at);
  const endDate   = new Date(ev.end_at);

  // Clamp to [0, 1440] minutes within the day column
  const startMin = Math.max(0, Math.min(1440, minutesFromMidnight(startDate)));
  const endMin   = Math.max(0, Math.min(1440, minutesFromMidnight(endDate)));

  const top    = startMin * PX_PER_MIN;
  const height = Math.max(MIN_EVENT_HEIGHT, (endMin - startMin) * PX_PER_MIN);

  // Horizontal placement via percentages (avoids needing pixel width)
  const { colIndex, colCount } = layout;
  const leftPct  = (colIndex / colCount) * 100;
  const widthPct = (1 / colCount) * 100;

  const block = document.createElement('div');
  block.className = `event-block ${COLOR_CLASSES[ev.id % COLOR_CLASSES.length]}`;
  block.style.top    = `${top}px`;
  block.style.height = `${height}px`;
  block.style.left   = `calc(${leftPct}% + ${EVENT_COL_GAP / 2}px)`;
  block.style.width  = `calc(${widthPct}% - ${EVENT_COL_GAP}px)`;

  const timeStr = `${formatTime(startDate)} – ${formatTime(endDate)}`;
  block.innerHTML =
    `<div class="event-title">${escapeHtml(ev.title)}</div>` +
    `<div class="event-time">${timeStr}</div>`;

  block.addEventListener('click', (e) => {
    e.stopPropagation();
    openEditModal(ev);
  });

  colEl.appendChild(block);
}

/* ============================================================
   Drag-to-create interaction
   ============================================================ */

function attachDragCreate(colEl, day) {
  let dragStartMin = null;
  let ghost        = null;
  let wasDragging  = false;

  /**
   * Convert a clientY coordinate to snapped minutes-from-midnight.
   * Accounts for the scroll position of the body-scroll container.
   */
  function yToMinutes(clientY) {
    const bodyScroll = /** @type {HTMLElement} */ (document.getElementById('body-scroll'));
    const rect = colEl.getBoundingClientRect();
    const relY = clientY - rect.top + bodyScroll.scrollTop;
    const raw  = relY / PX_PER_MIN;
    // Snap to nearest 15-minute interval
    return Math.max(0, Math.min(1440, Math.round(raw / 15) * 15));
  }

  function onMouseMove(e) {
    if (ghost === null) return;
    wasDragging = true;

    const curMin = yToMinutes(e.clientY);
    const lo     = Math.min(dragStartMin, curMin);
    const hi     = Math.max(dragStartMin, curMin);
    const endMin = Math.max(lo + 15, hi);

    ghost.style.top    = `${lo * PX_PER_MIN}px`;
    ghost.style.height = `${(endMin - lo) * PX_PER_MIN}px`;
  }

  function onMouseUp(e) {
    if (ghost === null) return;

    const curMin = yToMinutes(e.clientY);

    let loMin, hiMin;
    if (wasDragging) {
      loMin = Math.min(dragStartMin, curMin);
      hiMin = Math.max(loMin + 15, Math.max(dragStartMin, curMin));
    } else {
      // Simple click: default to a 1-hour slot
      loMin = dragStartMin;
      hiMin = Math.min(1440, dragStartMin + 60);
    }

    ghost.remove();
    ghost       = null;
    wasDragging = false;

    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);

    const startD = new Date(day);
    startD.setHours(Math.floor(loMin / 60), loMin % 60, 0, 0);

    const endD = new Date(day);
    endD.setHours(Math.floor(hiMin / 60), hiMin % 60, 0, 0);

    openCreateModal(startD, endD);
  }

  colEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (/** @type {Element} */ (e.target).closest('.event-block')) return;

    dragStartMin = yToMinutes(e.clientY);
    wasDragging  = false;

    ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    ghost.style.top    = `${dragStartMin * PX_PER_MIN}px`;
    ghost.style.height = `${PX_PER_MIN * 15}px`;
    ghost.style.left   = '2px';
    ghost.style.right  = '2px';
    colEl.appendChild(ghost);

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    e.preventDefault();
  });
}

/* ============================================================
   Modal helpers
   ============================================================ */

function showError(msg) {
  formError.textContent = msg;
  formError.classList.remove('hidden');
}

function hideError() {
  formError.classList.add('hidden');
}

function openCreateModal(startDate, endDate) {
  editingEventId       = null;
  modalTitle.textContent = 'New Event';
  fieldTitle.value     = '';
  fieldStart.value     = toDatetimeLocal(startDate);
  fieldEnd.value       = toDatetimeLocal(endDate);
  btnDelete.classList.add('hidden');
  hideError();
  modalOverlay.classList.remove('hidden');
  fieldTitle.focus();
}

function openEditModal(ev) {
  editingEventId         = ev.id;
  modalTitle.textContent = 'Edit Event';
  fieldTitle.value       = ev.title;
  fieldStart.value       = toDatetimeLocal(new Date(ev.start_at));
  fieldEnd.value         = toDatetimeLocal(new Date(ev.end_at));
  btnDelete.classList.remove('hidden');
  hideError();
  modalOverlay.classList.remove('hidden');
  fieldTitle.focus();
}

function closeModal() {
  modalOverlay.classList.add('hidden');
  editingEventId = null;
}

btnCancel.addEventListener('click', closeModal);

modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeModal();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});

/* ============================================================
   Form submission (create / update)
   ============================================================ */

eventForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError();

  const title    = fieldTitle.value.trim();
  const startVal = fieldStart.value;
  const endVal   = fieldEnd.value;

  if (!title) {
    showError('Title is required.');
    return;
  }
  if (!startVal || !endVal) {
    showError('Start and end times are required.');
    return;
  }

  const startDate = fromDatetimeLocal(startVal);
  const endDate   = fromDatetimeLocal(endVal);

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    showError('Invalid date/time values.');
    return;
  }
  if (endDate <= startDate) {
    showError('End time must be after start time.');
    return;
  }

  const payload = {
    title,
    start_at: startDate.toISOString(),
    end_at:   endDate.toISOString(),
  };

  try {
    if (editingEventId === null) {
      await api.createEvent(payload);
    } else {
      await api.updateEvent(editingEventId, payload);
    }
    closeModal();
    await loadWeek();
  } catch (err) {
    showError(err.message || 'Failed to save event.');
  }
});

/* ============================================================
   Delete event
   ============================================================ */

btnDelete.addEventListener('click', async () => {
  if (editingEventId === null) return;
  if (!confirm('Delete this event?')) return;

  try {
    await api.deleteEvent(editingEventId);
    closeModal();
    await loadWeek();
  } catch (err) {
    showError(err.message || 'Failed to delete event.');
  }
});

/* ============================================================
   Current-time indicator (red line)
   ============================================================ */

function updateNowLine(weekDays) {
  dayColumns.querySelectorAll('.now-line').forEach(el => el.remove());

  const now    = new Date();
  const colEls = dayColumns.querySelectorAll('.day-col');

  for (let i = 0; i < 7; i++) {
    if (isSameDayLocal(now, weekDays[i])) {
      const mins = minutesFromMidnight(now);
      const line = document.createElement('div');
      line.className = 'now-line';
      line.style.top = `${mins * PX_PER_MIN}px`;
      colEls[i].appendChild(line);
      break;
    }
  }
}

/* ============================================================
   Utilities
   ============================================================ */

function isSameDayLocal(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth()    === b.getMonth()    &&
    a.getDate()     === b.getDate()
  );
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ============================================================
   Scroll to current time on initial load
   ============================================================ */

function scrollToNow() {
  const now        = new Date();
  const mins       = minutesFromMidnight(now);
  const top        = mins * PX_PER_MIN;
  const bodyScroll = /** @type {HTMLElement} */ (document.getElementById('body-scroll'));
  // Position current time roughly 1/3 from the top of the viewport
  bodyScroll.scrollTop = Math.max(0, top - bodyScroll.clientHeight / 3);
}

/* ============================================================
   Auto-refresh now line every minute
   ============================================================ */

setInterval(() => {
  updateNowLine(getWeekDays(currentWeekStart));
}, 60_000);

/* ============================================================
   Bootstrap
   ============================================================ */

loadWeek().then(() => {
  scrollToNow();
});
