import {
  getWeekStart, getWeekEnd, getWeekDays,
  formatDayHeader, formatWeekRange, formatTime,
  isSameDay, isToday, toDatetimeLocal, fromDatetimeLocal,
} from './dates.js';
import { computeLayout, timeToPixels, pixelsToTime } from './layout.js';
import { fetchEvents } from './api.js';
import { openCreateModal, openEditModal } from './modal.js';
import { showToast } from './toast.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const HOUR_HEIGHT = 60; // px per hour — must match CSS --hour-height
const TOTAL_HEIGHT = HOUR_HEIGHT * 24;
const HOURS = Array.from({ length: 25 }, (_, i) => i); // 0..24

// Palette for events (cycles by event id)
const COLORS = [
  '#4f46e5', // indigo
  '#0891b2', // cyan
  '#059669', // emerald
  '#d97706', // amber
  '#dc2626', // red
  '#7c3aed', // violet
  '#db2777', // pink
  '#0284c7', // sky
];

function eventColor(id) {
  return COLORS[id % COLORS.length];
}

// ── State ─────────────────────────────────────────────────────────────────────
let weekStart = getWeekStart(new Date());
let events    = []; // all events for the current week

// ── DOM references ────────────────────────────────────────────────────────────
let weekLabelEl, daysGridEl, calendarHeaderEl, calendarBodyEl;

// ── Initialization ────────────────────────────────────────────────────────────

export function initCalendar(appEl) {
  appEl.innerHTML = '';

  // Toolbar
  const toolbar = document.createElement('div');
  toolbar.id = 'toolbar';
  toolbar.innerHTML = `
    <h1>📅 Week Calendar</h1>
    <button class="btn" id="btn-prev">‹ Prev</button>
    <span class="week-label" id="week-label"></span>
    <button class="btn" id="btn-today">Today</button>
    <button class="btn" id="btn-next">Next ›</button>
  `;
  appEl.appendChild(toolbar);

  weekLabelEl = toolbar.querySelector('#week-label');
  toolbar.querySelector('#btn-prev').addEventListener('click', () => navigateWeek(-1));
  toolbar.querySelector('#btn-today').addEventListener('click', () => navigateToday());
  toolbar.querySelector('#btn-next').addEventListener('click', () => navigateWeek(1));

  // Calendar wrapper
  const wrapper = document.createElement('div');
  wrapper.id = 'calendar-wrapper';
  appEl.appendChild(wrapper);

  // Header (sticky day names)
  calendarHeaderEl = document.createElement('div');
  calendarHeaderEl.id = 'calendar-header';
  wrapper.appendChild(calendarHeaderEl);

  // Scrollable body
  calendarBodyEl = document.createElement('div');
  calendarBodyEl.id = 'calendar-body';
  wrapper.appendChild(calendarBodyEl);

  // Time gutter
  const timeGutter = document.createElement('div');
  timeGutter.id = 'time-gutter';
  calendarBodyEl.appendChild(timeGutter);

  // Render hour labels in gutter
  for (const h of HOURS) {
    if (h === 0) continue; // skip midnight label at top
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = `${h * HOUR_HEIGHT}px`;
    label.textContent = `${String(h).padStart(2, '0')}:00`;
    timeGutter.appendChild(label);
  }

  // Days grid
  daysGridEl = document.createElement('div');
  daysGridEl.id = 'days-grid';
  calendarBodyEl.appendChild(daysGridEl);

  // Initialize global drag handlers (once)
  initDragHandlers();

  // Load initial week
  loadWeek();

  // Update current time indicator every minute
  updateCurrentTimeLine();
  setInterval(updateCurrentTimeLine, 60_000);

  // Scroll to 7am on load
  setTimeout(() => {
    calendarBodyEl.scrollTop = 7 * HOUR_HEIGHT - 20;
  }, 100);
}

// ── Navigation ────────────────────────────────────────────────────────────────

function navigateWeek(delta) {
  const d = new Date(weekStart);
  d.setDate(d.getDate() + delta * 7);
  weekStart = d;
  loadWeek();
}

function navigateToday() {
  weekStart = getWeekStart(new Date());
  loadWeek();
  setTimeout(() => {
    calendarBodyEl.scrollTop = 7 * HOUR_HEIGHT - 20;
  }, 100);
}

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadWeek() {
  const weekEnd = getWeekEnd(weekStart);
  weekLabelEl.textContent = formatWeekRange(weekStart);
  renderGrid(); // render structure immediately

  try {
    events = await fetchEvents(weekStart, weekEnd);
    renderEvents();
  } catch (err) {
    showToast('Failed to load events: ' + err.message, 'error');
  }
}

// ── Grid rendering ────────────────────────────────────────────────────────────

function renderGrid() {
  const days = getWeekDays(weekStart);
  const today = new Date();

  // ── Header ──
  calendarHeaderEl.innerHTML = '';

  const gutterSpacer = document.createElement('div');
  gutterSpacer.className = 'header-time-gutter';
  calendarHeaderEl.appendChild(gutterSpacer);

  const headerDays = document.createElement('div');
  headerDays.className = 'header-days';
  calendarHeaderEl.appendChild(headerDays);

  for (const day of days) {
    const { name, date } = formatDayHeader(day);
    const col = document.createElement('div');
    col.className = 'day-header' + (isToday(day) ? ' today' : '');

    const nameEl = document.createElement('div');
    nameEl.className = 'day-name';
    nameEl.textContent = name;

    const dateEl = document.createElement('div');
    dateEl.className = 'day-date';
    dateEl.textContent = date;

    col.append(nameEl, dateEl);
    headerDays.appendChild(col);
  }

  // ── Days grid ──
  daysGridEl.innerHTML = '';

  for (let i = 0; i < 7; i++) {
    const day = days[i];
    const col = document.createElement('div');
    col.className = 'day-column' + (isToday(day) ? ' today' : '');
    col.dataset.dayIndex = i;
    col.dataset.date = day.toISOString();

    // Hour lines
    for (const h of HOURS) {
      if (h === 24) continue;
      const line = document.createElement('div');
      line.className = 'hour-line' + (h % 1 === 0 ? ' major' : '');
      line.style.top = `${h * HOUR_HEIGHT}px`;
      col.appendChild(line);

      // Half-hour line
      const half = document.createElement('div');
      half.className = 'half-line';
      half.style.top = `${h * HOUR_HEIGHT + HOUR_HEIGHT / 2}px`;
      col.appendChild(half);
    }

    // Drag-to-create interaction
    attachDragToCreate(col, day);

    daysGridEl.appendChild(col);
  }
}

// ── Event rendering ───────────────────────────────────────────────────────────

function renderEvents() {
  // Clear existing event blocks from all columns
  daysGridEl.querySelectorAll('.event-block').forEach(el => el.remove());
  daysGridEl.querySelectorAll('.drag-ghost').forEach(el => el.remove());

  const days = getWeekDays(weekStart);

  for (let i = 0; i < 7; i++) {
    const day = days[i];
    const col = daysGridEl.querySelector(`[data-day-index="${i}"]`);
    if (!col) continue;

    // Filter events for this day
    const dayEvents = events.filter(ev => {
      const evStart = new Date(ev.start_at);
      const evEnd   = new Date(ev.end_at);
      // Event overlaps this day if it starts before end-of-day and ends after start-of-day
      const dayStart = new Date(day); dayStart.setHours(0, 0, 0, 0);
      const dayEnd   = new Date(day); dayEnd.setHours(24, 0, 0, 0);
      return evStart < dayEnd && evEnd > dayStart;
    });

    if (dayEvents.length === 0) continue;

    // Clamp events to this day's boundaries for layout purposes
    const clampedEvents = dayEvents.map(ev => {
      const dayStart = new Date(day); dayStart.setHours(0, 0, 0, 0);
      const dayEnd   = new Date(day); dayEnd.setHours(24, 0, 0, 0);
      return {
        ...ev,
        _clampedStart: new Date(Math.max(new Date(ev.start_at).getTime(), dayStart.getTime())),
        _clampedEnd:   new Date(Math.min(new Date(ev.end_at).getTime(),   dayEnd.getTime())),
      };
    });

    // Compute layout using clamped times for overlap detection
    const layoutEvents = clampedEvents.map(ev => ({
      ...ev,
      start_at: ev._clampedStart.toISOString(),
      end_at:   ev._clampedEnd.toISOString(),
    }));

    const laid = computeLayout(layoutEvents);

    const colWidth = col.clientWidth || col.getBoundingClientRect().width;

    for (const lev of laid) {
      const originalEvent = events.find(e => e.id === lev.id);
      if (!originalEvent) continue;

      const clampedStart = new Date(lev.start_at);
      const clampedEnd   = new Date(lev.end_at);

      const top    = timeToPixels(clampedStart, HOUR_HEIGHT, day);
      const bottom = timeToPixels(clampedEnd,   HOUR_HEIGHT, day);
      const height = Math.max(bottom - top, 18); // minimum 18px so it's clickable

      // Horizontal layout
      const widthPct  = 100 / lev.totalCols;
      const leftPct   = (lev.col / lev.totalCols) * 100;

      const block = document.createElement('div');
      block.className = 'event-block';
      block.dataset.eventId = lev.id;
      block.style.top    = `${top}px`;
      block.style.height = `${height}px`;
      block.style.left   = `calc(${leftPct}% + 1px)`;
      block.style.width  = `calc(${widthPct}% - 2px)`;
      block.style.background = eventColor(lev.id);

      const titleEl = document.createElement('div');
      titleEl.className = 'event-title';
      titleEl.textContent = originalEvent.title;

      const timeEl = document.createElement('div');
      timeEl.className = 'event-time';
      timeEl.textContent = `${formatTime(new Date(originalEvent.start_at))} – ${formatTime(new Date(originalEvent.end_at))}`;

      block.append(titleEl, timeEl);

      block.addEventListener('click', e => {
        e.stopPropagation();
        openEditModal(
          originalEvent,
          (updated) => {
            // Replace in events array
            const idx = events.findIndex(ev => ev.id === updated.id);
            if (idx !== -1) events[idx] = updated;
            renderEvents();
          },
          (deletedId) => {
            events = events.filter(ev => ev.id !== deletedId);
            renderEvents();
          }
        );
      });

      col.appendChild(block);
    }
  }
}

// ── Drag-to-create ────────────────────────────────────────────────────────────
// Single global drag state — only one drag can be active at a time.
let _drag = null;

function initDragHandlers() {
  document.addEventListener('mousemove', e => {
    if (!_drag) return;
    const { col, ghost, snapToMinutes, getY } = _drag;

    const y = getY(e);
    const snappedY = snapToMinutes(y);
    const diff = Math.abs(snappedY - _drag.startPx);

    if (diff >= 4) _drag.isDragging = true;

    if (_drag.isDragging) {
      const top    = Math.min(_drag.startPx, snappedY);
      const bottom = Math.max(_drag.startPx, snappedY);
      ghost.style.top    = `${top}px`;
      ghost.style.height = `${Math.max(bottom - top, 1)}px`;
    }
  });

  document.addEventListener('mouseup', e => {
    if (!_drag) return;

    const { col, ghost, snapToMinutes, getY, day, isDragging, startPx } = _drag;
    _drag = null;

    const y = getY(e);
    const snappedY = snapToMinutes(y);

    ghost.remove();

    const dragEndPx = snappedY;
    const lo = Math.min(startPx, dragEndPx);
    const hi = Math.max(startPx, dragEndPx);

    let startTime, endTime;
    if (!isDragging || hi - lo < HOUR_HEIGHT / 4) {
      // Treat as click: create 1-hour event at clicked position
      const clickPx = snapToMinutes(getY(e));
      startTime = pixelsToTime(Math.max(0, Math.min(clickPx, TOTAL_HEIGHT)), HOUR_HEIGHT, day);
      endTime   = new Date(startTime.getTime() + 60 * 60 * 1000);
      // Clamp end to midnight
      const midnight = new Date(day);
      midnight.setHours(24, 0, 0, 0);
      if (endTime > midnight) {
        endTime = midnight;
        if (endTime <= startTime) {
          startTime = new Date(midnight.getTime() - 60 * 60 * 1000);
        }
      }
    } else {
      startTime = pixelsToTime(Math.max(0, lo), HOUR_HEIGHT, day);
      endTime   = pixelsToTime(Math.min(hi, TOTAL_HEIGHT), HOUR_HEIGHT, day);
    }

    openCreateModal(
      { start: startTime, end: endTime },
      (newEvent) => {
        events.push(newEvent);
        renderEvents();
      }
    );
  });
}

function attachDragToCreate(col, day) {
  function getY(e) {
    const rect = col.getBoundingClientRect();
    return e.clientY - rect.top + calendarBodyEl.scrollTop;
  }

  function snapToMinutes(px, snap = 15) {
    const totalMinutes = (px / HOUR_HEIGHT) * 60;
    const snapped = Math.round(totalMinutes / snap) * snap;
    return Math.max(0, Math.min((snapped / 60) * HOUR_HEIGHT, TOTAL_HEIGHT));
  }

  col.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    if (e.target.closest('.event-block')) return;

    e.preventDefault();
    const y = getY(e);
    const startPx = snapToMinutes(y);

    const ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    ghost.style.left   = '2px';
    ghost.style.right  = '2px';
    ghost.style.top    = `${startPx}px`;
    ghost.style.height = '0px';
    col.appendChild(ghost);

    _drag = { col, ghost, snapToMinutes, getY, day, startPx, isDragging: false };
  });
}

// ── Current time indicator ────────────────────────────────────────────────────

function updateCurrentTimeLine() {
  // Remove existing lines
  daysGridEl.querySelectorAll('.current-time-line').forEach(el => el.remove());

  const now = new Date();
  const days = getWeekDays(weekStart);

  for (let i = 0; i < 7; i++) {
    if (isToday(days[i])) {
      const col = daysGridEl.querySelector(`[data-day-index="${i}"]`);
      if (!col) continue;

      const top = timeToPixels(now, HOUR_HEIGHT);
      const line = document.createElement('div');
      line.className = 'current-time-line';
      line.style.top = `${top}px`;
      col.appendChild(line);
      break;
    }
  }
}
