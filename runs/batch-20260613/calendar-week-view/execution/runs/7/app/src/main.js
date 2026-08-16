import './styles.css';

const HOURS = 24;
const MINUTES_PER_DAY = 1440;
const HOUR_HEIGHT = 64;
const SNAP_MINUTES = 15;
const DAY_MS = 24 * 60 * 60 * 1000;
const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const fmt2 = new Intl.NumberFormat(undefined, { minimumIntegerDigits: 2 });

let currentWeekStart = startOfWeek(new Date());
let events = [];
let selection = null;

const app = document.querySelector('#app');
app.innerHTML = `
  <header class="toolbar">
    <div class="brand">
      <h1>Week Calendar</h1>
      <p>Minute-accurate events with overlap-safe layout</p>
    </div>
    <nav class="week-nav" aria-label="Week navigation">
      <button id="prevWeek" type="button">← Previous</button>
      <button id="todayWeek" type="button">Today</button>
      <button id="nextWeek" type="button">Next →</button>
    </nav>
    <div id="weekLabel" class="week-label"></div>
  </header>
  <main class="calendar-shell">
    <div class="calendar" id="calendar"></div>
  </main>
  <dialog id="eventDialog">
    <form method="dialog" id="eventForm" class="event-form">
      <h2 id="dialogTitle">Create event</h2>
      <input type="hidden" id="eventId" />
      <label>
        Title
        <input id="eventTitle" name="title" required maxlength="200" autocomplete="off" />
      </label>
      <div class="form-row">
        <label>
          Start
          <input id="eventStart" name="start" type="datetime-local" required />
        </label>
        <label>
          End
          <input id="eventEnd" name="end" type="datetime-local" required />
        </label>
      </div>
      <p class="form-error" id="formError" role="alert"></p>
      <menu>
        <button type="button" id="deleteEvent" class="danger">Delete</button>
        <span class="spacer"></span>
        <button type="button" id="cancelDialog">Cancel</button>
        <button type="submit" id="saveEvent" class="primary">Save</button>
      </menu>
    </form>
  </dialog>
`;

const calendarEl = document.querySelector('#calendar');
const weekLabelEl = document.querySelector('#weekLabel');
const dialog = document.querySelector('#eventDialog');
const form = document.querySelector('#eventForm');
const dialogTitle = document.querySelector('#dialogTitle');
const eventIdInput = document.querySelector('#eventId');
const titleInput = document.querySelector('#eventTitle');
const startInput = document.querySelector('#eventStart');
const endInput = document.querySelector('#eventEnd');
const formError = document.querySelector('#formError');
const deleteButton = document.querySelector('#deleteEvent');

document.querySelector('#prevWeek').addEventListener('click', () => changeWeek(-1));
document.querySelector('#todayWeek').addEventListener('click', () => { currentWeekStart = startOfWeek(new Date()); loadWeek(); });
document.querySelector('#nextWeek').addEventListener('click', () => changeWeek(1));
document.querySelector('#cancelDialog').addEventListener('click', () => dialog.close());
form.addEventListener('submit', saveEvent);
deleteButton.addEventListener('click', deleteEvent);

function changeWeek(delta) {
  currentWeekStart = addDays(currentWeekStart, delta * 7);
  loadWeek();
}

async function loadWeek() {
  const start = currentWeekStart;
  const end = addDays(start, 7);
  weekLabelEl.textContent = `${formatDateLabel(start)} – ${formatDateLabel(addDays(end, -1))}`;
  const response = await fetch(`/api/events?start=${encodeURIComponent(toLocalIso(start))}&end=${encodeURIComponent(toLocalIso(end))}`);
  if (!response.ok) throw new Error('Failed to load events');
  events = await response.json();
  renderCalendar();
}

function renderCalendar() {
  calendarEl.innerHTML = '';
  calendarEl.style.setProperty('--hour-height', `${HOUR_HEIGHT}px`);
  calendarEl.style.setProperty('--day-height', `${HOUR_HEIGHT * HOURS}px`);

  const corner = document.createElement('div');
  corner.className = 'calendar-corner';
  calendarEl.append(corner);

  const today = stripTime(new Date());
  for (let i = 0; i < 7; i++) {
    const date = addDays(currentWeekStart, i);
    const header = document.createElement('div');
    header.className = 'day-header';
    if (+stripTime(date) === +today) header.classList.add('today');
    header.style.gridColumn = `${i + 2}`;
    header.innerHTML = `<span>${dayNames[i]}</span><strong>${formatDayNumber(date)}</strong>`;
    calendarEl.append(header);
  }

  const timeAxis = document.createElement('div');
  timeAxis.className = 'time-axis';
  for (let h = 0; h <= HOURS; h++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = `${h * HOUR_HEIGHT}px`;
    label.textContent = `${fmt2.format(h)}:00`;
    timeAxis.append(label);
  }
  calendarEl.append(timeAxis);

  const weekGrid = document.createElement('div');
  weekGrid.className = 'week-grid';
  calendarEl.append(weekGrid);

  for (let i = 0; i < 7; i++) {
    const date = addDays(currentWeekStart, i);
    const day = document.createElement('section');
    day.className = 'day-column';
    if (+stripTime(date) === +today) day.classList.add('today');
    day.dataset.dayIndex = String(i);
    day.setAttribute('aria-label', `${dayNames[i]} ${formatDateLabel(date)}`);
    day.addEventListener('pointerdown', startSelection);

    for (let h = 0; h < HOURS; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${h * HOUR_HEIGHT}px`;
      day.append(line);
    }

    const dayEvents = splitEventsForDay(i);
    for (const ev of layoutDayEvents(dayEvents)) {
      day.append(renderEvent(ev));
    }
    weekGrid.append(day);
  }
}

function splitEventsForDay(dayIndex) {
  const dayStart = addDays(currentWeekStart, dayIndex);
  const dayEnd = addDays(dayStart, 1);
  return events
    .map((event) => {
      const start = parseServerDate(event.start_at);
      const end = parseServerDate(event.end_at);
      const clippedStart = new Date(Math.max(start.getTime(), dayStart.getTime()));
      const clippedEnd = new Date(Math.min(end.getTime(), dayEnd.getTime()));
      if (clippedEnd <= dayStart || clippedStart >= dayEnd || clippedEnd <= clippedStart) return null;
      return { ...event, realStart: start, realEnd: end, start: clippedStart, end: clippedEnd, dayStart, dayEnd };
    })
    .filter(Boolean);
}

function layoutDayEvents(dayEvents) {
  const sorted = [...dayEvents].sort((a, b) => a.start - b.start || a.end - b.end || a.id - b.id);
  const clusters = [];
  let cluster = [];
  let clusterEnd = null;

  for (const ev of sorted) {
    if (!cluster.length || ev.start < clusterEnd) {
      cluster.push(ev);
      clusterEnd = clusterEnd && clusterEnd > ev.end ? clusterEnd : ev.end;
    } else {
      clusters.push(cluster);
      cluster = [ev];
      clusterEnd = ev.end;
    }
  }
  if (cluster.length) clusters.push(cluster);

  return clusters.flatMap(layoutCluster);
}

function layoutCluster(cluster) {
  const columns = [];
  const laidOut = [];
  for (const ev of cluster) {
    let columnIndex = columns.findIndex((lastEnd) => lastEnd <= ev.start);
    if (columnIndex === -1) {
      columnIndex = columns.length;
      columns.push(ev.end);
    } else {
      columns[columnIndex] = ev.end;
    }
    laidOut.push({ ...ev, columnIndex });
  }
  const columnCount = Math.max(1, columns.length);
  return laidOut.map((ev) => {
    const startMin = minutesSinceMidnight(ev.start);
    const endMin = ev.end.getTime() === ev.dayEnd.getTime() ? MINUTES_PER_DAY : minutesSinceMidnight(ev.end);
    const top = (startMin / 60) * HOUR_HEIGHT;
    const height = Math.max(1, ((endMin - startMin) / 60) * HOUR_HEIGHT);
    return { ...ev, columnCount, top, height };
  });
}

function renderEvent(ev) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'event-block';
  el.style.top = `${ev.top}px`;
  el.style.height = `${ev.height}px`;
  el.style.left = `calc(${(ev.columnIndex / ev.columnCount) * 100}% + 2px)`;
  el.style.width = `calc(${(1 / ev.columnCount) * 100}% - 4px)`;
  el.innerHTML = `
    <span class="event-title">${escapeHtml(ev.title)}</span>
    <span class="event-time">${formatTime(ev.realStart)}–${formatTime(ev.realEnd)}</span>
  `;
  el.addEventListener('pointerdown', (e) => e.stopPropagation());
  el.addEventListener('click', () => openEditDialog(ev));
  return el;
}

function startSelection(event) {
  if (event.button !== 0) return;
  const column = event.currentTarget;
  const dayIndex = Number(column.dataset.dayIndex);
  const rect = column.getBoundingClientRect();
  const startY = clamp(event.clientY - rect.top + column.scrollTop, 0, HOUR_HEIGHT * HOURS);
  const fromMin = snapMinutes((startY / (HOUR_HEIGHT * HOURS)) * MINUTES_PER_DAY);
  selection = { column, dayIndex, fromMin, toMin: Math.min(MINUTES_PER_DAY, fromMin + 60), ghost: document.createElement('div') };
  selection.ghost.className = 'selection-ghost';
  column.append(selection.ghost);
  updateSelectionGhost();
  column.setPointerCapture(event.pointerId);
  column.addEventListener('pointermove', moveSelection);
  column.addEventListener('pointerup', endSelection, { once: true });
  column.addEventListener('pointercancel', cancelSelection, { once: true });
}

function moveSelection(event) {
  if (!selection) return;
  const rect = selection.column.getBoundingClientRect();
  const y = clamp(event.clientY - rect.top + selection.column.scrollTop, 0, HOUR_HEIGHT * HOURS);
  const min = snapMinutes((y / (HOUR_HEIGHT * HOURS)) * MINUTES_PER_DAY);
  selection.toMin = min;
  updateSelectionGhost();
}

function endSelection(event) {
  if (!selection) return;
  selection.column.removeEventListener('pointermove', moveSelection);
  const { dayIndex } = selection;
  let startMin = Math.min(selection.fromMin, selection.toMin);
  let endMin = Math.max(selection.fromMin, selection.toMin);
  if (endMin === startMin) endMin = Math.min(MINUTES_PER_DAY, startMin + 60);
  if (endMin === startMin) startMin = Math.max(0, endMin - 60);
  const ghost = selection.ghost;
  selection = null;
  ghost.remove();
  openCreateDialog(dayIndex, startMin, endMin);
}

function cancelSelection() {
  if (!selection) return;
  selection.column.removeEventListener('pointermove', moveSelection);
  selection.ghost.remove();
  selection = null;
}

function updateSelectionGhost() {
  if (!selection) return;
  const a = Math.min(selection.fromMin, selection.toMin);
  const b = Math.max(selection.fromMin, selection.toMin);
  selection.ghost.style.top = `${(a / 60) * HOUR_HEIGHT}px`;
  selection.ghost.style.height = `${Math.max(10, ((b - a) / 60) * HOUR_HEIGHT)}px`;
}

function openCreateDialog(dayIndex, startMin, endMin) {
  const day = addDays(currentWeekStart, dayIndex);
  resetForm();
  dialogTitle.textContent = 'Create event';
  deleteButton.hidden = true;
  startInput.value = toDatetimeLocal(addMinutes(day, startMin));
  endInput.value = toDatetimeLocal(addMinutes(day, endMin));
  dialog.showModal();
  titleInput.focus();
}

function openEditDialog(ev) {
  resetForm();
  dialogTitle.textContent = 'Edit event';
  eventIdInput.value = ev.id;
  titleInput.value = ev.title;
  startInput.value = toDatetimeLocal(ev.realStart);
  endInput.value = toDatetimeLocal(ev.realEnd);
  deleteButton.hidden = false;
  dialog.showModal();
  titleInput.focus();
}

function resetForm() {
  formError.textContent = '';
  eventIdInput.value = '';
  titleInput.value = '';
  startInput.value = '';
  endInput.value = '';
}

async function saveEvent(event) {
  event.preventDefault();
  formError.textContent = '';
  const payload = {
    title: titleInput.value.trim(),
    start_at: startInput.value,
    end_at: endInput.value
  };
  if (!payload.title) return (formError.textContent = 'Title is required.');
  if (new Date(payload.end_at) <= new Date(payload.start_at)) return (formError.textContent = 'End must be after start.');

  const id = eventIdInput.value;
  const response = await fetch(id ? `/api/events/${id}` : '/api/events', {
    method: id ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    formError.textContent = data.error || 'Could not save event.';
    return;
  }
  dialog.close();
  await loadWeek();
}

async function deleteEvent() {
  const id = eventIdInput.value;
  if (!id || !confirm('Delete this event?')) return;
  const response = await fetch(`/api/events/${id}`, { method: 'DELETE' });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    formError.textContent = data.error || 'Could not delete event.';
    return;
  }
  dialog.close();
  await loadWeek();
}

function startOfWeek(date) {
  const d = stripTime(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  return addDays(d, diff);
}
function stripTime(date) { return new Date(date.getFullYear(), date.getMonth(), date.getDate()); }
function addDays(date, days) { return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days); }
function addMinutes(date, minutes) { return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, minutes); }
function minutesSinceMidnight(date) { return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60; }
function snapMinutes(min) { return clamp(Math.round(min / SNAP_MINUTES) * SNAP_MINUTES, 0, MINUTES_PER_DAY); }
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function parseServerDate(value) { return new Date(value.length === 19 ? value : value.replace(' ', 'T')); }
function toLocalIso(date) { return toDatetimeLocal(date); }
function toDatetimeLocal(date) {
  const y = date.getFullYear();
  const m = fmt2.format(date.getMonth() + 1);
  const d = fmt2.format(date.getDate());
  const h = fmt2.format(date.getHours());
  const min = fmt2.format(date.getMinutes());
  return `${y}-${m}-${d}T${h}:${min}`;
}
function formatTime(date) { return `${fmt2.format(date.getHours())}:${fmt2.format(date.getMinutes())}`; }
function formatDayNumber(date) { return `${date.getDate()}`; }
function formatDateLabel(date) { return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
function escapeHtml(str) {
  return String(str).replace(/[&<>'"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}

loadWeek().catch((err) => {
  console.error(err);
  calendarEl.innerHTML = `<p class="load-error">Could not load the calendar. Is the backend running?</p>`;
});
