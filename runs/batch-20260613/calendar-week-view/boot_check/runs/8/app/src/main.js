import './styles.css';

const MINUTES_PER_DAY = 24 * 60;
const HOUR_HEIGHT = 56;
const DAY_HEIGHT = HOUR_HEIGHT * 24;
const SNAP_MINUTES = 15;
const API_BASE = import.meta.env.VITE_API_BASE || '';
const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const state = {
  weekStart: startOfWeek(new Date()),
  events: [],
  drag: null,
  formEvent: null
};

const app = document.getElementById('app');
app.innerHTML = `
  <div class="calendar-app">
    <header class="toolbar">
      <div class="toolbar-left">
        <button id="prevWeek" type="button">‹ Previous</button>
        <button id="today" type="button">Today</button>
        <button id="nextWeek" type="button">Next ›</button>
      </div>
      <h1 id="weekTitle">Week</h1>
      <div class="toolbar-right"><span id="status" aria-live="polite"></span></div>
    </header>
    <main class="calendar-shell">
      <div class="corner"></div>
      <div id="dayHeaders" class="day-headers"></div>
      <div class="time-axis" id="timeAxis"></div>
      <div id="weekGrid" class="week-grid"></div>
    </main>
  </div>
  <div id="modal" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
    <form id="eventForm" class="event-form">
      <h2 id="modalTitle">Event</h2>
      <label>Title <input id="eventTitle" name="title" required /></label>
      <div class="form-row">
        <label>Start <input id="eventStart" name="start" type="datetime-local" required /></label>
        <label>End <input id="eventEnd" name="end" type="datetime-local" required /></label>
      </div>
      <p id="formError" class="form-error"></p>
      <div class="form-actions">
        <button id="deleteEvent" type="button" class="danger">Delete</button>
        <span class="spacer"></span>
        <button id="cancelForm" type="button">Cancel</button>
        <button type="submit" class="primary">Save</button>
      </div>
    </form>
  </div>
`;

const els = {
  weekTitle: document.getElementById('weekTitle'),
  dayHeaders: document.getElementById('dayHeaders'),
  timeAxis: document.getElementById('timeAxis'),
  weekGrid: document.getElementById('weekGrid'),
  status: document.getElementById('status'),
  modal: document.getElementById('modal'),
  form: document.getElementById('eventForm'),
  modalTitle: document.getElementById('modalTitle'),
  eventTitle: document.getElementById('eventTitle'),
  eventStart: document.getElementById('eventStart'),
  eventEnd: document.getElementById('eventEnd'),
  formError: document.getElementById('formError'),
  deleteEvent: document.getElementById('deleteEvent')
};

init();

function init() {
  renderStaticAxis();
  document.getElementById('prevWeek').addEventListener('click', () => moveWeek(-1));
  document.getElementById('today').addEventListener('click', () => { state.weekStart = startOfWeek(new Date()); loadWeek(); });
  document.getElementById('nextWeek').addEventListener('click', () => moveWeek(1));
  document.getElementById('cancelForm').addEventListener('click', closeForm);
  els.modal.addEventListener('mousedown', (e) => { if (e.target === els.modal) closeForm(); });
  els.form.addEventListener('submit', submitForm);
  els.deleteEvent.addEventListener('click', deleteCurrentEvent);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeForm(); });
  loadWeek();
}

function renderStaticAxis() {
  els.timeAxis.style.height = `${DAY_HEIGHT}px`;
  els.timeAxis.innerHTML = '';
  for (let h = 0; h <= 24; h++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = `${h * HOUR_HEIGHT}px`;
    label.textContent = `${String(h).padStart(2, '0')}:00`;
    els.timeAxis.appendChild(label);
  }
}

function moveWeek(delta) {
  state.weekStart = addDays(state.weekStart, delta * 7);
  loadWeek();
}

async function loadWeek() {
  setStatus('Loading…');
  try {
    const start = state.weekStart;
    const end = addDays(start, 7);
    const res = await fetch(`${API_BASE}/api/events?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`);
    if (!res.ok) throw new Error(await errorMessage(res));
    state.events = await res.json();
    renderWeek();
    setStatus('');
  } catch (err) {
    setStatus(err.message || String(err), true);
  }
}

function renderWeek() {
  const weekEnd = addDays(state.weekStart, 6);
  els.weekTitle.textContent = `${formatDateLong(state.weekStart)} – ${formatDateLong(weekEnd)}`;
  renderHeaders();
  renderGrid();
}

function renderHeaders() {
  els.dayHeaders.innerHTML = '';
  const todayKey = localDateKey(new Date());
  for (let i = 0; i < 7; i++) {
    const date = addDays(state.weekStart, i);
    const header = document.createElement('div');
    header.className = 'day-header';
    if (localDateKey(date) === todayKey) header.classList.add('today');
    header.innerHTML = `<span class="day-name">${dayNames[i]}</span><span class="day-date">${formatMonthDay(date)}</span>`;
    els.dayHeaders.appendChild(header);
  }
}

function renderGrid() {
  els.weekGrid.innerHTML = '';
  els.weekGrid.style.height = `${DAY_HEIGHT}px`;
  const todayKey = localDateKey(new Date());
  for (let i = 0; i < 7; i++) {
    const date = addDays(state.weekStart, i);
    const column = document.createElement('section');
    column.className = 'day-column';
    column.dataset.dayIndex = String(i);
    column.style.height = `${DAY_HEIGHT}px`;
    if (localDateKey(date) === todayKey) column.classList.add('today');
    renderHourLines(column);
    column.addEventListener('mousedown', onColumnMouseDown);
    els.weekGrid.appendChild(column);
  }

  const eventsByDay = Array.from({ length: 7 }, () => []);
  for (const event of state.events) {
    for (let day = 0; day < 7; day++) {
      const dayStart = addDays(state.weekStart, day);
      const dayEnd = addDays(dayStart, 1);
      const start = new Date(event.start_at);
      const end = new Date(event.end_at);
      if (start < dayEnd && end > dayStart) eventsByDay[day].push({ ...event, renderDay: day });
    }
  }

  eventsByDay.forEach((dayEvents, dayIndex) => {
    const positioned = layoutDayEvents(dayEvents, addDays(state.weekStart, dayIndex));
    const column = els.weekGrid.children[dayIndex];
    for (const item of positioned) column.appendChild(createEventBlock(item));
  });
}

function renderHourLines(column) {
  for (let h = 0; h <= 24; h++) {
    const line = document.createElement('div');
    line.className = 'hour-line';
    line.style.top = `${h * HOUR_HEIGHT}px`;
    column.appendChild(line);
  }
}

function layoutDayEvents(events, dayStart) {
  const dayEnd = addDays(dayStart, 1);
  const normalized = events.map((event) => {
    const actualStart = new Date(event.start_at);
    const actualEnd = new Date(event.end_at);
    const start = maxDate(actualStart, dayStart);
    const end = minDate(actualEnd, dayEnd);
    return {
      event,
      actualStart,
      actualEnd,
      start,
      end,
      startMin: minutesSince(dayStart, start),
      endMin: minutesSince(dayStart, end)
    };
  }).filter((e) => e.endMin > e.startMin)
    .sort((a, b) => a.start - b.start || a.end - b.end || a.event.id - b.event.id);

  const clusters = [];
  let current = null;
  for (const ev of normalized) {
    if (!current || ev.start >= current.end) {
      current = { events: [ev], end: ev.end };
      clusters.push(current);
    } else {
      current.events.push(ev);
      if (ev.end > current.end) current.end = ev.end;
    }
  }

  const laidOut = [];
  for (const cluster of clusters) {
    const columns = [];
    for (const ev of cluster.events) {
      let col = columns.findIndex((endTime) => endTime <= ev.start);
      if (col === -1) {
        col = columns.length;
        columns.push(ev.end);
      } else {
        columns[col] = ev.end;
      }
      ev.column = col;
      ev.columnCount = columns.length;
    }
    const totalColumns = columns.length || 1;
    for (const ev of cluster.events) {
      ev.columnCount = totalColumns;
      laidOut.push({
        ...ev,
        top: ev.startMin / MINUTES_PER_DAY * DAY_HEIGHT,
        height: (ev.endMin - ev.startMin) / MINUTES_PER_DAY * DAY_HEIGHT,
        leftPct: ev.column / totalColumns * 100,
        widthPct: 100 / totalColumns
      });
    }
  }
  return laidOut;
}

function createEventBlock(item) {
  const { event } = item;
  const block = document.createElement('button');
  block.type = 'button';
  block.className = 'event-block';
  block.style.top = `${item.top}px`;
  block.style.height = `${item.height}px`;
  block.style.left = `calc(${item.leftPct}% + 2px)`;
  block.style.width = `calc(${item.widthPct}% - 4px)`;
  block.title = `${event.title} (${formatTime(item.actualStart)}–${formatTime(item.actualEnd)})`;
  block.innerHTML = `<strong>${escapeHtml(event.title)}</strong><span>${formatTime(item.actualStart)}–${formatTime(item.actualEnd)}</span>`;
  block.addEventListener('mousedown', (e) => e.stopPropagation());
  block.addEventListener('click', (e) => { e.stopPropagation(); openEditForm(event); });
  return block;
}

function onColumnMouseDown(e) {
  if (e.button !== 0 || e.target.closest('.event-block')) return;
  const column = e.currentTarget;
  const dayIndex = Number(column.dataset.dayIndex);
  const startMin = clamp(roundToSnap(yToMinutes(e, column)), 0, MINUTES_PER_DAY - SNAP_MINUTES);
  const preview = document.createElement('div');
  preview.className = 'selection-preview';
  column.appendChild(preview);
  state.drag = { column, dayIndex, startMin, endMin: Math.min(startMin + 60, MINUTES_PER_DAY), preview };
  updateSelectionPreview();
  window.addEventListener('mousemove', onDragMove);
  window.addEventListener('mouseup', onDragEnd, { once: true });
}

function onDragMove(e) {
  if (!state.drag) return;
  const raw = clamp(roundToSnap(yToMinutes(e, state.drag.column)), 0, MINUTES_PER_DAY);
  if (raw === state.drag.startMin) {
    state.drag.endMin = Math.min(raw + SNAP_MINUTES, MINUTES_PER_DAY);
  } else {
    state.drag.endMin = raw;
  }
  updateSelectionPreview();
}

function onDragEnd() {
  window.removeEventListener('mousemove', onDragMove);
  if (!state.drag) return;
  const { dayIndex, preview } = state.drag;
  let startMin = Math.min(state.drag.startMin, state.drag.endMin);
  let endMin = Math.max(state.drag.startMin, state.drag.endMin);
  if (endMin <= startMin) endMin = Math.min(startMin + SNAP_MINUTES, MINUTES_PER_DAY);
  preview.remove();
  state.drag = null;
  const dayStart = addDays(state.weekStart, dayIndex);
  openCreateForm(addMinutes(dayStart, startMin), addMinutes(dayStart, endMin));
}

function updateSelectionPreview() {
  const { startMin, endMin, preview } = state.drag;
  const a = Math.min(startMin, endMin);
  const b = Math.max(startMin, endMin);
  preview.style.top = `${a / MINUTES_PER_DAY * DAY_HEIGHT}px`;
  preview.style.height = `${Math.max(SNAP_MINUTES, b - a) / MINUTES_PER_DAY * DAY_HEIGHT}px`;
}

function yToMinutes(e, column) {
  const rect = column.getBoundingClientRect();
  return (e.clientY - rect.top) / rect.height * MINUTES_PER_DAY;
}

function openCreateForm(start, end) {
  state.formEvent = null;
  els.modalTitle.textContent = 'Create event';
  els.eventTitle.value = '';
  els.eventStart.value = toDateTimeLocal(start);
  els.eventEnd.value = toDateTimeLocal(end);
  els.deleteEvent.hidden = true;
  els.formError.textContent = '';
  els.modal.classList.remove('hidden');
  els.eventTitle.focus();
}

function openEditForm(event) {
  state.formEvent = event;
  els.modalTitle.textContent = 'Edit event';
  els.eventTitle.value = event.title;
  els.eventStart.value = toDateTimeLocal(new Date(event.start_at));
  els.eventEnd.value = toDateTimeLocal(new Date(event.end_at));
  els.deleteEvent.hidden = false;
  els.formError.textContent = '';
  els.modal.classList.remove('hidden');
  els.eventTitle.focus();
}

function closeForm() {
  els.modal.classList.add('hidden');
  state.formEvent = null;
}

async function submitForm(e) {
  e.preventDefault();
  els.formError.textContent = '';
  const title = els.eventTitle.value.trim();
  const start = new Date(els.eventStart.value);
  const end = new Date(els.eventEnd.value);
  if (!title) return els.formError.textContent = 'Title is required.';
  if (!(end > start)) return els.formError.textContent = 'End must be after start.';
  const payload = { title, start_at: start.toISOString(), end_at: end.toISOString() };
  const editing = state.formEvent;
  try {
    const res = await fetch(`${API_BASE}/api/events${editing ? `/${editing.id}` : ''}`, {
      method: editing ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error(await errorMessage(res));
    closeForm();
    await loadWeek();
  } catch (err) {
    els.formError.textContent = err.message || String(err);
  }
}

async function deleteCurrentEvent() {
  if (!state.formEvent) return;
  if (!confirm('Delete this event?')) return;
  try {
    const res = await fetch(`${API_BASE}/api/events/${state.formEvent.id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(await errorMessage(res));
    closeForm();
    await loadWeek();
  } catch (err) {
    els.formError.textContent = err.message || String(err);
  }
}

function setStatus(message, isError = false) {
  els.status.textContent = message;
  els.status.className = isError ? 'error' : '';
}

async function errorMessage(res) {
  try {
    const body = await res.json();
    return body.error || res.statusText;
  } catch {
    return res.statusText;
  }
}

function startOfWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  const diff = (day + 6) % 7;
  d.setDate(d.getDate() - diff);
  return d;
}
function addDays(date, days) { const d = new Date(date); d.setDate(d.getDate() + days); return d; }
function addMinutes(date, minutes) { const d = new Date(date); d.setMinutes(d.getMinutes() + minutes); return d; }
function minutesSince(base, date) { return Math.round((date - base) / 60000); }
function maxDate(a, b) { return a > b ? a : b; }
function minDate(a, b) { return a < b ? a : b; }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function roundToSnap(minutes) { return Math.round(minutes / SNAP_MINUTES) * SNAP_MINUTES; }
function formatTime(date) { return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
function formatMonthDay(date) { return date.toLocaleDateString([], { month: 'short', day: 'numeric' }); }
function formatDateLong(date) { return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }); }
function localDateKey(date) { return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`; }
function toDateTimeLocal(date) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function escapeHtml(str) {
  return str.replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}
