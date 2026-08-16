import './styles.css';

const HOUR_HEIGHT = 64;
const DAY_MINUTES = 24 * 60;
const SNAP_MINUTES = 15;
const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3000';

const state = {
  weekStart: startOfWeek(new Date()),
  events: [],
  drag: null
};

const app = document.querySelector('#app');
app.innerHTML = `
  <div class="app-shell">
    <div class="toolbar">
      <h1>Week Calendar</h1>
      <button id="prevBtn" type="button">Previous</button>
      <button id="todayBtn" class="primary" type="button">Today</button>
      <button id="nextBtn" type="button">Next</button>
      <span id="error" class="error"></span>
      <span id="weekLabel" class="week-label"></span>
    </div>
    <div class="calendar-wrap">
      <div id="calendar" class="calendar"></div>
    </div>
  </div>
  <div id="modalBackdrop" class="modal-backdrop hidden" role="dialog" aria-modal="true">
    <form id="eventForm" class="modal">
      <h2 id="modalTitle">Create event</h2>
      <div class="form-row">
        <label for="titleInput">Title</label>
        <input id="titleInput" name="title" required maxlength="200" autocomplete="off" />
      </div>
      <div class="form-row">
        <label for="startInput">Start</label>
        <input id="startInput" name="start" type="datetime-local" required />
      </div>
      <div class="form-row">
        <label for="endInput">End</label>
        <input id="endInput" name="end" type="datetime-local" required />
      </div>
      <div id="modalError" class="error"></div>
      <div class="modal-actions">
        <button id="deleteBtn" class="delete hidden" type="button">Delete</button>
        <button id="cancelBtn" type="button">Cancel</button>
        <button class="primary" type="submit">Save</button>
      </div>
    </form>
  </div>
`;

const calendarEl = document.querySelector('#calendar');
const weekLabelEl = document.querySelector('#weekLabel');
const errorEl = document.querySelector('#error');
const modalBackdrop = document.querySelector('#modalBackdrop');
const eventForm = document.querySelector('#eventForm');
const modalTitle = document.querySelector('#modalTitle');
const titleInput = document.querySelector('#titleInput');
const startInput = document.querySelector('#startInput');
const endInput = document.querySelector('#endInput');
const modalError = document.querySelector('#modalError');
const deleteBtn = document.querySelector('#deleteBtn');
let editingId = null;

function pad(n) { return String(n).padStart(2, '0'); }
function addDays(date, days) { const d = new Date(date); d.setDate(d.getDate() + days); return d; }
function startOfDay(date) { const d = new Date(date); d.setHours(0, 0, 0, 0); return d; }
function startOfWeek(date) {
  const d = startOfDay(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
}
function formatDateShort(date) { return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
function formatTime(date) { return `${pad(date.getHours())}:${pad(date.getMinutes())}`; }
function formatDateTimeLocal(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function localInputToDate(value) { return new Date(value); }
function sameLocalDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
function minutesFromMidnight(date) { return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60 + date.getMilliseconds() / 60000; }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function toPixel(minutes) { return (minutes / 60) * HOUR_HEIGHT; }
function minutesToTimeOnDay(day, minutes) {
  const d = new Date(day);
  d.setMinutes(minutes, 0, 0);
  return d;
}
function snapMinutes(minutes) { return clamp(Math.round(minutes / SNAP_MINUTES) * SNAP_MINUTES, 0, DAY_MINUTES); }
function eventDates(event) { return { start: new Date(event.start_at), end: new Date(event.end_at) }; }

async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try { message = (await response.json()).error || message; } catch {}
    throw new Error(message);
  }
  if (response.status === 204) return null;
  return response.json();
}

async function loadEvents() {
  const start = state.weekStart;
  const end = addDays(start, 7);
  try {
    errorEl.textContent = '';
    state.events = await api(`/api/events?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`);
    render();
  } catch (err) {
    errorEl.textContent = err.message;
  }
}

function render() {
  calendarEl.innerHTML = '';
  weekLabelEl.textContent = `${formatDateShort(state.weekStart)} – ${formatDateShort(addDays(state.weekStart, 6))}`;

  const corner = document.createElement('div');
  corner.className = 'corner';
  calendarEl.appendChild(corner);

  const timeAxis = document.createElement('div');
  timeAxis.className = 'time-axis';
  for (let h = 0; h <= 24; h++) {
    const label = document.createElement('div');
    label.className = `time-label ${h === 0 ? 'midnight' : ''}`;
    label.style.top = `${toPixel(h * 60)}px`;
    label.textContent = h === 24 ? '24:00' : `${pad(h)}:00`;
    timeAxis.appendChild(label);
  }
  calendarEl.appendChild(timeAxis);

  const today = new Date();
  for (let i = 0; i < 7; i++) {
    const day = addDays(state.weekStart, i);
    const isToday = sameLocalDay(day, today);

    const header = document.createElement('div');
    header.className = `day-header ${isToday ? 'today' : ''}`;
    header.style.gridColumn = String(i + 2);
    header.innerHTML = `<div class="day-name">${day.toLocaleDateString(undefined, { weekday: 'short' })}</div><div class="day-date">${day.getDate()}</div>`;
    calendarEl.appendChild(header);

    const col = document.createElement('div');
    col.className = `day-column ${isToday ? 'today' : ''}`;
    col.style.gridColumn = String(i + 2);
    col.dataset.dayIndex = String(i);
    attachSelectionHandlers(col, day);
    calendarEl.appendChild(col);

    const dayEvents = clipsForDay(state.events, day);
    const layouts = layoutDayEvents(dayEvents);
    for (const item of layouts) col.appendChild(renderEvent(item));
  }
}

function clipsForDay(events, day) {
  const dayStart = startOfDay(day);
  const dayEnd = addDays(dayStart, 1);
  return events.map(ev => {
    const { start, end } = eventDates(ev);
    const clipStart = new Date(Math.max(start.getTime(), dayStart.getTime()));
    const clipEnd = new Date(Math.min(end.getTime(), dayEnd.getTime()));
    if (clipEnd.getTime() <= dayStart.getTime() || clipStart.getTime() >= dayEnd.getTime() || clipEnd <= clipStart) return null;
    return {
      ...ev,
      _actualStart: start,
      _actualEnd: end,
      _clipStart: clipStart,
      _clipEnd: clipEnd,
      _startMin: clamp(minutesFromMidnight(clipStart), 0, DAY_MINUTES),
      _endMin: clipEnd.getTime() === dayEnd.getTime() ? DAY_MINUTES : clamp(minutesFromMidnight(clipEnd), 0, DAY_MINUTES)
    };
  }).filter(Boolean);
}

function overlaps(a, b) { return a._startMin < b._endMin && b._startMin < a._endMin; }

function buildClusters(events) {
  const sorted = [...events].sort((a, b) => a._startMin - b._startMin || a._endMin - b._endMin || a.id - b.id);
  const clusters = [];
  let current = [];
  let currentEnd = -1;
  for (const ev of sorted) {
    if (current.length === 0 || ev._startMin < currentEnd) {
      current.push(ev);
      currentEnd = Math.max(currentEnd, ev._endMin);
    } else {
      clusters.push(current);
      current = [ev];
      currentEnd = ev._endMin;
    }
  }
  if (current.length) clusters.push(current);
  return clusters;
}

function layoutDayEvents(events) {
  const output = [];
  for (const cluster of buildClusters(events)) {
    const columns = [];
    const sorted = [...cluster].sort((a, b) => a._startMin - b._startMin || a._endMin - b._endMin || a.id - b.id);
    for (const ev of sorted) {
      let colIndex = columns.findIndex(endMin => endMin <= ev._startMin);
      if (colIndex === -1) {
        colIndex = columns.length;
        columns.push(ev._endMin);
      } else {
        columns[colIndex] = ev._endMin;
      }
      ev._column = colIndex;
    }
    const count = Math.max(columns.length, 1);
    for (const ev of sorted) {
      output.push({
        event: ev,
        top: toPixel(ev._startMin),
        height: Math.max(1, toPixel(ev._endMin - ev._startMin)),
        leftPct: (ev._column / count) * 100,
        widthPct: 100 / count
      });
    }
  }
  return output;
}

function renderEvent(item) {
  const ev = item.event;
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'event';
  el.style.top = `${item.top}px`;
  el.style.height = `${item.height}px`;
  el.style.left = `calc(${item.leftPct}% + 2px)`;
  el.style.width = `calc(${item.widthPct}% - 4px)`;
  el.title = `${ev.title} ${formatTime(ev._actualStart)}–${formatTime(ev._actualEnd)}`;
  el.innerHTML = `<div class="event-title"></div><div class="event-time"></div>`;
  el.querySelector('.event-title').textContent = ev.title;
  el.querySelector('.event-time').textContent = `${formatTime(ev._actualStart)}–${formatTime(ev._actualEnd)}`;
  el.addEventListener('click', e => {
    e.stopPropagation();
    const original = state.events.find(x => x.id === ev.id) || ev;
    openModal(original);
  });
  return el;
}

function attachSelectionHandlers(col, day) {
  col.addEventListener('mousedown', e => {
    if (e.button !== 0 || e.target !== col) return;
    const rect = col.getBoundingClientRect();
    const y = clamp(e.clientY - rect.top, 0, rect.height);
    const start = snapMinutes((y / rect.height) * DAY_MINUTES);
    const selection = document.createElement('div');
    selection.className = 'selection';
    col.appendChild(selection);
    state.drag = { col, day, start, end: start, selection, moved: false };
    updateSelection(selection, start, start + SNAP_MINUTES);
    e.preventDefault();
  });
}

document.addEventListener('mousemove', e => {
  if (!state.drag) return;
  const rect = state.drag.col.getBoundingClientRect();
  const y = clamp(e.clientY - rect.top, 0, rect.height);
  const end = snapMinutes((y / rect.height) * DAY_MINUTES);
  state.drag.end = end;
  state.drag.moved = state.drag.moved || Math.abs(end - state.drag.start) >= SNAP_MINUTES;
  const a = Math.min(state.drag.start, end);
  const b = Math.max(state.drag.start, end);
  updateSelection(state.drag.selection, a, b === a ? a + SNAP_MINUTES : b);
});

document.addEventListener('mouseup', () => {
  if (!state.drag) return;
  const { day, selection } = state.drag;
  let a = Math.min(state.drag.start, state.drag.end);
  let b = Math.max(state.drag.start, state.drag.end);
  if (a === b) b = Math.min(DAY_MINUTES, a + 60);
  if (b - a < SNAP_MINUTES) b = Math.min(DAY_MINUTES, a + SNAP_MINUTES);
  if (b <= a) a = Math.max(0, b - SNAP_MINUTES);
  selection.remove();
  state.drag = null;
  openModal({ title: '', start_at: minutesToTimeOnDay(day, a).toISOString(), end_at: minutesToTimeOnDay(day, b).toISOString() });
});

function updateSelection(el, startMin, endMin) {
  const a = clamp(startMin, 0, DAY_MINUTES);
  const b = clamp(endMin, 0, DAY_MINUTES);
  el.style.top = `${toPixel(a)}px`;
  el.style.height = `${Math.max(1, toPixel(b - a))}px`;
}

function openModal(event = null) {
  editingId = event?.id ?? null;
  modalTitle.textContent = editingId ? 'Edit event' : 'Create event';
  titleInput.value = event?.title || '';
  const fallbackStart = new Date();
  const fallbackEnd = new Date(fallbackStart.getTime() + 60 * 60 * 1000);
  startInput.value = formatDateTimeLocal(new Date(event?.start_at || fallbackStart));
  endInput.value = formatDateTimeLocal(new Date(event?.end_at || fallbackEnd));
  modalError.textContent = '';
  deleteBtn.classList.toggle('hidden', !editingId);
  modalBackdrop.classList.remove('hidden');
  titleInput.focus();
}

function closeModal() {
  modalBackdrop.classList.add('hidden');
  editingId = null;
}

eventForm.addEventListener('submit', async e => {
  e.preventDefault();
  modalError.textContent = '';
  const title = titleInput.value.trim();
  const start = localInputToDate(startInput.value);
  const end = localInputToDate(endInput.value);
  if (!title) return modalError.textContent = 'Title is required.';
  if (!(end > start)) return modalError.textContent = 'End must be after start.';
  try {
    const body = JSON.stringify({ title, start_at: start.toISOString(), end_at: end.toISOString() });
    if (editingId) await api(`/api/events/${editingId}`, { method: 'PUT', body });
    else await api('/api/events', { method: 'POST', body });
    closeModal();
    await loadEvents();
  } catch (err) {
    modalError.textContent = err.message;
  }
});

deleteBtn.addEventListener('click', async () => {
  if (!editingId || !confirm('Delete this event?')) return;
  try {
    await api(`/api/events/${editingId}`, { method: 'DELETE' });
    closeModal();
    await loadEvents();
  } catch (err) {
    modalError.textContent = err.message;
  }
});

document.querySelector('#cancelBtn').addEventListener('click', closeModal);
modalBackdrop.addEventListener('mousedown', e => { if (e.target === modalBackdrop) closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !modalBackdrop.classList.contains('hidden')) closeModal(); });

document.querySelector('#prevBtn').addEventListener('click', () => { state.weekStart = addDays(state.weekStart, -7); loadEvents(); });
document.querySelector('#todayBtn').addEventListener('click', () => { state.weekStart = startOfWeek(new Date()); loadEvents(); });
document.querySelector('#nextBtn').addEventListener('click', () => { state.weekStart = addDays(state.weekStart, 7); loadEvents(); });

loadEvents();
