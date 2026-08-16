import './styles.css';

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const SHORT_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MINUTES_PER_DAY = 24 * 60;
const EVENT_GAP_PX = 0;

const state = {
  weekStart: startOfWeek(new Date()),
  events: [],
  loading: false,
};

const app = document.querySelector('#app');
app.innerHTML = `
  <div class="app-shell">
    <header class="toolbar">
      <div>
        <h1>Week Calendar</h1>
        <div class="status" id="weekLabel"></div>
      </div>
      <div class="controls">
        <button class="btn" id="prevWeek" type="button">← Previous</button>
        <button class="btn" id="todayWeek" type="button">Today</button>
        <button class="btn" id="nextWeek" type="button">Next →</button>
        <button class="btn primary" id="newEvent" type="button">New event</button>
      </div>
    </header>
    <main class="calendar-wrap">
      <div class="calendar" id="calendar"></div>
    </main>
  </div>
  <div id="modalRoot"></div>
`;

const calendarEl = document.querySelector('#calendar');
const weekLabelEl = document.querySelector('#weekLabel');
const modalRoot = document.querySelector('#modalRoot');

document.querySelector('#prevWeek').addEventListener('click', () => changeWeek(-1));
document.querySelector('#todayWeek').addEventListener('click', () => {
  state.weekStart = startOfWeek(new Date());
  loadAndRender();
});
document.querySelector('#nextWeek').addEventListener('click', () => changeWeek(1));
document.querySelector('#newEvent').addEventListener('click', () => {
  const start = new Date();
  start.setSeconds(0, 0);
  start.setMinutes(Math.ceil(start.getMinutes() / 15) * 15);
  const dayIndex = clamp(Math.floor((startOfDay(start) - state.weekStart) / 86400000), 0, 6);
  const day = addDays(state.weekStart, dayIndex);
  const minutes = dayIndex >= 0 && dayIndex <= 6 ? start.getHours() * 60 + start.getMinutes() : 9 * 60;
  openEventModal({ start: dateAtMinutes(day, minutes), end: dateAtMinutes(day, Math.min(minutes + 60, MINUTES_PER_DAY)) });
});

function changeWeek(delta) {
  state.weekStart = addDays(state.weekStart, delta * 7);
  loadAndRender();
}

async function loadAndRender() {
  state.loading = true;
  renderShell();
  try {
    const start = state.weekStart;
    const end = addDays(start, 7);
    const response = await fetch(`/api/events?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`);
    if (!response.ok) throw new Error(await response.text());
    state.events = await response.json();
    state.loading = false;
    renderShell();
  } catch (error) {
    state.loading = false;
    weekLabelEl.textContent = `Failed to load events: ${error.message}`;
  }
}

function renderShell() {
  const weekEnd = addDays(state.weekStart, 6);
  weekLabelEl.textContent = `${formatDateLong(state.weekStart)} – ${formatDateLong(weekEnd)}${state.loading ? ' · loading…' : ''}`;
  calendarEl.innerHTML = '';

  const corner = document.createElement('div');
  corner.className = 'corner';
  calendarEl.append(corner);

  const today = startOfDay(new Date());
  const days = Array.from({ length: 7 }, (_, i) => addDays(state.weekStart, i));
  for (const [index, day] of days.entries()) {
    const header = document.createElement('div');
    header.className = `day-header${sameDay(day, today) ? ' today' : ''}`;
    header.style.gridColumn = String(index + 2);
    header.innerHTML = `<div class="day-name">${DAYS[index]}</div><div class="day-date">${day.getDate()}</div><div class="status">${formatMonth(day)}</div>`;
    calendarEl.append(header);
  }

  const gutter = document.createElement('div');
  gutter.className = 'time-gutter';
  for (let hour = 0; hour <= 24; hour += 1) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = `${(hour / 24) * 100}%`;
    label.textContent = `${String(hour).padStart(2, '0')}:00`;
    gutter.append(label);
  }
  calendarEl.append(gutter);

  for (const [index, day] of days.entries()) {
    const body = document.createElement('section');
    body.className = `day-body${sameDay(day, today) ? ' today' : ''}`;
    body.style.gridColumn = String(index + 2);
    body.dataset.dayIndex = String(index);
    drawGridLines(body);
    installSelectionHandlers(body, day);
    calendarEl.append(body);
  }

  renderEvents(days);
}

function drawGridLines(dayBody) {
  for (let hour = 0; hour <= 24; hour += 1) {
    const line = document.createElement('div');
    line.className = 'hour-line';
    line.style.top = `${(hour / 24) * 100}%`;
    dayBody.append(line);
    if (hour < 24) {
      const half = document.createElement('div');
      half.className = 'half-hour-line';
      half.style.top = `${((hour * 60 + 30) / MINUTES_PER_DAY) * 100}%`;
      dayBody.append(half);
    }
  }
}

function renderEvents(days) {
  const dayBodies = [...document.querySelectorAll('.day-body')];
  for (const [dayIndex, day] of days.entries()) {
    const dayStart = day.getTime();
    const dayEnd = addDays(day, 1).getTime();
    const segments = state.events
      .map((event) => toDaySegment(event, dayStart, dayEnd))
      .filter(Boolean);
    const laidOut = layoutDayEvents(segments);
    for (const item of laidOut) {
      dayBodies[dayIndex].append(renderEventElement(item));
    }
  }
}

function toDaySegment(event, dayStartMs, dayEndMs) {
  const startMs = new Date(event.start_at).getTime();
  const endMs = new Date(event.end_at).getTime();
  if (startMs >= dayEndMs || endMs <= dayStartMs) return null;
  const clampedStartMs = Math.max(startMs, dayStartMs);
  const clampedEndMs = Math.min(endMs, dayEndMs);
  const startMinutes = (clampedStartMs - dayStartMs) / 60000;
  const endMinutes = (clampedEndMs - dayStartMs) / 60000;
  if (endMinutes <= startMinutes) return null;
  return { ...event, startMinutes, endMinutes, startDate: new Date(startMs), endDate: new Date(endMs) };
}

export function layoutDayEvents(events) {
  const sorted = [...events].sort((a, b) => a.startMinutes - b.startMinutes || a.endMinutes - b.endMinutes || String(a.id).localeCompare(String(b.id)));
  const clusters = [];
  let current = null;

  for (const event of sorted) {
    if (!current || event.startMinutes >= current.endMinutes) {
      current = { events: [], endMinutes: event.endMinutes };
      clusters.push(current);
    }
    current.events.push(event);
    current.endMinutes = Math.max(current.endMinutes, event.endMinutes);
  }

  const result = [];
  for (const cluster of clusters) {
    const columnEnds = [];
    const assignments = [];

    for (const event of cluster.events) {
      let column = columnEnds.findIndex((end) => end <= event.startMinutes);
      if (column === -1) {
        column = columnEnds.length;
        columnEnds.push(event.endMinutes);
      } else {
        columnEnds[column] = event.endMinutes;
      }
      assignments.push({ event, column });
    }

    const columns = Math.max(columnEnds.length, 1);
    for (const assignment of assignments) {
      result.push({ ...assignment.event, column: assignment.column, columns });
    }
  }
  return result;
}

function renderEventElement(event) {
  const el = document.createElement('article');
  el.className = 'event';
  const top = (event.startMinutes / MINUTES_PER_DAY) * 100;
  const height = ((event.endMinutes - event.startMinutes) / MINUTES_PER_DAY) * 100;
  const width = 100 / event.columns;
  el.style.top = `${top}%`;
  el.style.height = `${height}%`;
  el.style.left = `calc(${event.column * width}% + ${EVENT_GAP_PX}px)`;
  el.style.width = `calc(${width}% - ${EVENT_GAP_PX * 2}px)`;
  el.title = `${event.title} (${formatTime(event.startDate)}–${formatTime(event.endDate)})`;
  el.innerHTML = `<div class="event-title"></div><div class="event-time">${formatTime(event.startDate)}–${formatTime(event.endDate)}</div>`;
  el.querySelector('.event-title').textContent = event.title;
  el.addEventListener('mousedown', (evt) => evt.stopPropagation());
  el.addEventListener('click', (evt) => {
    evt.stopPropagation();
    openEventModal({ event });
  });
  return el;
}

function installSelectionHandlers(dayBody, day) {
  let selection = null;

  dayBody.addEventListener('mousedown', (event) => {
    if (event.button !== 0 || event.target.closest('.event')) return;
    event.preventDefault();
    const startMinute = minuteFromPointer(dayBody, event.clientY);
    const box = document.createElement('div');
    box.className = 'selection';
    dayBody.append(box);
    selection = { startMinute, endMinute: startMinute, box, moved: false };
    updateSelectionBox(selection);

    const onMove = (moveEvent) => {
      selection.endMinute = minuteFromPointer(dayBody, moveEvent.clientY);
      selection.moved = selection.moved || Math.abs(selection.endMinute - selection.startMinute) > 2;
      updateSelectionBox(selection);
    };

    const onUp = (upEvent) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      selection.endMinute = minuteFromPointer(dayBody, upEvent.clientY);
      const low = Math.min(selection.startMinute, selection.endMinute);
      const high = Math.max(selection.startMinute, selection.endMinute);
      selection.box.remove();
      if (high - low < 5) {
        const minute = clamp(roundTo(low, 15), 0, MINUTES_PER_DAY - 15);
        openEventModal({ start: dateAtMinutes(day, minute), end: dateAtMinutes(day, Math.min(minute + 30, MINUTES_PER_DAY)) });
      } else {
        openEventModal({ start: dateAtMinutes(day, low), end: dateAtMinutes(day, high) });
      }
      selection = null;
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function updateSelectionBox(selection) {
  const low = Math.min(selection.startMinute, selection.endMinute);
  const high = Math.max(selection.startMinute, selection.endMinute);
  selection.box.style.top = `${(low / MINUTES_PER_DAY) * 100}%`;
  selection.box.style.height = `${(Math.max(high - low, 5) / MINUTES_PER_DAY) * 100}%`;
}

function minuteFromPointer(dayBody, clientY) {
  const rect = dayBody.getBoundingClientRect();
  const ratio = clamp((clientY - rect.top) / rect.height, 0, 1);
  return clamp(Math.round(ratio * MINUTES_PER_DAY), 0, MINUTES_PER_DAY);
}

function openEventModal({ event = null, start = null, end = null }) {
  const isEditing = Boolean(event);
  const startDate = isEditing ? new Date(event.start_at) : start;
  const endDate = isEditing ? new Date(event.end_at) : end;
  modalRoot.innerHTML = `
    <div class="modal-backdrop" role="presentation">
      <form class="modal" id="eventForm">
        <h2>${isEditing ? 'Edit event' : 'Create event'}</h2>
        <div class="form-row">
          <label for="titleInput">Title</label>
          <input id="titleInput" name="title" required maxlength="200" autocomplete="off" />
        </div>
        <div class="form-row">
          <label for="startInput">Start</label>
          <input id="startInput" name="start" type="datetime-local" required step="60" />
        </div>
        <div class="form-row">
          <label for="endInput">End</label>
          <input id="endInput" name="end" type="datetime-local" required step="60" />
        </div>
        <div class="form-error" id="formError"></div>
        <div class="form-actions">
          <div>${isEditing ? '<button class="btn danger" type="button" id="deleteBtn">Delete</button>' : ''}</div>
          <div class="right">
            <button class="btn" type="button" id="cancelBtn">Cancel</button>
            <button class="btn primary" type="submit">Save</button>
          </div>
        </div>
      </form>
    </div>
  `;

  const backdrop = modalRoot.querySelector('.modal-backdrop');
  const form = modalRoot.querySelector('#eventForm');
  const titleInput = modalRoot.querySelector('#titleInput');
  const startInput = modalRoot.querySelector('#startInput');
  const endInput = modalRoot.querySelector('#endInput');
  const errorEl = modalRoot.querySelector('#formError');

  titleInput.value = isEditing ? event.title : '';
  startInput.value = toDatetimeLocalValue(startDate);
  endInput.value = toDatetimeLocalValue(endDate);
  titleInput.focus();

  modalRoot.querySelector('#cancelBtn').addEventListener('click', closeModal);
  backdrop.addEventListener('mousedown', (evt) => {
    if (evt.target === backdrop) closeModal();
  });

  const deleteBtn = modalRoot.querySelector('#deleteBtn');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', async () => {
      if (!confirm('Delete this event?')) return;
      try {
        const response = await fetch(`/api/events/${encodeURIComponent(event.id)}`, { method: 'DELETE' });
        if (!response.ok) throw new Error(await response.text());
        closeModal();
        await loadAndRender();
      } catch (error) {
        errorEl.textContent = friendlyError(error);
      }
    });
  }

  form.addEventListener('submit', async (evt) => {
    evt.preventDefault();
    errorEl.textContent = '';
    const title = titleInput.value.trim();
    const payload = {
      title,
      start_at: datetimeLocalToDate(startInput.value).toISOString(),
      end_at: datetimeLocalToDate(endInput.value).toISOString(),
    };
    if (!title) {
      errorEl.textContent = 'Title is required.';
      return;
    }
    if (new Date(payload.end_at) <= new Date(payload.start_at)) {
      errorEl.textContent = 'End must be after start.';
      return;
    }

    try {
      const response = await fetch(isEditing ? `/api/events/${encodeURIComponent(event.id)}` : '/api/events', {
        method: isEditing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(await response.text());
      closeModal();
      await loadAndRender();
    } catch (error) {
      errorEl.textContent = friendlyError(error);
    }
  });
}

function closeModal() {
  modalRoot.innerHTML = '';
}

function friendlyError(error) {
  try {
    const parsed = JSON.parse(error.message);
    return parsed.error || error.message;
  } catch {
    return error.message || 'Something went wrong.';
  }
}

function startOfWeek(date) {
  const d = startOfDay(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  return addDays(d, diff);
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

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function dateAtMinutes(day, minutes) {
  const d = startOfDay(day);
  d.setMinutes(minutes, 0, 0);
  return d;
}

function toDatetimeLocalValue(date) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function datetimeLocalToDate(value) {
  return new Date(value);
}

function formatTime(date) {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date);
}

function formatDateLong(date) {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
}

function formatMonth(date) {
  return new Intl.DateTimeFormat(undefined, { month: 'short' }).format(date);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roundTo(value, step) {
  return Math.round(value / step) * step;
}

loadAndRender();
