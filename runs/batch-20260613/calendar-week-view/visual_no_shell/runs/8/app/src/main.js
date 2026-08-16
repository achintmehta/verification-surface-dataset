import './styles.css';

const MINUTES_PER_DAY = 24 * 60;
const PIXELS_PER_MINUTE = 1;
const DAY_HEIGHT = MINUTES_PER_DAY * PIXELS_PER_MINUTE;
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const state = {
  weekStart: startOfWeek(new Date()),
  events: [],
  selection: null,
  drag: null
};

const app = document.querySelector('#app');
app.innerHTML = `
  <div class="calendar-app">
    <header class="toolbar">
      <div class="toolbar-left">
        <button id="prevWeek" type="button" title="Previous week">← Previous</button>
        <button id="today" type="button">Today</button>
        <button id="nextWeek" type="button" title="Next week">Next →</button>
      </div>
      <h1 id="weekTitle">Week Calendar</h1>
      <button id="newEvent" type="button" class="primary">New event</button>
    </header>

    <main class="calendar-shell">
      <div class="week-header" id="weekHeader"></div>
      <div class="week-scroll" id="weekScroll">
        <div class="time-axis" id="timeAxis"></div>
        <div class="week-grid" id="weekGrid"></div>
      </div>
    </main>
  </div>

  <dialog id="eventDialog" class="event-dialog">
    <form id="eventForm" method="dialog">
      <h2 id="dialogTitle">Event</h2>
      <input id="eventId" type="hidden" />
      <label>
        Title
        <input id="eventTitle" name="title" type="text" required maxlength="200" autocomplete="off" />
      </label>
      <div class="form-row">
        <label>
          Start
          <input id="eventStart" name="start" type="datetime-local" step="60" required />
        </label>
        <label>
          End
          <input id="eventEnd" name="end" type="datetime-local" step="60" required />
        </label>
      </div>
      <p id="formError" class="form-error" role="alert"></p>
      <menu>
        <button id="deleteEvent" type="button" class="danger">Delete</button>
        <span class="spacer"></span>
        <button id="cancelDialog" type="button">Cancel</button>
        <button id="saveEvent" type="submit" class="primary">Save</button>
      </menu>
    </form>
  </dialog>
`;

const els = {
  prevWeek: document.querySelector('#prevWeek'),
  today: document.querySelector('#today'),
  nextWeek: document.querySelector('#nextWeek'),
  newEvent: document.querySelector('#newEvent'),
  weekTitle: document.querySelector('#weekTitle'),
  weekHeader: document.querySelector('#weekHeader'),
  weekGrid: document.querySelector('#weekGrid'),
  timeAxis: document.querySelector('#timeAxis'),
  weekScroll: document.querySelector('#weekScroll'),
  dialog: document.querySelector('#eventDialog'),
  form: document.querySelector('#eventForm'),
  dialogTitle: document.querySelector('#dialogTitle'),
  eventId: document.querySelector('#eventId'),
  eventTitle: document.querySelector('#eventTitle'),
  eventStart: document.querySelector('#eventStart'),
  eventEnd: document.querySelector('#eventEnd'),
  formError: document.querySelector('#formError'),
  deleteEvent: document.querySelector('#deleteEvent'),
  cancelDialog: document.querySelector('#cancelDialog')
};

installListeners();
renderStaticAxis();
loadWeek();

function installListeners() {
  els.prevWeek.addEventListener('click', () => changeWeek(-1));
  els.nextWeek.addEventListener('click', () => changeWeek(1));
  els.today.addEventListener('click', () => {
    state.weekStart = startOfWeek(new Date());
    loadWeek();
  });
  els.newEvent.addEventListener('click', () => {
    const start = new Date();
    start.setSeconds(0, 0);
    const rounded = roundToNextMinutes(start, 15);
    const end = addMinutes(rounded, 30);
    openCreateDialog(rounded, end);
  });
  els.cancelDialog.addEventListener('click', () => closeDialog());
  els.dialog.addEventListener('click', (event) => {
    if (event.target === els.dialog) closeDialog();
  });
  els.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    await saveDialogEvent();
  });
  els.deleteEvent.addEventListener('click', deleteDialogEvent);

  window.addEventListener('mousemove', onDragMove);
  window.addEventListener('mouseup', onDragEnd);
}

async function changeWeek(delta) {
  state.weekStart = addDays(state.weekStart, delta * 7);
  await loadWeek();
}

async function loadWeek() {
  const start = state.weekStart;
  const end = addDays(start, 7);
  els.weekTitle.textContent = `${formatShortDate(start)} – ${formatShortDate(addDays(start, 6))}`;
  renderHeaders();
  renderEmptyDays();
  try {
    const response = await fetch(`/api/events?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`);
    if (!response.ok) throw new Error('Could not load events.');
    state.events = await response.json();
    renderEvents();
  } catch (error) {
    console.error(error);
    showToast('Unable to load events from the server.');
  }
}

function renderStaticAxis() {
  els.timeAxis.style.height = `${DAY_HEIGHT}px`;
  els.timeAxis.innerHTML = '';
  for (let hour = 0; hour <= 24; hour++) {
    const marker = document.createElement('div');
    marker.className = 'time-label';
    marker.style.top = `${hour * 60 * PIXELS_PER_MINUTE}px`;
    marker.textContent = `${String(hour).padStart(2, '0')}:00`;
    els.timeAxis.appendChild(marker);
  }
}

function renderHeaders() {
  els.weekHeader.innerHTML = '<div class="header-gutter"></div>';
  const todayKey = dateKey(new Date());
  for (let i = 0; i < 7; i++) {
    const day = addDays(state.weekStart, i);
    const header = document.createElement('div');
    header.className = `day-header ${dateKey(day) === todayKey ? 'today' : ''}`;
    header.innerHTML = `<strong>${DAY_NAMES[i]}</strong><span>${formatHeaderDate(day)}</span>`;
    els.weekHeader.appendChild(header);
  }
}

function renderEmptyDays() {
  els.weekGrid.innerHTML = '';
  const todayKey = dateKey(new Date());
  for (let i = 0; i < 7; i++) {
    const day = addDays(state.weekStart, i);
    const col = document.createElement('section');
    col.className = `day-column ${dateKey(day) === todayKey ? 'today' : ''}`;
    col.dataset.dayIndex = String(i);
    col.style.height = `${DAY_HEIGHT}px`;
    for (let hour = 0; hour < 24; hour++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${hour * 60}px`;
      col.appendChild(line);
      const half = document.createElement('div');
      half.className = 'half-hour-line';
      half.style.top = `${hour * 60 + 30}px`;
      col.appendChild(half);
    }
    col.addEventListener('mousedown', onDayMouseDown);
    els.weekGrid.appendChild(col);
  }
}

function renderEvents() {
  document.querySelectorAll('.event-block, .selection-block').forEach((node) => node.remove());
  const segmentsByDay = Array.from({ length: 7 }, () => []);

  state.events.forEach((event) => {
    for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
      const dayStart = addDays(state.weekStart, dayIndex);
      const dayEnd = addDays(dayStart, 1);
      const start = new Date(event.start_at);
      const end = new Date(event.end_at);
      if (start < dayEnd && end > dayStart) {
        const clampedStart = new Date(Math.max(start.getTime(), dayStart.getTime()));
        const clampedEnd = new Date(Math.min(end.getTime(), dayEnd.getTime()));
        segmentsByDay[dayIndex].push({
          ...event,
          segmentStart: clampedStart,
          segmentEnd: clampedEnd,
          startMinute: minutesFromDayStart(clampedStart, dayStart),
          endMinute: minutesFromDayStart(clampedEnd, dayStart)
        });
      }
    }
  });

  segmentsByDay.forEach((segments, dayIndex) => {
    const column = els.weekGrid.querySelector(`[data-day-index="${dayIndex}"]`);
    const laidOut = layoutDayEvents(segments);
    laidOut.forEach((event) => column.appendChild(createEventElement(event)));
  });
}

function createEventElement(event) {
  const block = document.createElement('button');
  block.type = 'button';
  block.className = 'event-block';
  block.dataset.id = event.id;
  const top = Math.max(0, event.startMinute) * PIXELS_PER_MINUTE;
  const height = Math.max(1, event.endMinute - event.startMinute) * PIXELS_PER_MINUTE;
  const width = 100 / event.columnCount;
  block.style.top = `${top}px`;
  block.style.height = `${height}px`;
  block.style.left = `${event.columnIndex * width}%`;
  block.style.width = `${width}%`;
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

function layoutDayEvents(events) {
  const sorted = [...events]
    .filter((event) => event.endMinute > event.startMinute)
    .sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute || String(a.id).localeCompare(String(b.id)));
  const result = [];
  let i = 0;

  while (i < sorted.length) {
    const cluster = [sorted[i]];
    let clusterEnd = sorted[i].endMinute;
    i++;
    while (i < sorted.length && sorted[i].startMinute < clusterEnd) {
      cluster.push(sorted[i]);
      clusterEnd = Math.max(clusterEnd, sorted[i].endMinute);
      i++;
    }

    const columns = [];
    cluster.forEach((event) => {
      let chosen = columns.findIndex((endMinute) => endMinute <= event.startMinute);
      if (chosen === -1) {
        chosen = columns.length;
        columns.push(event.endMinute);
      } else {
        columns[chosen] = event.endMinute;
      }
      event.columnIndex = chosen;
    });
    const columnCount = Math.max(1, columns.length);
    cluster.forEach((event) => result.push({ ...event, columnCount }));
  }
  return result;
}

function onDayMouseDown(event) {
  if (event.button !== 0 || event.target.closest('.event-block')) return;
  const column = event.currentTarget;
  const dayIndex = Number(column.dataset.dayIndex);
  const startMinute = minuteFromPointer(event, column);
  state.drag = { column, dayIndex, startMinute, currentMinute: startMinute, moved: false };
  renderSelection();
  event.preventDefault();
}

function onDragMove(event) {
  if (!state.drag) return;
  const minute = minuteFromPointer(event, state.drag.column);
  if (Math.abs(minute - state.drag.startMinute) > 2) state.drag.moved = true;
  state.drag.currentMinute = minute;
  renderSelection();
}

function onDragEnd() {
  if (!state.drag) return;
  const { dayIndex, startMinute, currentMinute, moved } = state.drag;
  clearSelection();
  state.drag = null;

  let a = startMinute;
  let b = currentMinute;
  if (!moved || a === b) b = Math.min(MINUTES_PER_DAY, a + 30);
  let min = Math.min(a, b);
  let max = Math.max(a, b);
  if (min >= MINUTES_PER_DAY) min = MINUTES_PER_DAY - 1;
  max = Math.min(MINUTES_PER_DAY, Math.max(min + 1, max));
  const start = addMinutes(addDays(state.weekStart, dayIndex), min);
  const end = addMinutes(addDays(state.weekStart, dayIndex), max);
  openCreateDialog(start, end);
}

function renderSelection() {
  clearSelection();
  if (!state.drag) return;
  const { column, startMinute, currentMinute } = state.drag;
  const min = Math.min(startMinute, currentMinute);
  const max = Math.max(startMinute, currentMinute);
  const block = document.createElement('div');
  block.className = 'selection-block';
  block.style.top = `${min}px`;
  block.style.height = `${Math.max(1, max - min)}px`;
  column.appendChild(block);
}

function clearSelection() {
  document.querySelectorAll('.selection-block').forEach((node) => node.remove());
}

function minuteFromPointer(event, column) {
  const rect = column.getBoundingClientRect();
  const raw = event.clientY - rect.top;
  return Math.max(0, Math.min(MINUTES_PER_DAY, Math.round(raw / PIXELS_PER_MINUTE)));
}

function openCreateDialog(start, end) {
  if (minutesFromDayStart(start, startOfDay(start)) >= MINUTES_PER_DAY) start = addMinutes(startOfDay(start), MINUTES_PER_DAY - 1);
  if (end <= start) end = addMinutes(start, 30);
  els.dialogTitle.textContent = 'Create event';
  els.eventId.value = '';
  els.eventTitle.value = '';
  els.eventStart.value = toDateTimeLocalValue(start);
  els.eventEnd.value = toDateTimeLocalValue(end);
  els.deleteEvent.hidden = true;
  els.formError.textContent = '';
  showDialog();
}

function openEditDialog(event) {
  els.dialogTitle.textContent = 'Edit event';
  els.eventId.value = event.id;
  els.eventTitle.value = event.title;
  els.eventStart.value = toDateTimeLocalValue(new Date(event.start_at));
  els.eventEnd.value = toDateTimeLocalValue(new Date(event.end_at));
  els.deleteEvent.hidden = false;
  els.formError.textContent = '';
  showDialog();
}

function showDialog() {
  if (typeof els.dialog.showModal === 'function') els.dialog.showModal();
  else els.dialog.setAttribute('open', '');
  setTimeout(() => els.eventTitle.focus(), 0);
}

function closeDialog() {
  els.dialog.close?.();
  els.dialog.removeAttribute('open');
}

async function saveDialogEvent() {
  const id = els.eventId.value;
  const title = els.eventTitle.value.trim();
  const start = localInputToDate(els.eventStart.value);
  const end = localInputToDate(els.eventEnd.value);
  if (!title) return setFormError('Title is required.');
  if (!isValidDate(start) || !isValidDate(end)) return setFormError('Start and end are required.');
  if (end <= start) return setFormError('End must be after start.');
  const payload = {
    title,
    start_at: start.toISOString(),
    end_at: end.toISOString()
  };

  try {
    const response = await fetch(id ? `/api/events/${id}` : '/api/events', {
      method: id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Save failed.');
    }
    closeDialog();
    await loadWeek();
  } catch (error) {
    setFormError(error.message);
  }
}

async function deleteDialogEvent() {
  const id = els.eventId.value;
  if (!id || !confirm('Delete this event?')) return;
  try {
    const response = await fetch(`/api/events/${id}`, { method: 'DELETE' });
    if (!response.ok) throw new Error('Delete failed.');
    closeDialog();
    await loadWeek();
  } catch (error) {
    setFormError(error.message);
  }
}

function setFormError(message) {
  els.formError.textContent = message;
}

function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

function startOfWeek(date) {
  const d = startOfDay(date);
  const day = d.getDay();
  const diff = (day + 6) % 7;
  d.setDate(d.getDate() - diff);
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

function addMinutes(date, minutes) {
  const d = new Date(date);
  d.setMinutes(d.getMinutes() + minutes);
  return d;
}

function minutesFromDayStart(date, dayStart) {
  const nextDay = addDays(dayStart, 1);
  if (date.getTime() >= nextDay.getTime()) return MINUTES_PER_DAY;
  if (date.getTime() <= dayStart.getTime()) return 0;
  return date.getHours() * 60 + date.getMinutes();
}

function roundToNextMinutes(date, interval) {
  const d = new Date(date);
  const mins = d.getMinutes();
  const rounded = Math.ceil(mins / interval) * interval;
  d.setMinutes(rounded, 0, 0);
  return d;
}

function toDateTimeLocalValue(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function localInputToDate(value) {
  return new Date(value);
}

function isValidDate(date) {
  return date instanceof Date && !Number.isNaN(date.getTime());
}

function formatTime(date) {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

function formatShortDate(date) {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
}

function formatHeaderDate(date) {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
}

function dateKey(date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
