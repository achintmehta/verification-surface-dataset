/**
 * Calendar week-view renderer.
 *
 * Responsibilities:
 *   - Render the 7-column week grid with a shared time axis.
 *   - Place event blocks with pixel-perfect vertical geometry.
 *   - Apply the cluster overlap layout (via layout.js).
 *   - Handle drag-to-create on empty space.
 *   - Emit callbacks for event click (edit) and new-event creation.
 */

import { computeDayLayout, groupByDay, localDateKey } from './layout.js';
import { getWeekDays, dayName, formatTime } from './week.js';

// ── Constants ─────────────────────────────────────────────────────────────────
// These must match the CSS custom properties in style.css.
const HOUR_HEIGHT  = 64;   // px per hour  (--hour-height)
const TOTAL_HEIGHT = HOUR_HEIGHT * 24; // 1536 px
const MINUTES_PER_DAY = 24 * 60;

// Minimum event block height in pixels (so tiny events are still clickable)
const MIN_EVENT_HEIGHT = 18;

// ── Colour palette for events (cycles by event id) ───────────────────────────
const EVENT_COLORS = [
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
  const n = typeof id === 'number' ? id : parseInt(id, 10) || 0;
  return EVENT_COLORS[Math.abs(n) % EVENT_COLORS.length];
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Render the full week view into `container`.
 *
 * @param {HTMLElement} container
 * @param {Object} opts
 * @param {Date}   opts.weekStart       Monday of the week to render
 * @param {Array}  opts.events          flat list of event objects from the API
 * @param {Function} opts.onEventClick  (event) => void
 * @param {Function} opts.onNewEvent    ({ start_at, end_at }) => void
 */
export function renderCalendar(container, { weekStart, events, onEventClick, onNewEvent }) {
  container.innerHTML = '';

  const days = getWeekDays(weekStart);
  const today = localDateKey(new Date());

  // Group events by day
  const byDay = groupByDay(events);

  // ── Header ──────────────────────────────────────────────────────────────────
  const header = document.createElement('div');
  header.className = 'calendar-header';

  // Corner cell (above time axis)
  const corner = document.createElement('div');
  corner.className = 'axis-corner';
  header.appendChild(corner);

  days.forEach((day) => {
    const isToday = localDateKey(day) === today;
    const cell = document.createElement('div');
    cell.className = 'day-header' + (isToday ? ' today' : '');
    cell.innerHTML = `
      <div class="day-name">${dayName(day)}</div>
      <div class="day-number">${day.getDate()}</div>
    `;
    header.appendChild(cell);
  });

  container.appendChild(header);

  // ── Scrollable body ──────────────────────────────────────────────────────────
  const body = document.createElement('div');
  body.className = 'calendar-body';

  const grid = document.createElement('div');
  grid.className = 'calendar-grid';

  // ── Time axis ────────────────────────────────────────────────────────────────
  const axis = document.createElement('div');
  axis.className = 'time-axis';

  for (let h = 0; h <= 24; h++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = `${h * HOUR_HEIGHT}px`;
    label.textContent = h === 24 ? '' : `${String(h).padStart(2, '0')}:00`;
    axis.appendChild(label);
  }

  grid.appendChild(axis);

  // ── Day columns ──────────────────────────────────────────────────────────────
  days.forEach((day) => {
    const dayKey  = localDateKey(day);
    const isToday = dayKey === today;
    const col     = document.createElement('div');
    col.className = 'day-column' + (isToday ? ' today' : '');
    col.dataset.date = dayKey;

    // Hour lines (full and half)
    for (let h = 0; h < 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${h * HOUR_HEIGHT}px`;
      col.appendChild(line);

      const half = document.createElement('div');
      half.className = 'hour-line half';
      half.style.top = `${h * HOUR_HEIGHT + HOUR_HEIGHT / 2}px`;
      col.appendChild(half);
    }
    // Bottom border line
    const bottomLine = document.createElement('div');
    bottomLine.className = 'hour-line';
    bottomLine.style.top = `${24 * HOUR_HEIGHT}px`;
    col.appendChild(bottomLine);

    // Render events for this day
    const dayEvents = byDay.get(dayKey) ?? [];
    const layouts   = computeDayLayout(dayEvents);

    layouts.forEach((item) => {
      const block = buildEventBlock(item, col);
      col.appendChild(block);
      block.addEventListener('click', (e) => {
        e.stopPropagation();
        onEventClick(item.event);
      });
    });

    // Drag-to-create interaction
    attachDragCreate(col, day, onNewEvent);

    grid.appendChild(col);
  });

  body.appendChild(grid);
  container.appendChild(body);

  // Scroll to 07:00 on initial render
  body.scrollTop = 7 * HOUR_HEIGHT - 32;
}

// ── Event block builder ───────────────────────────────────────────────────────

function buildEventBlock(item, col) {
  const { event, top, height, left, width } = item;

  const topPx    = top    * TOTAL_HEIGHT;
  const heightPx = Math.max(height * TOTAL_HEIGHT, MIN_EVENT_HEIGHT);

  // Clamp to column bounds
  const clampedTop    = Math.max(0, Math.min(topPx, TOTAL_HEIGHT - 1));
  const clampedHeight = Math.min(heightPx, TOTAL_HEIGHT - clampedTop);

  const block = document.createElement('div');
  block.className = 'event-block';
  block.dataset.eventId = event.id;

  block.style.top    = `${clampedTop}px`;
  block.style.height = `${clampedHeight}px`;
  block.style.left   = `calc(${left * 100}% + 1px)`;
  block.style.width  = `calc(${width * 100}% - 2px)`;
  block.style.backgroundColor = eventColor(event.id);

  const startTime = formatTime(new Date(event.start_at));
  const endTime   = formatTime(new Date(event.end_at));

  block.innerHTML = `
    <div class="event-title">${escHtml(event.title)}</div>
    <div class="event-time">${startTime}–${endTime}</div>
  `;

  return block;
}

// ── Drag-to-create ────────────────────────────────────────────────────────────

function attachDragCreate(col, day, onNewEvent) {
  let dragState = null;
  let ghost     = null;

  col.addEventListener('mousedown', (e) => {
    // Only respond to left-button clicks on the column background
    if (e.button !== 0) return;
    if (e.target.closest('.event-block')) return;

    e.preventDefault();

    const startMin = pixelToMinutes(e, col);

    dragState = {
      startMin,
      currentMin: startMin,
    };

    ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    updateGhost(ghost, dragState.startMin, dragState.startMin);
    col.appendChild(ghost);
  });

  const onMouseMove = (e) => {
    if (!dragState) return;
    dragState.currentMin = pixelToMinutes(e, col);
    updateGhost(ghost, dragState.startMin, dragState.currentMin);
  };

  const onMouseUp = (e) => {
    if (!dragState) return;

    const endMin = pixelToMinutes(e, col);
    let startMin = dragState.startMin;
    let finalEnd = endMin;

    // Ensure start < end; if same point, create a 30-min event
    if (finalEnd <= startMin) {
      if (finalEnd === startMin) {
        finalEnd = startMin + 30;
      } else {
        [startMin, finalEnd] = [finalEnd, startMin];
      }
    }

    // Clamp to day bounds
    startMin = Math.max(0, Math.min(startMin, MINUTES_PER_DAY - 1));
    finalEnd = Math.max(startMin + 1, Math.min(finalEnd, MINUTES_PER_DAY));

    // Build ISO strings for the selected day
    const start_at = minutesToIso(day, startMin);
    const end_at   = minutesToIso(day, finalEnd);

    if (ghost) { ghost.remove(); ghost = null; }
    dragState = null;

    onNewEvent({ start_at, end_at });
  };

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);

  // Clean up global listeners when the column is removed from DOM
  // (happens on re-render)
  const observer = new MutationObserver(() => {
    if (!document.body.contains(col)) {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function pixelToMinutes(mouseEvent, col) {
  const body = col.closest('.calendar-body');
  const bodyRect = body.getBoundingClientRect();
  // y = distance from the top of the full (scrollable) grid
  const y = mouseEvent.clientY - bodyRect.top + body.scrollTop;
  // Snap to nearest 15 minutes
  const rawMin = (y / TOTAL_HEIGHT) * MINUTES_PER_DAY;
  return Math.max(0, Math.min(Math.round(rawMin / 15) * 15, MINUTES_PER_DAY));
}

function updateGhost(ghost, startMin, currentMin) {
  const lo = Math.min(startMin, currentMin);
  const hi = Math.max(startMin, currentMin);
  const topPx    = (lo / MINUTES_PER_DAY) * TOTAL_HEIGHT;
  const heightPx = Math.max(((hi - lo) / MINUTES_PER_DAY) * TOTAL_HEIGHT, 4);
  ghost.style.top    = `${topPx}px`;
  ghost.style.height = `${heightPx}px`;
  ghost.style.left   = '2px';
  ghost.style.right  = '2px';
}

function minutesToIso(day, minutes) {
  const d = new Date(day);
  d.setHours(0, 0, 0, 0);
  d.setMinutes(minutes);
  return d.toISOString();
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
