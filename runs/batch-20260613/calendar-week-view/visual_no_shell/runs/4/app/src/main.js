import { computeDayLayout, snapMinutes } from './layout.js';
import { fetchEvents, createEvent, updateEvent, deleteEvent } from './api.js';

// ── Constants ──────────────────────────────────────────────────────────────
const HOUR_HEIGHT = 60; // px per hour (matches CSS --hour-height)
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// Event color palette (cycles by event id)
const EVENT_COLORS = [
  '#1a73e8', // blue
  '#0f9d58', // green
  '#f4511e', // deep orange
  '#8430ce', // purple
  '#e37400', // amber
  '#0288d1', // light blue
  '#00897b', // teal
  '#c62828', // red
  '#6a1b9a', // deep purple
  '#558b2f', // light green
];

// ── State ──────────────────────────────────────────────────────────────────
let currentWeekStart = getWeekStart(new Date());
let events = [];
// Track drag listeners so we can clean them up on re-render
let activeDragListeners = [];

// ── Date Utilities ─────────────────────────────────────────────────────────

/** Get Monday of the week containing `date` (local time) */
function getWeekStart(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0=Sun, 1=Mon, ...
  const diff = (day === 0) ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
}

/** Get the 7 dates of the week starting from weekStart (Monday) */
function getWeekDates(weekStart) {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    return d;
  });
}

/** Format date as local YYYY-MM-DD */
function formatDateLocal(date) {
  const d = new Date(date);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dy = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${dy}`;
}

/** Format time as HH:MM (local) */
function formatTime(dateStr) {
  const d = new Date(dateStr);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

/** Format for datetime-local input (local time, no seconds) */
function formatDateTimeLocal(date) {
  const d = new Date(date);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Format week label e.g. "Jun 15 – Jun 21, 2026" */
function formatWeekLabel(weekStart) {
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);
  const opts = { month: 'short', day: 'numeric' };
  const startStr = weekStart.toLocaleDateString(undefined, opts);
  const endStr = weekEnd.toLocaleDateString(undefined, { ...opts, year: 'numeric' });
  return `${startStr} – ${endStr}`;
}

/** Check if two dates are the same local calendar day */
function isSameDay(a, b) {
  const da = new Date(a);
  const db = new Date(b);
  return da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate();
}

/** Build a Date from a day date + minutes from midnight (local) */
function dateFromDayAndMinutes(dayDate, minutes) {
  const d = new Date(dayDate);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h >= 24) {
    d.setDate(d.getDate() + 1);
    d.setHours(0, 0, 0, 0);
  } else {
    d.setHours(h, m, 0, 0);
  }
  return d;
}

// ── Toast Notifications ────────────────────────────────────────────────────
function showToast(message, type = 'info') {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `toast${type === 'error' ? ' error' : ''}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ── HTML Escape ────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Modal ──────────────────────────────────────────────────────────────────
function openModal({ title = '', startAt = '', endAt = '', eventId = null }) {
  closeModal();

  const isEdit = eventId !== null;
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';

  backdrop.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <h2 id="modal-title">${isEdit ? 'Edit Event' : 'New Event'}</h2>
      <div class="form-group">
        <label for="ev-title">Title</label>
        <input type="text" id="ev-title" placeholder="Add title" value="${escapeHtml(title)}" autocomplete="off" />
        <div class="error-msg" id="title-error"></div>
      </div>
      <div class="form-group">
        <label for="ev-start">Start</label>
        <input type="datetime-local" id="ev-start" value="${startAt}" />
        <div class="error-msg" id="start-error"></div>
      </div>
      <div class="form-group">
        <label for="ev-end">End</label>
        <input type="datetime-local" id="ev-end" value="${endAt}" />
        <div class="error-msg" id="end-error"></div>
      </div>
      <div class="error-msg" id="form-error" style="margin-top:8px;font-size:13px;"></div>
      <div class="modal-actions">
        ${isEdit ? '<button class="btn btn-danger-outline" id="btn-delete">Delete</button>' : ''}
        <button class="btn" id="btn-cancel">Cancel</button>
        <button class="btn btn-primary" id="btn-save">${isEdit ? 'Save Changes' : 'Create Event'}</button>
      </div>
    </div>
  `;

  document.body.appendChild(backdrop);

  const titleInput = backdrop.querySelector('#ev-title');
  const startInput = backdrop.querySelector('#ev-start');
  const endInput = backdrop.querySelector('#ev-end');
  const formError = backdrop.querySelector('#form-error');
  const saveBtn = backdrop.querySelector('#btn-save');

  titleInput.focus();
  if (titleInput.value) titleInput.select();

  backdrop.addEventListener('click', e => {
    if (e.target === backdrop) closeModal();
  });

  backdrop.querySelector('#btn-cancel').addEventListener('click', closeModal);

  if (isEdit) {
    backdrop.querySelector('#btn-delete').addEventListener('click', async () => {
      if (!confirm('Delete this event?')) return;
      try {
        await deleteEvent(eventId);
        closeModal();
        await loadAndRender();
        showToast('Event deleted');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  async function handleSave() {
    const titleVal = titleInput.value.trim();
    const startVal = startInput.value;
    const endVal = endInput.value;

    // Clear errors
    formError.textContent = '';
    backdrop.querySelectorAll('.error-msg').forEach(el => el.textContent = '');
    backdrop.querySelectorAll('input').forEach(el => el.classList.remove('error'));

    let valid = true;

    if (!titleVal) {
      backdrop.querySelector('#title-error').textContent = 'Title is required';
      titleInput.classList.add('error');
      titleInput.focus();
      valid = false;
    }
    if (!startVal) {
      backdrop.querySelector('#start-error').textContent = 'Start time is required';
      startInput.classList.add('error');
      if (valid) startInput.focus();
      valid = false;
    }
    if (!endVal) {
      backdrop.querySelector('#end-error').textContent = 'End time is required';
      endInput.classList.add('error');
      if (valid) endInput.focus();
      valid = false;
    }
    if (startVal && endVal && new Date(endVal) <= new Date(startVal)) {
      backdrop.querySelector('#end-error').textContent = 'End must be after start';
      endInput.classList.add('error');
      if (valid) endInput.focus();
      valid = false;
    }

    if (!valid) return;

    const payload = {
      title: titleVal,
      start_at: new Date(startVal).toISOString(),
      end_at: new Date(endVal).toISOString(),
    };

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';

    try {
      if (isEdit) {
        await updateEvent(eventId, payload);
        showToast('Event updated');
      } else {
        await createEvent(payload);
        showToast('Event created');
      }
      closeModal();
      await loadAndRender();
    } catch (err) {
      formError.textContent = err.message;
      saveBtn.disabled = false;
      saveBtn.textContent = isEdit ? 'Save Changes' : 'Create Event';
    }
  }

  saveBtn.addEventListener('click', handleSave);

  backdrop.querySelector('.modal').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSave();
    }
    if (e.key === 'Escape') closeModal();
  });
}

function closeModal() {
  const existing = document.querySelector('.modal-backdrop');
  if (existing) existing.remove();
}

// ── Data Loading ───────────────────────────────────────────────────────────
async function loadAndRender() {
  // Clean up old drag listeners before re-render
  for (const { type, fn } of activeDragListeners) {
    document.removeEventListener(type, fn);
  }
  activeDragListeners = [];

  const weekDates = getWeekDates(currentWeekStart);
  const rangeStart = new Date(weekDates[0]);
  rangeStart.setHours(0, 0, 0, 0);
  const rangeEnd = new Date(weekDates[6]);
  rangeEnd.setDate(rangeEnd.getDate() + 1);
  rangeEnd.setHours(0, 0, 0, 0); // Start of next Monday = end of Sunday

  try {
    events = await fetchEvents(rangeStart, rangeEnd);
  } catch (err) {
    showToast('Failed to load events: ' + err.message, 'error');
    events = [];
  }

  renderCalendar();
}

// ── Rendering ──────────────────────────────────────────────────────────────
function renderCalendar() {
  const app = document.getElementById('app');
  app.innerHTML = '';

  const weekDates = getWeekDates(currentWeekStart);
  const today = new Date();

  // ── Toolbar ──
  const toolbar = document.createElement('div');
  toolbar.className = 'toolbar';
  toolbar.innerHTML = `
    <h1>📅 Calendar</h1>
    <button class="btn btn-icon" id="btn-prev" title="Previous week" aria-label="Previous week">&#8249;</button>
    <span class="week-label" aria-live="polite">${formatWeekLabel(currentWeekStart)}</span>
    <button class="btn btn-icon" id="btn-next" title="Next week" aria-label="Next week">&#8250;</button>
    <button class="btn" id="btn-today">Today</button>
    <button class="btn btn-primary" id="btn-new">+ New Event</button>
  `;
  app.appendChild(toolbar);

  toolbar.querySelector('#btn-prev').addEventListener('click', () => {
    currentWeekStart = new Date(currentWeekStart);
    currentWeekStart.setDate(currentWeekStart.getDate() - 7);
    loadAndRender();
  });
  toolbar.querySelector('#btn-next').addEventListener('click', () => {
    currentWeekStart = new Date(currentWeekStart);
    currentWeekStart.setDate(currentWeekStart.getDate() + 7);
    loadAndRender();
  });
  toolbar.querySelector('#btn-today').addEventListener('click', () => {
    currentWeekStart = getWeekStart(new Date());
    loadAndRender();
  });
  toolbar.querySelector('#btn-new').addEventListener('click', () => {
    // Default to today (or Monday of current week) at current time rounded to 15min
    const now = new Date();
    const snap = snapMinutes(now.getHours() * 60 + now.getMinutes(), 15);
    const startDate = new Date(now);
    startDate.setHours(Math.floor(snap / 60), snap % 60, 0, 0);
    const endDate = new Date(startDate);
    endDate.setHours(endDate.getHours() + 1);
    openModal({
      startAt: formatDateTimeLocal(startDate),
      endAt: formatDateTimeLocal(endDate),
    });
  });

  // ── Calendar container ──
  const calContainer = document.createElement('div');
  calContainer.className = 'calendar-container';
  app.appendChild(calContainer);

  // ── Header row ──
  const calHeader = document.createElement('div');
  calHeader.className = 'calendar-header';

  const headerGutter = document.createElement('div');
  headerGutter.className = 'header-gutter';
  calHeader.appendChild(headerGutter);

  const headerDays = document.createElement('div');
  headerDays.className = 'header-days';

  weekDates.forEach((date, i) => {
    const isToday = isSameDay(date, today);
    const dayHeader = document.createElement('div');
    dayHeader.className = `day-header${isToday ? ' today' : ''}`;
    dayHeader.innerHTML = `
      <span class="day-name">${DAY_NAMES[i]}</span>
      <span class="day-number">${date.getDate()}</span>
    `;
    headerDays.appendChild(dayHeader);
  });

  calHeader.appendChild(headerDays);
  calContainer.appendChild(calHeader);

  // ── Scrollable body ──
  const calBody = document.createElement('div');
  calBody.className = 'calendar-body';
  calContainer.appendChild(calBody);

  // ── Time gutter ──
  const timeGutter = document.createElement('div');
  timeGutter.className = 'time-gutter';
  timeGutter.setAttribute('aria-hidden', 'true');

  for (let h = 1; h < 24; h++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = `${h * HOUR_HEIGHT}px`;
    label.textContent = `${String(h).padStart(2,'0')}:00`;
    timeGutter.appendChild(label);
  }

  calBody.appendChild(timeGutter);

  // ── Days grid ──
  const daysGrid = document.createElement('div');
  daysGrid.className = 'days-grid';
  calBody.appendChild(daysGrid);

  weekDates.forEach((date, dayIndex) => {
    const isToday = isSameDay(date, today);
    const dayCol = document.createElement('div');
    dayCol.className = `day-column${isToday ? ' today' : ''}`;
    dayCol.dataset.dayIndex = String(dayIndex);
    dayCol.dataset.date = formatDateLocal(date);

    // Hour lines (background grid)
    for (let h = 0; h <= 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${h * HOUR_HEIGHT}px`;
      dayCol.appendChild(line);

      if (h < 24) {
        const halfLine = document.createElement('div');
        halfLine.className = 'hour-line half';
        halfLine.style.top = `${h * HOUR_HEIGHT + HOUR_HEIGHT / 2}px`;
        dayCol.appendChild(halfLine);
      }
    }

    // Current time indicator (today only)
    if (isToday) {
      const now = new Date();
      const nowMinutes = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
      const nowPx = (nowMinutes / 60) * HOUR_HEIGHT;
      const timeLine = document.createElement('div');
      timeLine.className = 'current-time-line';
      timeLine.style.top = `${nowPx}px`;
      dayCol.appendChild(timeLine);
    }

    // Get events for this day (by local date of start_at)
    const dayEvents = events.filter(ev => isSameDay(new Date(ev.start_at), date));

    // Compute overlap layout
    const layout = computeDayLayout(dayEvents);
    renderEventBlocks(dayCol, layout, date);

    // Drag-to-create interaction
    setupDragToCreate(dayCol, date, calBody);

    daysGrid.appendChild(dayCol);
  });

  // Scroll to 7am on load
  calBody.scrollTop = 7 * HOUR_HEIGHT - 30;
}

// ── Event Block Rendering ──────────────────────────────────────────────────
function renderEventBlocks(dayCol, layout, dayDate) {
  // Day boundaries in milliseconds (local time)
  const dayStartMs = new Date(dayDate).setHours(0, 0, 0, 0);
  const dayEndMs = new Date(dayDate).setHours(24, 0, 0, 0);

  layout.forEach(({ event, colIndex, numCols }) => {
    const evStartMs = new Date(event.start_at).getTime();
    const evEndMs = new Date(event.end_at).getTime();

    // Clamp to day boundaries [00:00, 24:00)
    const clampedStartMs = Math.max(evStartMs, dayStartMs);
    const clampedEndMs = Math.min(evEndMs, dayEndMs);

    if (clampedStartMs >= clampedEndMs) return; // fully outside this day

    const startMinutes = (clampedStartMs - dayStartMs) / 60000;
    const endMinutes = (clampedEndMs - dayStartMs) / 60000;

    const top = (startMinutes / 60) * HOUR_HEIGHT;
    // Minimum height of 4px so very short events are still visible
    const height = Math.max(((endMinutes - startMinutes) / 60) * HOUR_HEIGHT, 4);

    // Horizontal layout: equal width columns with small gaps
    const GAP = 2; // px gap between adjacent columns
    const widthPct = 100 / numCols;
    const leftPct = colIndex * widthPct;
    const leftInset = colIndex === 0 ? 1 : GAP / 2;
    const rightInset = colIndex === numCols - 1 ? 1 : GAP / 2;

    const block = document.createElement('div');
    block.className = 'event-block';
    block.style.top = `${top}px`;
    block.style.height = `${height}px`;
    block.style.left = `calc(${leftPct}% + ${leftInset}px)`;
    block.style.width = `calc(${widthPct}% - ${leftInset + rightInset}px)`;
    block.style.background = EVENT_COLORS[event.id % EVENT_COLORS.length];

    const startTimeStr = formatTime(event.start_at);
    const endTimeStr = formatTime(event.end_at);

    block.innerHTML = `
      <div class="event-title">${escapeHtml(event.title)}</div>
      <div class="event-time">${startTimeStr}–${endTimeStr}</div>
    `;

    block.setAttribute('role', 'button');
    block.setAttribute('tabindex', '0');
    block.setAttribute('aria-label', `${event.title}, ${startTimeStr} to ${endTimeStr}. Click to edit.`);

    block.addEventListener('click', e => {
      e.stopPropagation();
      openModal({
        title: event.title,
        startAt: formatDateTimeLocal(new Date(event.start_at)),
        endAt: formatDateTimeLocal(new Date(event.end_at)),
        eventId: event.id,
      });
    });

    block.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        block.click();
      }
    });

    dayCol.appendChild(block);
  });
}

// ── Drag-to-Create ─────────────────────────────────────────────────────────
function setupDragToCreate(dayCol, dayDate, calBody) {
  let isDragging = false;
  let startMinutes = 0;
  let selectionEl = null;
  let hasMoved = false;

  function getMinutesFromClientY(clientY) {
    const rect = dayCol.getBoundingClientRect();
    const relY = clientY - rect.top + calBody.scrollTop;
    const rawMinutes = (relY / HOUR_HEIGHT) * 60;
    return Math.max(0, Math.min(1440, rawMinutes));
  }

  function snap(minutes) {
    return snapMinutes(minutes, 15);
  }

  function updateSelection(currentMinutes) {
    if (!selectionEl) return;
    const minStart = Math.min(startMinutes, currentMinutes);
    const minEnd = Math.max(startMinutes, currentMinutes);
    const top = (minStart / 60) * HOUR_HEIGHT;
    const height = Math.max(((minEnd - minStart) / 60) * HOUR_HEIGHT, 2);
    selectionEl.style.top = `${top}px`;
    selectionEl.style.height = `${height}px`;
  }

  dayCol.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    if (e.target.closest('.event-block')) return;

    isDragging = true;
    hasMoved = false;
    startMinutes = snap(getMinutesFromClientY(e.clientY));

    selectionEl = document.createElement('div');
    selectionEl.className = 'selection-overlay';
    selectionEl.style.left = '2px';
    selectionEl.style.right = '2px';
    updateSelection(startMinutes);
    dayCol.appendChild(selectionEl);

    e.preventDefault();
  });

  function onMouseMove(e) {
    if (!isDragging) return;
    hasMoved = true;
    const currentMinutes = snap(getMinutesFromClientY(e.clientY));
    updateSelection(currentMinutes);
  }

  function onMouseUp(e) {
    if (!isDragging) return;
    isDragging = false;

    if (selectionEl) {
      selectionEl.remove();
      selectionEl = null;
    }

    const endMinutes = snap(getMinutesFromClientY(e.clientY));
    let minStart = Math.min(startMinutes, endMinutes);
    let minEnd = Math.max(startMinutes, endMinutes);

    // Single click (no meaningful drag) → default 1-hour slot
    if (!hasMoved || minEnd - minStart < 15) {
      minEnd = minStart + 60;
    }

    // Clamp to day
    minStart = Math.max(0, Math.min(1439, minStart));
    minEnd = Math.max(minStart + 15, Math.min(1440, minEnd));

    const startDate = dateFromDayAndMinutes(dayDate, minStart);
    const endDate = dateFromDayAndMinutes(dayDate, minEnd);

    openModal({
      startAt: formatDateTimeLocal(startDate),
      endAt: formatDateTimeLocal(endDate),
    });
  }

  // Register on document (to handle mouse leaving the column during drag)
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);

  // Track for cleanup on next render
  activeDragListeners.push({ type: 'mousemove', fn: onMouseMove });
  activeDragListeners.push({ type: 'mouseup', fn: onMouseUp });
}

// ── Current Time Update ────────────────────────────────────────────────────
function updateCurrentTimeLine() {
  const line = document.querySelector('.current-time-line');
  if (!line) return;
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  const nowPx = (nowMinutes / 60) * HOUR_HEIGHT;
  line.style.top = `${nowPx}px`;
}

// ── Init ───────────────────────────────────────────────────────────────────
async function init() {
  await loadAndRender();
  setInterval(updateCurrentTimeLine, 60000);
}

init();
