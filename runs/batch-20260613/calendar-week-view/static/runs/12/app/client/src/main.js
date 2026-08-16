import './styles.css';
import {
  startOfWeek,
  weekDays,
  addDays,
  sameDay,
  dayName,
  formatDateHeader,
  formatRangeLabel,
  formatTime,
} from './dates.js';
import { layoutDay, MINUTES_PER_DAY } from './layout.js';
import { fetchEvents, createEvent, updateEvent, deleteEvent } from './api.js';
import { openEventModal } from './modal.js';

const SNAP_MINUTES = 15; // selection snapping granularity

const state = {
  weekStart: startOfWeek(new Date()),
  events: [],
  loading: false,
};

const root = document.getElementById('app');

/** Round minutes to the configured snap granularity. */
function snap(min) {
  return Math.round(min / SNAP_MINUTES) * SNAP_MINUTES;
}

function colorClass(id) {
  // Stable per-event color bucket.
  const n = typeof id === 'number' ? id : String(id).length;
  return `c${((n % 6) + 6) % 6}`;
}

async function loadWeek() {
  const start = state.weekStart;
  const end = addDays(start, 7);
  state.loading = true;
  render();
  try {
    state.events = await fetchEvents(start, end);
  } catch (err) {
    console.error('Failed to load events', err);
    state.events = [];
  } finally {
    state.loading = false;
    render();
  }
}

function render() {
  root.innerHTML = '';
  root.appendChild(renderToolbar());
  root.appendChild(renderCalendar());
}

function renderToolbar() {
  const bar = document.createElement('div');
  bar.className = 'toolbar';

  const title = document.createElement('h1');
  title.textContent = 'Week';

  const range = document.createElement('span');
  range.className = 'range-label';
  range.textContent = formatRangeLabel(state.weekStart);

  const spacer = document.createElement('div');
  spacer.className = 'spacer';

  const nav = document.createElement('div');
  nav.className = 'nav-group';

  const prevBtn = document.createElement('button');
  prevBtn.textContent = '‹ Prev';
  prevBtn.addEventListener('click', () => {
    state.weekStart = addDays(state.weekStart, -7);
    loadWeek();
  });

  const todayBtn = document.createElement('button');
  todayBtn.textContent = 'Today';
  todayBtn.addEventListener('click', () => {
    state.weekStart = startOfWeek(new Date());
    loadWeek();
  });

  const nextBtn = document.createElement('button');
  nextBtn.textContent = 'Next ›';
  nextBtn.addEventListener('click', () => {
    state.weekStart = addDays(state.weekStart, 7);
    loadWeek();
  });

  nav.append(prevBtn, todayBtn, nextBtn);
  bar.append(title, range, spacer, nav);
  return bar;
}

function renderCalendar() {
  const calendar = document.createElement('div');
  calendar.className = 'calendar';

  if (state.loading) {
    const banner = document.createElement('div');
    banner.className = 'loading-banner';
    banner.textContent = 'Loading…';
    calendar.appendChild(banner);
  }

  const inner = document.createElement('div');
  inner.className = 'calendar-inner';

  // Corner cell
  const corner = document.createElement('div');
  corner.className = 'corner';
  inner.appendChild(corner);

  const days = weekDays(state.weekStart);
  const today = new Date();

  // Day headers
  for (const day of days) {
    const header = document.createElement('div');
    header.className = 'day-header';
    if (sameDay(day, today)) header.classList.add('today');
    const dow = document.createElement('div');
    dow.className = 'dow';
    dow.textContent = dayName(day);
    const date = document.createElement('div');
    date.className = 'date';
    date.textContent = sameDay(day, today)
      ? String(day.getDate())
      : formatDateHeader(day);
    header.append(dow, date);
    inner.appendChild(header);
  }

  // Time gutter
  const gutter = document.createElement('div');
  gutter.className = 'time-gutter';
  for (let h = 0; h <= 24; h++) {
    const label = document.createElement('div');
    label.className = 'hour-label';
    label.style.top = `${(h / 24) * 100}%`;
    label.textContent = h === 24 ? '24:00' : `${String(h).padStart(2, '0')}:00`;
    gutter.appendChild(label);
  }
  inner.appendChild(gutter);

  // Day columns with events
  for (const day of days) {
    inner.appendChild(renderDayColumn(day, today));
  }

  calendar.appendChild(inner);
  return calendar;
}

function renderDayColumn(day, today) {
  const col = document.createElement('div');
  col.className = 'day-col';
  if (sameDay(day, today)) col.classList.add('today');
  col.dataset.day = day.toISOString();

  // Lay out events for this day.
  const placed = layoutDay(state.events, day);
  for (const p of placed) {
    col.appendChild(renderEvent(p));
  }

  setupSelection(col, day);
  return col;
}

function renderEvent(p) {
  const el = document.createElement('div');
  el.className = `event ${colorClass(p.event.id)}`;
  el.style.top = `${p.topFrac * 100}%`;
  el.style.height = `${p.heightFrac * 100}%`;
  // Leave a tiny gutter between side-by-side blocks while still filling width.
  const leftPct = p.leftFrac * 100;
  const widthPct = p.widthFrac * 100;
  el.style.left = `calc(${leftPct}% + 1px)`;
  el.style.width = `calc(${widthPct}% - 2px)`;

  const titleEl = document.createElement('div');
  titleEl.className = 'event-title';
  titleEl.textContent = p.event.title;

  const timeEl = document.createElement('div');
  timeEl.className = 'event-time';
  timeEl.textContent = `${formatTime(p.event.start)} – ${formatTime(p.event.end)}`;

  el.append(titleEl, timeEl);
  el.title = `${p.event.title}\n${formatTime(p.event.start)} – ${formatTime(p.event.end)}`;

  el.addEventListener('click', (e) => {
    e.stopPropagation();
    openEditor(p.event);
  });

  return el;
}

/** Convert a vertical pixel offset within a day column to minutes (0..1440). */
function offsetToMinutes(col, clientY) {
  const rect = col.getBoundingClientRect();
  let frac = (clientY - rect.top) / rect.height;
  frac = Math.min(1, Math.max(0, frac));
  return frac * MINUTES_PER_DAY;
}

// A single active drag-selection, shared across the whole calendar. The global
// mousemove/mouseup listeners are registered exactly once (see below) so they
// never accumulate across re-renders.
let activeSelection = null; // { col, day, startMin, selEl, moved }

function updateSelectionBand(sel, a, b) {
  const top = Math.min(a, b);
  const bottom = Math.max(a, b);
  sel.selEl.style.top = `${(top / MINUTES_PER_DAY) * 100}%`;
  sel.selEl.style.height = `${((bottom - top) / MINUTES_PER_DAY) * 100}%`;
}

function setupSelection(col, day) {
  col.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    // Ignore clicks that originate on an event block.
    if (e.target.closest('.event')) return;
    const startMin = snap(offsetToMinutes(col, e.clientY));
    const selEl = document.createElement('div');
    selEl.className = 'selection';
    col.appendChild(selEl);
    activeSelection = { col, day, startMin, selEl, moved: false };
    updateSelectionBand(activeSelection, startMin, startMin);
    e.preventDefault();
  });
}

window.addEventListener('mousemove', (e) => {
  const sel = activeSelection;
  if (!sel) return;
  sel.moved = true;
  const cur = snap(offsetToMinutes(sel.col, e.clientY));
  updateSelectionBand(sel, sel.startMin, cur);
});

window.addEventListener('mouseup', (e) => {
  const sel = activeSelection;
  if (!sel) return;
  activeSelection = null;
  const endMinRaw = snap(offsetToMinutes(sel.col, e.clientY));
  if (sel.selEl.parentNode) sel.selEl.parentNode.removeChild(sel.selEl);

  let a = Math.min(sel.startMin, endMinRaw);
  let b = Math.max(sel.startMin, endMinRaw);
  // A plain click (no real drag) creates a default 1-hour slot.
  if (!sel.moved || b - a < SNAP_MINUTES) {
    a = sel.startMin;
    b = Math.min(MINUTES_PER_DAY, a + 60);
    if (b === a) {
      a = MINUTES_PER_DAY - 60;
      b = MINUTES_PER_DAY;
    }
  }
  openCreator(sel.day, a, b);
});

function minutesToDate(day, minutes) {
  const d = new Date(day);
  d.setHours(0, 0, 0, 0);
  d.setMinutes(minutes);
  return d;
}

function openCreator(day, startMin, endMin) {
  const start = minutesToDate(day, startMin);
  const end = minutesToDate(day, endMin);
  openEventModal({
    mode: 'create',
    initial: { title: '', start, end },
    onSubmit: async (data) => {
      const created = await createEvent(data);
      state.events.push(created);
      render();
    },
  });
}

function openEditor(event) {
  openEventModal({
    mode: 'edit',
    initial: { title: event.title, start: event.start, end: event.end },
    onSubmit: async (data) => {
      const updated = await updateEvent(event.id, data);
      const idx = state.events.findIndex((e) => e.id === event.id);
      if (idx >= 0) state.events[idx] = updated;
      // Reload to keep week filtering accurate if times moved.
      await loadWeek();
    },
    onDelete: async () => {
      await deleteEvent(event.id);
      state.events = state.events.filter((e) => e.id !== event.id);
      render();
    },
  });
}

loadWeek();
