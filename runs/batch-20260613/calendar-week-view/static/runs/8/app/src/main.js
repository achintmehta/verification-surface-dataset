import './styles.css';

const MINUTES_PER_DAY = 24 * 60;
const HOUR_HEIGHT = 64;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const SHORT_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const API_BASE = '';

let weekStart = startOfWeek(new Date());
let events = [];
let selection = null;

const app = document.querySelector('#app');
app.innerHTML = `
  <header class="topbar">
    <div>
      <h1>Week Calendar</h1>
      <p class="subtle">Drag an empty area to create an event. Click an event to edit it.</p>
    </div>
    <nav class="week-nav" aria-label="Week navigation">
      <button id="prevWeek" type="button">← Previous</button>
      <button id="todayWeek" type="button">Today</button>
      <button id="nextWeek" type="button">Next →</button>
    </nav>
  </header>
  <main>
    <section class="calendar-shell" aria-live="polite">
      <div class="calendar-header">
        <div class="time-header"></div>
        <div id="dayHeaders" class="day-headers"></div>
      </div>
      <div class="calendar-scroll">
        <div class="time-axis" id="timeAxis"></div>
        <div class="week-grid" id="weekGrid"></div>
      </div>
    </section>
  </main>
  <dialog id="eventDialog" class="event-dialog">
    <form method="dialog" id="eventForm" novalidate>
      <input type="hidden" id="eventId" />
      <h2 id="dialogTitle">Create event</h2>
      <label>
        Title
        <input id="titleInput" name="title" required maxlength="200" autocomplete="off" />
      </label>
      <label>
        Start
        <input id="startInput" name="start" type="datetime-local" required />
      </label>
      <label>
        End
        <input id="endInput" name="end" type="datetime-local" required />
      </label>
      <p id="formError" class="form-error" role="alert"></p>
      <div class="dialog-actions">
        <button id="deleteButton" class="danger" type="button">Delete</button>
        <span class="spacer"></span>
        <button value="cancel" type="button" id="cancelButton">Cancel</button>
        <button id="saveButton" type="submit">Save</button>
      </div>
    </form>
  </dialog>
`;

const els = {
  prevWeek: document.querySelector('#prevWeek'),
  todayWeek: document.querySelector('#todayWeek'),
  nextWeek: document.querySelector('#nextWeek'),
  dayHeaders: document.querySelector('#dayHeaders'),
  timeAxis: document.querySelector('#timeAxis'),
  weekGrid: document.querySelector('#weekGrid'),
  dialog: document.querySelector('#eventDialog'),
  form: document.querySelector('#eventForm'),
  dialogTitle: document.querySelector('#dialogTitle'),
  eventId: document.querySelector('#eventId'),
  title: document.querySelector('#titleInput'),
  start: document.querySelector('#startInput'),
  end: document.querySelector('#endInput'),
  formError: document.querySelector('#formError'),
  deleteButton: document.querySelector('#deleteButton'),
  cancelButton: document.querySelector('#cancelButton')
};

els.prevWeek.addEventListener('click', () => changeWeek(-1));
els.todayWeek.addEventListener('click', () => { weekStart = startOfWeek(new Date()); loadWeek(); });
els.nextWeek.addEventListener('click', () => changeWeek(1));
els.form.addEventListener('submit', saveForm);
els.cancelButton.addEventListener('click', () => els.dialog.close());
els.deleteButton.addEventListener('click', deleteCurrentEvent);

renderTimeAxis();
loadWeek();

function changeWeek(delta) {
  weekStart = addDays(weekStart, delta * 7);
  loadWeek();
}

async function loadWeek() {
  const rangeStart = new Date(weekStart);
  const rangeEnd = addDays(rangeStart, 7);
  try {
    const response = await fetch(`${API_BASE}/api/events?start=${encodeURIComponent(rangeStart.toISOString())}&end=${encodeURIComponent(rangeEnd.toISOString())}`);
    if (!response.ok) throw new Error(await response.text());
    events = (await response.json()).map((event) => ({
      ...event,
      start: new Date(event.start_at),
      end: new Date(event.end_at)
    }));
    renderCalendar();
  } catch (error) {
    console.error(error);
    els.weekGrid.innerHTML = `<div class="load-error">Could not load events. Is the server running?</div>`;
  }
}

function renderCalendar() {
  renderHeaders();
  renderDays();
}

function renderHeaders() {
  const today = startOfDay(new Date()).getTime();
  const rangeEnd = addDays(weekStart, 7);
  const formatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
  const titleFormatter = new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
  document.title = `Week of ${titleFormatter.format(weekStart)} – Calendar`;
  els.dayHeaders.innerHTML = '';
  for (let i = 0; i < 7; i += 1) {
    const day = addDays(weekStart, i);
    const header = document.createElement('div');
    header.className = 'day-header';
    if (startOfDay(day).getTime() === today) header.classList.add('today');
    header.innerHTML = `<span class="weekday">${SHORT_DAYS[i]}</span><span class="date">${formatter.format(day)}</span>`;
    header.title = DAYS[i];
    els.dayHeaders.appendChild(header);
  }
  document.querySelector('h1').textContent = `${titleFormatter.format(weekStart)} – ${titleFormatter.format(addMs(rangeEnd, -1))}`;
}

function renderTimeAxis() {
  els.timeAxis.style.height = `${HOUR_HEIGHT * 24}px`;
  els.timeAxis.innerHTML = '';
  for (let hour = 0; hour <= 24; hour += 1) {
    const mark = document.createElement('div');
    mark.className = 'time-mark';
    mark.style.top = `${hour * HOUR_HEIGHT}px`;
    mark.textContent = String(hour).padStart(2, '0') + ':00';
    els.timeAxis.appendChild(mark);
  }
}

function renderDays() {
  els.weekGrid.innerHTML = '';
  els.weekGrid.style.height = `${HOUR_HEIGHT * 24}px`;
  const today = startOfDay(new Date()).getTime();

  for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
    const dayStart = addDays(weekStart, dayIndex);
    const dayEnd = addDays(dayStart, 1);
    const dayColumn = document.createElement('div');
    dayColumn.className = 'day-column';
    if (startOfDay(dayStart).getTime() === today) dayColumn.classList.add('today');
    dayColumn.dataset.dayIndex = String(dayIndex);

    const hourLines = document.createElement('div');
    hourLines.className = 'hour-lines';
    for (let hour = 0; hour < 24; hour += 1) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${hour * HOUR_HEIGHT}px`;
      hourLines.appendChild(line);
    }
    dayColumn.appendChild(hourLines);

    const dayEvents = events
      .filter((event) => event.start < dayEnd && event.end > dayStart)
      .map((event) => segmentForDay(event, dayStart, dayEnd))
      .filter(Boolean);

    for (const item of computeDayLayout(dayEvents)) {
      dayColumn.appendChild(renderEventBlock(item));
    }

    setupSelection(dayColumn, dayStart);
    els.weekGrid.appendChild(dayColumn);
  }
}

function renderEventBlock(item) {
  const event = item.event;
  const block = document.createElement('button');
  block.type = 'button';
  block.className = 'event-block';
  block.style.top = `${minutesSinceMidnight(item.visibleStart) * HOUR_HEIGHT / 60}px`;
  block.style.height = `${Math.max(1, (item.visibleEnd - item.visibleStart) / 60000 * HOUR_HEIGHT / 60)}px`;
  block.style.left = `${item.leftPercent}%`;
  block.style.width = `${item.widthPercent}%`;
  block.title = `${event.title}\n${formatTime(event.start)} – ${formatTime(event.end)}`;
  block.innerHTML = `
    <span class="event-title"></span>
    <span class="event-time">${formatTime(event.start)} – ${formatTime(event.end)}</span>
  `;
  block.querySelector('.event-title').textContent = event.title;
  block.addEventListener('click', (evt) => {
    evt.stopPropagation();
    openEventDialog(event);
  });
  return block;
}

function segmentForDay(event, dayStart, dayEnd) {
  const visibleStart = new Date(Math.max(event.start.getTime(), dayStart.getTime()));
  const visibleEnd = new Date(Math.min(event.end.getTime(), dayEnd.getTime()));
  if (visibleEnd <= visibleStart) return null;
  return { event, visibleStart, visibleEnd, startMin: minutesSinceMidnight(visibleStart), endMin: minutesSinceMidnight(visibleEnd) };
}

export function computeDayLayout(dayEvents) {
  const sorted = [...dayEvents].sort((a, b) => {
    const startDiff = a.visibleStart - b.visibleStart;
    if (startDiff) return startDiff;
    const endDiff = a.visibleEnd - b.visibleEnd;
    if (endDiff) return endDiff;
    return (a.event.id ?? 0) - (b.event.id ?? 0);
  });

  const clusters = [];
  let current = null;
  for (const item of sorted) {
    if (!current || item.visibleStart >= current.end) {
      current = { items: [], end: item.visibleEnd };
      clusters.push(current);
    }
    current.items.push(item);
    if (item.visibleEnd > current.end) current.end = item.visibleEnd;
  }

  const laidOut = [];
  for (const cluster of clusters) {
    const colEnds = [];
    const assignments = new Map();
    for (const item of cluster.items) {
      let column = colEnds.findIndex((end) => end <= item.visibleStart);
      if (column === -1) {
        column = colEnds.length;
        colEnds.push(item.visibleEnd);
      } else {
        colEnds[column] = item.visibleEnd;
      }
      assignments.set(item, column);
    }

    const columnCount = Math.max(1, colEnds.length);
    for (const item of cluster.items) {
      const column = assignments.get(item);
      laidOut.push({
        ...item,
        column,
        columnCount,
        leftPercent: (column / columnCount) * 100,
        widthPercent: 100 / columnCount
      });
    }
  }
  return laidOut;
}

function setupSelection(dayColumn, dayStart) {
  dayColumn.addEventListener('mousedown', (event) => {
    if (event.button !== 0 || event.target.closest('.event-block')) return;
    const startMinute = minuteFromPointer(event, dayColumn);
    selection = {
      dayColumn,
      dayStart,
      startMinute,
      currentMinute: startMinute,
      element: document.createElement('div')
    };
    selection.element.className = 'selection-range';
    dayColumn.appendChild(selection.element);
    updateSelectionVisual();
    event.preventDefault();
  });
}

document.addEventListener('mousemove', (event) => {
  if (!selection) return;
  selection.currentMinute = minuteFromPointer(event, selection.dayColumn);
  updateSelectionVisual();
});

document.addEventListener('mouseup', () => {
  if (!selection) return;
  const startMinute = Math.min(selection.startMinute, selection.currentMinute);
  let endMinute = Math.max(selection.startMinute, selection.currentMinute);
  if (endMinute === startMinute) endMinute = Math.min(MINUTES_PER_DAY, startMinute + 30);
  const roundedStart = clamp(roundToNearest(startMinute, 5), 0, MINUTES_PER_DAY - 1);
  const roundedEnd = clamp(roundToNearest(endMinute, 5), roundedStart + 1, MINUTES_PER_DAY);
  selection.element.remove();
  const dayStart = selection.dayStart;
  selection = null;
  openCreateDialog(addMinutes(dayStart, roundedStart), addMinutes(dayStart, roundedEnd));
});

function updateSelectionVisual() {
  const start = Math.min(selection.startMinute, selection.currentMinute);
  const end = Math.max(selection.startMinute, selection.currentMinute);
  const top = start * HOUR_HEIGHT / 60;
  const height = Math.max(2, (end - start) * HOUR_HEIGHT / 60);
  selection.element.style.top = `${top}px`;
  selection.element.style.height = `${height}px`;
}

function minuteFromPointer(pointerEvent, dayColumn) {
  const rect = dayColumn.getBoundingClientRect();
  const y = clamp(pointerEvent.clientY - rect.top, 0, HOUR_HEIGHT * 24);
  return clamp(Math.round(y / (HOUR_HEIGHT * 24) * MINUTES_PER_DAY), 0, MINUTES_PER_DAY);
}

function openCreateDialog(start, end) {
  els.form.reset();
  els.formError.textContent = '';
  els.eventId.value = '';
  els.dialogTitle.textContent = 'Create event';
  els.deleteButton.hidden = true;
  els.title.value = '';
  els.start.value = toDatetimeLocalValue(start);
  els.end.value = toDatetimeLocalValue(end);
  els.dialog.showModal();
  els.title.focus();
}

function openEventDialog(event) {
  els.form.reset();
  els.formError.textContent = '';
  els.eventId.value = String(event.id);
  els.dialogTitle.textContent = 'Edit event';
  els.deleteButton.hidden = false;
  els.title.value = event.title;
  els.start.value = toDatetimeLocalValue(event.start);
  els.end.value = toDatetimeLocalValue(event.end);
  els.dialog.showModal();
  els.title.focus();
}

async function saveForm(event) {
  event.preventDefault();
  els.formError.textContent = '';
  const title = els.title.value.trim();
  const start = new Date(els.start.value);
  const end = new Date(els.end.value);
  if (!title) return showFormError('Title is required.');
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return showFormError('Start and end are required.');
  if (end <= start) return showFormError('End must be after start.');

  const id = els.eventId.value;
  const payload = { title, start_at: start.toISOString(), end_at: end.toISOString() };
  const url = id ? `${API_BASE}/api/events/${id}` : `${API_BASE}/api/events`;
  const method = id ? 'PUT' : 'POST';
  try {
    const response = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      let message = 'Could not save event.';
      try { message = (await response.json()).error || message; } catch {}
      return showFormError(message);
    }
    els.dialog.close();
    await loadWeek();
  } catch (error) {
    console.error(error);
    showFormError('Could not reach the server.');
  }
}

async function deleteCurrentEvent() {
  const id = els.eventId.value;
  if (!id) return;
  if (!confirm('Delete this event?')) return;
  try {
    const response = await fetch(`${API_BASE}/api/events/${id}`, { method: 'DELETE' });
    if (!response.ok) return showFormError('Could not delete event.');
    els.dialog.close();
    await loadWeek();
  } catch (error) {
    console.error(error);
    showFormError('Could not reach the server.');
  }
}

function showFormError(message) {
  els.formError.textContent = message;
}

function startOfWeek(date) {
  const value = startOfDay(date);
  const day = value.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  return addDays(value, diff);
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date, days) {
  const value = new Date(date);
  value.setDate(value.getDate() + days);
  return value;
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function addMs(date, ms) {
  return new Date(date.getTime() + ms);
}

function minutesSinceMidnight(date) {
  return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60 + date.getMilliseconds() / 60000;
}

function toDatetimeLocalValue(date) {
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatTime(date) {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date);
}

function roundToNearest(value, amount) {
  return Math.round(value / amount) * amount;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
