import './styles.css';

const HOUR_HEIGHT = 64;
const DAY_MINUTES = 24 * 60;
const SNAP_MINUTES = 15;
const API_BASE = '';

const state = {
  weekStart: startOfWeek(new Date()),
  events: [],
  selection: null,
};

const app = document.querySelector('#app');
app.innerHTML = `
  <div class="calendar-app">
    <header class="toolbar">
      <div class="nav">
        <button id="prevWeek" type="button">← Previous</button>
        <button id="today" type="button">Today</button>
        <button id="nextWeek" type="button">Next →</button>
      </div>
      <div>
        <h1>Week Calendar</h1>
        <div id="weekLabel" class="week-label"></div>
      </div>
      <div class="hint">Drag empty space to create • Click events to edit</div>
    </header>
    <main class="calendar-shell">
      <div class="corner"></div>
      <div id="dayHeaders" class="day-headers"></div>
      <div class="time-axis" id="timeAxis"></div>
      <div id="weekGrid" class="week-grid"></div>
    </main>
  </div>

  <dialog id="eventDialog" class="event-dialog">
    <form id="eventForm" method="dialog">
      <h2 id="dialogTitle">Event</h2>
      <input id="eventId" type="hidden" />
      <label>
        Title
        <input id="eventTitle" type="text" maxlength="120" required />
      </label>
      <div class="form-row">
        <label>
          Start
          <input id="eventStart" type="datetime-local" required />
        </label>
        <label>
          End
          <input id="eventEnd" type="datetime-local" required />
        </label>
      </div>
      <p id="formError" class="form-error" role="alert"></p>
      <div class="dialog-actions">
        <button id="deleteEvent" class="danger" type="button">Delete</button>
        <span class="spacer"></span>
        <button id="cancelDialog" type="button">Cancel</button>
        <button id="saveEvent" type="submit">Save</button>
      </div>
    </form>
  </dialog>
`;

const els = {
  weekLabel: document.querySelector('#weekLabel'),
  dayHeaders: document.querySelector('#dayHeaders'),
  weekGrid: document.querySelector('#weekGrid'),
  timeAxis: document.querySelector('#timeAxis'),
  dialog: document.querySelector('#eventDialog'),
  form: document.querySelector('#eventForm'),
  dialogTitle: document.querySelector('#dialogTitle'),
  eventId: document.querySelector('#eventId'),
  eventTitle: document.querySelector('#eventTitle'),
  eventStart: document.querySelector('#eventStart'),
  eventEnd: document.querySelector('#eventEnd'),
  formError: document.querySelector('#formError'),
  deleteEvent: document.querySelector('#deleteEvent'),
};

document.querySelector('#prevWeek').addEventListener('click', () => moveWeek(-1));
document.querySelector('#today').addEventListener('click', () => {
  state.weekStart = startOfWeek(new Date());
  loadAndRender();
});
document.querySelector('#nextWeek').addEventListener('click', () => moveWeek(1));
document.querySelector('#cancelDialog').addEventListener('click', () => els.dialog.close());
els.form.addEventListener('submit', onSubmitEvent);
els.deleteEvent.addEventListener('click', onDeleteEvent);

renderTimeAxis();
loadAndRender();

function moveWeek(delta) {
  state.weekStart = addDays(state.weekStart, delta * 7);
  loadAndRender();
}

async function loadAndRender() {
  const start = state.weekStart;
  const end = addDays(start, 7);
  const res = await fetch(`${API_BASE}/api/events?start=${encodeURIComponent(toLocalIso(start))}&end=${encodeURIComponent(toLocalIso(end))}`);
  if (!res.ok) throw new Error('Failed to load events');
  state.events = await res.json();
  render();
}

function render() {
  const days = Array.from({ length: 7 }, (_, i) => addDays(state.weekStart, i));
  els.weekLabel.textContent = `${formatDate(days[0])} – ${formatDate(days[6])}`;
  renderHeaders(days);
  renderGrid(days);
}

function renderHeaders(days) {
  const todayKey = dateKey(new Date());
  els.dayHeaders.innerHTML = days.map((day) => {
    const isToday = dateKey(day) === todayKey;
    return `<div class="day-header ${isToday ? 'today' : ''}">
      <span class="weekday">${day.toLocaleDateString(undefined, { weekday: 'short' })}</span>
      <span class="date">${day.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
    </div>`;
  }).join('');
}

function renderTimeAxis() {
  let html = '';
  for (let h = 0; h <= 24; h++) {
    html += `<div class="time-label" style="top:${h * HOUR_HEIGHT}px">${String(h).padStart(2, '0')}:00</div>`;
  }
  els.timeAxis.innerHTML = html;
}

function renderGrid(days) {
  els.weekGrid.innerHTML = '';
  const todayKey = dateKey(new Date());
  days.forEach((day, dayIndex) => {
    const col = document.createElement('section');
    col.className = `day-column ${dateKey(day) === todayKey ? 'today' : ''}`;
    col.dataset.dayIndex = String(dayIndex);
    col.style.height = `${24 * HOUR_HEIGHT}px`;

    for (let h = 0; h < 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${h * HOUR_HEIGHT}px`;
      col.appendChild(line);
    }

    const segments = segmentsForDay(day).sort(compareSegments);
    const laidOut = layoutDayEvents(segments);
    for (const item of laidOut) col.appendChild(createEventElement(item));

    attachSelectionHandlers(col, day);
    els.weekGrid.appendChild(col);
  });
}

function segmentsForDay(day) {
  const dayStart = startOfDay(day);
  const dayEnd = addDays(dayStart, 1);
  return state.events.flatMap((event) => {
    const start = parseLocal(event.start_at);
    const end = parseLocal(event.end_at);
    if (start >= dayEnd || end <= dayStart) return [];
    const clippedStart = new Date(Math.max(start.getTime(), dayStart.getTime()));
    const clippedEnd = new Date(Math.min(end.getTime(), dayEnd.getTime()));
    const startMin = minutesSinceStartOfDay(clippedStart);
    const endMin = clippedEnd.getTime() === dayEnd.getTime() ? DAY_MINUTES : minutesSinceStartOfDay(clippedEnd);
    if (endMin <= startMin) return [];
    return [{ event, start, end, clippedStart, clippedEnd, startMin, endMin }];
  });
}

function layoutDayEvents(segments) {
  const clusters = [];
  let current = null;
  for (const seg of segments) {
    if (!current || seg.startMin >= current.endMin) {
      current = { segments: [], endMin: seg.endMin };
      clusters.push(current);
    }
    current.segments.push(seg);
    current.endMin = Math.max(current.endMin, seg.endMin);
  }

  const output = [];
  for (const cluster of clusters) {
    const columnsEnd = [];
    const assigned = [];
    for (const seg of cluster.segments) {
      let col = columnsEnd.findIndex((end) => end <= seg.startMin);
      if (col === -1) {
        col = columnsEnd.length;
        columnsEnd.push(seg.endMin);
      } else {
        columnsEnd[col] = seg.endMin;
      }
      assigned.push({ ...seg, col });
    }
    const cols = columnsEnd.length || 1;
    for (const item of assigned) output.push({ ...item, cols });
  }
  return output;
}

function createEventElement(item) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'event-block';
  el.style.top = `${(item.startMin / 60) * HOUR_HEIGHT}px`;
  el.style.height = `${((item.endMin - item.startMin) / 60) * HOUR_HEIGHT}px`;
  el.style.left = `${(item.col / item.cols) * 100}%`;
  el.style.width = `${(1 / item.cols) * 100}%`;
  el.innerHTML = `<strong>${escapeHtml(item.event.title)}</strong><span>${formatTime(parseLocal(item.event.start_at))} – ${formatTime(parseLocal(item.event.end_at))}</span>`;
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    openEditDialog(item.event);
  });
  return el;
}

function attachSelectionHandlers(col, day) {
  let drag = null;
  col.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target !== col) return;
    const startMin = pointToMinute(e, col);
    drag = { startMin, endMin: startMin, selectionEl: document.createElement('div') };
    drag.selectionEl.className = 'selection-range';
    col.appendChild(drag.selectionEl);
    updateSelectionEl(drag);
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    drag.endMin = pointToMinute(e, col);
    updateSelectionEl(drag);
  });
  window.addEventListener('mouseup', () => {
    if (!drag) return;
    const a = Math.min(drag.startMin, drag.endMin);
    let b = Math.max(drag.startMin, drag.endMin);
    if (b === a) b = Math.min(DAY_MINUTES, a + 60);
    if (b - a < SNAP_MINUTES) b = Math.min(DAY_MINUTES, a + SNAP_MINUTES);
    drag.selectionEl.remove();
    drag = null;
    openCreateDialog(day, a, b);
  });
}

function updateSelectionEl(drag) {
  const a = Math.min(drag.startMin, drag.endMin);
  const b = Math.max(drag.startMin, drag.endMin);
  drag.selectionEl.style.top = `${(a / 60) * HOUR_HEIGHT}px`;
  drag.selectionEl.style.height = `${Math.max(4, ((b - a) / 60) * HOUR_HEIGHT)}px`;
}

function pointToMinute(e, col) {
  const rect = col.getBoundingClientRect();
  const y = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
  const raw = (y / rect.height) * DAY_MINUTES;
  return Math.max(0, Math.min(DAY_MINUTES, Math.round(raw / SNAP_MINUTES) * SNAP_MINUTES));
}

function openCreateDialog(day, startMin, endMin) {
  const start = addMinutes(startOfDay(day), startMin);
  const end = addMinutes(startOfDay(day), endMin);
  els.dialogTitle.textContent = 'Create event';
  els.eventId.value = '';
  els.eventTitle.value = '';
  els.eventStart.value = toDateTimeLocal(start);
  els.eventEnd.value = toDateTimeLocal(end);
  els.deleteEvent.hidden = true;
  els.formError.textContent = '';
  els.dialog.showModal();
  els.eventTitle.focus();
}

function openEditDialog(event) {
  els.dialogTitle.textContent = 'Edit event';
  els.eventId.value = event.id;
  els.eventTitle.value = event.title;
  els.eventStart.value = toDateTimeLocal(parseLocal(event.start_at));
  els.eventEnd.value = toDateTimeLocal(parseLocal(event.end_at));
  els.deleteEvent.hidden = false;
  els.formError.textContent = '';
  els.dialog.showModal();
  els.eventTitle.focus();
}

async function onSubmitEvent(e) {
  e.preventDefault();
  const id = els.eventId.value;
  const payload = {
    title: els.eventTitle.value.trim(),
    start_at: localInputToIso(els.eventStart.value),
    end_at: localInputToIso(els.eventEnd.value),
  };
  if (!payload.title) return showFormError('Title is required.');
  if (!payload.start_at || !payload.end_at || parseLocal(payload.end_at) <= parseLocal(payload.start_at)) {
    return showFormError('End must be after start.');
  }
  const res = await fetch(id ? `${API_BASE}/api/events/${id}` : `${API_BASE}/api/events`, {
    method: id ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return showFormError(err.error || 'Unable to save event.');
  }
  els.dialog.close();
  await loadAndRender();
}

async function onDeleteEvent() {
  const id = els.eventId.value;
  if (!id) return;
  if (!confirm('Delete this event?')) return;
  const res = await fetch(`${API_BASE}/api/events/${id}`, { method: 'DELETE' });
  if (!res.ok) return showFormError('Unable to delete event.');
  els.dialog.close();
  await loadAndRender();
}

function showFormError(message) {
  els.formError.textContent = message;
}

function startOfWeek(date) {
  const d = startOfDay(date);
  const day = d.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  return addDays(d, mondayOffset);
}
function startOfDay(date) { const d = new Date(date); d.setHours(0, 0, 0, 0); return d; }
function addDays(date, days) { const d = new Date(date); d.setDate(d.getDate() + days); return d; }
function addMinutes(date, minutes) { return new Date(date.getTime() + minutes * 60000); }
function minutesSinceStartOfDay(date) { return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60 + date.getMilliseconds() / 60000; }
function compareSegments(a, b) { return a.startMin - b.startMin || a.endMin - b.endMin || a.event.id - b.event.id; }
function dateKey(date) { return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`; }
function parseLocal(value) { return value instanceof Date ? value : new Date(value); }
function pad(n) { return String(n).padStart(2, '0'); }
function toLocalIso(date) { return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`; }
function toDateTimeLocal(date) { return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`; }
function localInputToIso(value) { return value ? `${value}:00` : ''; }
function formatDate(date) { return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
function formatTime(date) { return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); }
function escapeHtml(s) { return s.replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c])); }
