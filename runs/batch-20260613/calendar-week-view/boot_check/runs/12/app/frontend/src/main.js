import './style.css';
import { layoutDayEvents } from './layout.js';
import {
  fetchEvents,
  createEvent,
  updateEvent,
  deleteEvent,
} from './api.js';
import {
  startOfWeek,
  addDays,
  isSameDay,
  minutesFromMidnight,
  dayLabel,
  formatRange,
  toDatetimeLocalValue,
  fromDatetimeLocalValue,
  monthYearLabel,
  MS_PER_DAY,
} from './dates.js';

const DAY_MINUTES = 24 * 60;

const state = {
  weekStart: startOfWeek(new Date()),
  events: [], // raw events from API: {id, title, start_at, end_at}
};

const app = document.getElementById('app');

// ---------- Geometry helpers ----------

// Pixels per minute, derived from the CSS axis height so styling stays in sync.
function axisHeightPx() {
  const cssVal = getComputedStyle(document.documentElement)
    .getPropertyValue('--axis-height')
    .trim();
  // --axis-height is calc(48px * 24); resolve via a temp element.
  const probe = document.createElement('div');
  probe.style.height = cssVal || 'calc(48px * 24)';
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  document.body.appendChild(probe);
  const h = probe.getBoundingClientRect().height;
  document.body.removeChild(probe);
  return h || 48 * 24;
}

function minuteToPx(minute) {
  return (minute / DAY_MINUTES) * axisHeightPx();
}

// Map a raw event to per-day clamped segments. An event normally lives in a
// single day, but if it spans midnight it is split per day so each day column
// renders only its own portion.
function eventSegmentsForWeek(ev) {
  const start = new Date(ev.start_at);
  const end = new Date(ev.end_at);
  const segments = [];
  for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
    const dayStart = addDays(state.weekStart, dayIdx);
    const dayEnd = addDays(dayStart, 1);
    // Intersection of [start, end) with [dayStart, dayEnd)
    const segStart = start > dayStart ? start : dayStart;
    const segEnd = end < dayEnd ? end : dayEnd;
    if (segEnd <= segStart) continue;
    const startMin = (segStart - dayStart) / 60000;
    const endMin = (segEnd - dayStart) / 60000;
    segments.push({
      dayIdx,
      startMin: Math.max(0, startMin),
      endMin: Math.min(DAY_MINUTES, endMin),
      event: ev,
      id: ev.id,
    });
  }
  return segments;
}

// ---------- Data loading ----------

async function loadWeek() {
  const rangeStart = state.weekStart;
  const rangeEnd = addDays(state.weekStart, 7);
  try {
    state.events = await fetchEvents(
      rangeStart.toISOString(),
      rangeEnd.toISOString()
    );
  } catch (err) {
    console.error('Failed to load events', err);
    state.events = [];
  }
  render();
}

// ---------- Rendering ----------

function render() {
  app.innerHTML = '';
  app.appendChild(renderToolbar());
  app.appendChild(renderCalendar());
}

function renderToolbar() {
  const bar = el('div', 'toolbar');
  const title = el('h1', null, 'Week Calendar');
  const prev = button('‹ Prev', () => navigate(-7));
  const today = button('Today', () => {
    state.weekStart = startOfWeek(new Date());
    loadWeek();
  });
  const next = button('Next ›', () => navigate(7));
  const label = el('span', 'range-label', monthYearLabel(state.weekStart));
  bar.append(title, prev, today, next, label);
  return bar;
}

function navigate(days) {
  state.weekStart = addDays(state.weekStart, days);
  loadWeek();
}

function button(text, onClick) {
  const b = el('button', null, text);
  b.addEventListener('click', onClick);
  return b;
}

function renderCalendar() {
  const cal = el('div', 'calendar');
  const grid = el('div', 'grid');

  // Header row: corner + 7 day headers.
  grid.appendChild(el('div', 'corner'));
  const today = new Date();
  for (let i = 0; i < 7; i++) {
    const day = addDays(state.weekStart, i);
    const isToday = isSameDay(day, today);
    const h = el('div', 'day-header' + (isToday ? ' today' : ''));
    h.appendChild(el('div', 'dow', dayLabel(day)));
    h.appendChild(el('div', 'date', String(day.getDate())));
    grid.appendChild(h);
  }

  // Time gutter.
  const gutter = el('div', 'time-gutter');
  for (let hour = 0; hour <= 24; hour++) {
    const mark = el('div', 'hour-mark', `${String(hour).padStart(2, '0')}:00`);
    mark.style.top = minuteToPx(hour * 60) + 'px';
    gutter.appendChild(mark);
  }
  grid.appendChild(gutter);

  // Precompute layout per day.
  const segmentsByDay = Array.from({ length: 7 }, () => []);
  for (const ev of state.events) {
    for (const seg of eventSegmentsForWeek(ev)) {
      segmentsByDay[seg.dayIdx].push(seg);
    }
  }

  for (let i = 0; i < 7; i++) {
    const day = addDays(state.weekStart, i);
    const isToday = isSameDay(day, today);
    const col = el('div', 'day-col' + (isToday ? ' today' : ''));
    col.dataset.dayIdx = String(i);

    // Hour lines.
    for (let hour = 0; hour <= 24; hour++) {
      const line = el('div', 'hour-line');
      line.style.top = minuteToPx(hour * 60) + 'px';
      col.appendChild(line);
      if (hour < 24) {
        const half = el('div', 'half-line');
        half.style.top = minuteToPx(hour * 60 + 30) + 'px';
        col.appendChild(half);
      }
    }

    // Laid out events for this day.
    const laid = layoutDayEvents(segmentsByDay[i]);
    for (const item of laid) {
      col.appendChild(renderEventBlock(item));
    }

    enableDragCreate(col, day);
    grid.appendChild(col);
  }

  cal.appendChild(grid);
  return cal;
}

function renderEventBlock(item) {
  const { startMin, endMin, colIndex, colCount, event } = item;
  const top = minuteToPx(startMin);
  const height = Math.max(minuteToPx(endMin) - top, minuteToPx(15) * 0.6, 12);

  const block = el('div', 'event');
  // Horizontal placement: equal share of the column width with a tiny gap.
  const gapPct = 1; // percent gap between adjacent blocks
  const widthPct = 100 / colCount;
  block.style.left = `calc(${colIndex * widthPct}% + 1px)`;
  block.style.width = `calc(${widthPct}% - ${gapPct + 2}px)`;
  block.style.top = top + 'px';
  block.style.height = height + 'px';

  const start = new Date(event.start_at);
  const end = new Date(event.end_at);
  block.appendChild(el('div', 'ev-title', event.title));
  block.appendChild(el('div', 'ev-time', formatRange(start, end)));

  block.addEventListener('click', (e) => {
    e.stopPropagation();
    openEditForm(event);
  });
  return block;
}

// ---------- Drag-to-create ----------

function enableDragCreate(col, day) {
  let preview = null;
  let startY = 0;
  let dragging = false;

  const yToMinute = (clientY) => {
    const rect = col.getBoundingClientRect();
    let min = ((clientY - rect.top) / rect.height) * DAY_MINUTES;
    min = Math.max(0, Math.min(DAY_MINUTES, min));
    // Snap to 15-minute increments.
    return Math.round(min / 15) * 15;
  };

  col.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.event')) return;
    dragging = true;
    startY = yToMinute(e.clientY);
    preview = el('div', 'drag-preview');
    col.appendChild(preview);
    updatePreview(startY, startY);
    e.preventDefault();
  });

  function updatePreview(a, b) {
    const top = Math.min(a, b);
    const bottom = Math.max(a, b);
    preview.style.top = minuteToPx(top) + 'px';
    preview.style.height = minuteToPx(bottom - top) + 'px';
  }

  const onMove = (e) => {
    if (!dragging) return;
    updatePreview(startY, yToMinute(e.clientY));
  };

  const onUp = (e) => {
    if (!dragging) return;
    dragging = false;
    const endY = yToMinute(e.clientY);
    if (preview) {
      preview.remove();
      preview = null;
    }
    let a = Math.min(startY, endY);
    let b = Math.max(startY, endY);
    if (b - a < 15) b = Math.min(DAY_MINUTES, a + 60); // default 1h on a click
    if (b <= a) return;
    const startDate = new Date(day);
    startDate.setHours(0, 0, 0, 0);
    startDate.setMinutes(a);
    const endDate = new Date(day);
    endDate.setHours(0, 0, 0, 0);
    endDate.setMinutes(b);
    openCreateForm(startDate, endDate);
  };

  col.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

// ---------- Forms (modal) ----------

function openCreateForm(start, end) {
  openModal({
    title: 'New event',
    values: { title: '', start, end },
    onSave: async (vals) => {
      await createEvent({
        title: vals.title,
        start_at: vals.start.toISOString(),
        end_at: vals.end.toISOString(),
      });
      await loadWeek();
    },
  });
}

function openEditForm(event) {
  openModal({
    title: 'Edit event',
    values: {
      title: event.title,
      start: new Date(event.start_at),
      end: new Date(event.end_at),
    },
    onSave: async (vals) => {
      await updateEvent(event.id, {
        title: vals.title,
        start_at: vals.start.toISOString(),
        end_at: vals.end.toISOString(),
      });
      await loadWeek();
    },
    onDelete: async () => {
      await deleteEvent(event.id);
      await loadWeek();
    },
  });
}

function openModal({ title, values, onSave, onDelete }) {
  const backdrop = el('div', 'modal-backdrop');
  const modal = el('div', 'modal');
  modal.appendChild(el('h2', null, title));

  const titleInput = inputField('Title', 'text', values.title);
  const startInput = inputField(
    'Start',
    'datetime-local',
    toDatetimeLocalValue(values.start)
  );
  const endInput = inputField(
    'End',
    'datetime-local',
    toDatetimeLocalValue(values.end)
  );
  modal.append(titleInput.wrap, startInput.wrap, endInput.wrap);

  const errorBox = el('div', 'error', '');
  modal.appendChild(errorBox);

  const actions = el('div', 'actions');
  if (onDelete) {
    const del = el('button', 'danger', 'Delete');
    del.addEventListener('click', async () => {
      try {
        await onDelete();
        close();
      } catch (err) {
        errorBox.textContent = err.message;
      }
    });
    actions.appendChild(del);
  }
  const cancel = el('button', null, 'Cancel');
  cancel.addEventListener('click', close);
  const save = el('button', 'primary', 'Save');
  save.addEventListener('click', async () => {
    const titleVal = titleInput.input.value.trim();
    const startVal = fromDatetimeLocalValue(startInput.input.value);
    const endVal = fromDatetimeLocalValue(endInput.input.value);
    errorBox.textContent = '';
    if (!titleVal) {
      errorBox.textContent = 'Title is required.';
      return;
    }
    if (Number.isNaN(startVal.getTime()) || Number.isNaN(endVal.getTime())) {
      errorBox.textContent = 'Valid start and end times are required.';
      return;
    }
    if (!(endVal.getTime() > startVal.getTime())) {
      errorBox.textContent = 'End must be after start.';
      return;
    }
    try {
      await onSave({ title: titleVal, start: startVal, end: endVal });
      close();
    } catch (err) {
      errorBox.textContent = err.message;
    }
  });
  actions.append(cancel, save);
  modal.appendChild(actions);

  backdrop.appendChild(modal);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  document.body.appendChild(backdrop);
  titleInput.input.focus();

  function close() {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) {
    if (e.key === 'Escape') close();
  }
  document.addEventListener('keydown', onKey);
}

function inputField(labelText, type, value) {
  const wrap = el('div');
  const label = el('label', null, labelText);
  const input = document.createElement('input');
  input.type = type;
  input.value = value;
  wrap.append(label, input);
  return { wrap, input };
}

// ---------- Tiny DOM helper ----------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// ---------- Boot ----------

loadWeek();
window.addEventListener('resize', () => render());
