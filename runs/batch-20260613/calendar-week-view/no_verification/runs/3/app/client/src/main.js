import { computeLayout } from './layout.js';
import { fetchEvents, createEvent, updateEvent, deleteEvent } from './api.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const HOUR_HEIGHT = 60;   // px per hour — must match CSS --hour-height
const TOTAL_HEIGHT = HOUR_HEIGHT * 24;
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ── State ─────────────────────────────────────────────────────────────────────
let currentWeekStart = getWeekStart(new Date()); // Monday of the displayed week
let events = [];   // all events for the current week
let initialScrollDone = false;

// ── Date helpers ──────────────────────────────────────────────────────────────

/** Returns the Monday of the week containing `date` (local time). */
function getWeekStart(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0=Sun … 6=Sat
  const diff = (day === 0) ? -6 : 1 - day; // shift to Monday
  d.setDate(d.getDate() + diff);
  return d;
}

/** Returns a Date that is `n` days after `date`. */
function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

/** Format a Date as "YYYY-MM-DDTHH:MM" for datetime-local inputs. */
function toLocalInputValue(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Format a Date as "HH:MM". */
function formatTime(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Format a Date as "MMM D". */
function formatMonthDay(date) {
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Convert minutes-from-midnight to pixels. */
function minutesToPx(minutes) {
  return (minutes / 60) * HOUR_HEIGHT;
}

/** Convert a clientY offset within a day-body element to minutes-from-midnight. */
function pxToMinutes(px) {
  return Math.round((px / HOUR_HEIGHT) * 60);
}

/** Snap minutes to the nearest 15-minute boundary. */
function snapMinutes(minutes) {
  return Math.round(minutes / 15) * 15;
}

/** Clamp a value between min and max. */
function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

/** Return ISO string for a given day + minutes-from-midnight. */
function dayMinutesToISO(dayDate, minutes) {
  const d = new Date(dayDate);
  d.setHours(0, 0, 0, 0);
  d.setMinutes(minutes);
  return d.toISOString();
}

// ── DOM refs ──────────────────────────────────────────────────────────────────
const weekLabel    = document.getElementById('week-label');
const btnPrev      = document.getElementById('btn-prev');
const btnToday     = document.getElementById('btn-today');
const btnNext      = document.getElementById('btn-next');
const timeGutter   = document.getElementById('time-gutter');
const daysWrapper  = document.getElementById('days-wrapper');

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

// ── Build time gutter ─────────────────────────────────────────────────────────
function buildGutter() {
  timeGutter.innerHTML = '';
  for (let h = 0; h <= 24; h++) {
    const div = document.createElement('div');
    div.className = 'gutter-hour';
    div.textContent = h < 24 ? `${String(h).padStart(2,'0')}:00` : '';
    div.style.height = h < 24 ? `${HOUR_HEIGHT}px` : '0';
    timeGutter.appendChild(div);
  }
}

// ── Build day columns ─────────────────────────────────────────────────────────
function buildDayColumns() {
  daysWrapper.innerHTML = '';
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let d = 0; d < 7; d++) {
    const dayDate = addDays(currentWeekStart, d);
    const isToday = dayDate.getTime() === today.getTime();

    const col = document.createElement('div');
    col.className = 'day-col' + (isToday ? ' today' : '');
    col.dataset.dayIndex = d;

    // Header
    const header = document.createElement('div');
    header.className = 'day-header';

    const nameEl = document.createElement('div');
    nameEl.className = 'day-name';
    nameEl.textContent = DAYS[d];

    const dateEl = document.createElement('div');
    dateEl.className = 'day-date';
    dateEl.textContent = dayDate.getDate();

    header.appendChild(nameEl);
    header.appendChild(dateEl);
    col.appendChild(header);

    // Body (the scrollable time area)
    const body = document.createElement('div');
    body.className = 'day-body';
    body.dataset.dayIndex = d;
    body.dataset.dayDate = dayDate.toISOString();

    // Hour and half-hour lines
    for (let h = 0; h < 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${h * HOUR_HEIGHT}px`;
      body.appendChild(line);

      const half = document.createElement('div');
      half.className = 'half-hour-line';
      half.style.top = `${h * HOUR_HEIGHT + HOUR_HEIGHT / 2}px`;
      body.appendChild(half);
    }
    // Bottom border line
    const bottomLine = document.createElement('div');
    bottomLine.className = 'hour-line';
    bottomLine.style.top = `${24 * HOUR_HEIGHT}px`;
    body.appendChild(bottomLine);

    col.appendChild(body);
    daysWrapper.appendChild(col);

    // Attach drag-to-create listeners
    attachDragListeners(body, dayDate);
  }
}

// ── Render events ─────────────────────────────────────────────────────────────
function renderEvents() {
  // Clear existing event blocks
  document.querySelectorAll('.event-block').forEach(el => el.remove());
  document.querySelectorAll('.drag-selection').forEach(el => el.remove());

  // Group events by day index
  const byDay = Array.from({ length: 7 }, () => []);

  for (const ev of events) {
    const evStart = new Date(ev.start_at);
    const evEnd   = new Date(ev.end_at);

    // Determine which day column(s) this event belongs to.
    // We only render within the current week; events are clipped to their day.
    for (let d = 0; d < 7; d++) {
      const dayStart = addDays(currentWeekStart, d);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = addDays(currentWeekStart, d);
      dayEnd.setHours(24, 0, 0, 0);

      // Event overlaps this day?
      if (evStart < dayEnd && evEnd > dayStart) {
        byDay[d].push(ev);
      }
    }
  }

  // Render each day
  for (let d = 0; d < 7; d++) {
    const body = daysWrapper.querySelector(`.day-body[data-day-index="${d}"]`);
    if (!body) continue;

    const dayDate = addDays(currentWeekStart, d);
    dayDate.setHours(0, 0, 0, 0);
    const dayEndMs = dayDate.getTime() + 24 * 60 * 60 * 1000;

    const layoutItems = computeLayout(byDay[d]);

    for (const { event: ev, col, totalCols } of layoutItems) {
      const evStart = new Date(ev.start_at);
      const evEnd   = new Date(ev.end_at);

      // Clamp to day boundaries
      const clampedStart = Math.max(evStart.getTime(), dayDate.getTime());
      const clampedEnd   = Math.min(evEnd.getTime(),   dayEndMs);

      const startMinutes = (clampedStart - dayDate.getTime()) / 60000;
      const endMinutes   = (clampedEnd   - dayDate.getTime()) / 60000;

      const top    = minutesToPx(startMinutes);
      const height = Math.max(minutesToPx(endMinutes - startMinutes), 18); // min 18px

      // Horizontal layout: divide column width equally
      // Use percentage-based left/width so it adapts to column width
      const widthPct  = 100 / totalCols;
      const leftPct   = col * widthPct;

      // Small inset so adjacent events have a visible gap
      const GAP = 1; // px gap between event columns
      const block = document.createElement('div');
      block.className = 'event-block';
      block.style.top    = `${top}px`;
      block.style.height = `${height}px`;
      block.style.left   = `calc(${leftPct}% + ${GAP}px)`;
      block.style.width  = `calc(${widthPct}% - ${GAP * 2}px)`;
      block.dataset.eventId = ev.id;

      // Color variety based on id
      const colors = [
        ['#1a73e8','#1558b0'],
        ['#0b8043','#06602f'],
        ['#e37400','#b35a00'],
        ['#8430ce','#5e1f9e'],
        ['#c0392b','#922b21'],
        ['#16a085','#0e6655'],
      ];
      const [bg, border] = colors[ev.id % colors.length];
      block.style.background  = bg;
      block.style.borderLeftColor = border;

      const titleEl = document.createElement('div');
      titleEl.className = 'event-title';
      titleEl.textContent = ev.title;

      const timeEl = document.createElement('div');
      timeEl.className = 'event-time';
      timeEl.textContent = `${formatTime(evStart)}–${formatTime(evEnd)}`;

      block.appendChild(titleEl);
      block.appendChild(timeEl);

      block.addEventListener('click', e => {
        e.stopPropagation();
        openEditModal(ev);
      });

      body.appendChild(block);
    }
  }
}

// ── Drag-to-create ────────────────────────────────────────────────────────────
let dragState = null;

function attachDragListeners(body, dayDate) {
  body.addEventListener('mousedown', e => {
    // Only left-click on the body itself (not on event blocks)
    if (e.button !== 0) return;
    if (e.target.closest('.event-block')) return;

    e.preventDefault();

    const rect = body.getBoundingClientRect();
    const startY = clamp(e.clientY - rect.top, 0, TOTAL_HEIGHT);
    const startMin = snapMinutes(pxToMinutes(startY));

    // Create selection highlight element
    const sel = document.createElement('div');
    sel.className = 'drag-selection';
    body.appendChild(sel);

    dragState = { body, dayDate, startMin, currentMin: startMin, selEl: sel };
    updateDragSelection();
  });
}

function updateDragSelection() {
  if (!dragState) return;
  const { startMin, currentMin, selEl } = dragState;
  const top    = minutesToPx(Math.min(startMin, currentMin));
  const height = Math.max(minutesToPx(Math.abs(currentMin - startMin)), minutesToPx(15));
  selEl.style.top    = `${top}px`;
  selEl.style.height = `${height}px`;
}

document.addEventListener('mousemove', e => {
  if (!dragState) return;
  const rect = dragState.body.getBoundingClientRect();
  const y = clamp(e.clientY - rect.top, 0, TOTAL_HEIGHT);
  dragState.currentMin = snapMinutes(pxToMinutes(y));
  updateDragSelection();
});

document.addEventListener('mouseup', e => {
  if (!dragState) return;
  const { dayDate, startMin, currentMin, selEl } = dragState;
  selEl.remove();
  dragState = null;

  let s = Math.min(startMin, currentMin);
  let en = Math.max(startMin, currentMin);
  if (en - s < 15) en = s + 15; // minimum 15 min
  en = Math.min(en, 24 * 60);   // clamp to end of day

  const startISO = dayMinutesToISO(dayDate, s);
  const endISO   = dayMinutesToISO(dayDate, en);
  openCreateModal(startISO, endISO);
});

// ── Modal helpers ─────────────────────────────────────────────────────────────
let editingEventId = null;

function showError(msg) {
  formError.textContent = msg;
  formError.classList.remove('hidden');
}

function hideError() {
  formError.classList.add('hidden');
}

function openCreateModal(startISO, endISO) {
  editingEventId = null;
  modalTitle.textContent = 'New Event';
  fTitle.value = '';
  fStart.value = toLocalInputValue(new Date(startISO));
  fEnd.value   = toLocalInputValue(new Date(endISO));
  btnDelete.classList.add('hidden');
  hideError();
  modalOverlay.classList.remove('hidden');
  fTitle.focus();
}

function openEditModal(ev) {
  editingEventId = ev.id;
  modalTitle.textContent = 'Edit Event';
  fTitle.value = ev.title;
  fStart.value = toLocalInputValue(new Date(ev.start_at));
  fEnd.value   = toLocalInputValue(new Date(ev.end_at));
  btnDelete.classList.remove('hidden');
  hideError();
  modalOverlay.classList.remove('hidden');
  fTitle.focus();
}

function closeModal() {
  modalOverlay.classList.add('hidden');
  editingEventId = null;
}

btnCancel.addEventListener('click', closeModal);
modalOverlay.addEventListener('click', e => {
  if (e.target === modalOverlay) closeModal();
});

// ── Form submission ───────────────────────────────────────────────────────────
eventForm.addEventListener('submit', async e => {
  e.preventDefault();
  hideError();

  const title    = fTitle.value.trim();
  const startVal = fStart.value;
  const endVal   = fEnd.value;

  if (!title) {
    showError('Title is required.');
    fTitle.focus();
    return;
  }
  if (!startVal || !endVal) {
    showError('Start and end times are required.');
    return;
  }

  const startISO = new Date(startVal).toISOString();
  const endISO   = new Date(endVal).toISOString();

  if (new Date(endISO) <= new Date(startISO)) {
    showError('End time must be after start time.');
    return;
  }

  btnSave.disabled = true;
  try {
    if (editingEventId === null) {
      await createEvent({ title, start_at: startISO, end_at: endISO });
    } else {
      await updateEvent(editingEventId, { title, start_at: startISO, end_at: endISO });
    }
    closeModal();
    await loadAndRender();
  } catch (err) {
    showError(err.data?.error || err.message || 'Failed to save event.');
  } finally {
    btnSave.disabled = false;
  }
});

btnDelete.addEventListener('click', async () => {
  if (editingEventId === null) return;
  if (!confirm('Delete this event?')) return;
  btnDelete.disabled = true;
  try {
    await deleteEvent(editingEventId);
    closeModal();
    await loadAndRender();
  } catch (err) {
    showError(err.data?.error || err.message || 'Failed to delete event.');
  } finally {
    btnDelete.disabled = false;
  }
});

// ── Navigation ────────────────────────────────────────────────────────────────
btnPrev.addEventListener('click', () => {
  currentWeekStart = addDays(currentWeekStart, -7);
  loadAndRender();
});

btnToday.addEventListener('click', () => {
  currentWeekStart = getWeekStart(new Date());
  loadAndRender();
});

btnNext.addEventListener('click', () => {
  currentWeekStart = addDays(currentWeekStart, 7);
  loadAndRender();
});

// ── Load & render ─────────────────────────────────────────────────────────────
async function loadAndRender() {
  // Week window: Monday 00:00 → Sunday 24:00
  const weekEnd = addDays(currentWeekStart, 7);

  // Update header label
  const startLabel = formatMonthDay(currentWeekStart);
  const endLabel   = formatMonthDay(addDays(currentWeekStart, 6));
  weekLabel.textContent = `${startLabel} – ${endLabel}, ${currentWeekStart.getFullYear()}`;

  // Rebuild columns (updates today highlight, headers)
  buildDayColumns();

  try {
    events = await fetchEvents(currentWeekStart.toISOString(), weekEnd.toISOString());
  } catch (err) {
    console.error('Failed to fetch events:', err);
    events = [];
  }

  renderEvents();

  // Scroll to 07:00 on first load only
  if (!initialScrollDone) {
    initialScrollDone = true;
    daysWrapper.scrollTop = minutesToPx(7 * 60);
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
buildGutter();
loadAndRender();
