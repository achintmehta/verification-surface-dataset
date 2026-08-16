import './styles.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3000';
const DAY_MINUTES = 24 * 60;
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const SHORT_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

let currentWeekStart = startOfWeek(new Date());
let events = [];
let selection = null;
let modalMode = 'create';
let editingEvent = null;

const app = document.querySelector('#app');
app.innerHTML = `
  <div class="app-shell">
    <div class="toolbar">
      <h1>Week Calendar</h1>
      <button id="prevWeek" type="button">← Previous</button>
      <button id="today" type="button">Today</button>
      <button id="nextWeek" type="button">Next →</button>
      <div class="spacer"></div>
      <div id="weekLabel" class="week-label"></div>
    </div>
    <div id="message" class="message"></div>
    <div class="calendar-scroll">
      <div class="calendar">
        <div id="headerRow" class="header-row"></div>
        <div id="gridRow" class="grid-row"></div>
      </div>
    </div>
  </div>
  <div id="modalBackdrop" class="modal-backdrop" role="dialog" aria-modal="true">
    <form id="eventForm" class="modal">
      <h2 id="modalTitle">Create event</h2>
      <div class="form-row">
        <label for="titleInput">Title</label>
        <input id="titleInput" name="title" maxlength="200" required />
      </div>
      <div class="form-row">
        <label for="startInput">Start</label>
        <input id="startInput" name="start" type="datetime-local" required />
      </div>
      <div class="form-row">
        <label for="endInput">End</label>
        <input id="endInput" name="end" type="datetime-local" required />
      </div>
      <div id="formError" class="form-error"></div>
      <div class="modal-actions">
        <button id="deleteButton" class="danger left" type="button">Delete</button>
        <button id="cancelButton" type="button">Cancel</button>
        <button class="primary" type="submit">Save</button>
      </div>
    </form>
  </div>
`;

const headerRow = document.querySelector('#headerRow');
const gridRow = document.querySelector('#gridRow');
const weekLabel = document.querySelector('#weekLabel');
const message = document.querySelector('#message');
const modalBackdrop = document.querySelector('#modalBackdrop');
const eventForm = document.querySelector('#eventForm');
const modalTitle = document.querySelector('#modalTitle');
const titleInput = document.querySelector('#titleInput');
const startInput = document.querySelector('#startInput');
const endInput = document.querySelector('#endInput');
const formError = document.querySelector('#formError');
const deleteButton = document.querySelector('#deleteButton');

function startOfWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function minutesFromMidnight(date) {
  return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60 + date.getMilliseconds() / 60000;
}

function hourHeight() {
  const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--hour-height'));
  return Number.isFinite(value) && value > 0 ? value : 64;
}

function yForMinutes(minutes) {
  return (minutes / 60) * hourHeight();
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatTime(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatDate(date) {
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function dateInputValue(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function readInputDate(input) {
  return input.value ? new Date(input.value) : null;
}

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function showMessage(text) {
  message.textContent = text;
  message.classList.toggle('show', Boolean(text));
}

async function api(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  if (!res.ok) {
    let error = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body.error) error = body.error;
    } catch (_) {
      // ignore
    }
    throw new Error(error);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function loadEvents() {
  const weekEnd = addDays(currentWeekStart, 7);
  try {
    events = await api(`/api/events?start=${encodeURIComponent(currentWeekStart.toISOString())}&end=${encodeURIComponent(weekEnd.toISOString())}`);
    showMessage('');
    render();
  } catch (err) {
    showMessage(`Could not load events: ${err.message}`);
  }
}

function render() {
  renderHeaders();
  renderGrid();
  weekLabel.textContent = `${formatDate(currentWeekStart)} – ${formatDate(addDays(currentWeekStart, 6))}`;
}

function renderHeaders() {
  headerRow.innerHTML = '<div class="corner"></div>';
  const today = new Date();
  for (let i = 0; i < 7; i += 1) {
    const day = addDays(currentWeekStart, i);
    const el = document.createElement('div');
    el.className = `day-header${isSameDay(day, today) ? ' today' : ''}`;
    el.innerHTML = `<div class="day-name">${DAYS[i]}</div><div class="day-date">${day.getDate()}</div>`;
    headerRow.appendChild(el);
  }
}

function renderGrid() {
  gridRow.innerHTML = '';
  const timeAxis = document.createElement('div');
  timeAxis.className = 'time-axis';
  for (let hour = 0; hour <= 24; hour += 1) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = `${yForMinutes(hour * 60)}px`;
    label.textContent = `${pad(hour)}:00`;
    timeAxis.appendChild(label);
  }
  gridRow.appendChild(timeAxis);

  const today = new Date();
  for (let i = 0; i < 7; i += 1) {
    const day = addDays(currentWeekStart, i);
    const column = document.createElement('div');
    column.className = `day-column${isSameDay(day, today) ? ' today' : ''}`;
    column.dataset.dayIndex = String(i);
    addHourLines(column);
    attachSelectionHandlers(column, day);
    renderDayEvents(column, day);
    gridRow.appendChild(column);
  }
}

function addHourLines(column) {
  for (let hour = 0; hour <= 24; hour += 1) {
    const line = document.createElement('div');
    line.className = 'hour-line';
    line.style.top = `${yForMinutes(hour * 60)}px`;
    column.appendChild(line);
    if (hour < 24) {
      const half = document.createElement('div');
      half.className = 'half-hour-line';
      half.style.top = `${yForMinutes(hour * 60 + 30)}px`;
      column.appendChild(half);
    }
  }
}

function eventsForDay(day) {
  const dayStart = new Date(day);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = addDays(dayStart, 1);
  return events
    .map((event) => ({ ...event, startDate: new Date(event.start_at), endDate: new Date(event.end_at) }))
    .filter((event) => event.startDate < dayEnd && event.endDate > dayStart)
    .map((event) => ({
      ...event,
      renderStart: event.startDate < dayStart ? dayStart : event.startDate,
      renderEnd: event.endDate > dayEnd ? dayEnd : event.endDate,
    }))
    .filter((event) => event.renderEnd > event.renderStart);
}

function overlaps(a, b) {
  return a.renderStart < b.renderEnd && b.renderStart < a.renderEnd;
}

function layoutDayEvents(dayEvents) {
  const sorted = [...dayEvents].sort((a, b) => a.renderStart - b.renderStart || a.renderEnd - b.renderEnd || a.id - b.id);
  const laidOut = [];
  let cluster = [];
  let clusterEnd = null;

  function flushCluster() {
    if (cluster.length === 0) return;
    laidOut.push(...layoutCluster(cluster));
    cluster = [];
    clusterEnd = null;
  }

  for (const event of sorted) {
    if (cluster.length === 0) {
      cluster = [event];
      clusterEnd = event.renderEnd;
    } else if (event.renderStart < clusterEnd) {
      cluster.push(event);
      if (event.renderEnd > clusterEnd) clusterEnd = event.renderEnd;
    } else {
      flushCluster();
      cluster = [event];
      clusterEnd = event.renderEnd;
    }
  }
  flushCluster();
  return laidOut;
}

function layoutCluster(clusterEvents) {
  const columns = [];
  const assigned = [];
  const sorted = [...clusterEvents].sort((a, b) => a.renderStart - b.renderStart || a.renderEnd - b.renderEnd || a.id - b.id);

  for (const event of sorted) {
    let col = 0;
    while (col < columns.length && columns[col] > event.renderStart) col += 1;
    if (col === columns.length) columns.push(event.renderEnd);
    else columns[col] = event.renderEnd;
    assigned.push({ ...event, column: col });
  }

  const columnCount = Math.max(1, columns.length);
  return assigned.map((event) => ({ ...event, columnCount }));
}

function renderDayEvents(column, day) {
  const laidOut = layoutDayEvents(eventsForDay(day));
  for (const event of laidOut) {
    const topMinutes = Math.max(0, Math.min(DAY_MINUTES, minutesFromMidnight(event.renderStart)));
    const endMinutesRaw = isSameDay(event.renderEnd, event.renderStart) ? minutesFromMidnight(event.renderEnd) : DAY_MINUTES;
    const endMinutes = Math.max(0, Math.min(DAY_MINUTES, endMinutesRaw));
    const top = yForMinutes(topMinutes);
    const height = Math.max(1, yForMinutes(endMinutes - topMinutes));
    const widthPct = 100 / event.columnCount;
    const leftPct = event.column * widthPct;

    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'event';
    el.style.top = `${top}px`;
    el.style.height = `${height}px`;
    el.style.left = `calc(${leftPct}% + 2px)`;
    el.style.width = `calc(${widthPct}% - 4px)`;
    el.title = `${event.title} ${formatTime(new Date(event.start_at))}–${formatTime(new Date(event.end_at))}`;
    el.innerHTML = `<div class="event-title"></div><div class="event-time">${formatTime(new Date(event.start_at))}–${formatTime(new Date(event.end_at))}</div>`;
    el.querySelector('.event-title').textContent = event.title;
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      openEditModal(event);
    });
    column.appendChild(el);
  }
}

function minuteFromPointer(e, column) {
  const rect = column.getBoundingClientRect();
  const y = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
  return Math.round((y / rect.height) * DAY_MINUTES / 5) * 5;
}

function dateAtMinute(day, minute) {
  const d = new Date(day);
  d.setHours(0, 0, 0, 0);
  d.setMinutes(minute);
  return d;
}

function attachSelectionHandlers(column, day) {
  column.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('.event')) return;
    e.preventDefault();
    const startMinute = minuteFromPointer(e, column);
    selection = { column, day, startMinute, currentMinute: startMinute, el: document.createElement('div') };
    selection.el.className = 'selection';
    column.appendChild(selection.el);
    column.classList.add('selecting');
    updateSelection();
    document.addEventListener('mousemove', onSelectionMove);
    document.addEventListener('mouseup', onSelectionEnd);
  });
}

function updateSelection() {
  if (!selection) return;
  const a = selection.startMinute;
  const b = selection.currentMinute;
  const start = Math.min(a, b);
  const end = Math.max(a, b);
  selection.el.style.top = `${yForMinutes(start)}px`;
  selection.el.style.height = `${Math.max(4, yForMinutes(end - start))}px`;
}

function onSelectionMove(e) {
  if (!selection) return;
  selection.currentMinute = minuteFromPointer(e, selection.column);
  updateSelection();
}

function onSelectionEnd() {
  if (!selection) return;
  document.removeEventListener('mousemove', onSelectionMove);
  document.removeEventListener('mouseup', onSelectionEnd);
  const { column, day, startMinute, currentMinute, el } = selection;
  column.classList.remove('selecting');
  el.remove();
  selection = null;

  let start = Math.min(startMinute, currentMinute);
  let end = Math.max(startMinute, currentMinute);
  if (end === start) end = Math.min(DAY_MINUTES, start + 30);
  if (start >= DAY_MINUTES) start = DAY_MINUTES - 30;
  if (end <= start) end = start + 30;
  openCreateModal(dateAtMinute(day, start), dateAtMinute(day, Math.min(end, DAY_MINUTES)));
}

function openCreateModal(start, end) {
  modalMode = 'create';
  editingEvent = null;
  modalTitle.textContent = 'Create event';
  titleInput.value = '';
  startInput.value = dateInputValue(start);
  endInput.value = dateInputValue(end);
  deleteButton.style.display = 'none';
  formError.textContent = '';
  modalBackdrop.classList.add('show');
  titleInput.focus();
}

function openEditModal(event) {
  modalMode = 'edit';
  editingEvent = event;
  modalTitle.textContent = 'Edit event';
  titleInput.value = event.title;
  startInput.value = dateInputValue(new Date(event.start_at));
  endInput.value = dateInputValue(new Date(event.end_at));
  deleteButton.style.display = '';
  formError.textContent = '';
  modalBackdrop.classList.add('show');
  titleInput.focus();
}

function closeModal() {
  modalBackdrop.classList.remove('show');
}

async function saveForm(e) {
  e.preventDefault();
  const title = titleInput.value.trim();
  const start = readInputDate(startInput);
  const end = readInputDate(endInput);
  if (!title) {
    formError.textContent = 'Title is required.';
    return;
  }
  if (!start || !end || end <= start) {
    formError.textContent = 'End must be after start.';
    return;
  }

  const payload = JSON.stringify({ title, start_at: start.toISOString(), end_at: end.toISOString() });
  try {
    if (modalMode === 'edit' && editingEvent) {
      await api(`/api/events/${editingEvent.id}`, { method: 'PUT', body: payload });
    } else {
      await api('/api/events', { method: 'POST', body: payload });
    }
    closeModal();
    await loadEvents();
  } catch (err) {
    formError.textContent = err.message;
  }
}

async function deleteCurrentEvent() {
  if (!editingEvent) return;
  if (!confirm('Delete this event?')) return;
  try {
    await api(`/api/events/${editingEvent.id}`, { method: 'DELETE' });
    closeModal();
    await loadEvents();
  } catch (err) {
    formError.textContent = err.message;
  }
}

document.querySelector('#prevWeek').addEventListener('click', () => {
  currentWeekStart = addDays(currentWeekStart, -7);
  loadEvents();
});
document.querySelector('#nextWeek').addEventListener('click', () => {
  currentWeekStart = addDays(currentWeekStart, 7);
  loadEvents();
});
document.querySelector('#today').addEventListener('click', () => {
  currentWeekStart = startOfWeek(new Date());
  loadEvents();
});
document.querySelector('#cancelButton').addEventListener('click', closeModal);
deleteButton.addEventListener('click', deleteCurrentEvent);
eventForm.addEventListener('submit', saveForm);
modalBackdrop.addEventListener('mousedown', (e) => {
  if (e.target === modalBackdrop) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});

render();
loadEvents();
