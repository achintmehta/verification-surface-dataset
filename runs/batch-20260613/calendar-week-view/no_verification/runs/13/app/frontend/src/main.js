import './style.css';
import {
  startOfWeek,
  weekDays,
  addWeeks,
  isSameDay,
  endOfDay,
  weekdayName,
  formatTime,
  formatHourLabel,
  weekRangeLabel,
  dateFromDayAndMinutes,
} from './dates.js';
import {
  minutesFromMidnight,
  layoutDayEvents,
} from './layout.js';
import {
  fetchEvents,
  createEvent,
  updateEvent,
  deleteEvent,
} from './api.js';
import { openModal } from './modal.js';

const MINUTES_PER_DAY = 24 * 60;
// Snap drag selections to 15-minute increments.
const SNAP_MINUTES = 15;

const state = {
  weekStart: startOfWeek(new Date()),
  events: [],
};

const root = document.getElementById('app');

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function loadWeek() {
  const days = weekDays(state.weekStart);
  const rangeStart = days[0]; // Monday 00:00 local
  const rangeEnd = endOfDay(days[6]); // next Monday 00:00 local
  try {
    const events = await fetchEvents(
      rangeStart.toISOString(),
      rangeEnd.toISOString()
    );
    state.events = events;
  } catch (err) {
    console.error('Failed to load events:', err);
    state.events = [];
  }
  render();
}

// Split the week's events into per-day buckets with clamped minute ranges.
// An event may span multiple days; each day gets the clamped portion that
// falls within it, so rendering stays within the day column.
function buildDayBuckets(days) {
  const buckets = days.map(() => []);
  for (const ev of state.events) {
    const start = new Date(ev.start_at);
    const end = new Date(ev.end_at);
    days.forEach((dayStart, i) => {
      const dayEnd = endOfDay(dayStart);
      // Does this event intersect this day at all?
      if (end.getTime() <= dayStart.getTime()) return;
      if (start.getTime() >= dayEnd.getTime()) return;
      const startMin = minutesFromMidnight(start, dayStart);
      const endMin = minutesFromMidnight(end, dayStart);
      // Guard against zero-height clamped slivers.
      if (endMin <= startMin) return;
      buckets[i].push({
        id: ev.id,
        title: ev.title,
        start_at: ev.start_at,
        end_at: ev.end_at,
        startMin,
        endMin,
      });
    });
  }
  return buckets;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  root.innerHTML = '';
  root.appendChild(renderToolbar());

  const days = weekDays(state.weekStart);
  const buckets = buildDayBuckets(days);

  const calendar = document.createElement('div');
  calendar.className = 'calendar';

  const grid = document.createElement('div');
  grid.className = 'calendar-grid';

  // Corner cell.
  const corner = document.createElement('div');
  corner.className = 'corner';
  grid.appendChild(corner);

  // Day headers.
  const today = new Date();
  days.forEach((dayStart) => {
    const header = document.createElement('div');
    header.className = 'day-header';
    if (isSameDay(dayStart, today)) header.classList.add('today');
    header.innerHTML = `
      <span class="dow">${weekdayName(dayStart)}</span>
      <span class="dom">${dayStart.getDate()}</span>
    `;
    grid.appendChild(header);
  });

  // Time gutter.
  const gutter = document.createElement('div');
  gutter.className = 'time-gutter';
  for (let h = 0; h <= 24; h++) {
    const label = document.createElement('div');
    label.className = 'hour-label';
    label.style.top = `${(h / 24) * 100}%`;
    label.textContent = h === 24 ? '24:00' : formatHourLabel(h);
    gutter.appendChild(label);
  }
  grid.appendChild(gutter);

  // Day columns.
  days.forEach((dayStart, i) => {
    const col = document.createElement('div');
    col.className = 'day-col';
    if (isSameDay(dayStart, today)) col.classList.add('today');
    col.dataset.dayIndex = String(i);

    // Hour lines.
    for (let h = 1; h < 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${(h / 24) * 100}%`;
      col.appendChild(line);
    }

    // Events laid out with the cluster algorithm.
    const laid = layoutDayEvents(buckets[i]);
    for (const ev of laid) {
      col.appendChild(renderEventBlock(ev));
    }

    // Drag-to-create interaction.
    attachDragCreate(col, dayStart);

    grid.appendChild(col);
  });

  calendar.appendChild(grid);
  root.appendChild(calendar);

  // Scroll so morning hours are visible on first paint.
  requestAnimationFrame(() => {
    const hourHeightPx = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--hour-height')
    );
    calendar.scrollTop = hourHeightPx * 7; // ~07:00
  });
}

function renderEventBlock(ev) {
  const block = document.createElement('div');
  block.className = 'event';
  block.style.top = `${ev.top * 100}%`;
  block.style.height = `${ev.height * 100}%`;
  // Small inner gap between side-by-side columns; keep within the column.
  const gapPct = 1; // percent
  block.style.left = `calc(${ev.left * 100}% + 1px)`;
  block.style.width = `calc(${ev.width * 100}% - ${gapPct + 1}px)`;

  const start = new Date(ev.start_at);
  const end = new Date(ev.end_at);

  block.innerHTML = `
    <div class="ev-title"></div>
    <div class="ev-time"></div>
  `;
  block.querySelector('.ev-title').textContent = ev.title;
  block.querySelector('.ev-time').textContent =
    `${formatTime(start)}–${formatTime(end)}`;

  block.addEventListener('click', (e) => {
    e.stopPropagation();
    openEditModal(ev);
  });

  return block;
}

function renderToolbar() {
  const bar = document.createElement('div');
  bar.className = 'toolbar';
  bar.innerHTML = `
    <h1>Week Calendar</h1>
    <button id="nav-prev" title="Previous week">‹</button>
    <button id="nav-today">Today</button>
    <button id="nav-next" title="Next week">›</button>
    <span class="week-label">${weekRangeLabel(state.weekStart)}</span>
    <span class="spacer"></span>
    <button id="new-event" class="primary">+ New event</button>
  `;
  bar.querySelector('#nav-prev').addEventListener('click', () => {
    state.weekStart = addWeeks(state.weekStart, -1);
    loadWeek();
  });
  bar.querySelector('#nav-next').addEventListener('click', () => {
    state.weekStart = addWeeks(state.weekStart, 1);
    loadWeek();
  });
  bar.querySelector('#nav-today').addEventListener('click', () => {
    state.weekStart = startOfWeek(new Date());
    loadWeek();
  });
  bar.querySelector('#new-event').addEventListener('click', () => {
    // Default to a 1-hour slot at 09:00 on the first day of the week.
    const day = weekDays(state.weekStart)[0];
    const start = dateFromDayAndMinutes(day, 9 * 60);
    const end = dateFromDayAndMinutes(day, 10 * 60);
    openCreateModal(start, end);
  });
  return bar;
}

// ---------------------------------------------------------------------------
// Drag-to-create
// ---------------------------------------------------------------------------

// Module-level drag state, so we attach exactly one set of window listeners
// (not one per render).
const drag = {
  active: false,
  col: null,
  dayStart: null,
  startMin: 0,
  preview: null,
};

function colMinutesFromEvent(col, e) {
  const rect = col.getBoundingClientRect();
  const y = e.clientY - rect.top;
  const frac = Math.min(Math.max(y / rect.height, 0), 1);
  let minutes = frac * MINUTES_PER_DAY;
  minutes = Math.round(minutes / SNAP_MINUTES) * SNAP_MINUTES;
  return Math.min(Math.max(minutes, 0), MINUTES_PER_DAY);
}

function updateDragPreview(a, b) {
  if (!drag.preview) return;
  const top = Math.min(a, b);
  const bottom = Math.max(a, b);
  drag.preview.style.top = `${(top / MINUTES_PER_DAY) * 100}%`;
  drag.preview.style.height = `${((bottom - top) / MINUTES_PER_DAY) * 100}%`;
}

function attachDragCreate(col, dayStart) {
  col.addEventListener('mousedown', (e) => {
    // Only react to clicks on empty space (not on an event block).
    if (e.target.closest('.event')) return;
    if (e.button !== 0) return;
    drag.active = true;
    drag.col = col;
    drag.dayStart = dayStart;
    drag.startMin = colMinutesFromEvent(col, e);
    drag.preview = document.createElement('div');
    drag.preview.className = 'drag-preview';
    col.appendChild(drag.preview);
    updateDragPreview(drag.startMin, drag.startMin);
    e.preventDefault();
  });
}

// Single global move/up handlers shared by every column.
window.addEventListener('mousemove', (e) => {
  if (!drag.active) return;
  const cur = colMinutesFromEvent(drag.col, e);
  updateDragPreview(drag.startMin, cur);
});

window.addEventListener('mouseup', (e) => {
  if (!drag.active) return;
  drag.active = false;
  const endMin = colMinutesFromEvent(drag.col, e);
  let a = Math.min(drag.startMin, endMin);
  let b = Math.max(drag.startMin, endMin);
  const dayStart = drag.dayStart;
  if (drag.preview) {
    drag.preview.remove();
    drag.preview = null;
  }
  drag.col = null;
  drag.dayStart = null;
  // A plain click (no real drag) defaults to a 1-hour slot.
  if (b - a < SNAP_MINUTES) {
    b = Math.min(a + 60, MINUTES_PER_DAY);
    if (b === a) {
      a = Math.max(0, b - 60);
    }
  }
  const start = dateFromDayAndMinutes(dayStart, a);
  const end = dateFromDayAndMinutes(dayStart, b);
  openCreateModal(start, end);
});

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------

function openCreateModal(start, end) {
  openModal({
    mode: 'create',
    start,
    end,
    onSave: async (data) => {
      await createEvent(data);
      await loadWeek();
    },
  });
}

function openEditModal(ev) {
  openModal({
    mode: 'edit',
    event: ev,
    onSave: async (data) => {
      await updateEvent(ev.id, data);
      await loadWeek();
    },
    onDelete: async (id) => {
      await deleteEvent(id);
      await loadWeek();
    },
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

loadWeek();
