/**
 * Week Calendar — Main Entry Point
 * Vanilla JS, no framework dependencies.
 */

import { computeLayout } from './layout.js';
import { api } from './api.js';

// ─── Constants ────────────────────────────────────────────────────────────────
const HOUR_HEIGHT    = 64;           // px per hour — must match CSS --hour-height
const MINUTES_PER_DAY = 24 * 60;    // 1440
const TOTAL_HEIGHT   = HOUR_HEIGHT * 24; // 1536 px
const EVENT_GAP      = 2;           // px gap between adjacent event columns

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December'
];
const COLORS = [
  '#1a73e8','#0f9d58','#f4511e','#8430ce','#e37400',
  '#0288d1','#c2185b','#00796b','#5d4037','#455a64'
];

// ─── State ────────────────────────────────────────────────────────────────────
let currentWeekStart = getWeekStart(new Date());
let events = [];
let dragState = null;

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const weekLabel       = document.getElementById('week-label');
const dayHeadersEl    = document.getElementById('day-headers');
const timeGutterEl    = document.getElementById('time-gutter');
const dayColumnsEl    = document.getElementById('day-columns');
const gridScroll      = document.getElementById('grid-scroll');
const modalOverlay    = document.getElementById('modal-overlay');
const modalTitle      = document.getElementById('modal-title');
const eventForm       = document.getElementById('event-form');
const eventIdInput    = document.getElementById('event-id');
const eventTitleInput = document.getElementById('event-title');
const eventStartInput = document.getElementById('event-start');
const eventEndInput   = document.getElementById('event-end');
const formError       = document.getElementById('form-error');
const btnDelete       = document.getElementById('btn-delete');
const btnSave         = document.getElementById('btn-save');

// ─── Date utilities ───────────────────────────────────────────────────────────

/** Monday of the week containing `date` (local calendar date). */
function getWeekStart(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay(); // 0=Sun, 1=Mon, …
  const offset = dow === 0 ? -6 : 1 - dow; // days to subtract to reach Monday
  d.setDate(d.getDate() + offset);
  d.setHours(0, 0, 0, 0); // re-normalize after date arithmetic
  return d;
}

/** Date for day `idx` (0=Mon…6=Sun) of the given week. */
function getDayDate(weekStart, idx) {
  const d = new Date(weekStart);
  d.setDate(d.getDate() + idx);
  return d;
}

/** "YYYY-MM-DDTHH:MM" for datetime-local inputs (local time). */
function toDatetimeLocal(date) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth()+1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}`;
}

/** "HH:MM" from a Date (local time). */
function formatTime(date) {
  const p = n => String(n).padStart(2, '0');
  return `${p(date.getHours())}:${p(date.getMinutes())}`;
}

/** "MMM D" short date. */
function formatShortDate(date) {
  return `${MONTH_NAMES[date.getMonth()].slice(0,3)} ${date.getDate()}`;
}

/** Minutes from midnight (local time). */
function getMinutes(date) {
  return date.getHours() * 60 + date.getMinutes();
}

/** px from minutes. */
function minutesToPx(min) {
  return (min / MINUTES_PER_DAY) * TOTAL_HEIGHT;
}

/** minutes from px offset within a day column. */
function pxToMinutes(px) {
  return (px / TOTAL_HEIGHT) * MINUTES_PER_DAY;
}

/** Snap to nearest 15-minute boundary. */
function snap15(min) {
  return Math.round(min / 15) * 15;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth()    === b.getMonth()    &&
         a.getDate()     === b.getDate();
}

function isToday(date) { return isSameDay(date, new Date()); }

/**
 * Parse the server's "YYYY-MM-DDTHH:MM:SS" string as LOCAL time.
 * The server returns timestamps without a timezone suffix, so
 * `new Date(str)` would parse them as UTC in most environments.
 * We force local interpretation by replacing the T separator.
 */
function parseLocalISO(str) {
  // "2026-06-15T09:00:00" → local Date
  return new Date(str.replace('T', ' '));
}

// ─── Week label ───────────────────────────────────────────────────────────────
function updateWeekLabel() {
  const s = currentWeekStart;
  const e = getDayDate(s, 6);
  if (s.getMonth() === e.getMonth()) {
    weekLabel.textContent =
      `${MONTH_NAMES[s.getMonth()]} ${s.getDate()}–${e.getDate()}, ${s.getFullYear()}`;
  } else if (s.getFullYear() === e.getFullYear()) {
    weekLabel.textContent =
      `${formatShortDate(s)} – ${formatShortDate(e)}, ${s.getFullYear()}`;
  } else {
    weekLabel.textContent =
      `${formatShortDate(s)}, ${s.getFullYear()} – ${formatShortDate(e)}, ${e.getFullYear()}`;
  }
}

// ─── Build static grid ────────────────────────────────────────────────────────
function buildGrid() {
  // Time gutter labels
  timeGutterEl.innerHTML = '';
  for (let h = 1; h <= 23; h++) {
    const lbl = document.createElement('div');
    lbl.className = 'hour-label';
    lbl.style.top = `${minutesToPx(h * 60)}px`;
    lbl.textContent = `${String(h).padStart(2,'0')}:00`;
    timeGutterEl.appendChild(lbl);
  }

  // 7 day columns
  dayColumnsEl.innerHTML = '';
  for (let d = 0; d < 7; d++) {
    const col = document.createElement('div');
    col.className = 'day-col';
    col.dataset.dayIndex = d;

    // Hour and half-hour lines
    for (let h = 0; h < 24; h++) {
      const hl = document.createElement('div');
      hl.className = 'hour-line';
      hl.style.top = `${minutesToPx(h * 60)}px`;
      col.appendChild(hl);

      const hh = document.createElement('div');
      hh.className = 'half-hour-line';
      hh.style.top = `${minutesToPx(h * 60 + 30)}px`;
      col.appendChild(hh);
    }
    // Bottom boundary line
    const bot = document.createElement('div');
    bot.className = 'hour-line';
    bot.style.top = `${TOTAL_HEIGHT}px`;
    col.appendChild(bot);

    col.addEventListener('mousedown', onColMouseDown);
    dayColumnsEl.appendChild(col);
  }
}

// ─── Update day headers ───────────────────────────────────────────────────────
function updateDayHeaders() {
  dayHeadersEl.querySelectorAll('.day-header-cell').forEach(el => el.remove());

  for (let d = 0; d < 7; d++) {
    const date = getDayDate(currentWeekStart, d);
    const cell = document.createElement('div');
    cell.className = 'day-header-cell' + (isToday(date) ? ' today' : '');

    const nameEl = document.createElement('div');
    nameEl.className = 'day-name';
    nameEl.textContent = DAY_NAMES[d];

    const numEl = document.createElement('div');
    numEl.className = 'day-number';
    numEl.textContent = date.getDate();

    cell.appendChild(nameEl);
    cell.appendChild(numEl);
    dayHeadersEl.appendChild(cell);
  }
}

// ─── Today column highlight ───────────────────────────────────────────────────
function updateTodayColumn() {
  Array.from(dayColumnsEl.children).forEach((col, d) => {
    col.classList.toggle('today-col', isToday(getDayDate(currentWeekStart, d)));
  });
}

// ─── Current time indicator ───────────────────────────────────────────────────
let _timeInterval = null;

function updateCurrentTimeLine() {
  document.querySelectorAll('.current-time-line').forEach(el => el.remove());
  const now = new Date();
  Array.from(dayColumnsEl.children).forEach((col, d) => {
    if (isToday(getDayDate(currentWeekStart, d))) {
      const line = document.createElement('div');
      line.className = 'current-time-line';
      line.style.top = `${minutesToPx(getMinutes(now))}px`;
      col.appendChild(line);
    }
  });
}

function startTimeLine() {
  if (_timeInterval) clearInterval(_timeInterval);
  updateCurrentTimeLine();
  _timeInterval = setInterval(updateCurrentTimeLine, 60_000);
}

// ─── Render events ────────────────────────────────────────────────────────────

/** Day index (0=Mon) for a date within the current week, or -1 if outside.
 *  Uses calendar-date comparison (UTC noon) to avoid DST-induced off-by-one errors.
 */
function dayIndexOf(date) {
  // Compare calendar dates via UTC to sidestep DST hour shifts
  const wUTC = Date.UTC(
    currentWeekStart.getFullYear(),
    currentWeekStart.getMonth(),
    currentWeekStart.getDate()
  );
  const dUTC = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const diff = Math.round((dUTC - wUTC) / 86_400_000);
  return (diff >= 0 && diff <= 6) ? diff : -1;
}

/**
 * Compute the effective [startMin, endMin] for an event within a given day.
 * Handles the midnight-end case: if endDate is 00:00 of the next day,
 * treat it as 24:00 (1440) so the block reaches the column bottom.
 */
function effectiveMinutes(startDate, endDate) {
  let startMin = clamp(getMinutes(startDate), 0, MINUTES_PER_DAY);
  let endMin   = getMinutes(endDate);
  // Midnight of the next day → 24:00
  if (endMin === 0 && !isSameDay(startDate, endDate)) {
    endMin = MINUTES_PER_DAY;
  }
  endMin = clamp(endMin, 0, MINUTES_PER_DAY);
  return [startMin, endMin];
}

function renderEvents() {
  // Remove existing event blocks only (keep grid lines, time indicator)
  document.querySelectorAll('.event-block').forEach(el => el.remove());

  // Group events by day index
  const byDay = new Map();
  for (const ev of events) {
    const startDate = parseLocalISO(ev.start_at);
    const endDate   = parseLocalISO(ev.end_at);
    const idx = dayIndexOf(startDate);
    if (idx < 0) continue;

    if (!byDay.has(idx)) byDay.set(idx, []);
    byDay.get(idx).push({ ...ev, startDate, endDate });
  }

  // Render each day
  for (const [idx, dayEvents] of byDay) {
    const col = dayColumnsEl.children[idx];
    if (!col) continue;

    // Build layout input
    const layoutInput = dayEvents.map(ev => {
      const [startMin, endMin] = effectiveMinutes(ev.startDate, ev.endDate);
      return { id: ev.id, startMin, endMin };
    });

    const positioned = computeLayout(layoutInput);

    for (const pos of positioned) {
      const ev = dayEvents.find(e => e.id === pos.id);
      if (!ev) continue;

      const top    = minutesToPx(pos.startMin);
      const height = Math.max(minutesToPx(pos.endMin) - top, 18);

      const block = document.createElement('div');
      block.className = 'event-block';
      block.dataset.eventId = ev.id;
      block.style.top    = `${top}px`;
      block.style.height = `${height}px`;
      // left/width as percentages; subtract EVENT_GAP for visual separation
      block.style.left   = `${pos.left * 100}%`;
      block.style.width  = `calc(${pos.width * 100}% - ${EVENT_GAP}px)`;
      block.style.background = COLORS[ev.id % COLORS.length];

      const titleEl = document.createElement('div');
      titleEl.className = 'event-title';
      titleEl.textContent = ev.title;

      const timeEl = document.createElement('div');
      timeEl.className = 'event-time';
      const endStr = pos.endMin >= MINUTES_PER_DAY ? '24:00' : formatTime(ev.endDate);
      timeEl.textContent = `${formatTime(ev.startDate)} – ${endStr}`;

      block.appendChild(titleEl);
      block.appendChild(timeEl);

      block.addEventListener('click', e => {
        e.stopPropagation();
        openEditModal(ev);
      });

      col.appendChild(block);
    }
  }
}

// ─── Fetch & render ───────────────────────────────────────────────────────────
async function fetchAndRender() {
  const weekEnd = getDayDate(currentWeekStart, 7); // exclusive (next Monday 00:00)
  try {
    events = await api.getEvents(
      currentWeekStart.toISOString(),
      weekEnd.toISOString()
    );
  } catch (err) {
    console.error('Failed to fetch events:', err);
    events = [];
  }
  updateDayHeaders();
  updateTodayColumn();
  renderEvents();
  startTimeLine();
}

// ─── Navigation ───────────────────────────────────────────────────────────────
document.getElementById('btn-prev').addEventListener('click', () => {
  currentWeekStart = new Date(currentWeekStart);
  currentWeekStart.setDate(currentWeekStart.getDate() - 7);
  updateWeekLabel();
  fetchAndRender();
});

document.getElementById('btn-next').addEventListener('click', () => {
  currentWeekStart = new Date(currentWeekStart);
  currentWeekStart.setDate(currentWeekStart.getDate() + 7);
  updateWeekLabel();
  fetchAndRender();
});

document.getElementById('btn-today').addEventListener('click', () => {
  currentWeekStart = getWeekStart(new Date());
  updateWeekLabel();
  fetchAndRender();
});

// ─── Drag-to-create ───────────────────────────────────────────────────────────

/** Y offset within a day column, accounting for scroll. */
function colRelativeY(col, clientY) {
  const rect = col.getBoundingClientRect();
  return clientY - rect.top + gridScroll.scrollTop;
}

function onColMouseDown(e) {
  if (e.button !== 0) return;
  if (e.target.closest('.event-block')) return;

  const col = e.currentTarget;
  const dayIndex = parseInt(col.dataset.dayIndex, 10);
  const relY = colRelativeY(col, e.clientY);
  const anchorMin = clamp(snap15(pxToMinutes(relY)), 0, MINUTES_PER_DAY - 15);

  const ghost = document.createElement('div');
  ghost.className = 'drag-ghost';
  ghost.style.left  = '0';
  ghost.style.right = '0';
  ghost.style.top    = `${minutesToPx(anchorMin)}px`;
  ghost.style.height = `${minutesToPx(15)}px`;
  col.appendChild(ghost);

  dragState = { dayIndex, anchorMin, selStart: anchorMin, selEnd: anchorMin + 15, ghost, col };
  e.preventDefault();
}

document.addEventListener('mousemove', e => {
  if (!dragState) return;
  const { col, anchorMin } = dragState;
  const relY = colRelativeY(col, e.clientY);
  const curMin = clamp(snap15(pxToMinutes(relY)), 0, MINUTES_PER_DAY);

  const selStart = Math.min(anchorMin, curMin);
  const selEnd   = Math.max(anchorMin, curMin);
  const finalEnd = Math.max(selEnd, selStart + 15);

  dragState.selStart = selStart;
  dragState.selEnd   = finalEnd;

  dragState.ghost.style.top    = `${minutesToPx(selStart)}px`;
  dragState.ghost.style.height = `${minutesToPx(finalEnd - selStart)}px`;
});

document.addEventListener('mouseup', () => {
  if (!dragState) return;
  const { dayIndex, selStart, selEnd, ghost } = dragState;
  ghost.remove();
  dragState = null;

  const dayDate = getDayDate(currentWeekStart, dayIndex);
  const startDate = new Date(dayDate);
  startDate.setHours(Math.floor(selStart / 60), selStart % 60, 0, 0);
  const endDate = new Date(dayDate);
  endDate.setHours(Math.floor(selEnd / 60), selEnd % 60, 0, 0);

  openCreateModal(startDate, endDate);
});

// ─── Modal ────────────────────────────────────────────────────────────────────
function showModal() {
  modalOverlay.classList.remove('hidden');
  setTimeout(() => eventTitleInput.focus(), 50);
}

function hideModal() {
  modalOverlay.classList.add('hidden');
  formError.classList.add('hidden');
  formError.textContent = '';
  eventForm.reset();
  eventIdInput.value = '';
}

function openCreateModal(startDate, endDate) {
  modalTitle.textContent = 'New Event';
  eventIdInput.value = '';
  eventTitleInput.value = '';
  eventStartInput.value = toDatetimeLocal(startDate);
  eventEndInput.value   = toDatetimeLocal(endDate);
  btnDelete.classList.add('hidden');
  btnSave.textContent = 'Create';
  showModal();
}

function openEditModal(ev) {
  modalTitle.textContent = 'Edit Event';
  eventIdInput.value = ev.id;
  eventTitleInput.value = ev.title;
  eventStartInput.value = toDatetimeLocal(parseLocalISO(ev.start_at));
  eventEndInput.value   = toDatetimeLocal(parseLocalISO(ev.end_at));
  btnDelete.classList.remove('hidden');
  btnSave.textContent = 'Save';
  showModal();
}

function showFormError(msg) {
  formError.textContent = msg;
  formError.classList.remove('hidden');
}

// ─── Form submit ──────────────────────────────────────────────────────────────
eventForm.addEventListener('submit', async e => {
  e.preventDefault();
  formError.classList.add('hidden');

  const id    = eventIdInput.value;
  const title = eventTitleInput.value.trim();
  const start = eventStartInput.value;
  const end   = eventEndInput.value;

  if (!title) { showFormError('Title is required.'); return; }
  if (!start || !end) { showFormError('Start and end times are required.'); return; }
  if (new Date(end) <= new Date(start)) {
    showFormError('End time must be after start time.');
    return;
  }

  const payload = {
    title,
    start_at: new Date(start).toISOString(),
    end_at:   new Date(end).toISOString(),
  };

  try {
    if (id) {
      await api.updateEvent(id, payload);
    } else {
      await api.createEvent(payload);
    }
    hideModal();
    await fetchAndRender();
  } catch (err) {
    showFormError(err.message || 'Failed to save event.');
  }
});

// ─── Delete ───────────────────────────────────────────────────────────────────
btnDelete.addEventListener('click', async () => {
  const id = eventIdInput.value;
  if (!id) return;
  if (!confirm('Delete this event?')) return;
  try {
    await api.deleteEvent(id);
    hideModal();
    await fetchAndRender();
  } catch (err) {
    showFormError(err.message || 'Failed to delete event.');
  }
});

// ─── Modal close ──────────────────────────────────────────────────────────────
document.getElementById('modal-close').addEventListener('click', hideModal);
document.getElementById('btn-cancel').addEventListener('click', hideModal);
modalOverlay.addEventListener('click', e => { if (e.target === modalOverlay) hideModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') hideModal(); });

// ─── Init ─────────────────────────────────────────────────────────────────────
buildGrid();
updateWeekLabel();
fetchAndRender().then(() => {
  // Scroll to 7am on initial load
  gridScroll.scrollTop = minutesToPx(7 * 60) - 32;
});
