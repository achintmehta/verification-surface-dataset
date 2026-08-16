import './styles.css';
import {
  DAY_LABELS,
  startOfWeek,
  addDays,
  addWeeks,
  sameDay,
  minutesFromDayStart,
  formatTime,
  toDatetimeLocalValue,
  fromDatetimeLocalValue,
  formatDateRangeLabel,
} from './dates.js';
import { computeDayLayout } from './layout.js';
import { fetchEvents, createEvent, updateEvent, deleteEvent } from './api.js';

// ---- Geometry constants -------------------------------------------------
const HOURS = 24;
const HOUR_HEIGHT = 48; // px per hour -> single axis-height constant
const AXIS_HEIGHT = HOURS * HOUR_HEIGHT; // 1152px
const DAY_MINUTES = HOURS * 60;
const SNAP_MINUTES = 15;

// ---- App state ----------------------------------------------------------
let weekStart = startOfWeek(new Date());
let events = []; // raw events from API: { id, title, start_at, end_at }
let loadError = null;

const appEl = document.getElementById('app');

// ---- Data loading -------------------------------------------------------
async function loadWeek() {
  const rangeStart = new Date(weekStart);
  const rangeEnd = addDays(weekStart, 7);
  try {
    events = await fetchEvents(rangeStart.toISOString(), rangeEnd.toISOString());
    loadError = null;
  } catch (err) {
    loadError = err.message;
    events = [];
  }
  render();
}

// ---- Layout computation per day ----------------------------------------
// For a given day index (0..6), produce positioned event boxes.
function eventsForDay(dayIndex) {
  const dayStart = addDays(weekStart, dayIndex);
  const dayEnd = addDays(dayStart, 1);

  const dayEvents = [];
  for (const ev of events) {
    const s = new Date(ev.start_at);
    const e = new Date(ev.end_at);
    // Does it intersect this day's window?
    if (e.getTime() <= dayStart.getTime() || s.getTime() >= dayEnd.getTime()) {
      continue;
    }
    // Clamp to the day window.
    const startMin = Math.max(0, minutesFromDayStart(s, dayStart));
    const endMin = Math.min(DAY_MINUTES, minutesFromDayStart(e, dayStart));
    if (endMin <= startMin) continue;
    dayEvents.push({
      id: ev.id,
      raw: ev,
      startMin,
      endMin,
    });
  }

  const slots = computeDayLayout(dayEvents);
  return dayEvents.map((de) => {
    const slot = slots.get(de) || { colIndex: 0, colCount: 1 };
    return { ...de, ...slot };
  });
}

// ---- Rendering ----------------------------------------------------------
function render() {
  appEl.innerHTML = '';

  appEl.appendChild(renderToolbar());

  if (loadError) {
    const banner = document.createElement('div');
    banner.className = 'error-banner';
    banner.textContent = `Could not load events: ${loadError}`;
    appEl.appendChild(banner);
  }

  appEl.appendChild(renderCalendar());
}

function renderToolbar() {
  const bar = document.createElement('div');
  bar.className = 'toolbar';

  const nav = document.createElement('div');
  nav.className = 'nav';

  const prev = button('‹ Prev', () => {
    weekStart = addWeeks(weekStart, -1);
    loadWeek();
  });
  const today = button('Today', () => {
    weekStart = startOfWeek(new Date());
    loadWeek();
  });
  const next = button('Next ›', () => {
    weekStart = addWeeks(weekStart, 1);
    loadWeek();
  });
  nav.append(prev, today, next);

  const label = document.createElement('div');
  label.className = 'week-label';
  label.textContent = formatDateRangeLabel(weekStart);

  bar.append(nav, label);
  return bar;
}

function button(text, onClick, className = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  if (className) b.className = className;
  b.addEventListener('click', onClick);
  return b;
}

function renderCalendar() {
  const calendar = document.createElement('div');
  calendar.className = 'calendar';

  // --- Header row: corner + 7 day headers ---
  const header = document.createElement('div');
  header.className = 'calendar-header';

  const corner = document.createElement('div');
  corner.className = 'corner';
  header.appendChild(corner);

  const todayDate = new Date();
  for (let i = 0; i < 7; i++) {
    const dayDate = addDays(weekStart, i);
    const h = document.createElement('div');
    h.className = 'day-header';
    if (sameDay(dayDate, todayDate)) h.classList.add('today');
    h.innerHTML = `<span class="dow">${DAY_LABELS[i]}</span>` +
      `<span class="dnum">${dayDate.getDate()}</span>`;
    header.appendChild(h);
  }
  calendar.appendChild(header);

  // --- Scrollable body: time gutter + 7 day columns ---
  const body = document.createElement('div');
  body.className = 'calendar-body';

  const grid = document.createElement('div');
  grid.className = 'grid';
  grid.style.height = `${AXIS_HEIGHT}px`;

  // Time gutter
  const gutter = document.createElement('div');
  gutter.className = 'time-gutter';
  gutter.style.height = `${AXIS_HEIGHT}px`;
  for (let h = 0; h <= HOURS; h++) {
    const label = document.createElement('div');
    label.className = 'hour-label';
    label.style.top = `${h * HOUR_HEIGHT}px`;
    if (h < HOURS) label.textContent = `${String(h).padStart(2, '0')}:00`;
    gutter.appendChild(label);
  }
  grid.appendChild(gutter);

  // Day columns
  for (let i = 0; i < 7; i++) {
    grid.appendChild(renderDayColumn(i, todayDate));
  }

  body.appendChild(grid);
  calendar.appendChild(body);
  return calendar;
}

function renderDayColumn(dayIndex, todayDate) {
  const dayDate = addDays(weekStart, dayIndex);
  const col = document.createElement('div');
  col.className = 'day-column';
  col.style.height = `${AXIS_HEIGHT}px`;
  if (sameDay(dayDate, todayDate)) col.classList.add('today');

  // Hour grid lines.
  for (let h = 0; h <= HOURS; h++) {
    const line = document.createElement('div');
    line.className = 'hour-line';
    if (h === HOURS) line.classList.add('last');
    line.style.top = `${h * HOUR_HEIGHT}px`;
    col.appendChild(line);
  }

  // Interaction layer for creating events by click/drag.
  attachCreateInteraction(col, dayDate);

  // Event blocks.
  const positioned = eventsForDay(dayIndex);
  for (const ev of positioned) {
    col.appendChild(renderEventBlock(ev));
  }

  return col;
}

function renderEventBlock(ev) {
  const top = (ev.startMin / 60) * HOUR_HEIGHT;
  const height = ((ev.endMin - ev.startMin) / 60) * HOUR_HEIGHT;
  const widthPct = 100 / ev.colCount;
  const leftPct = ev.colIndex * widthPct;

  const block = document.createElement('div');
  block.className = 'event';
  block.style.top = `${top}px`;
  block.style.height = `${Math.max(height, 1)}px`;
  block.style.left = `calc(${leftPct}% + 1px)`;
  block.style.width = `calc(${widthPct}% - 2px)`;

  const start = new Date(ev.raw.start_at);
  const end = new Date(ev.raw.end_at);

  const title = document.createElement('div');
  title.className = 'event-title';
  title.textContent = ev.raw.title;

  const time = document.createElement('div');
  time.className = 'event-time';
  time.textContent = `${formatTime(start)}–${formatTime(end)}`;

  block.append(title, time);
  block.title = `${ev.raw.title}\n${formatTime(start)}–${formatTime(end)}`;

  block.addEventListener('click', (e) => {
    e.stopPropagation();
    openEditForm(ev.raw);
  });
  block.addEventListener('mousedown', (e) => e.stopPropagation());

  return block;
}

// ---- Create interaction (click / click-drag) ----------------------------
function attachCreateInteraction(col, dayDate) {
  let dragging = false;
  let startY = 0;
  let selectionEl = null;

  const yToMinutes = (clientY) => {
    const rect = col.getBoundingClientRect();
    let y = clientY - rect.top + col.scrollTop;
    y = Math.max(0, Math.min(AXIS_HEIGHT, y));
    const minutes = (y / HOUR_HEIGHT) * 60;
    return Math.round(minutes / SNAP_MINUTES) * SNAP_MINUTES;
  };

  col.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    startY = yToMinutes(e.clientY);
    selectionEl = document.createElement('div');
    selectionEl.className = 'selection';
    col.appendChild(selectionEl);
    updateSelection(startY, startY);
    e.preventDefault();
  });

  function updateSelection(a, b) {
    const top = (Math.min(a, b) / 60) * HOUR_HEIGHT;
    const height = (Math.abs(b - a) / 60) * HOUR_HEIGHT;
    selectionEl.style.top = `${top}px`;
    selectionEl.style.height = `${height}px`;
  }

  const onMove = (e) => {
    if (!dragging || !selectionEl) return;
    const cur = yToMinutes(e.clientY);
    updateSelection(startY, cur);
  };

  const onUp = (e) => {
    if (!dragging) return;
    dragging = false;
    const endMin = yToMinutes(e.clientY);
    if (selectionEl) {
      selectionEl.remove();
      selectionEl = null;
    }
    let a = Math.min(startY, endMin);
    let b = Math.max(startY, endMin);
    // Plain click (no drag): default to a 60-minute block.
    if (b - a < SNAP_MINUTES) {
      b = Math.min(DAY_MINUTES, a + 60);
      if (b === a) a = Math.max(0, b - 60);
    }
    openCreateForm(dayDate, a, b);
  };

  col.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

// ---- Forms (modal) ------------------------------------------------------
function minutesToDate(dayDate, minutes) {
  const d = new Date(dayDate);
  d.setHours(0, 0, 0, 0);
  d.setMinutes(minutes);
  return d;
}

function openCreateForm(dayDate, startMin, endMin) {
  const start = minutesToDate(dayDate, startMin);
  const end = minutesToDate(dayDate, endMin);
  openForm({
    mode: 'create',
    title: '',
    start,
    end,
  });
}

function openEditForm(rawEvent) {
  openForm({
    mode: 'edit',
    id: rawEvent.id,
    title: rawEvent.title,
    start: new Date(rawEvent.start_at),
    end: new Date(rawEvent.end_at),
  });
}

function openForm({ mode, id, title, start, end }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'modal';

  modal.innerHTML = `
    <h2>${mode === 'create' ? 'New event' : 'Edit event'}</h2>
    <form>
      <label>Title
        <input name="title" type="text" autocomplete="off" />
      </label>
      <label>Start
        <input name="start" type="datetime-local" />
      </label>
      <label>End
        <input name="end" type="datetime-local" />
      </label>
      <p class="form-error" hidden></p>
      <div class="form-actions">
        ${mode === 'edit' ? '<button type="button" class="danger" data-action="delete">Delete</button>' : '<span></span>'}
        <div class="right-actions">
          <button type="button" data-action="cancel">Cancel</button>
          <button type="submit" class="primary">Save</button>
        </div>
      </div>
    </form>
  `;

  const form = modal.querySelector('form');
  form.title.value = title;
  form.start.value = toDatetimeLocalValue(start);
  form.end.value = toDatetimeLocalValue(end);
  const errEl = modal.querySelector('.form-error');

  const close = () => overlay.remove();

  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close();
  });
  modal.querySelector('[data-action="cancel"]').addEventListener('click', close);

  const delBtn = modal.querySelector('[data-action="delete"]');
  if (delBtn) {
    delBtn.addEventListener('click', async () => {
      try {
        await deleteEvent(id);
        close();
        await loadWeek();
      } catch (err) {
        showError(errEl, err.message);
      }
    });
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const t = form.title.value.trim();
    const s = fromDatetimeLocalValue(form.start.value);
    const en = fromDatetimeLocalValue(form.end.value);
    if (t === '') return showError(errEl, 'Title must not be empty.');
    if (!s || !en) return showError(errEl, 'Start and end are required.');
    if (!(en.getTime() > s.getTime())) {
      return showError(errEl, 'End must be after start.');
    }
    const payload = {
      title: t,
      start_at: s.toISOString(),
      end_at: en.toISOString(),
    };
    try {
      if (mode === 'create') {
        await createEvent(payload);
      } else {
        await updateEvent(id, payload);
      }
      close();
      await loadWeek();
    } catch (err) {
      showError(errEl, err.message);
    }
  });

  overlay.appendChild(modal);
  appEl.appendChild(overlay);
  form.title.focus();
}

function showError(el, message) {
  el.textContent = message;
  el.hidden = false;
}

// ---- Boot ---------------------------------------------------------------
loadWeek().then(() => {
  // Scroll the calendar body to ~08:00 so events are visible on load.
  const body = document.querySelector('.calendar-body');
  if (body) body.scrollTop = 7 * HOUR_HEIGHT;
});
