import './styles.css';

const API_BASE = import.meta.env.VITE_API_BASE || '';
const MINUTES_PER_DAY = 24 * 60;
const PX_PER_MINUTE = 1;
const DAY_HEIGHT = MINUTES_PER_DAY * PX_PER_MINUTE;
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

let currentWeekStart = startOfWeek(new Date());
let events = [];
let modalEvent = null;
let selection = null;

const app = document.querySelector('#app');
app.innerHTML = `
  <div class="shell">
    <header class="toolbar">
      <div class="nav-group">
        <button id="prevWeek" type="button">← Previous</button>
        <button id="todayWeek" type="button">Today</button>
        <button id="nextWeek" type="button">Next →</button>
      </div>
      <h1>Week Calendar</h1>
      <div id="weekLabel" class="week-label"></div>
    </header>
    <main class="calendar-card">
      <div class="calendar-header" id="calendarHeader"></div>
      <div class="calendar-scroll">
        <div class="time-gutter" id="timeGutter"></div>
        <div class="week-grid" id="weekGrid"></div>
      </div>
    </main>
  </div>

  <dialog id="eventDialog" class="event-dialog">
    <form method="dialog" id="eventForm" class="event-form">
      <h2 id="dialogTitle">Create event</h2>
      <label>
        Title
        <input id="eventTitle" name="title" type="text" required maxlength="200" />
      </label>
      <label>
        Start
        <input id="eventStart" name="start" type="datetime-local" required />
      </label>
      <label>
        End
        <input id="eventEnd" name="end" type="datetime-local" required />
      </label>
      <p id="formError" class="form-error" role="alert"></p>
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
  prev: document.querySelector('#prevWeek'),
  today: document.querySelector('#todayWeek'),
  next: document.querySelector('#nextWeek'),
  weekLabel: document.querySelector('#weekLabel'),
  header: document.querySelector('#calendarHeader'),
  grid: document.querySelector('#weekGrid'),
  gutter: document.querySelector('#timeGutter'),
  dialog: document.querySelector('#eventDialog'),
  form: document.querySelector('#eventForm'),
  dialogTitle: document.querySelector('#dialogTitle'),
  title: document.querySelector('#eventTitle'),
  start: document.querySelector('#eventStart'),
  end: document.querySelector('#eventEnd'),
  error: document.querySelector('#formError'),
  delete: document.querySelector('#deleteEvent'),
  cancel: document.querySelector('#cancelDialog')
};

els.prev.addEventListener('click', () => moveWeek(-1));
els.today.addEventListener('click', () => { currentWeekStart = startOfWeek(new Date()); loadWeek(); });
els.next.addEventListener('click', () => moveWeek(1));
els.cancel.addEventListener('click', closeDialog);
els.delete.addEventListener('click', deleteCurrentEvent);
els.form.addEventListener('submit', saveEvent);

renderStaticGrid();
loadWeek();

function renderStaticGrid() {
  els.gutter.style.height = `${DAY_HEIGHT}px`;
  els.gutter.innerHTML = '';
  for (let hour = 0; hour <= 24; hour++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = `${hour * 60 * PX_PER_MINUTE}px`;
    label.textContent = `${String(hour).padStart(2, '0')}:00`;
    els.gutter.appendChild(label);
  }
}

async function loadWeek() {
  const weekEnd = addDays(currentWeekStart, 7);
  els.weekLabel.textContent = `${formatDate(currentWeekStart)} – ${formatDate(addDays(currentWeekStart, 6))}`;
  try {
    const response = await fetch(`${API_BASE}/api/events?start=${encodeURIComponent(toLocalDateTime(currentWeekStart))}&end=${encodeURIComponent(toLocalDateTime(weekEnd))}`);
    if (!response.ok) throw new Error(await errorText(response));
    events = await response.json();
    renderWeek();
  } catch (err) {
    console.error(err);
    events = [];
    renderWeek();
    alert(`Could not load events: ${err.message}`);
  }
}

function renderWeek() {
  const todayKey = dateKey(new Date());
  els.header.innerHTML = '<div class="header-gutter"></div>';
  els.grid.innerHTML = '';

  for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
    const date = addDays(currentWeekStart, dayIndex);
    const key = dateKey(date);

    const header = document.createElement('div');
    header.className = `day-header ${key === todayKey ? 'today' : ''}`;
    header.innerHTML = `<span>${DAY_NAMES[dayIndex]}</span><strong>${date.getDate()}</strong>`;
    els.header.appendChild(header);

    const col = document.createElement('section');
    col.className = `day-column ${key === todayKey ? 'today' : ''}`;
    col.dataset.dayIndex = String(dayIndex);
    col.style.height = `${DAY_HEIGHT}px`;
    attachSelectionHandlers(col, date);
    els.grid.appendChild(col);

    const segments = segmentsForDay(events, date);
    const laidOut = layoutDaySegments(segments);
    for (const seg of laidOut) col.appendChild(renderEventBlock(seg));
  }
}

function renderEventBlock(seg) {
  const event = seg.event;
  const block = document.createElement('button');
  block.type = 'button';
  block.className = 'event-block';
  block.style.top = `${seg.top}px`;
  block.style.height = `${Math.max(1, seg.height)}px`;
  block.style.left = `calc(${(seg.column / seg.columnCount) * 100}% + 2px)`;
  block.style.width = `calc(${(1 / seg.columnCount) * 100}% - 4px)`;
  block.title = `${event.title} (${formatTime(new Date(event.start_at))}–${formatTime(new Date(event.end_at))})`;
  block.innerHTML = `
    <span class="event-title">${escapeHtml(event.title)}</span>
    <span class="event-time">${formatTime(new Date(event.start_at))}–${formatTime(new Date(event.end_at))}</span>
  `;
  block.addEventListener('mousedown', (e) => e.stopPropagation());
  block.addEventListener('click', (e) => {
    e.stopPropagation();
    openEditDialog(event);
  });
  return block;
}

function segmentsForDay(sourceEvents, day) {
  const dayStart = startOfDay(day);
  const dayEnd = addDays(dayStart, 1);
  return sourceEvents
    .map((event) => {
      const start = new Date(event.start_at);
      const end = new Date(event.end_at);
      const effectiveStart = maxDate(start, dayStart);
      const effectiveEnd = minDate(end, dayEnd);
      if (effectiveEnd <= dayStart || effectiveStart >= dayEnd || effectiveEnd <= effectiveStart) return null;
      const startMin = minutesSinceMidnight(effectiveStart);
      const endMin = effectiveEnd.getTime() === dayEnd.getTime() ? MINUTES_PER_DAY : minutesSinceMidnight(effectiveEnd);
      return {
        event,
        effectiveStart,
        effectiveEnd,
        startMin: clamp(startMin, 0, MINUTES_PER_DAY),
        endMin: clamp(endMin, 0, MINUTES_PER_DAY)
      };
    })
    .filter(Boolean);
}

export function layoutDaySegments(segments) {
  const sorted = [...segments].sort((a, b) =>
    a.startMin - b.startMin || a.endMin - b.endMin || String(a.event.id).localeCompare(String(b.event.id))
  );
  const laidOut = [];
  let cluster = [];
  let clusterEnd = -1;

  const flush = () => {
    if (cluster.length === 0) return;
    laidOut.push(...layoutCluster(cluster));
    cluster = [];
    clusterEnd = -1;
  };

  for (const seg of sorted) {
    // Endpoints that merely touch (10:00 end, 10:00 start) do not overlap.
    if (cluster.length === 0 || seg.startMin < clusterEnd) {
      cluster.push(seg);
      clusterEnd = Math.max(clusterEnd, seg.endMin);
    } else {
      flush();
      cluster.push(seg);
      clusterEnd = seg.endMin;
    }
  }
  flush();
  return laidOut;
}

function layoutCluster(cluster) {
  const columns = [];
  const result = [];
  for (const seg of cluster) {
    let colIndex = columns.findIndex((endMin) => endMin <= seg.startMin);
    if (colIndex === -1) {
      colIndex = columns.length;
      columns.push(seg.endMin);
    } else {
      columns[colIndex] = seg.endMin;
    }
    result.push({ ...seg, column: colIndex });
  }

  const columnCount = columns.length || 1;
  return result.map((seg) => ({
    ...seg,
    columnCount,
    top: seg.startMin * PX_PER_MINUTE,
    height: (seg.endMin - seg.startMin) * PX_PER_MINUTE
  }));
}

function attachSelectionHandlers(col, date) {
  col.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target !== col) return;

    const startMinute = minuteFromPointer(e, col);
    const preview = document.createElement('div');
    preview.className = 'selection-preview';
    col.appendChild(preview);
    updatePreview(preview, startMinute, startMinute + 30);

    const onMove = (moveEvent) => {
      const current = minuteFromPointer(moveEvent, col);
      updatePreview(preview, startMinute, current);
    };

    const onUp = (upEvent) => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      const endMinute = minuteFromPointer(upEvent, col);
      preview.remove();
      let a = Math.min(startMinute, endMinute);
      let b = Math.max(startMinute, endMinute);
      if (b - a < 1) b = Math.min(MINUTES_PER_DAY, a + 60);
      if (b <= a) a = Math.max(0, b - 60);
      openCreateDialog(dateAtMinute(date, a), dateAtMinute(date, b));
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    e.preventDefault();
  });
}

function updatePreview(preview, a, b) {
  let start = Math.min(a, b);
  let end = Math.max(a, b);
  if (end === start) end = Math.min(MINUTES_PER_DAY, start + 30);
  preview.style.top = `${start * PX_PER_MINUTE}px`;
  preview.style.height = `${Math.max(1, (end - start) * PX_PER_MINUTE)}px`;
}

function minuteFromPointer(e, col) {
  const rect = col.getBoundingClientRect();
  return clamp(Math.round((e.clientY - rect.top) / PX_PER_MINUTE), 0, MINUTES_PER_DAY);
}

function openCreateDialog(start, end) {
  modalEvent = null;
  els.dialogTitle.textContent = 'Create event';
  els.delete.hidden = true;
  els.title.value = '';
  els.start.value = toInputValue(start);
  els.end.value = toInputValue(end);
  els.error.textContent = '';
  els.dialog.showModal();
  els.title.focus();
}

function openEditDialog(event) {
  modalEvent = event;
  els.dialogTitle.textContent = 'Edit event';
  els.delete.hidden = false;
  els.title.value = event.title;
  els.start.value = toInputValue(new Date(event.start_at));
  els.end.value = toInputValue(new Date(event.end_at));
  els.error.textContent = '';
  els.dialog.showModal();
}

function closeDialog() {
  els.dialog.close();
  modalEvent = null;
}

async function saveEvent(e) {
  e.preventDefault();
  const payload = {
    title: els.title.value.trim(),
    start_at: els.start.value,
    end_at: els.end.value
  };
  if (!payload.title) return showFormError('Title is required.');
  if (!payload.start_at || !payload.end_at || new Date(payload.end_at) <= new Date(payload.start_at)) {
    return showFormError('End must be after start.');
  }

  const url = modalEvent ? `${API_BASE}/api/events/${modalEvent.id}` : `${API_BASE}/api/events`;
  const method = modalEvent ? 'PUT' : 'POST';
  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!response.ok) return showFormError(await errorText(response));
  closeDialog();
  await loadWeek();
}

async function deleteCurrentEvent() {
  if (!modalEvent) return;
  if (!confirm(`Delete “${modalEvent.title}”?`)) return;
  const response = await fetch(`${API_BASE}/api/events/${modalEvent.id}`, { method: 'DELETE' });
  if (!response.ok) return showFormError(await errorText(response));
  closeDialog();
  await loadWeek();
}

function showFormError(message) {
  els.error.textContent = message;
}

function moveWeek(delta) {
  currentWeekStart = addDays(currentWeekStart, delta * 7);
  loadWeek();
}

async function errorText(response) {
  try {
    const json = await response.json();
    return json.error || response.statusText;
  } catch {
    return response.statusText;
  }
}

function startOfWeek(date) {
  const d = startOfDay(date);
  const mondayOffset = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - mondayOffset);
  return d;
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function dateAtMinute(day, minute) {
  const d = startOfDay(day);
  d.setMinutes(minute, 0, 0);
  return d;
}

function minutesSinceMidnight(date) {
  return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
}

function maxDate(a, b) { return a > b ? a : b; }
function minDate(a, b) { return a < b ? a : b; }
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function dateKey(date) { return toLocalDateTime(startOfDay(date)).slice(0, 10); }
function formatDate(date) { return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
function formatTime(date) { return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); }
function toInputValue(date) { return toLocalDateTime(date).slice(0, 16); }

function toLocalDateTime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
