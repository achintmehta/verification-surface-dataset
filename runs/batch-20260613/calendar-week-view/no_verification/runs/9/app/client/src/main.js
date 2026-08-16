import './styles.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const MINUTES_PER_DAY = 24 * 60;
const MINUTE_HEIGHT = 1; // px; keep in sync with CSS --minute-height
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const state = {
  weekStart: startOfWeek(new Date()),
  events: [],
  selection: null,
  editingEvent: null,
  drag: null
};

const app = document.querySelector('#app');
app.innerHTML = `
  <header class="toolbar">
    <div class="brand">
      <h1>Week Calendar</h1>
      <p>Minute-accurate weekly scheduling</p>
    </div>
    <div class="nav">
      <button id="prevWeek" type="button">← Previous</button>
      <button id="today" type="button">Today</button>
      <button id="nextWeek" type="button">Next →</button>
    </div>
    <div id="weekLabel" class="week-label"></div>
  </header>
  <main class="calendar-shell">
    <div class="calendar">
      <div class="corner"></div>
      <div id="dayHeaders" class="day-headers"></div>
      <div id="timeAxis" class="time-axis"></div>
      <div id="weekGrid" class="week-grid"></div>
    </div>
  </main>
  <dialog id="eventDialog" class="event-dialog">
    <form id="eventForm" method="dialog">
      <h2 id="dialogTitle">Create event</h2>
      <label>
        Title
        <input id="eventTitle" name="title" required maxlength="160" autocomplete="off" />
      </label>
      <label>
        Start
        <input id="eventStart" name="start" type="datetime-local" required />
      </label>
      <label>
        End
        <input id="eventEnd" name="end" type="datetime-local" required />
      </label>
      <p id="formError" class="form-error" aria-live="polite"></p>
      <div class="dialog-actions">
        <button id="deleteEvent" class="danger" type="button">Delete</button>
        <span class="spacer"></span>
        <button id="cancelDialog" type="button">Cancel</button>
        <button class="primary" type="submit">Save</button>
      </div>
    </form>
  </dialog>
`;

const els = {
  prevWeek: document.querySelector('#prevWeek'),
  today: document.querySelector('#today'),
  nextWeek: document.querySelector('#nextWeek'),
  weekLabel: document.querySelector('#weekLabel'),
  dayHeaders: document.querySelector('#dayHeaders'),
  timeAxis: document.querySelector('#timeAxis'),
  weekGrid: document.querySelector('#weekGrid'),
  dialog: document.querySelector('#eventDialog'),
  form: document.querySelector('#eventForm'),
  dialogTitle: document.querySelector('#dialogTitle'),
  eventTitle: document.querySelector('#eventTitle'),
  eventStart: document.querySelector('#eventStart'),
  eventEnd: document.querySelector('#eventEnd'),
  formError: document.querySelector('#formError'),
  deleteEvent: document.querySelector('#deleteEvent'),
  cancelDialog: document.querySelector('#cancelDialog')
};

els.prevWeek.addEventListener('click', () => changeWeek(-1));
els.nextWeek.addEventListener('click', () => changeWeek(1));
els.today.addEventListener('click', () => {
  state.weekStart = startOfWeek(new Date());
  loadAndRender();
});
els.cancelDialog.addEventListener('click', () => els.dialog.close());
els.form.addEventListener('submit', saveEventFromForm);
els.deleteEvent.addEventListener('click', deleteCurrentEvent);

renderTimeAxis();
loadAndRender();

async function loadAndRender() {
  renderStaticWeek();
  const start = toLocalIso(state.weekStart);
  const end = toLocalIso(addDays(state.weekStart, 7));
  try {
    const response = await fetch(`${API_BASE}/api/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
    if (!response.ok) throw new Error(`Failed to load events (${response.status})`);
    state.events = await response.json();
    renderEvents();
  } catch (err) {
    console.error(err);
    state.events = [];
    renderEvents();
    els.weekGrid.insertAdjacentHTML('beforeend', `<div class="load-error">${escapeHtml(err.message)}</div>`);
  }
}

function renderStaticWeek() {
  const weekEnd = addDays(state.weekStart, 6);
  els.weekLabel.textContent = `${formatDate(state.weekStart, { month: 'short', day: 'numeric' })} – ${formatDate(weekEnd, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  els.dayHeaders.innerHTML = '';
  els.weekGrid.innerHTML = '';

  const todayKey = dateKey(new Date());
  for (let i = 0; i < 7; i += 1) {
    const date = addDays(state.weekStart, i);
    const isToday = dateKey(date) === todayKey;

    const header = document.createElement('div');
    header.className = `day-header${isToday ? ' today' : ''}`;
    header.innerHTML = `<span class="day-name">${DAYS[i]}</span><span class="day-date">${formatDate(date, { month: 'short', day: 'numeric' })}</span>`;
    els.dayHeaders.appendChild(header);

    const col = document.createElement('section');
    col.className = `day-column${isToday ? ' today' : ''}`;
    col.dataset.dayIndex = String(i);
    col.style.height = `${MINUTES_PER_DAY * MINUTE_HEIGHT}px`;
    col.addEventListener('pointerdown', onDayPointerDown);
    els.weekGrid.appendChild(col);
  }
}

function renderTimeAxis() {
  els.timeAxis.innerHTML = '';
  els.timeAxis.style.height = `${MINUTES_PER_DAY * MINUTE_HEIGHT}px`;
  for (let hour = 0; hour <= 24; hour += 1) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = `${hour * 60 * MINUTE_HEIGHT}px`;
    label.textContent = `${String(hour).padStart(2, '0')}:00`;
    els.timeAxis.appendChild(label);
  }
}

function renderEvents() {
  document.querySelectorAll('.day-column').forEach(col => {
    col.querySelectorAll('.event-block, .selection-preview').forEach(el => el.remove());
  });

  const segmentsByDay = Array.from({ length: 7 }, () => []);
  for (const event of state.events) {
    for (const seg of splitEventIntoVisibleDaySegments(event, state.weekStart)) {
      segmentsByDay[seg.dayIndex].push(seg);
    }
  }

  segmentsByDay.forEach((segments, dayIndex) => {
    const column = document.querySelector(`.day-column[data-day-index="${dayIndex}"]`);
    const laidOut = layoutDayEvents(segments);
    for (const item of laidOut) {
      const block = document.createElement('button');
      block.type = 'button';
      block.className = 'event-block';
      block.style.top = `${item.startMinute * MINUTE_HEIGHT}px`;
      block.style.height = `${Math.max(1, (item.endMinute - item.startMinute) * MINUTE_HEIGHT)}px`;
      block.style.left = `${(item.column / item.columnCount) * 100}%`;
      block.style.width = `${(1 / item.columnCount) * 100}%`;
      const timeRange = `${formatMinuteOfDay(item.startMinute)}–${formatMinuteOfDay(item.endMinute)}`;
      block.title = `${item.title}\n${timeRange}`;
      block.innerHTML = `
        <span class="event-title">${escapeHtml(item.title)}</span>
        <span class="event-time">${timeRange}</span>
      `;
      block.addEventListener('click', (e) => {
        e.stopPropagation();
        const original = state.events.find(ev => Number(ev.id) === Number(item.id));
        if (original) openEditDialog(original);
      });
      column.appendChild(block);
    }
  });
}

function splitEventIntoVisibleDaySegments(event, weekStart) {
  const eventStart = parseLocalDate(event.start_at);
  const eventEnd = parseLocalDate(event.end_at);
  const segments = [];
  for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
    const dayStart = addDays(weekStart, dayIndex);
    const dayEnd = addDays(dayStart, 1);
    const visibleStart = maxDate(eventStart, dayStart);
    const visibleEnd = minDate(eventEnd, dayEnd);
    if (visibleEnd > visibleStart) {
      const startMinute = minutesSinceStartOfDay(visibleStart, dayStart);
      const endMinute = minutesSinceStartOfDay(visibleEnd, dayStart);
      segments.push({
        ...event,
        dayIndex,
        startMinute: clamp(startMinute, 0, MINUTES_PER_DAY),
        endMinute: clamp(endMinute, 0, MINUTES_PER_DAY)
      });
    }
  }
  return segments;
}

export function layoutDayEvents(events) {
  const sorted = [...events]
    .filter(e => e.endMinute > e.startMinute)
    .sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute || Number(a.id) - Number(b.id));
  const output = [];
  let cluster = [];
  let clusterEnd = -Infinity;

  const flushCluster = () => {
    if (cluster.length === 0) return;
    const activeColumnEnds = [];
    let maxColumns = 0;
    const assigned = cluster.map(event => {
      let column = activeColumnEnds.findIndex(end => end <= event.startMinute);
      if (column === -1) column = activeColumnEnds.length;
      activeColumnEnds[column] = event.endMinute;
      maxColumns = Math.max(maxColumns, activeColumnEnds.filter(end => end > event.startMinute).length);
      return { ...event, column };
    });
    for (const event of assigned) {
      output.push({ ...event, columnCount: maxColumns });
    }
    cluster = [];
    clusterEnd = -Infinity;
  };

  for (const event of sorted) {
    if (cluster.length === 0) {
      cluster = [event];
      clusterEnd = event.endMinute;
    } else if (event.startMinute < clusterEnd) {
      cluster.push(event);
      clusterEnd = Math.max(clusterEnd, event.endMinute);
    } else {
      flushCluster();
      cluster = [event];
      clusterEnd = event.endMinute;
    }
  }
  flushCluster();
  return output;
}

function onDayPointerDown(e) {
  if (e.button !== 0 || e.target.closest('.event-block')) return;
  const column = e.currentTarget;
  column.setPointerCapture(e.pointerId);
  const dayIndex = Number(column.dataset.dayIndex);
  const startMinute = minuteFromPointer(e, column);
  state.drag = { column, dayIndex, startMinute, endMinute: startMinute, pointerId: e.pointerId, preview: null };
  updateSelectionPreview();
  column.addEventListener('pointermove', onDayPointerMove);
  column.addEventListener('pointerup', onDayPointerUp, { once: true });
  column.addEventListener('pointercancel', cancelDrag, { once: true });
}

function onDayPointerMove(e) {
  if (!state.drag) return;
  state.drag.endMinute = minuteFromPointer(e, state.drag.column);
  updateSelectionPreview();
}

function onDayPointerUp(e) {
  if (!state.drag) return;
  state.drag.endMinute = minuteFromPointer(e, state.drag.column);
  const { dayIndex } = state.drag;
  const a = state.drag.startMinute;
  const b = state.drag.endMinute;
  cleanupDragListeners();
  const startMinute = Math.min(a, b);
  let endMinute = Math.max(a, b);
  if (endMinute === startMinute) endMinute = Math.min(MINUTES_PER_DAY, startMinute + 30);
  if (endMinute <= startMinute) return;
  const day = addDays(state.weekStart, dayIndex);
  openCreateDialog(addMinutes(day, startMinute), addMinutes(day, endMinute));
}

function cancelDrag() {
  cleanupDragListeners();
}

function cleanupDragListeners() {
  if (!state.drag) return;
  state.drag.column.removeEventListener('pointermove', onDayPointerMove);
  state.drag.preview?.remove();
  state.drag = null;
}

function updateSelectionPreview() {
  if (!state.drag) return;
  if (!state.drag.preview) {
    state.drag.preview = document.createElement('div');
    state.drag.preview.className = 'selection-preview';
    state.drag.column.appendChild(state.drag.preview);
  }
  const start = Math.min(state.drag.startMinute, state.drag.endMinute);
  let end = Math.max(state.drag.startMinute, state.drag.endMinute);
  if (end === start) end = Math.min(MINUTES_PER_DAY, start + 30);
  state.drag.preview.style.top = `${start * MINUTE_HEIGHT}px`;
  state.drag.preview.style.height = `${Math.max(1, end - start) * MINUTE_HEIGHT}px`;
}

function minuteFromPointer(e, column) {
  const rect = column.getBoundingClientRect();
  const y = e.clientY - rect.top;
  // Snap creation selections to 15-minute increments while preserving the
  // renderer's minute-precision positioning for persisted arbitrary times.
  return clamp(Math.round(y / (15 * MINUTE_HEIGHT)) * 15, 0, MINUTES_PER_DAY);
}

function openCreateDialog(start, end) {
  state.editingEvent = null;
  els.dialogTitle.textContent = 'Create event';
  els.eventTitle.value = '';
  els.eventStart.value = toDateTimeLocalValue(start);
  els.eventEnd.value = toDateTimeLocalValue(end);
  els.formError.textContent = '';
  els.deleteEvent.hidden = true;
  els.dialog.showModal();
  els.eventTitle.focus();
}

function openEditDialog(event) {
  state.editingEvent = event;
  els.dialogTitle.textContent = 'Edit event';
  els.eventTitle.value = event.title;
  els.eventStart.value = toDateTimeLocalValue(parseLocalDate(event.start_at));
  els.eventEnd.value = toDateTimeLocalValue(parseLocalDate(event.end_at));
  els.formError.textContent = '';
  els.deleteEvent.hidden = false;
  els.dialog.showModal();
  els.eventTitle.focus();
}

async function saveEventFromForm(e) {
  e.preventDefault();
  const payload = {
    title: els.eventTitle.value.trim(),
    start_at: normalizeInputDateTime(els.eventStart.value),
    end_at: normalizeInputDateTime(els.eventEnd.value)
  };
  if (!payload.title) return showFormError('Please enter a title.');
  if (!(parseLocalDate(payload.end_at) > parseLocalDate(payload.start_at))) return showFormError('End must be after start.');

  const isEdit = Boolean(state.editingEvent);
  const url = isEdit ? `${API_BASE}/api/events/${state.editingEvent.id}` : `${API_BASE}/api/events`;
  const method = isEdit ? 'PUT' : 'POST';
  try {
    const response = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `Save failed (${response.status})`);
    }
    els.dialog.close();
    await loadAndRender();
  } catch (err) {
    showFormError(err.message);
  }
}

async function deleteCurrentEvent() {
  if (!state.editingEvent) return;
  if (!confirm('Delete this event?')) return;
  try {
    const response = await fetch(`${API_BASE}/api/events/${state.editingEvent.id}`, { method: 'DELETE' });
    if (!response.ok) throw new Error(`Delete failed (${response.status})`);
    els.dialog.close();
    await loadAndRender();
  } catch (err) {
    showFormError(err.message);
  }
}

function showFormError(message) {
  els.formError.textContent = message;
}

function changeWeek(delta) {
  state.weekStart = addDays(state.weekStart, delta * 7);
  loadAndRender();
}

function startOfWeek(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const mondayOffset = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - mondayOffset);
  return d;
}

function addDays(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds());
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60_000);
}

function minDate(a, b) { return a < b ? a : b; }
function maxDate(a, b) { return a > b ? a : b; }
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function dateKey(date) { return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`; }

function minutesSinceStartOfDay(date, dayStart) {
  return Math.round((date.getTime() - dayStart.getTime()) / 60_000);
}

function parseLocalDate(value) {
  if (value instanceof Date) return value;
  const s = String(value);
  const [datePart, timePart = '00:00:00'] = s.replace(' ', 'T').split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour = 0, minute = 0, second = 0] = timePart.split(':').map(Number);
  return new Date(year, month - 1, day, hour, minute, second || 0, 0);
}

function toDateTimeLocalValue(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function normalizeInputDateTime(value) {
  // datetime-local inputs produce YYYY-MM-DDTHH:mm; append seconds for consistency.
  return value.length === 16 ? `${value}:00` : value;
}

function toLocalIso(date) {
  return `${toDateTimeLocalValue(date)}:00`;
}

function formatDate(date, options) {
  return new Intl.DateTimeFormat(undefined, options).format(date);
}

function formatMinuteOfDay(minute) {
  if (minute >= MINUTES_PER_DAY) return '24:00';
  const safe = clamp(minute, 0, MINUTES_PER_DAY);
  return `${pad(Math.floor(safe / 60))}:${pad(safe % 60)}`;
}

function pad(n) { return String(n).padStart(2, '0'); }

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}
