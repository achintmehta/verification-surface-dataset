const MINUTES_PER_DAY = 24 * 60;
const HOUR_HEIGHT = 60;
const DAY_HEIGHT = MINUTES_PER_DAY; // 1px per minute: exact, easy-to-audit geometry.
const API = '/api/events';

const state = {
  weekStart: startOfWeek(new Date()),
  events: [],
  selection: null
};

const app = document.querySelector('#app');
app.innerHTML = `
  <div class="calendar-app">
    <header class="toolbar">
      <div class="brand">
        <div class="logo">W</div>
        <div>
          <h1>Week Calendar</h1>
          <p>Minute-accurate week view with persistent events</p>
        </div>
      </div>
      <div class="nav-controls">
        <button id="prevWeek" type="button">← Previous</button>
        <button id="today" type="button">Today</button>
        <button id="nextWeek" type="button">Next →</button>
      </div>
    </header>

    <section class="week-card">
      <div class="week-title-row">
        <div>
          <strong id="weekRange"></strong>
          <span id="status" role="status"></span>
        </div>
        <button id="newEvent" type="button" class="primary">New event</button>
      </div>
      <div class="calendar-shell">
        <div class="calendar-header" id="calendarHeader"></div>
        <div class="calendar-scroll" id="calendarScroll">
          <div class="time-axis" id="timeAxis"></div>
          <div class="days-grid" id="daysGrid"></div>
        </div>
      </div>
    </section>
  </div>

  <dialog id="eventDialog" class="event-dialog">
    <form id="eventForm" method="dialog">
      <h2 id="dialogTitle">Create event</h2>
      <input type="hidden" id="eventId" />
      <label>
        Title
        <input id="titleInput" name="title" required maxlength="200" autocomplete="off" />
      </label>
      <div class="form-grid">
        <label>
          Start
          <input id="startInput" name="start" type="datetime-local" required />
        </label>
        <label>
          End
          <input id="endInput" name="end" type="datetime-local" required />
        </label>
      </div>
      <p id="formError" class="form-error" aria-live="polite"></p>
      <menu>
        <button id="deleteButton" type="button" class="danger">Delete</button>
        <span class="spacer"></span>
        <button id="cancelButton" type="button">Cancel</button>
        <button id="saveButton" type="submit" class="primary">Save</button>
      </menu>
    </form>
  </dialog>
`;

const els = {
  prevWeek: document.querySelector('#prevWeek'),
  today: document.querySelector('#today'),
  nextWeek: document.querySelector('#nextWeek'),
  newEvent: document.querySelector('#newEvent'),
  weekRange: document.querySelector('#weekRange'),
  status: document.querySelector('#status'),
  calendarHeader: document.querySelector('#calendarHeader'),
  timeAxis: document.querySelector('#timeAxis'),
  daysGrid: document.querySelector('#daysGrid'),
  calendarScroll: document.querySelector('#calendarScroll'),
  dialog: document.querySelector('#eventDialog'),
  form: document.querySelector('#eventForm'),
  dialogTitle: document.querySelector('#dialogTitle'),
  eventId: document.querySelector('#eventId'),
  titleInput: document.querySelector('#titleInput'),
  startInput: document.querySelector('#startInput'),
  endInput: document.querySelector('#endInput'),
  formError: document.querySelector('#formError'),
  deleteButton: document.querySelector('#deleteButton'),
  cancelButton: document.querySelector('#cancelButton')
};

buildStaticGrid();
wireEvents();
loadWeek().then(() => {
  const now = new Date();
  if (sameDay(now, addDays(state.weekStart, 0)) || now >= state.weekStart && now < addDays(state.weekStart, 7)) {
    els.calendarScroll.scrollTop = Math.max(0, minutesFromMidnight(now) - 180);
  } else {
    els.calendarScroll.scrollTop = 8 * HOUR_HEIGHT;
  }
});

function wireEvents() {
  els.prevWeek.addEventListener('click', () => changeWeek(-7));
  els.nextWeek.addEventListener('click', () => changeWeek(7));
  els.today.addEventListener('click', () => {
    state.weekStart = startOfWeek(new Date());
    loadWeek();
  });
  els.newEvent.addEventListener('click', () => {
    const start = new Date();
    start.setSeconds(0, 0);
    start.setMinutes(Math.ceil(start.getMinutes() / 15) * 15);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    openCreateDialog(start, end);
  });
  els.cancelButton.addEventListener('click', () => els.dialog.close());
  els.form.addEventListener('submit', onSubmitForm);
  els.deleteButton.addEventListener('click', onDeleteEvent);
}

function buildStaticGrid() {
  document.documentElement.style.setProperty('--day-height', `${DAY_HEIGHT}px`);

  els.calendarHeader.innerHTML = '<div class="corner-cell"></div>' + weekDates().map((date, index) => `
    <div class="day-head ${sameDay(date, new Date()) ? 'today' : ''}" data-day-index="${index}">
      <span>${weekdayName(date)}</span>
      <strong>${monthDay(date)}</strong>
    </div>
  `).join('');

  els.timeAxis.innerHTML = Array.from({ length: 25 }, (_, hour) => `
    <div class="time-label" style="top:${hour * HOUR_HEIGHT}px">${pad(hour)}:00</div>
  `).join('');

  els.daysGrid.innerHTML = weekDates().map((date, index) => `
    <div class="day-column ${sameDay(date, new Date()) ? 'today' : ''}" data-day-index="${index}">
      <div class="hour-lines">
        ${Array.from({ length: 25 }, (_, hour) => `<div class="hour-line" style="top:${hour * HOUR_HEIGHT}px"></div>`).join('')}
      </div>
      <div class="day-body" data-day-index="${index}" aria-label="${weekdayName(date)} ${monthDay(date)}"></div>
    </div>
  `).join('');

  els.daysGrid.querySelectorAll('.day-body').forEach((body) => {
    body.addEventListener('pointerdown', onDayPointerDown);
  });
}

async function loadWeek() {
  setStatus('Loading…');
  buildStaticGrid();
  const start = state.weekStart;
  const end = addDays(start, 7);
  els.weekRange.textContent = `${longDate(start)} – ${longDate(addDays(end, -1))}`;
  try {
    const response = await fetch(`${API}?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`);
    if (!response.ok) throw new Error(await response.text());
    state.events = await response.json();
    renderEvents();
    setStatus(`${state.events.length} event${state.events.length === 1 ? '' : 's'}`);
  } catch (err) {
    console.error(err);
    setStatus('Could not load events');
  }
}

function renderEvents() {
  els.daysGrid.querySelectorAll('.event-block').forEach((el) => el.remove());
  const daySegments = Array.from({ length: 7 }, () => []);

  for (const event of state.events) {
    const start = new Date(event.start_at);
    const end = new Date(event.end_at);
    for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
      const dayStart = addDays(state.weekStart, dayIndex);
      const dayEnd = addDays(dayStart, 1);
      if (start < dayEnd && end > dayStart) {
        const segStart = new Date(Math.max(start.getTime(), dayStart.getTime()));
        const segEnd = new Date(Math.min(end.getTime(), dayEnd.getTime()));
        const startMin = clamp(minutesDiff(dayStart, segStart), 0, MINUTES_PER_DAY);
        const endMin = clamp(minutesDiff(dayStart, segEnd), 0, MINUTES_PER_DAY);
        if (endMin > startMin) {
          daySegments[dayIndex].push({
            ...event,
            segmentStart: segStart,
            segmentEnd: segEnd,
            startMin,
            endMin
          });
        }
      }
    }
  }

  daySegments.forEach((segments, dayIndex) => {
    const laidOut = layoutDayEvents(segments);
    const body = els.daysGrid.querySelector(`.day-body[data-day-index="${dayIndex}"]`);
    for (const ev of laidOut) {
      const block = document.createElement('button');
      block.type = 'button';
      block.className = 'event-block';
      block.style.top = `${ev.startMin}px`;
      block.style.height = `${Math.max(1, ev.endMin - ev.startMin)}px`;
      block.style.left = `${(ev.column / ev.columnCount) * 100}%`;
      block.style.width = `${(1 / ev.columnCount) * 100}%`;
      block.dataset.eventId = ev.id;
      block.innerHTML = `
        <span class="event-title">${escapeHtml(ev.title)}</span>
        <span class="event-time">${timeRange(new Date(ev.start_at), new Date(ev.end_at))}</span>
      `;
      block.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditDialog(state.events.find((item) => String(item.id) === String(ev.id)));
      });
      body.appendChild(block);
    }
  });
}

export function layoutDayEvents(events) {
  const sorted = [...events].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin || Number(a.id) - Number(b.id));
  const clusters = [];
  let current = null;

  for (const ev of sorted) {
    if (!current || ev.startMin >= current.endMin) {
      current = { events: [], endMin: ev.endMin };
      clusters.push(current);
    } else {
      current.endMin = Math.max(current.endMin, ev.endMin);
    }
    current.events.push(ev);
  }

  const result = [];
  for (const cluster of clusters) {
    const columnEnds = [];
    const assigned = [];
    for (const ev of cluster.events) {
      let column = columnEnds.findIndex((end) => end <= ev.startMin);
      if (column === -1) {
        column = columnEnds.length;
        columnEnds.push(ev.endMin);
      } else {
        columnEnds[column] = ev.endMin;
      }
      assigned.push({ ...ev, column });
    }
    const columnCount = Math.max(1, columnEnds.length);
    result.push(...assigned.map((ev) => ({ ...ev, columnCount })));
  }
  return result;
}

function onDayPointerDown(e) {
  if (e.button !== 0 || e.target.closest('.event-block')) return;
  const body = e.currentTarget;
  const dayIndex = Number(body.dataset.dayIndex);
  const startY = yToMinute(e, body);
  body.setPointerCapture(e.pointerId);

  const selection = document.createElement('div');
  selection.className = 'selection-range';
  body.appendChild(selection);

  const updateSelection = (minute) => {
    const a = clamp(startY, 0, MINUTES_PER_DAY);
    const b = clamp(minute, 0, MINUTES_PER_DAY);
    const top = Math.min(a, b);
    const height = Math.max(1, Math.abs(b - a));
    selection.style.top = `${top}px`;
    selection.style.height = `${height}px`;
  };
  updateSelection(startY + 30);

  const move = (ev) => updateSelection(yToMinute(ev, body));
  const up = (ev) => {
    body.releasePointerCapture(e.pointerId);
    body.removeEventListener('pointermove', move);
    body.removeEventListener('pointerup', up);
    const endY = yToMinute(ev, body);
    selection.remove();
    let startMin = Math.min(startY, endY);
    let endMin = Math.max(startY, endY);
    if (Math.abs(endMin - startMin) < 5) {
      startMin = startY;
      endMin = Math.min(MINUTES_PER_DAY, startY + 30);
      if (endMin === startMin) startMin = Math.max(0, endMin - 30);
    }
    const dayStart = addDays(state.weekStart, dayIndex);
    openCreateDialog(addMinutes(dayStart, startMin), addMinutes(dayStart, endMin));
  };

  body.addEventListener('pointermove', move);
  body.addEventListener('pointerup', up);
}

async function onSubmitForm(e) {
  e.preventDefault();
  els.formError.textContent = '';
  const id = els.eventId.value;
  const title = els.titleInput.value.trim();
  const start = new Date(els.startInput.value);
  const end = new Date(els.endInput.value);
  if (!title) return showFormError('Title is required.');
  if (!(end > start)) return showFormError('End must be after start.');

  const payload = { title, start_at: start.toISOString(), end_at: end.toISOString() };
  try {
    const response = await fetch(id ? `${API}/${id}` : API, {
      method: id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || 'Save failed.');
    }
    els.dialog.close();
    await loadWeek();
  } catch (err) {
    showFormError(err.message);
  }
}

async function onDeleteEvent() {
  const id = els.eventId.value;
  if (!id) return;
  if (!confirm('Delete this event?')) return;
  try {
    const response = await fetch(`${API}/${id}`, { method: 'DELETE' });
    if (!response.ok && response.status !== 204) throw new Error('Delete failed.');
    els.dialog.close();
    await loadWeek();
  } catch (err) {
    showFormError(err.message);
  }
}

function openCreateDialog(start, end) {
  els.dialogTitle.textContent = 'Create event';
  els.eventId.value = '';
  els.titleInput.value = '';
  els.startInput.value = toDatetimeLocal(start);
  els.endInput.value = toDatetimeLocal(end);
  els.deleteButton.hidden = true;
  els.formError.textContent = '';
  els.dialog.showModal();
  els.titleInput.focus();
}

function openEditDialog(event) {
  if (!event) return;
  els.dialogTitle.textContent = 'Edit event';
  els.eventId.value = event.id;
  els.titleInput.value = event.title;
  els.startInput.value = toDatetimeLocal(new Date(event.start_at));
  els.endInput.value = toDatetimeLocal(new Date(event.end_at));
  els.deleteButton.hidden = false;
  els.formError.textContent = '';
  els.dialog.showModal();
  els.titleInput.focus();
}

function changeWeek(days) {
  state.weekStart = addDays(state.weekStart, days);
  loadWeek();
}

function weekDates() {
  return Array.from({ length: 7 }, (_, i) => addDays(state.weekStart, i));
}

function startOfWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const mondayOffset = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - mondayOffset);
  return d;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function minutesDiff(a, b) {
  return Math.round((b.getTime() - a.getTime()) / 60000);
}

function minutesFromMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

function yToMinute(e, element) {
  const rect = element.getBoundingClientRect();
  const ratio = (e.clientY - rect.top) / rect.height;
  return clamp(Math.round(ratio * MINUTES_PER_DAY), 0, MINUTES_PER_DAY);
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function toDatetimeLocal(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function timeRange(start, end) {
  return `${pad(start.getHours())}:${pad(start.getMinutes())}–${pad(end.getHours())}:${pad(end.getMinutes())}`;
}

function weekdayName(date) {
  return date.toLocaleDateString(undefined, { weekday: 'short' });
}

function monthDay(date) {
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function longDate(date) {
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function setStatus(text) {
  els.status.textContent = text;
}

function showFormError(message) {
  els.formError.textContent = message;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[ch]));
}
