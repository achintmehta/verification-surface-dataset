import './styles.css';

const HOUR_HEIGHT = 60;
const DAY_HEIGHT = HOUR_HEIGHT * 24;
const MINUTES_PER_DAY = 24 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;

const state = {
  weekStart: startOfWeek(new Date()),
  events: [],
  selection: null
};

const app = document.getElementById('app');
app.innerHTML = `
  <header class="topbar">
    <div>
      <h1>Week Calendar</h1>
      <div id="rangeLabel" class="range-label"></div>
    </div>
    <nav class="nav-buttons" aria-label="Week navigation">
      <button id="prevWeek" type="button">← Previous</button>
      <button id="today" type="button">Today</button>
      <button id="nextWeek" type="button">Next →</button>
    </nav>
  </header>
  <main class="calendar-shell">
    <div id="calendar" class="calendar"></div>
  </main>
  <div id="modal" class="modal hidden" role="dialog" aria-modal="true">
    <form id="eventForm" class="event-form">
      <div class="form-header">
        <h2 id="formTitle">New event</h2>
        <button id="closeModal" class="icon-button" type="button" aria-label="Close">×</button>
      </div>
      <input id="eventId" type="hidden" />
      <label>
        Title
        <input id="eventTitle" name="title" required maxlength="200" autocomplete="off" />
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
      <div class="form-actions">
        <button id="deleteEvent" class="danger hidden" type="button">Delete</button>
        <span class="spacer"></span>
        <button type="button" id="cancelForm">Cancel</button>
        <button type="submit" class="primary">Save</button>
      </div>
    </form>
  </div>
`;

const els = {
  rangeLabel: document.getElementById('rangeLabel'),
  calendar: document.getElementById('calendar'),
  modal: document.getElementById('modal'),
  form: document.getElementById('eventForm'),
  formTitle: document.getElementById('formTitle'),
  eventId: document.getElementById('eventId'),
  eventTitle: document.getElementById('eventTitle'),
  eventStart: document.getElementById('eventStart'),
  eventEnd: document.getElementById('eventEnd'),
  formError: document.getElementById('formError'),
  deleteEvent: document.getElementById('deleteEvent')
};

document.getElementById('prevWeek').addEventListener('click', () => moveWeek(-1));
document.getElementById('nextWeek').addEventListener('click', () => moveWeek(1));
document.getElementById('today').addEventListener('click', () => {
  state.weekStart = startOfWeek(new Date());
  loadWeek();
});
document.getElementById('closeModal').addEventListener('click', closeModal);
document.getElementById('cancelForm').addEventListener('click', closeModal);
els.modal.addEventListener('click', (event) => {
  if (event.target === els.modal) closeModal();
});
els.form.addEventListener('submit', saveForm);
els.deleteEvent.addEventListener('click', deleteCurrentEvent);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !els.modal.classList.contains('hidden')) closeModal();
});

loadWeek();

function moveWeek(delta) {
  state.weekStart = addDays(state.weekStart, delta * 7);
  loadWeek();
}

async function loadWeek() {
  const start = state.weekStart;
  const end = addDays(start, 7);
  els.rangeLabel.textContent = `${formatLongDate(start)} – ${formatLongDate(addDays(end, -1))}`;
  renderSkeleton();
  try {
    const response = await fetch(`/api/events?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`);
    if (!response.ok) throw new Error(await errorText(response));
    state.events = await response.json();
    renderEvents();
  } catch (err) {
    showCalendarMessage(`Could not load events: ${err.message}`);
  }
}

function renderSkeleton() {
  els.calendar.innerHTML = '';
  const corner = document.createElement('div');
  corner.className = 'time-axis header-corner';
  els.calendar.appendChild(corner);

  const todayKey = dateKey(new Date());
  for (let i = 0; i < 7; i++) {
    const day = addDays(state.weekStart, i);
    const header = document.createElement('div');
    header.className = `day-header ${dateKey(day) === todayKey ? 'today' : ''}`;
    header.innerHTML = `<span class="weekday">${weekdayName(day)}</span><span class="date-number">${day.getDate()}</span>`;
    els.calendar.appendChild(header);
  }

  const axis = document.createElement('div');
  axis.className = 'time-axis time-labels';
  axis.style.height = `${DAY_HEIGHT}px`;
  for (let h = 0; h <= 24; h++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = `${h * HOUR_HEIGHT}px`;
    label.textContent = `${String(h).padStart(2, '0')}:00`;
    axis.appendChild(label);
  }
  els.calendar.appendChild(axis);

  for (let i = 0; i < 7; i++) {
    const day = addDays(state.weekStart, i);
    const col = document.createElement('div');
    col.className = `day-column ${dateKey(day) === todayKey ? 'today' : ''}`;
    col.dataset.dayIndex = String(i);
    col.style.height = `${DAY_HEIGHT}px`;
    for (let h = 0; h < 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-row';
      line.style.top = `${h * HOUR_HEIGHT}px`;
      col.appendChild(line);
    }
    attachSelectionHandlers(col, day);
    els.calendar.appendChild(col);
  }
}

function renderEvents() {
  document.querySelectorAll('.event-block, .selection-block').forEach((node) => node.remove());
  const segmentsByDay = Array.from({ length: 7 }, () => []);
  const weekEnd = addDays(state.weekStart, 7);

  for (const event of state.events) {
    const start = new Date(event.start_at);
    const end = new Date(event.end_at);
    if (end <= state.weekStart || start >= weekEnd) continue;
    for (let i = 0; i < 7; i++) {
      const dayStart = addDays(state.weekStart, i);
      const dayEnd = addDays(dayStart, 1);
      if (start < dayEnd && end > dayStart) {
        const segStart = maxDate(start, dayStart);
        const segEnd = minDate(end, dayEnd);
        if (segEnd > segStart) {
          segmentsByDay[i].push({ ...event, originalStart: start, originalEnd: end, dayStart, segStart, segEnd });
        }
      }
    }
  }

  for (let i = 0; i < 7; i++) {
    const column = els.calendar.querySelector(`.day-column[data-day-index="${i}"]`);
    const laidOut = layoutDayEvents(segmentsByDay[i]);
    for (const item of laidOut) {
      column.appendChild(eventElement(item));
    }
  }
}

function eventElement(item) {
  const top = minutesSince(item.dayStart, item.segStart) / MINUTES_PER_DAY * DAY_HEIGHT;
  const bottom = minutesSince(item.dayStart, item.segEnd) / MINUTES_PER_DAY * DAY_HEIGHT;
  const height = Math.max(1, bottom - top);
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'event-block';
  el.style.top = `${top}px`;
  el.style.height = `${height}px`;
  el.style.left = `calc(${item.leftPct}% + 2px)`;
  el.style.width = `calc(${item.widthPct}% - 4px)`;
  el.title = `${item.title} (${formatTime(item.originalStart)}–${formatTime(item.originalEnd)})`;
  el.innerHTML = `<strong>${escapeHtml(item.title)}</strong><span>${formatTime(item.originalStart)}–${formatTime(item.originalEnd)}</span>`;
  el.addEventListener('click', (event) => {
    event.stopPropagation();
    openEdit(item);
  });
  return el;
}

export function layoutDayEvents(events) {
  const sorted = [...events].sort((a, b) => a.segStart - b.segStart || a.segEnd - b.segEnd || a.id - b.id);
  const laidOut = [];
  let cluster = [];
  let clusterEnd = null;

  function flush() {
    if (!cluster.length) return;
    laidOut.push(...layoutCluster(cluster));
    cluster = [];
    clusterEnd = null;
  }

  for (const event of sorted) {
    if (!cluster.length) {
      cluster = [event];
      clusterEnd = event.segEnd;
    } else if (event.segStart < clusterEnd) {
      cluster.push(event);
      if (event.segEnd > clusterEnd) clusterEnd = event.segEnd;
    } else {
      flush();
      cluster = [event];
      clusterEnd = event.segEnd;
    }
  }
  flush();
  return laidOut;
}

function layoutCluster(cluster) {
  const columns = [];
  const assigned = [];
  for (const event of cluster) {
    let col = columns.findIndex((end) => end <= event.segStart);
    if (col === -1) {
      col = columns.length;
      columns.push(event.segEnd);
    } else {
      columns[col] = event.segEnd;
    }
    assigned.push({ ...event, layoutColumn: col });
  }
  const count = Math.max(1, columns.length);
  return assigned.map((event) => ({
    ...event,
    leftPct: event.layoutColumn * 100 / count,
    widthPct: 100 / count
  }));
}

function attachSelectionHandlers(column, day) {
  let startY = null;
  let preview = null;

  const removePreview = () => {
    if (preview) preview.remove();
    preview = null;
  };
  const yToMinute = (clientY) => {
    const rect = column.getBoundingClientRect();
    const y = clamp(clientY - rect.top, 0, rect.height);
    return clamp(Math.round(y / rect.height * MINUTES_PER_DAY), 0, MINUTES_PER_DAY);
  };
  const drawPreview = (a, b) => {
    removePreview();
    const topMinute = Math.min(a, b);
    const bottomMinute = Math.max(a, b);
    preview = document.createElement('div');
    preview.className = 'selection-block';
    preview.style.top = `${topMinute / MINUTES_PER_DAY * DAY_HEIGHT}px`;
    preview.style.height = `${Math.max(2, (bottomMinute - topMinute) / MINUTES_PER_DAY * DAY_HEIGHT)}px`;
    column.appendChild(preview);
  };

  column.addEventListener('mousedown', (event) => {
    if (event.button !== 0 || event.target.closest('.event-block')) return;
    startY = yToMinute(event.clientY);
    drawPreview(startY, Math.min(MINUTES_PER_DAY, startY + 30));
    event.preventDefault();
  });
  column.addEventListener('mousemove', (event) => {
    if (startY == null) return;
    drawPreview(startY, yToMinute(event.clientY));
  });
  window.addEventListener('mouseup', (event) => {
    if (startY == null) return;
    const endY = yToMinute(event.clientY);
    removePreview();
    let startMinute = Math.min(startY, endY);
    let endMinute = Math.max(startY, endY);
    if (endMinute === startMinute) endMinute = Math.min(MINUTES_PER_DAY, startMinute + 30);
    if (endMinute === startMinute) startMinute = Math.max(0, endMinute - 30);
    startY = null;
    openCreate(addMinutes(day, startMinute), addMinutes(day, endMinute));
  });
}

function openCreate(start, end) {
  els.form.reset();
  els.eventId.value = '';
  els.formTitle.textContent = 'New event';
  els.eventTitle.value = '';
  els.eventStart.value = toDateTimeLocalValue(start);
  els.eventEnd.value = toDateTimeLocalValue(end);
  els.deleteEvent.classList.add('hidden');
  els.formError.textContent = '';
  els.modal.classList.remove('hidden');
  els.eventTitle.focus();
}

function openEdit(event) {
  els.form.reset();
  els.eventId.value = event.id;
  els.formTitle.textContent = 'Edit event';
  els.eventTitle.value = event.title;
  els.eventStart.value = toDateTimeLocalValue(event.originalStart);
  els.eventEnd.value = toDateTimeLocalValue(event.originalEnd);
  els.deleteEvent.classList.remove('hidden');
  els.formError.textContent = '';
  els.modal.classList.remove('hidden');
  els.eventTitle.focus();
}

function closeModal() {
  els.modal.classList.add('hidden');
  els.formError.textContent = '';
}

async function saveForm(event) {
  event.preventDefault();
  els.formError.textContent = '';
  const id = els.eventId.value;
  const title = els.eventTitle.value.trim();
  const start = parseDateTimeLocal(els.eventStart.value);
  const end = parseDateTimeLocal(els.eventEnd.value);
  if (!title) return (els.formError.textContent = 'Title is required.');
  if (!start || !end || end <= start) return (els.formError.textContent = 'End must be after start.');

  const payload = { title, start_at: start.toISOString(), end_at: end.toISOString() };
  try {
    const response = await fetch(id ? `/api/events/${id}` : '/api/events', {
      method: id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error(await errorText(response));
    closeModal();
    await loadWeek();
  } catch (err) {
    els.formError.textContent = err.message;
  }
}

async function deleteCurrentEvent() {
  const id = els.eventId.value;
  if (!id) return;
  if (!confirm('Delete this event?')) return;
  try {
    const response = await fetch(`/api/events/${id}`, { method: 'DELETE' });
    if (!response.ok) throw new Error(await errorText(response));
    closeModal();
    await loadWeek();
  } catch (err) {
    els.formError.textContent = err.message;
  }
}

async function errorText(response) {
  try {
    const body = await response.json();
    return body.error || response.statusText;
  } catch {
    return response.statusText;
  }
}

function showCalendarMessage(message) {
  const el = document.createElement('div');
  el.className = 'calendar-message';
  el.textContent = message;
  els.calendar.appendChild(el);
}

function startOfWeek(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
}
function addDays(date, days) { return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days); }
function addMinutes(date, minutes) { return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, minutes); }
function maxDate(a, b) { return a > b ? a : b; }
function minDate(a, b) { return a < b ? a : b; }
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
function minutesSince(start, date) { return (date - start) / 60000; }
function dateKey(date) { return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`; }
function weekdayName(date) { return date.toLocaleDateString(undefined, { weekday: 'short' }); }
function formatLongDate(date) { return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
function formatTime(date) { return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); }
function toDateTimeLocalValue(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function parseDateTimeLocal(value) { return value ? new Date(value) : null; }
function escapeHtml(value) {
  return value.replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}
