import './styles.css';
import {
  startOfWeek,
  addDays,
  addWeeks,
  minutesFromMidnight,
  sameDay,
  startOfDay,
  dayName,
  formatTime,
  formatHour,
  formatRangeLabel,
} from './dates.js';
import { layoutDayEvents, DAY_MINUTES } from './layout.js';
import * as api from './api.js';
import { openEventModal } from './modal.js';

const appEl = document.getElementById('app');

const state = {
  weekStart: startOfWeek(new Date()),
  events: [], // raw events from API: {id, title, start_at, end_at}
};

/* ----------------------------- Data loading ----------------------------- */

async function loadWeek() {
  const start = state.weekStart;
  const end = addDays(start, 7);
  state.events = await api.fetchEvents(start.toISOString(), end.toISOString());
  render();
}

/* ------------------------------- Rendering ------------------------------ */

function render() {
  appEl.innerHTML = '';
  appEl.appendChild(renderToolbar());
  appEl.appendChild(renderCalendar());
}

function renderToolbar() {
  const bar = document.createElement('div');
  bar.className = 'toolbar';

  const h1 = document.createElement('h1');
  h1.textContent = 'Week Calendar';

  const prev = button('‹ Prev', () => navigate(-1));
  const today = button('Today', () => {
    state.weekStart = startOfWeek(new Date());
    loadWeek();
  });
  const next = button('Next ›', () => navigate(1));

  const label = document.createElement('span');
  label.className = 'range-label';
  label.textContent = formatRangeLabel(state.weekStart);

  const spacer = document.createElement('div');
  spacer.className = 'spacer';

  bar.append(h1, prev, today, next, label, spacer);
  return bar;
}

function button(text, onClick, className) {
  const b = document.createElement('button');
  b.textContent = text;
  if (className) b.className = className;
  b.addEventListener('click', onClick);
  return b;
}

function navigate(deltaWeeks) {
  state.weekStart = addWeeks(state.weekStart, deltaWeeks);
  loadWeek();
}

function renderCalendar() {
  const calendar = document.createElement('div');
  calendar.className = 'calendar';

  const grid = document.createElement('div');
  grid.className = 'calendar-grid';

  // Header row: corner + 7 day headers
  const corner = document.createElement('div');
  corner.className = 'corner';
  grid.appendChild(corner);

  const today = new Date();
  const days = [];
  for (let i = 0; i < 7; i++) {
    const dayDate = addDays(state.weekStart, i);
    days.push(dayDate);
    grid.appendChild(renderDayHeader(dayDate, i, sameDay(dayDate, today)));
  }

  // Body row: time gutter + 7 day columns
  grid.appendChild(renderTimeGutter());

  for (let i = 0; i < 7; i++) {
    const dayDate = days[i];
    grid.appendChild(renderDayColumn(dayDate, sameDay(dayDate, today)));
  }

  calendar.appendChild(grid);
  return calendar;
}

function renderDayHeader(dayDate, index, isToday) {
  const header = document.createElement('div');
  header.className = 'day-header' + (isToday ? ' today' : '');

  const dow = document.createElement('div');
  dow.className = 'dow';
  dow.textContent = dayName(index);

  const dom = document.createElement('div');
  dom.className = 'dom';
  dom.textContent = String(dayDate.getDate());

  header.append(dow, dom);
  return header;
}

function renderTimeGutter() {
  const gutter = document.createElement('div');
  gutter.className = 'time-gutter';
  // Labels at each hour line, 00:00 .. 24:00
  for (let h = 0; h <= 24; h++) {
    const label = document.createElement('div');
    label.className = 'hour-label';
    label.style.top = `${(h / 24) * 100}%`;
    label.textContent = h === 24 ? '24:00' : formatHour(h);
    gutter.appendChild(label);
  }
  return gutter;
}

/**
 * Compute per-day event geometry, converting each raw event to minutes
 * clamped to this day's [00:00, 24:00] window.
 */
function eventsForDay(dayDate) {
  const dayStart = startOfDay(dayDate);
  const dayEnd = addDays(dayStart, 1);
  const result = [];
  for (const ev of state.events) {
    const s = new Date(ev.start_at);
    const e = new Date(ev.end_at);
    // Does it intersect this day at all?
    if (e <= dayStart || s >= dayEnd) continue;

    // Minutes from this day's midnight, clamped to [0, 1440].
    const startMin = s <= dayStart ? 0 : minutesFromMidnight(s);
    const endMin = e >= dayEnd ? DAY_MINUTES : minutesFromMidnight(e);

    result.push({
      id: ev.id,
      title: ev.title,
      start: startMin,
      end: endMin,
      raw: ev,
    });
  }
  return result;
}

function renderDayColumn(dayDate, isToday) {
  const col = document.createElement('div');
  col.className = 'day-column' + (isToday ? ' today' : '');

  // Lay out events for this day.
  const dayEvents = eventsForDay(dayDate);
  const laid = layoutDayEvents(dayEvents);

  for (const e of laid) {
    col.appendChild(renderEventBlock(e));
  }

  // "Now" indicator on today's column.
  if (isToday) {
    const nowMin = minutesFromMidnight(new Date());
    const now = document.createElement('div');
    now.className = 'now-indicator';
    now.style.top = `${(nowMin / DAY_MINUTES) * 100}%`;
    col.appendChild(now);
  }

  attachDragToCreate(col, dayDate);
  return col;
}

function renderEventBlock(e) {
  const block = document.createElement('div');
  block.className = 'event';
  // Geometry as percentages of the column / axis so it stays exact.
  block.style.top = `${e.top * 100}%`;
  block.style.height = `${e.height * 100}%`;
  block.style.left = `calc(${e.left * 100}% + 1px)`;
  block.style.width = `calc(${e.width * 100}% - 2px)`;

  const s = new Date(e.raw.start_at);
  const en = new Date(e.raw.end_at);

  const titleEl = document.createElement('div');
  titleEl.className = 'event-title';
  titleEl.textContent = e.title;

  const timeEl = document.createElement('div');
  timeEl.className = 'event-time';
  timeEl.textContent = `${formatTime(s)}–${formatTime(en)}`;

  block.append(titleEl, timeEl);
  block.title = `${e.title}\n${formatTime(s)}–${formatTime(en)}`;

  block.addEventListener('click', (evt) => {
    evt.stopPropagation();
    openEditModal(e.raw);
  });

  return block;
}

/* --------------------------- Drag to create ----------------------------- */

function attachDragToCreate(col, dayDate) {
  let dragging = false;
  let startY = 0;
  let selectionBox = null;

  function yToMinutes(clientY) {
    const rect = col.getBoundingClientRect();
    const offset = clientY - rect.top;
    const frac = Math.max(0, Math.min(1, offset / rect.height));
    return frac * DAY_MINUTES;
  }

  // Snap minutes to 15-minute increments.
  function snap(min) {
    return Math.round(min / 15) * 15;
  }

  col.addEventListener('mousedown', (e) => {
    // Ignore clicks on existing events.
    if (e.target.closest('.event')) return;
    if (e.button !== 0) return;
    dragging = true;
    startY = e.clientY;
    selectionBox = document.createElement('div');
    selectionBox.className = 'selection-box';
    col.appendChild(selectionBox);
    updateSelection(e.clientY);
    e.preventDefault();
  });

  function updateSelection(clientY) {
    const a = snap(yToMinutes(startY));
    const b = snap(yToMinutes(clientY));
    const top = Math.min(a, b);
    const bottom = Math.max(a, b);
    selectionBox.style.top = `${(top / DAY_MINUTES) * 100}%`;
    selectionBox.style.height = `${((bottom - top) / DAY_MINUTES) * 100}%`;
  }

  function onMove(e) {
    if (!dragging) return;
    updateSelection(e.clientY);
  }

  function onUp(e) {
    if (!dragging) return;
    dragging = false;
    const a = snap(yToMinutes(startY));
    const b = snap(yToMinutes(e.clientY));
    let top = Math.min(a, b);
    let bottom = Math.max(a, b);
    if (selectionBox) {
      selectionBox.remove();
      selectionBox = null;
    }
    // A plain click (no drag) defaults to a 1-hour event.
    if (bottom - top < 15) {
      bottom = Math.min(DAY_MINUTES, top + 60);
      if (bottom === DAY_MINUTES) top = Math.max(0, DAY_MINUTES - 60);
    }
    openCreateModal(dayDate, top, bottom);
  }

  col.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

function minutesToDate(dayDate, minutes) {
  const d = startOfDay(dayDate);
  d.setMinutes(Math.round(minutes));
  return d;
}

/* ------------------------------ Modals ---------------------------------- */

function openCreateModal(dayDate, startMin, endMin) {
  const start = minutesToDate(dayDate, startMin);
  const end =
    endMin >= DAY_MINUTES
      ? new Date(startOfDay(addDays(dayDate, 1)).getTime())
      : minutesToDate(dayDate, endMin);

  openEventModal(
    'create',
    { title: '', start, end },
    {
      onSave: async ({ title, start, end }) => {
        await api.createEvent({
          title,
          start_at: start.toISOString(),
          end_at: end.toISOString(),
        });
        await loadWeek();
      },
    }
  );
}

function openEditModal(raw) {
  openEventModal(
    'edit',
    {
      id: raw.id,
      title: raw.title,
      start: new Date(raw.start_at),
      end: new Date(raw.end_at),
    },
    {
      onSave: async ({ id, title, start, end }) => {
        await api.updateEvent(id, {
          title,
          start_at: start.toISOString(),
          end_at: end.toISOString(),
        });
        await loadWeek();
      },
      onDelete: async (id) => {
        await api.deleteEvent(id);
        await loadWeek();
      },
    }
  );
}

/* ------------------------------- Boot ----------------------------------- */

loadWeek().catch((err) => {
  console.error(err);
  appEl.innerHTML = `<div style="padding:24px;color:#dc2626">Failed to load: ${err.message}. Is the API server running on port 3001?</div>`;
});
