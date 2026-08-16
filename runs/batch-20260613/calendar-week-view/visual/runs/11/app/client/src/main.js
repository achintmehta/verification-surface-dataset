import { layoutDay } from './layout.js';
import {
  fetchEvents,
  createEvent,
  updateEvent,
  deleteEvent
} from './api.js';
import {
  startOfWeek,
  addDays,
  isSameDay,
  minutesFromMidnight,
  weekdayLabel,
  formatDayHeaderDate,
  formatTimeHM,
  toDatetimeLocalValue,
  fromDatetimeLocalValue,
  formatWeekRange,
  MINUTES_PER_DAY,
  pad2
} from './dates.js';

const HOUR_HEIGHT = 48; // px per hour
const AXIS_HEIGHT = HOUR_HEIGHT * 24; // total grid height
const SNAP_MIN = 15; // minute snap for click/drag selection

const state = {
  weekStart: startOfWeek(new Date()),
  events: []
};

const root = document.getElementById('app');

function pxFromMinutes(min) {
  return (min / MINUTES_PER_DAY) * AXIS_HEIGHT;
}

function minutesFromPx(px) {
  return (px / AXIS_HEIGHT) * MINUTES_PER_DAY;
}

// ----- Rendering -----------------------------------------------------------

function render() {
  root.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'toolbar';
  header.innerHTML = `
    <div class="nav">
      <button id="prev" class="btn">‹ Prev</button>
      <button id="today" class="btn">Today</button>
      <button id="next" class="btn">Next ›</button>
    </div>
    <h1 class="week-range">${formatWeekRange(state.weekStart)}</h1>
  `;
  root.appendChild(header);

  header.querySelector('#prev').addEventListener('click', () => navigate(-7));
  header.querySelector('#next').addEventListener('click', () => navigate(7));
  header.querySelector('#today').addEventListener('click', () => {
    state.weekStart = startOfWeek(new Date());
    load();
  });

  const calendar = document.createElement('div');
  calendar.className = 'calendar';
  root.appendChild(calendar);

  // Column headers row
  const headRow = document.createElement('div');
  headRow.className = 'cal-head';
  headRow.appendChild(corner());
  const today = new Date();
  for (let i = 0; i < 7; i++) {
    const day = addDays(state.weekStart, i);
    const cell = document.createElement('div');
    cell.className = 'day-head' + (isSameDay(day, today) ? ' today' : '');
    cell.innerHTML = `<span class="dow">${weekdayLabel(i)}</span><span class="date">${formatDayHeaderDate(day)}</span>`;
    headRow.appendChild(cell);
  }
  calendar.appendChild(headRow);

  // Scrollable body: time axis + 7 day columns
  const body = document.createElement('div');
  body.className = 'cal-body';

  const axis = document.createElement('div');
  axis.className = 'time-axis';
  axis.style.height = `${AXIS_HEIGHT}px`;
  for (let h = 0; h <= 24; h++) {
    const label = document.createElement('div');
    label.className = 'hour-label';
    label.style.top = `${pxFromMinutes(h * 60)}px`;
    label.textContent = `${pad2(h === 24 ? 24 : h)}:00`;
    axis.appendChild(label);
  }
  body.appendChild(axis);

  const grid = document.createElement('div');
  grid.className = 'day-grid';
  grid.style.height = `${AXIS_HEIGHT}px`;

  for (let i = 0; i < 7; i++) {
    const day = addDays(state.weekStart, i);
    const col = buildDayColumn(day, i, today);
    grid.appendChild(col);
  }
  body.appendChild(grid);
  calendar.appendChild(body);
}

function corner() {
  const c = document.createElement('div');
  c.className = 'corner';
  return c;
}

function buildDayColumn(day, dayIndex, today) {
  const col = document.createElement('div');
  col.className = 'day-col' + (isSameDay(day, today) ? ' today' : '');
  col.style.height = `${AXIS_HEIGHT}px`;
  col.dataset.dayIndex = String(dayIndex);

  // hour grid lines
  for (let h = 1; h < 24; h++) {
    const line = document.createElement('div');
    line.className = 'hour-line';
    line.style.top = `${pxFromMinutes(h * 60)}px`;
    col.appendChild(line);
  }

  const dayStart = new Date(day);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = addDays(dayStart, 1);

  // Filter events that intersect this day, clamp to the day, compute minutes.
  const dayEvents = [];
  for (const ev of state.events) {
    const s = new Date(ev.start_at);
    const e = new Date(ev.end_at);
    if (s < dayEnd && e > dayStart) {
      const startMin = Math.max(0, minutesFromMidnight(s, dayStart));
      const endMin = Math.min(MINUTES_PER_DAY, minutesFromMidnight(e, dayStart));
      if (endMin > startMin) {
        dayEvents.push({ id: ev.id, ref: ev, start: startMin, end: endMin });
      }
    }
  }

  const laid = layoutDay(dayEvents);
  for (const item of laid) {
    col.appendChild(buildEventBlock(item));
  }

  attachSelection(col, dayStart);
  return col;
}

function buildEventBlock(item) {
  const top = pxFromMinutes(item.start);
  const height = pxFromMinutes(item.end - item.start);
  const widthPct = 100 / item.colCount;
  const leftPct = (item.colIndex * 100) / item.colCount;

  const el = document.createElement('div');
  el.className = 'event';
  el.style.top = `${top}px`;
  el.style.height = `${Math.max(height, 1)}px`;
  el.style.left = `calc(${leftPct}% + 1px)`;
  el.style.width = `calc(${widthPct}% - 2px)`;

  const s = new Date(item.ref.start_at);
  const e = new Date(item.ref.end_at);
  el.innerHTML = `
    <div class="event-title">${escapeHtml(item.ref.title)}</div>
    <div class="event-time">${formatTimeHM(s)}–${formatTimeHM(e)}</div>
  `;
  el.title = `${item.ref.title} (${formatTimeHM(s)}–${formatTimeHM(e)})`;
  el.addEventListener('mousedown', (ev) => ev.stopPropagation());
  el.addEventListener('click', (ev) => {
    ev.stopPropagation();
    openEditForm(item.ref);
  });
  return el;
}

// ----- Click / drag to create ----------------------------------------------

function attachSelection(col, dayStart) {
  let dragging = false;
  let startY = 0;
  let ghost = null;

  const snap = (min) => Math.round(min / SNAP_MIN) * SNAP_MIN;

  col.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return;
    dragging = true;
    const rect = col.getBoundingClientRect();
    startY = ev.clientY - rect.top;
    ghost = document.createElement('div');
    ghost.className = 'event ghost';
    col.appendChild(ghost);
    updateGhost(ev);
    ev.preventDefault();
  });

  function updateGhost(ev) {
    if (!ghost) return;
    const rect = col.getBoundingClientRect();
    const curY = clamp(ev.clientY - rect.top, 0, AXIS_HEIGHT);
    const top = Math.min(startY, curY);
    const bottom = Math.max(startY, curY);
    ghost.style.top = `${top}px`;
    ghost.style.height = `${Math.max(bottom - top, 2)}px`;
    ghost.style.left = '1px';
    ghost.style.width = 'calc(100% - 2px)';
  }

  function onMove(ev) {
    if (dragging) updateGhost(ev);
  }

  function onUp(ev) {
    if (!dragging) return;
    dragging = false;
    const rect = col.getBoundingClientRect();
    const curY = clamp(ev.clientY - rect.top, 0, AXIS_HEIGHT);
    if (ghost) {
      ghost.remove();
      ghost = null;
    }
    let startMin = snap(minutesFromPx(Math.min(startY, curY)));
    let endMin = snap(minutesFromPx(Math.max(startY, curY)));
    // A plain click (no real drag) creates a default 1-hour slot.
    if (Math.abs(curY - startY) < 4) {
      startMin = snap(minutesFromPx(startY));
      endMin = startMin + 60;
    }
    startMin = clamp(startMin, 0, MINUTES_PER_DAY - SNAP_MIN);
    endMin = clamp(endMin, startMin + SNAP_MIN, MINUTES_PER_DAY);

    const startDate = new Date(dayStart);
    startDate.setMinutes(startMin);
    const endDate = new Date(dayStart);
    endDate.setMinutes(endMin);
    openCreateForm(startDate, endDate);
  }

  col.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  // store cleanup not strictly needed since re-render replaces DOM, but
  // window listener would leak; guard by checking col still in document.
  col._onUp = onUp;
}

// ----- Forms (modal) --------------------------------------------------------

function openCreateForm(startDate, endDate) {
  showModal({
    title: 'New event',
    values: { title: '', start: startDate, end: endDate },
    onSubmit: async (vals) => {
      await createEvent({
        title: vals.title,
        start_at: vals.start.toISOString(),
        end_at: vals.end.toISOString()
      });
      await load();
    }
  });
}

function openEditForm(ev) {
  showModal({
    title: 'Edit event',
    values: {
      title: ev.title,
      start: new Date(ev.start_at),
      end: new Date(ev.end_at)
    },
    onSubmit: async (vals) => {
      await updateEvent(ev.id, {
        title: vals.title,
        start_at: vals.start.toISOString(),
        end_at: vals.end.toISOString()
      });
      await load();
    },
    onDelete: async () => {
      await deleteEvent(ev.id);
      await load();
    }
  });
}

function showModal({ title, values, onSubmit, onDelete }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <form class="modal" autocomplete="off">
      <h2>${escapeHtml(title)}</h2>
      <label>Title
        <input type="text" name="title" value="${escapeAttr(values.title)}" required />
      </label>
      <label>Start
        <input type="datetime-local" name="start" value="${toDatetimeLocalValue(values.start)}" required />
      </label>
      <label>End
        <input type="datetime-local" name="end" value="${toDatetimeLocalValue(values.end)}" required />
      </label>
      <p class="form-error" role="alert"></p>
      <div class="modal-actions">
        ${onDelete ? '<button type="button" class="btn danger" data-act="delete">Delete</button>' : '<span></span>'}
        <div>
          <button type="button" class="btn" data-act="cancel">Cancel</button>
          <button type="submit" class="btn primary">Save</button>
        </div>
      </div>
    </form>
  `;
  document.body.appendChild(overlay);

  const form = overlay.querySelector('form');
  const errEl = overlay.querySelector('.form-error');
  const close = () => overlay.remove();

  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close();
  });
  overlay.querySelector('[data-act="cancel"]').addEventListener('click', close);
  form.querySelector('input[name="title"]').focus();

  if (onDelete) {
    overlay.querySelector('[data-act="delete"]').addEventListener('click', async () => {
      try {
        await onDelete();
        close();
      } catch (err) {
        errEl.textContent = err.message;
      }
    });
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.textContent = '';
    const titleVal = form.title.value.trim();
    const startVal = fromDatetimeLocalValue(form.start.value);
    const endVal = fromDatetimeLocalValue(form.end.value);
    if (!titleVal) {
      errEl.textContent = 'Title must not be empty.';
      return;
    }
    if (!(endVal.getTime() > startVal.getTime())) {
      errEl.textContent = 'End must be after start.';
      return;
    }
    try {
      await onSubmit({ title: titleVal, start: startVal, end: endVal });
      close();
    } catch (err) {
      errEl.textContent = err.message;
    }
  });
}

// ----- Data + navigation ----------------------------------------------------

async function load() {
  const weekStart = state.weekStart;
  const weekEnd = addDays(weekStart, 7);
  try {
    state.events = await fetchEvents(weekStart.toISOString(), weekEnd.toISOString());
  } catch (err) {
    console.error('Failed to load events', err);
    state.events = [];
  }
  render();
}

function navigate(days) {
  state.weekStart = addDays(state.weekStart, days);
  load();
}

// ----- helpers --------------------------------------------------------------

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

load();
