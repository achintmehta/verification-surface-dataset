import './style.css';
import { layoutDay } from './layout.js';
import * as api from './api.js';
import {
  startOfWeek,
  weekDays,
  addWeeks,
  isSameDay,
  minutesIntoDay,
  dayName,
  formatTime,
  toLocalInputValue,
  fromLocalInputValue,
  dateFromDayMinutes,
  pad2,
} from './dates.js';

const HOUR_HEIGHT = 48; // must match --hour-height in style.css
const DAY_HEIGHT = HOUR_HEIGHT * 24;
const MINUTES_PER_DAY = 1440;
const PX_PER_MIN = DAY_HEIGHT / MINUTES_PER_DAY;
const SNAP_MIN = 15; // snap drag selection to 15-minute increments

const state = {
  weekStart: startOfWeek(new Date()),
  events: [],
  loading: false,
};

const root = document.getElementById('app');

// -------------------------------------------------------------------------
// Data loading
// -------------------------------------------------------------------------
function weekRange() {
  const start = state.weekStart;
  const end = new Date(start.getTime());
  end.setDate(end.getDate() + 7);
  return { start, end };
}

async function loadEvents() {
  const { start, end } = weekRange();
  state.loading = true;
  try {
    const rows = await api.fetchEvents(start.toISOString(), end.toISOString());
    state.events = rows.map((e) => ({
      id: e.id,
      title: e.title,
      start: new Date(e.start_at),
      end: new Date(e.end_at),
    }));
  } catch (err) {
    console.error('Failed to load events:', err);
    alert('Failed to load events: ' + err.message);
    state.events = [];
  } finally {
    state.loading = false;
    render();
  }
}

// -------------------------------------------------------------------------
// Per-day clipping: split events into day-local segments in minutes.
// -------------------------------------------------------------------------
function segmentsForDay(dayStart) {
  const dayEnd = new Date(dayStart.getTime());
  dayEnd.setDate(dayEnd.getDate() + 1);

  const segs = [];
  for (const ev of state.events) {
    // Does the event overlap this day at all?
    if (ev.end <= dayStart || ev.start >= dayEnd) continue;
    // Clamp to the day's [0, 1440] window.
    const startMin = Math.max(0, minutesIntoDay(ev.start, dayStart));
    const endMin = Math.min(MINUTES_PER_DAY, minutesIntoDay(ev.end, dayStart));
    if (endMin <= startMin) continue;
    segs.push({
      id: ev.id,
      event: ev,
      startMin,
      endMin,
    });
  }
  return segs;
}

// -------------------------------------------------------------------------
// Rendering
// -------------------------------------------------------------------------
function rangeLabel() {
  const days = weekDays(state.weekStart);
  const first = days[0];
  const last = days[6];
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const sameMonth = first.getMonth() === last.getMonth();
  const sameYear = first.getFullYear() === last.getFullYear();
  if (sameMonth) {
    return `${monthNames[first.getMonth()]} ${first.getDate()} – ${last.getDate()}, ${first.getFullYear()}`;
  }
  if (sameYear) {
    return `${monthNames[first.getMonth()]} ${first.getDate()} – ${monthNames[last.getMonth()]} ${last.getDate()}, ${first.getFullYear()}`;
  }
  return `${monthNames[first.getMonth()]} ${first.getDate()}, ${first.getFullYear()} – ${monthNames[last.getMonth()]} ${last.getDate()}, ${last.getFullYear()}`;
}

function render() {
  root.innerHTML = '';
  root.appendChild(renderToolbar());
  root.appendChild(renderCalendar());
}

function renderToolbar() {
  const bar = el('div', 'toolbar');
  bar.appendChild(el('h1', null, 'Week Calendar'));
  bar.appendChild(el('span', 'range-label', rangeLabel()));

  const spacer = el('div', 'spacer');
  bar.appendChild(spacer);

  const prev = button('‹ Prev', 'btn', () => {
    state.weekStart = addWeeks(state.weekStart, -1);
    loadEvents();
  });
  const today = button('Today', 'btn', () => {
    state.weekStart = startOfWeek(new Date());
    loadEvents();
  });
  const next = button('Next ›', 'btn', () => {
    state.weekStart = addWeeks(state.weekStart, 1);
    loadEvents();
  });
  const create = button('+ New event', 'btn primary', () => {
    const now = new Date();
    const start = new Date(state.weekStart.getTime());
    start.setHours(9, 0, 0, 0);
    const end = new Date(start.getTime() + 60 * 60000);
    openEventForm({ mode: 'create', title: '', start, end });
  });

  bar.appendChild(prev);
  bar.appendChild(today);
  bar.appendChild(next);
  bar.appendChild(create);
  return bar;
}

function renderCalendar() {
  const scroll = el('div', 'calendar');
  const grid = el('div', 'calendar-grid');

  const days = weekDays(state.weekStart);
  const now = new Date();

  // Header row: corner + 7 day headers
  grid.appendChild(el('div', 'corner'));
  for (const day of days) {
    const isToday = isSameDay(day, now);
    const header = el('div', 'day-header' + (isToday ? ' today' : ''));
    header.appendChild(el('div', 'dow', dayName(day)));
    header.appendChild(el('div', 'date', String(day.getDate())));
    grid.appendChild(header);
  }

  // Time gutter
  const gutter = el('div', 'time-gutter');
  gutter.style.height = `${DAY_HEIGHT}px`;
  for (let h = 0; h <= 24; h++) {
    const label = el('div', 'hour-label', `${pad2(h)}:00`);
    label.style.top = `${h * HOUR_HEIGHT}px`;
    gutter.appendChild(label);
  }
  grid.appendChild(gutter);

  // Day columns
  for (const day of days) {
    grid.appendChild(renderDayColumn(day, isSameDay(day, now)));
  }

  scroll.appendChild(grid);
  return scroll;
}

function renderDayColumn(dayStart, isToday) {
  const col = el('div', 'day-col' + (isToday ? ' today' : ''));
  col.style.height = `${DAY_HEIGHT}px`;

  // Hour & half-hour grid lines
  for (let h = 0; h < 24; h++) {
    const line = el('div', 'hour-line');
    line.style.top = `${h * HOUR_HEIGHT}px`;
    col.appendChild(line);
    const half = el('div', 'half-hour-line');
    half.style.top = `${h * HOUR_HEIGHT + HOUR_HEIGHT / 2}px`;
    col.appendChild(half);
  }

  // Lay out events for this day.
  const segs = segmentsForDay(dayStart);
  const placed = layoutDay(segs);
  for (const p of placed) {
    col.appendChild(renderEvent(p));
  }

  // Drag-to-create interaction.
  attachDragCreate(col, dayStart);

  return col;
}

function renderEvent(p) {
  const top = p.startMin * PX_PER_MIN;
  const height = (p.endMin - p.startMin) * PX_PER_MIN;
  const div = el('div', 'event');
  // Horizontal placement from fractional layout, with a tiny gap between columns.
  const GAP = 2; // px
  div.style.top = `${top}px`;
  div.style.height = `${Math.max(height, 2)}px`;
  div.style.left = `calc(${p.left * 100}% + ${GAP / 2}px)`;
  div.style.width = `calc(${p.width * 100}% - ${GAP}px)`;

  const ev = p.event;
  const timeText = `${formatTime(ev.start)} – ${formatTime(ev.end)}`;
  div.appendChild(el('div', 'title', ev.title));
  div.appendChild(el('div', 'time', timeText));
  div.title = `${ev.title}\n${timeText}`;

  div.addEventListener('click', (e) => {
    e.stopPropagation();
    openEventForm({
      mode: 'edit',
      id: ev.id,
      title: ev.title,
      start: ev.start,
      end: ev.end,
    });
  });
  return div;
}

// -------------------------------------------------------------------------
// Drag-to-create
// -------------------------------------------------------------------------
function attachDragCreate(col, dayStart) {
  let dragging = false;
  let startY = 0;
  let selBox = null;

  function yToMinutes(y) {
    let min = y / PX_PER_MIN;
    min = Math.round(min / SNAP_MIN) * SNAP_MIN;
    return Math.max(0, Math.min(MINUTES_PER_DAY, min));
  }

  function localY(e) {
    const rect = col.getBoundingClientRect();
    return e.clientY - rect.top + col.scrollTop;
  }

  col.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    // Ignore clicks that started on an event block.
    if (e.target.closest('.event')) return;
    dragging = true;
    startY = localY(e);
    selBox = el('div', 'selection-box');
    col.appendChild(selBox);
    updateSelBox(startY, startY);
    // Track movement/release on window so the drag works even if the cursor
    // leaves the column. Listeners are removed on release (see onUp).
    window.addEventListener('mousemove', onWindowMove);
    window.addEventListener('mouseup', onUp);
    e.preventDefault();
  });

  function onWindowMove(e) {
    if (!dragging) return;
    updateSelBox(startY, localY(e));
  }

  function updateSelBox(y1, y2) {
    const top = Math.min(y1, y2);
    const bottom = Math.max(y1, y2);
    selBox.style.top = `${top}px`;
    selBox.style.height = `${bottom - top}px`;
  }

  function onUp(e) {
    window.removeEventListener('mousemove', onWindowMove);
    window.removeEventListener('mouseup', onUp);
    if (!dragging) return;
    dragging = false;
    const endY = localY(e);
    if (selBox) { selBox.remove(); selBox = null; }

    let startMin = yToMinutes(Math.min(startY, endY));
    let endMin = yToMinutes(Math.max(startY, endY));

    // A simple click (no real drag) => default 1-hour event at the clicked slot.
    if (endMin - startMin < SNAP_MIN) {
      startMin = yToMinutes(startY);
      endMin = Math.min(MINUTES_PER_DAY, startMin + 60);
      if (endMin <= startMin) {
        startMin = MINUTES_PER_DAY - 60;
        endMin = MINUTES_PER_DAY;
      }
    }

    const start = dateFromDayMinutes(dayStart, startMin);
    const end = dateFromDayMinutes(dayStart, endMin);
    openEventForm({ mode: 'create', title: '', start, end });
  }
}

// -------------------------------------------------------------------------
// Event form (create / edit) modal
// -------------------------------------------------------------------------
function openEventForm(opts) {
  const backdrop = el('div', 'modal-backdrop');
  const modal = el('div', 'modal');
  backdrop.appendChild(modal);

  modal.appendChild(el('h2', null, opts.mode === 'edit' ? 'Edit event' : 'New event'));

  const titleField = el('div', 'field');
  titleField.appendChild(el('label', null, 'Title'));
  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.value = opts.title || '';
  titleInput.placeholder = 'Event title';
  titleField.appendChild(titleInput);
  modal.appendChild(titleField);

  const startField = el('div', 'field');
  startField.appendChild(el('label', null, 'Starts'));
  const startInput = document.createElement('input');
  startInput.type = 'datetime-local';
  startInput.value = toLocalInputValue(opts.start);
  startField.appendChild(startInput);
  modal.appendChild(startField);

  const endField = el('div', 'field');
  endField.appendChild(el('label', null, 'Ends'));
  const endInput = document.createElement('input');
  endInput.type = 'datetime-local';
  endInput.value = toLocalInputValue(opts.end);
  endField.appendChild(endInput);
  modal.appendChild(endField);

  const errorEl = el('div', 'error', '');
  modal.appendChild(errorEl);

  const actions = el('div', 'modal-actions');

  if (opts.mode === 'edit') {
    const delBtn = button('Delete', 'btn danger', async () => {
      try {
        await api.deleteEvent(opts.id);
        close();
        await loadEvents();
      } catch (err) {
        errorEl.textContent = err.message;
      }
    });
    actions.appendChild(delBtn);
  }

  actions.appendChild(el('div', 'spacer'));

  const cancelBtn = button('Cancel', 'btn', () => close());
  const saveBtn = button('Save', 'btn primary', onSave);
  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
  modal.appendChild(actions);

  function close() {
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
  }

  function onKey(e) {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter' && document.activeElement !== titleInput) onSave();
  }

  async function onSave() {
    errorEl.textContent = '';
    const title = titleInput.value.trim();
    if (!title) {
      errorEl.textContent = 'Title is required.';
      return;
    }
    const start = fromLocalInputValue(startInput.value);
    const end = fromLocalInputValue(endInput.value);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      errorEl.textContent = 'Please provide valid start and end times.';
      return;
    }
    if (!(end.getTime() > start.getTime())) {
      errorEl.textContent = 'End time must be after start time.';
      return;
    }
    const payload = {
      title,
      start_at: start.toISOString(),
      end_at: end.toISOString(),
    };
    try {
      if (opts.mode === 'edit') {
        await api.updateEvent(opts.id, payload);
      } else {
        await api.createEvent(payload);
      }
      close();
      // If the new/edited event moved out of the current week, it simply won't
      // appear; otherwise it re-renders in place.
      await loadEvents();
    } catch (err) {
      errorEl.textContent = err.message;
    }
  }

  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener('keydown', onKey);

  document.body.appendChild(backdrop);
  titleInput.focus();
  titleInput.select();
}

// -------------------------------------------------------------------------
// Small DOM helpers
// -------------------------------------------------------------------------
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(label, className, onClick) {
  const b = el('button', className, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

// -------------------------------------------------------------------------
// Boot
// -------------------------------------------------------------------------
render();
loadEvents();
