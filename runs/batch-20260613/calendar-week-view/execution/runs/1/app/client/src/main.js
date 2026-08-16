import { api } from './api.js';
import { computeLayout } from './layout.js';
import {
  getMondayOf, getWeekDays, shiftWeek,
  dayStart, dayEnd,
  formatDayHeader, formatWeekLabel, isToday,
  toDatetimeLocal, formatTime,
} from './week.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const HOUR_H   = 64;    // px per hour — must match CSS --hour-h
const TOTAL_H  = HOUR_H * 24;
const MINS_DAY = 1440;

// ── State ─────────────────────────────────────────────────────────────────────
let currentMonday = getMondayOf(new Date());
let events        = [];

// ── DOM refs ──────────────────────────────────────────────────────────────────
const weekLabel    = document.getElementById('week-label');
const btnPrev      = document.getElementById('btn-prev');
const btnToday     = document.getElementById('btn-today');
const btnNext      = document.getElementById('btn-next');
const timeGutter   = document.getElementById('time-gutter');
const daysRow      = document.getElementById('days-row');
const calContainer = document.getElementById('cal-container');

const modalOverlay = document.getElementById('modal-overlay');
const modalTitle   = document.getElementById('modal-title');
const eventForm    = document.getElementById('event-form');
const fTitle       = document.getElementById('f-title');
const fStart       = document.getElementById('f-start');
const fEnd         = document.getElementById('f-end');
const formError    = document.getElementById('form-error');
const btnDelete    = document.getElementById('btn-delete');
const btnCancel    = document.getElementById('btn-cancel');

// ── Helpers ───────────────────────────────────────────────────────────────────
function minutesToPx(mins) {
  return (mins / MINS_DAY) * TOTAL_H;
}

function escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Time gutter ───────────────────────────────────────────────────────────────
function buildTimeGutter() {
  timeGutter.innerHTML = '';
  for (let h = 0; h <= 24; h++) {
    const label = document.createElement('div');
    label.className = 'gutter-label';
    label.style.top = `${h * HOUR_H}px`;
    // Don't show 00:00 label (it would be cut off at top)
    label.textContent = h === 0 ? '' : `${String(h).padStart(2, '0')}:00`;
    timeGutter.appendChild(label);
  }
}

// ── Week grid ─────────────────────────────────────────────────────────────────
function buildWeekGrid(weekDays) {
  // Remove old sticky header row if present
  const oldHeader = document.getElementById('days-header-row');
  if (oldHeader) oldHeader.remove();

  // Build sticky day-header row and insert at top of cal-container
  const headerRow = document.createElement('div');
  headerRow.id = 'days-header-row';

  // Gutter spacer to align with time gutter
  const gutterSpacer = document.createElement('div');
  gutterSpacer.className = 'day-header-gutter';
  headerRow.appendChild(gutterSpacer);

  weekDays.forEach(day => {
    const cell = document.createElement('div');
    cell.className = 'day-header-cell' + (isToday(day) ? ' today' : '');
    const { dow, num } = formatDayHeader(day);
    cell.innerHTML = `<span class="dow">${dow}</span><span class="date-num">${num}</span>`;
    headerRow.appendChild(cell);
  });

  // Insert sticky header before the cal-body
  calContainer.insertBefore(headerRow, calContainer.firstChild);

  // Build day columns
  daysRow.innerHTML = '';
  weekDays.forEach((day, dayIdx) => {
    const col = document.createElement('div');
    col.className = 'day-col' + (isToday(day) ? ' today-col' : '');
    col.dataset.dayIdx = dayIdx;
    col.dataset.date   = day.toISOString().slice(0, 10);

    // Hour lines (00:00 through 24:00)
    for (let h = 0; h <= 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${h * HOUR_H}px`;
      col.appendChild(line);
      // Half-hour dashed line
      if (h < 24) {
        const half = document.createElement('div');
        half.className = 'hour-line half';
        half.style.top = `${h * HOUR_H + HOUR_H / 2}px`;
        col.appendChild(half);
      }
    }

    // Drag-to-create interaction
    attachDragCreate(col, day);

    daysRow.appendChild(col);
  });
}

// ── Event rendering ───────────────────────────────────────────────────────────
function renderEvents(weekDays) {
  // Clear existing event blocks
  daysRow.querySelectorAll('.event-block').forEach(el => el.remove());

  weekDays.forEach((day, dayIdx) => {
    const col = daysRow.children[dayIdx];
    if (!col) return;

    // Day boundaries in ms
    const dayStart0 = new Date(day); dayStart0.setHours(0, 0, 0, 0);
    const dayEnd0   = new Date(day); dayEnd0.setHours(24, 0, 0, 0);

    // Events that overlap this day
    const dayEvents = events.filter(ev => {
      const s = new Date(ev.start_at);
      const e = new Date(ev.end_at);
      return s < dayEnd0 && e > dayStart0;
    });

    const laid = computeLayout(dayEvents);

    laid.forEach(({ event: ev, colIndex, colCount }) => {
      const block = buildEventBlock(ev, day, dayStart0, dayEnd0, colIndex, colCount);
      col.appendChild(block);
    });
  });
}

function buildEventBlock(ev, day, dayStart0, dayEnd0, colIndex, colCount) {
  const evStart = new Date(ev.start_at);
  const evEnd   = new Date(ev.end_at);

  // Clamp to day boundaries (handles multi-day events gracefully)
  const clampedStartMs = Math.max(evStart.getTime(), dayStart0.getTime());
  const clampedEndMs   = Math.min(evEnd.getTime(),   dayEnd0.getTime());

  const startMins = (clampedStartMs - dayStart0.getTime()) / 60000;
  const endMins   = (clampedEndMs   - dayStart0.getTime()) / 60000;

  const top    = minutesToPx(startMins);
  const height = Math.max(minutesToPx(endMins - startMins), 18); // minimum 18px for visibility

  // Horizontal layout using percentages
  // Small pixel gap between adjacent event columns for visual separation
  const GAP       = 2; // px
  const widthPct  = 100 / colCount;
  const leftPct   = (colIndex / colCount) * 100;

  const block = document.createElement('div');
  block.className = `event-block ev-color-${ev.id % 8}`;
  block.style.top    = `${top}px`;
  block.style.height = `${height}px`;
  block.style.left   = `calc(${leftPct}% + ${GAP}px)`;
  block.style.width  = `calc(${widthPct}% - ${GAP * 2}px)`;

  const timeStr = `${formatTime(ev.start_at)} – ${formatTime(ev.end_at)}`;
  block.innerHTML = `
    <div class="ev-title">${escHtml(ev.title)}</div>
    <div class="ev-time">${timeStr}</div>
  `;

  block.addEventListener('click', e => {
    e.stopPropagation();
    openEditModal(ev);
  });

  return block;
}

// ── Drag-to-create ────────────────────────────────────────────────────────────
function attachDragCreate(col, day) {
  let dragState = null;

  col.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    if (e.target.closest('.event-block')) return;

    const rect    = col.getBoundingClientRect();
    const y       = e.clientY - rect.top;
    const rawMins = (y / TOTAL_H) * MINS_DAY;
    const snapMins = Math.round(rawMins / 15) * 15; // snap to 15-min grid

    const ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    col.appendChild(ghost);

    dragState = { startMins: snapMins, endMins: snapMins + 30, ghost };
    updateGhost(ghost, dragState.startMins, dragState.endMins);

    e.preventDefault();
  });

  function onMouseMove(e) {
    if (!dragState) return;
    const rect    = col.getBoundingClientRect();
    const y       = e.clientY - rect.top;
    const rawMins = (y / TOTAL_H) * MINS_DAY;
    const snapMins = Math.round(rawMins / 15) * 15;
    dragState.endMins = Math.max(snapMins, dragState.startMins + 15);
    updateGhost(dragState.ghost, dragState.startMins, dragState.endMins);
  }

  function onMouseUp() {
    if (!dragState) return;
    const { startMins, endMins, ghost } = dragState;
    dragState = null;
    ghost.remove();

    const startDate = new Date(day);
    startDate.setHours(0, startMins, 0, 0);
    const endDate = new Date(day);
    endDate.setHours(0, endMins, 0, 0);

    openCreateModal(toDatetimeLocal(startDate), toDatetimeLocal(endDate));
  }

  function updateGhost(ghost, startMins, endMins) {
    ghost.style.top    = `${minutesToPx(startMins)}px`;
    ghost.style.height = `${minutesToPx(endMins - startMins)}px`;
  }

  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup',   onMouseUp);
}

// ── Modal ─────────────────────────────────────────────────────────────────────
let editingEventId = null;

function showModal() {
  modalOverlay.classList.remove('hidden');
  fTitle.focus();
}

function hideModal() {
  modalOverlay.classList.add('hidden');
  editingEventId = null;
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

function openCreateModal(startLocal, endLocal) {
  editingEventId = null;
  modalTitle.textContent = 'New Event';
  fTitle.value = '';
  fStart.value = startLocal;
  fEnd.value   = endLocal;
  btnDelete.classList.add('hidden');
  hideFormError();
  showModal();
}

function openEditModal(ev) {
  editingEventId = ev.id;
  modalTitle.textContent = 'Edit Event';
  fTitle.value = ev.title;
  fStart.value = toDatetimeLocal(new Date(ev.start_at));
  fEnd.value   = toDatetimeLocal(new Date(ev.end_at));
  btnDelete.classList.remove('hidden');
  hideFormError();
  showModal();
}

// ── Form submission ───────────────────────────────────────────────────────────
eventForm.addEventListener('submit', async e => {
  e.preventDefault();
  hideFormError();

  const title    = fTitle.value.trim();
  const startVal = fStart.value;
  const endVal   = fEnd.value;

  if (!title)    { showFormError('Title is required.'); return; }
  if (!startVal) { showFormError('Start time is required.'); return; }
  if (!endVal)   { showFormError('End time is required.'); return; }

  const startISO = new Date(startVal).toISOString();
  const endISO   = new Date(endVal).toISOString();

  if (new Date(endISO) <= new Date(startISO)) {
    showFormError('End time must be after start time.');
    return;
  }

  try {
    if (editingEventId == null) {
      await api.createEvent({ title, start_at: startISO, end_at: endISO });
    } else {
      await api.updateEvent(editingEventId, { title, start_at: startISO, end_at: endISO });
    }
    hideModal();
    await loadAndRender();
  } catch (err) {
    showFormError(err.data?.error || err.message || 'Failed to save event.');
  }
});

btnDelete.addEventListener('click', async () => {
  if (editingEventId == null) return;
  if (!confirm('Delete this event?')) return;
  try {
    await api.deleteEvent(editingEventId);
    hideModal();
    await loadAndRender();
  } catch (err) {
    showFormError(err.data?.error || err.message || 'Failed to delete event.');
  }
});

btnCancel.addEventListener('click', hideModal);

modalOverlay.addEventListener('click', e => {
  if (e.target === modalOverlay) hideModal();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') hideModal();
});

// ── Data loading ──────────────────────────────────────────────────────────────
async function loadAndRender() {
  const weekDays = getWeekDays(currentMonday);
  const start    = dayStart(weekDays[0]);
  const end      = dayEnd(weekDays[6]);

  try {
    events = await api.getEvents(start, end);
  } catch (err) {
    console.error('Failed to load events:', err);
    events = [];
  }

  renderEvents(weekDays);
}

// ── Navigation ────────────────────────────────────────────────────────────────
async function navigate(monday) {
  currentMonday = monday;
  const weekDays = getWeekDays(currentMonday);
  weekLabel.textContent = formatWeekLabel(currentMonday);
  buildWeekGrid(weekDays);
  await loadAndRender();
}

btnPrev.addEventListener('click',  () => navigate(shiftWeek(currentMonday, -1)));
btnNext.addEventListener('click',  () => navigate(shiftWeek(currentMonday,  1)));
btnToday.addEventListener('click', () => navigate(getMondayOf(new Date())));

// ── Bootstrap ─────────────────────────────────────────────────────────────────
buildTimeGutter();
navigate(currentMonday);
