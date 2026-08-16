import { api } from './api.js';
import { computeLayout } from './layout.js';
import {
  getMondayOf, getWeekDays, addWeeks,
  toDatetimeLocal, formatTime, formatDayHeader,
  formatWeekLabel, isSameDay, minutesFromMidnight,
} from './week.js';

// ── Constants ─────────────────────────────────────────────────────────────────
// Must match --hour-height in style.css
const HOUR_HEIGHT = 64; // px per hour
const TOTAL_MINUTES = 24 * 60;
const TOTAL_HEIGHT = HOUR_HEIGHT * 24; // px

function minutesToPx(minutes) {
  return (minutes / 60) * HOUR_HEIGHT;
}

// ── State ─────────────────────────────────────────────────────────────────────
let currentMonday = getMondayOf(new Date());
let events = []; // raw events from server for current week

// ── DOM refs ──────────────────────────────────────────────────────────────────
const weekLabel     = document.getElementById('week-label');
const dayHeaders    = document.getElementById('day-headers');
const timeGutter    = document.getElementById('time-gutter');
const timeLines     = document.getElementById('time-lines');
const eventColumns  = document.getElementById('event-columns');
const gridBody      = document.getElementById('grid-body');

const modalOverlay  = document.getElementById('modal-overlay');
const modalTitle    = document.getElementById('modal-title');
const eventForm     = document.getElementById('event-form');
const fTitle        = document.getElementById('f-title');
const fStart        = document.getElementById('f-start');
const fEnd          = document.getElementById('f-end');
const formError     = document.getElementById('form-error');
const btnSave       = document.getElementById('btn-save');
const btnDelete     = document.getElementById('btn-delete');
const btnCancel     = document.getElementById('btn-cancel');

// ── Build static grid structure (once) ───────────────────────────────────────

function buildTimeGutter() {
  timeGutter.innerHTML = '';
  for (let h = 0; h <= 24; h++) {
    const label = document.createElement('div');
    label.className = 'gutter-label';
    label.style.height = `${HOUR_HEIGHT}px`;
    label.textContent = h < 24 ? `${String(h).padStart(2, '0')}:00` : '';
    timeGutter.appendChild(label);
  }
}

function buildTimeLines() {
  timeLines.innerHTML = '';
  for (let h = 0; h <= 24; h++) {
    const line = document.createElement('div');
    line.className = 'hour-line';
    line.style.top = `${minutesToPx(h * 60)}px`;
    timeLines.appendChild(line);

    if (h < 24) {
      const half = document.createElement('div');
      half.className = 'half-hour-line';
      half.style.top = `${minutesToPx(h * 60 + 30)}px`;
      timeLines.appendChild(half);
    }
  }
}

buildTimeGutter();
buildTimeLines();

// ── Week rendering ────────────────────────────────────────────────────────────

function renderWeek() {
  const sunday = addWeeks(currentMonday, 1);
  sunday.setDate(sunday.getDate() - 1); // Sunday = Monday + 6 days
  weekLabel.textContent = formatWeekLabel(currentMonday, sunday);

  const days = getWeekDays(currentMonday);
  const today = new Date();

  // ── Day headers ──
  dayHeaders.innerHTML = '';
  days.forEach(day => {
    const { dayName, dayNum } = formatDayHeader(day);
    const hdr = document.createElement('div');
    hdr.className = 'day-header' + (isSameDay(day, today) ? ' today' : '');
    hdr.innerHTML = `
      <span class="day-name">${dayName}</span>
      <span class="day-date">${dayNum}</span>
    `;
    dayHeaders.appendChild(hdr);
  });

  // ── Event columns ──
  eventColumns.innerHTML = '';
  days.forEach((day, dayIndex) => {
    const col = document.createElement('div');
    col.className = 'day-column' + (isSameDay(day, today) ? ' today' : '');
    col.dataset.dayIndex = dayIndex;

    // Attach drag-to-create listeners
    attachDragListeners(col, day);

    eventColumns.appendChild(col);
  });

  renderEvents();
}

// ── Event rendering ───────────────────────────────────────────────────────────

function renderEvents() {
  const days = getWeekDays(currentMonday);
  const today = new Date();

  // Clear existing event blocks (but keep the column divs)
  document.querySelectorAll('.event-block, .now-line').forEach(el => el.remove());

  // Group events by day index
  const byDay = Array.from({ length: 7 }, () => []);

  for (const ev of events) {
    const evStart = new Date(ev.start_at);
    for (let i = 0; i < 7; i++) {
      if (isSameDay(evStart, days[i])) {
        byDay[i].push(ev);
        break;
      }
    }
  }

  // Render each day
  const dayColumns = document.querySelectorAll('.day-column');
  days.forEach((day, i) => {
    const col = dayColumns[i];
    const laid = computeLayout(byDay[i]);

    for (const ev of laid) {
      const block = createEventBlock(ev);
      col.appendChild(block);
    }

    // Current-time indicator for today
    if (isSameDay(day, today)) {
      const nowLine = document.createElement('div');
      nowLine.className = 'now-line';
      const nowMinutes = minutesFromMidnight(today);
      nowLine.style.top = `${minutesToPx(nowMinutes)}px`;
      col.appendChild(nowLine);
    }
  });
}

function createEventBlock(ev) {
  const startDate = new Date(ev.start_at);
  const endDate   = new Date(ev.end_at);

  const startMin = minutesFromMidnight(startDate);

  // Compute end minutes, handling events that end exactly at 00:00 of the
  // next day (which represents 24:00 / end-of-day).
  let rawEndMin = minutesFromMidnight(endDate);
  if (rawEndMin === 0 && endDate > startDate) {
    rawEndMin = TOTAL_MINUTES; // 24:00
  }
  const endMinClamped = Math.min(rawEndMin, TOTAL_MINUTES);

  const topPx    = minutesToPx(startMin);
  const heightPx = Math.max(minutesToPx(endMinClamped - startMin), 18);

  // Horizontal layout
  const widthPct  = 100 / ev.totalCols;
  const leftPct   = widthPct * ev.col;

  const block = document.createElement('div');
  block.className = 'event-block';
  block.style.top    = `${topPx}px`;
  block.style.height = `${heightPx}px`;
  block.style.left   = `${leftPct}%`;
  block.style.width  = `calc(${widthPct}% - 2px)`;

  const timeStr = `${formatTime(startDate)} – ${formatTime(endDate)}`;
  block.innerHTML = `
    <div class="event-title">${escapeHtml(ev.title)}</div>
    <div class="event-time">${timeStr}</div>
  `;

  block.addEventListener('click', e => {
    e.stopPropagation();
    openEditModal(ev);
  });

  return block;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Drag-to-create ────────────────────────────────────────────────────────────

function attachDragListeners(colEl, day) {
  let dragStart = null;
  let ghost = null;

  function yToMinutes(y) {
    // Clamp to [0, TOTAL_HEIGHT]
    const clamped = Math.max(0, Math.min(y, TOTAL_HEIGHT));
    // Snap to 15-minute intervals
    const raw = (clamped / TOTAL_HEIGHT) * TOTAL_MINUTES;
    return Math.round(raw / 15) * 15;
  }

  function minutesToDate(minutes) {
    const d = new Date(day);
    d.setHours(0, 0, 0, 0);
    d.setMinutes(minutes);
    return d;
  }

  colEl.addEventListener('mousedown', e => {
    // Only left-click on the column background (not on event blocks)
    if (e.button !== 0) return;
    if (e.target.closest('.event-block')) return;

    e.preventDefault();
    const rect = colEl.getBoundingClientRect();
    const y = e.clientY - rect.top + colEl.closest('#grid-body').scrollTop;
    dragStart = yToMinutes(y);

    ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    ghost.style.left   = '1px';
    ghost.style.right  = '1px';
    ghost.style.top    = `${minutesToPx(dragStart)}px`;
    ghost.style.height = `${minutesToPx(15)}px`;
    colEl.appendChild(ghost);
  });

  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);

  function onMouseMove(e) {
    if (dragStart === null || !ghost) return;
    const rect = colEl.getBoundingClientRect();
    const y = e.clientY - rect.top + colEl.closest('#grid-body').scrollTop;
    const current = yToMinutes(y);

    const top    = Math.min(dragStart, current);
    const bottom = Math.max(dragStart, current);
    const height = Math.max(bottom - top, 15);

    ghost.style.top    = `${minutesToPx(top)}px`;
    ghost.style.height = `${minutesToPx(height)}px`;
  }

  function onMouseUp(e) {
    if (dragStart === null) return;

    const rect = colEl.getBoundingClientRect();
    const y = e.clientY - rect.top + colEl.closest('#grid-body').scrollTop;
    const dragEnd = yToMinutes(y);

    const startMin = Math.min(dragStart, dragEnd);
    const endMin   = Math.max(dragStart, dragEnd);

    if (ghost) { ghost.remove(); ghost = null; }
    dragStart = null;

    // Minimum 15 minutes
    const finalEnd = endMin - startMin < 15 ? startMin + 60 : endMin;

    const startDate = minutesToDate(startMin);
    const endDate   = minutesToDate(Math.min(finalEnd, TOTAL_MINUTES));

    openCreateModal(startDate, endDate);
  }
}

// ── Modal ─────────────────────────────────────────────────────────────────────

let editingEventId = null;

function showFormError(msg) {
  formError.textContent = msg;
  formError.classList.remove('hidden');
}

function hideFormError() {
  formError.classList.add('hidden');
}

function openCreateModal(startDate, endDate) {
  editingEventId = null;
  modalTitle.textContent = 'New Event';
  fTitle.value = '';
  fStart.value = toDatetimeLocal(startDate);
  fEnd.value   = toDatetimeLocal(endDate);
  btnDelete.classList.add('hidden');
  hideFormError();
  modalOverlay.classList.remove('hidden');
  fTitle.focus();
}

function openEditModal(ev) {
  editingEventId = ev.id;
  modalTitle.textContent = 'Edit Event';
  fTitle.value = ev.title;
  fStart.value = toDatetimeLocal(new Date(ev.start_at));
  fEnd.value   = toDatetimeLocal(new Date(ev.end_at));
  btnDelete.classList.remove('hidden');
  hideFormError();
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
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModal();
});

eventForm.addEventListener('submit', async e => {
  e.preventDefault();
  hideFormError();

  const title    = fTitle.value.trim();
  const startVal = fStart.value;
  const endVal   = fEnd.value;

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

  btnSave.disabled = true;
  try {
    if (editingEventId === null) {
      await api.createEvent(title, startDate.toISOString(), endDate.toISOString());
    } else {
      await api.updateEvent(editingEventId, title, startDate.toISOString(), endDate.toISOString());
    }
    closeModal();
    await loadAndRender();
  } catch (err) {
    showFormError(err.message || 'Failed to save event.');
  } finally {
    btnSave.disabled = false;
  }
});

btnDelete.addEventListener('click', async () => {
  if (editingEventId === null) return;
  if (!confirm('Delete this event?')) return;

  btnDelete.disabled = true;
  try {
    await api.deleteEvent(editingEventId);
    closeModal();
    await loadAndRender();
  } catch (err) {
    showFormError(err.message || 'Failed to delete event.');
  } finally {
    btnDelete.disabled = false;
  }
});

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadAndRender() {
  const weekStart = new Date(currentMonday);
  weekStart.setHours(0, 0, 0, 0);

  const weekEnd = addWeeks(weekStart, 1);

  try {
    events = await api.getEvents(weekStart.toISOString(), weekEnd.toISOString());
  } catch (err) {
    console.error('Failed to load events:', err);
    events = [];
  }

  renderWeek();
}

// ── Navigation ────────────────────────────────────────────────────────────────

document.getElementById('btn-prev').addEventListener('click', async () => {
  currentMonday = addWeeks(currentMonday, -1);
  await loadAndRender();
});

document.getElementById('btn-today').addEventListener('click', async () => {
  currentMonday = getMondayOf(new Date());
  await loadAndRender();
});

document.getElementById('btn-next').addEventListener('click', async () => {
  currentMonday = addWeeks(currentMonday, 1);
  await loadAndRender();
});

// ── Current-time auto-update ──────────────────────────────────────────────────

function updateNowLine() {
  const nowLines = document.querySelectorAll('.now-line');
  const today = new Date();
  const nowMinutes = minutesFromMidnight(today);
  nowLines.forEach(line => {
    line.style.top = `${minutesToPx(nowMinutes)}px`;
  });
}

setInterval(updateNowLine, 60_000);

// ── Scroll to business hours on load ─────────────────────────────────────────

function scrollToCurrentTime() {
  const today = new Date();
  const minutes = minutesFromMidnight(today);
  // Scroll so current time is roughly 1/3 from the top
  const targetScroll = minutesToPx(minutes) - gridBody.clientHeight / 3;
  gridBody.scrollTop = Math.max(0, targetScroll);
}

// ── Init ──────────────────────────────────────────────────────────────────────

await loadAndRender();
scrollToCurrentTime();
