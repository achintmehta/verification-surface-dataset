import './styles.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3000';
const HOUR_HEIGHT = 64;
const DAY_HEIGHT = HOUR_HEIGHT * 24;
const MINUTE_HEIGHT = HOUR_HEIGHT / 60;
const SNAP_MINUTES = 15;
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const FULL_DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const state = {
  weekStart: startOfWeek(new Date()),
  events: [],
  selection: null,
  editingEvent: null,
};

const app = document.querySelector('#app');
app.innerHTML = `
  <header class="toolbar">
    <div class="brand">
      <h1>Week Calendar</h1>
      <p>Minute-precise single-user week view</p>
    </div>
    <nav class="nav-actions" aria-label="Week navigation">
      <button id="prevWeek" type="button">← Previous</button>
      <button id="today" type="button">Today</button>
      <button id="nextWeek" type="button">Next →</button>
    </nav>
    <div id="weekLabel" class="week-label"></div>
  </header>
  <main class="calendar-shell">
    <div class="calendar" id="calendar">
      <div class="corner"></div>
      <div class="day-headers" id="dayHeaders"></div>
      <div class="time-axis" id="timeAxis"></div>
      <div class="week-grid" id="weekGrid"></div>
    </div>
  </main>
  <div id="modalRoot" class="modal-root hidden"></div>
`;

const els = {
  prev: document.querySelector('#prevWeek'),
  today: document.querySelector('#today'),
  next: document.querySelector('#nextWeek'),
  weekLabel: document.querySelector('#weekLabel'),
  dayHeaders: document.querySelector('#dayHeaders'),
  timeAxis: document.querySelector('#timeAxis'),
  weekGrid: document.querySelector('#weekGrid'),
  modalRoot: document.querySelector('#modalRoot'),
};

els.prev.addEventListener('click', () => changeWeek(-1));
els.today.addEventListener('click', () => {
  state.weekStart = startOfWeek(new Date());
  loadAndRender();
});
els.next.addEventListener('click', () => changeWeek(1));

renderTimeAxis();
loadAndRender();

function changeWeek(delta) {
  state.weekStart = addDays(state.weekStart, delta * 7);
  loadAndRender();
}

async function loadAndRender() {
  closeModal();
  const start = state.weekStart;
  const end = addDays(start, 7);
  try {
    const res = await fetch(`${API_BASE}/api/events?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`);
    if (!res.ok) throw new Error(await res.text());
    state.events = await res.json();
  } catch (err) {
    console.error(err);
    state.events = [];
    alert('Could not load events. Is the backend running?');
  }
  renderWeek();
}

function renderTimeAxis() {
  els.timeAxis.style.height = `${DAY_HEIGHT}px`;
  els.timeAxis.innerHTML = '';
  for (let hour = 0; hour <= 24; hour++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = `${hour * HOUR_HEIGHT}px`;
    label.textContent = `${String(hour).padStart(2, '0')}:00`;
    els.timeAxis.appendChild(label);
  }
}

function renderWeek() {
  const weekEnd = addDays(state.weekStart, 6);
  els.weekLabel.textContent = `${formatDate(state.weekStart)} – ${formatDate(weekEnd)}`;
  renderHeaders();
  renderGrid();
}

function renderHeaders() {
  els.dayHeaders.innerHTML = '';
  const today = startOfDay(new Date());
  for (let i = 0; i < 7; i++) {
    const date = addDays(state.weekStart, i);
    const header = document.createElement('div');
    header.className = 'day-header';
    if (sameDay(date, today)) header.classList.add('today');
    header.innerHTML = `<span>${DAY_NAMES[i]}</span><strong>${date.getDate()}</strong><small>${formatMonth(date)}</small>`;
    els.dayHeaders.appendChild(header);
  }
}

function renderGrid() {
  els.weekGrid.innerHTML = '';
  els.weekGrid.style.height = `${DAY_HEIGHT}px`;
  const today = startOfDay(new Date());

  for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
    const date = addDays(state.weekStart, dayIndex);
    const day = document.createElement('section');
    day.className = 'day-column';
    if (sameDay(date, today)) day.classList.add('today');
    day.style.height = `${DAY_HEIGHT}px`;
    day.dataset.dayIndex = String(dayIndex);
    day.setAttribute('aria-label', FULL_DAY_NAMES[dayIndex]);

    for (let hour = 0; hour < 24; hour++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${hour * HOUR_HEIGHT}px`;
      day.appendChild(line);
    }

    attachSelectionHandlers(day, date);
    renderDayEvents(day, date);
    els.weekGrid.appendChild(day);
  }
}

function renderDayEvents(dayEl, date) {
  const dayStart = startOfDay(date);
  const dayEnd = addDays(dayStart, 1);
  const visible = state.events
    .map((event) => ({
      ...event,
      startDate: new Date(event.start_at),
      endDate: new Date(event.end_at),
    }))
    .filter((event) => event.startDate < dayEnd && event.endDate > dayStart)
    .map((event) => {
      const clippedStart = event.startDate < dayStart ? dayStart : event.startDate;
      const clippedEnd = event.endDate > dayEnd ? dayEnd : event.endDate;
      return {
        ...event,
        clippedStart,
        clippedEnd,
        startMin: minutesSinceMidnight(clippedStart),
        endMin: clippedEnd.getTime() === dayEnd.getTime() ? 1440 : minutesSinceMidnight(clippedEnd),
      };
    })
    .filter((event) => event.endMin > event.startMin)
    .sort(compareEvents);

  const layouts = layoutEvents(visible);
  for (const item of layouts) {
    const eventEl = document.createElement('button');
    eventEl.type = 'button';
    eventEl.className = 'event-block';
    const top = item.startMin * MINUTE_HEIGHT;
    const height = (item.endMin - item.startMin) * MINUTE_HEIGHT;
    eventEl.style.top = `${top}px`;
    eventEl.style.height = `${height}px`;
    eventEl.style.left = `calc(${item.leftPct}% + 2px)`;
    eventEl.style.width = `calc(${item.widthPct}% - 4px)`;
    eventEl.title = `${item.title} ${formatTime(new Date(item.start_at))}–${formatTime(new Date(item.end_at))}`;
    eventEl.innerHTML = `<strong>${escapeHtml(item.title)}</strong><span>${formatTime(new Date(item.start_at))}–${formatTime(new Date(item.end_at))}</span>`;
    eventEl.addEventListener('pointerdown', (e) => e.stopPropagation());
    eventEl.addEventListener('click', (e) => {
      e.stopPropagation();
      openEventModal(item);
    });
    dayEl.appendChild(eventEl);
  }
}

function layoutEvents(events) {
  if (events.length === 0) return [];
  const sorted = [...events].sort(compareEvents);
  const clusters = [];
  let current = [];
  let clusterEnd = -1;

  for (const event of sorted) {
    // Half-open interval semantics: an event ending at 10:00 does not overlap one starting at 10:00.
    if (current.length === 0 || event.startMin < clusterEnd) {
      current.push(event);
      clusterEnd = Math.max(clusterEnd, event.endMin);
    } else {
      clusters.push(current);
      current = [event];
      clusterEnd = event.endMin;
    }
  }
  if (current.length) clusters.push(current);

  const laidOut = [];
  for (const cluster of clusters) {
    const columns = [];
    const assignments = [];
    for (const event of cluster.sort(compareEvents)) {
      let colIndex = columns.findIndex((endMin) => endMin <= event.startMin);
      if (colIndex === -1) {
        colIndex = columns.length;
        columns.push(event.endMin);
      } else {
        columns[colIndex] = event.endMin;
      }
      assignments.push({ event, colIndex });
    }
    const colCount = Math.max(1, columns.length);
    const widthPct = 100 / colCount;
    for (const { event, colIndex } of assignments) {
      laidOut.push({
        ...event,
        column: colIndex,
        columns: colCount,
        leftPct: colIndex * widthPct,
        widthPct,
      });
    }
  }
  return laidOut;
}

function attachSelectionHandlers(dayEl, date) {
  let drag = null;

  dayEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.event-block')) return;
    const rect = dayEl.getBoundingClientRect();
    const minute = snapMinute(((e.clientY - rect.top) / rect.height) * 1440);
    drag = { start: clampMinute(minute), end: clampMinute(minute), rect };
    dayEl.setPointerCapture(e.pointerId);
    drawSelection(dayEl, drag);
  });

  dayEl.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const minute = snapMinute(((e.clientY - drag.rect.top) / drag.rect.height) * 1440);
    drag.end = clampMinute(minute);
    drawSelection(dayEl, drag);
  });

  dayEl.addEventListener('pointerup', (e) => {
    if (!drag) return;
    dayEl.releasePointerCapture(e.pointerId);
    const startMin = Math.min(drag.start, drag.end);
    let endMin = Math.max(drag.start, drag.end);
    if (endMin === startMin) endMin = Math.min(1440, startMin + 60);
    removeSelection(dayEl);
    drag = null;
    openCreateModal(date, startMin, endMin);
  });

  dayEl.addEventListener('pointercancel', () => {
    drag = null;
    removeSelection(dayEl);
  });
}

function drawSelection(dayEl, drag) {
  let sel = dayEl.querySelector('.selection');
  if (!sel) {
    sel = document.createElement('div');
    sel.className = 'selection';
    dayEl.appendChild(sel);
  }
  const start = Math.min(drag.start, drag.end);
  const end = Math.max(drag.start, drag.end);
  const height = Math.max(8, (end - start) * MINUTE_HEIGHT);
  sel.style.top = `${start * MINUTE_HEIGHT}px`;
  sel.style.height = `${height}px`;
}

function removeSelection(dayEl) {
  dayEl.querySelector('.selection')?.remove();
}

function openCreateModal(date, startMin, endMin) {
  const start = dateAtMinutes(startOfDay(date), startMin);
  const end = dateAtMinutes(startOfDay(date), endMin);
  openFormModal({
    mode: 'create',
    title: '',
    start_at: toLocalInputValue(start),
    end_at: endMin === 1440 ? toLocalInputValue(addDays(startOfDay(date), 1)) : toLocalInputValue(end),
  });
}

function openEventModal(event) {
  openFormModal({
    mode: 'edit',
    id: event.id,
    title: event.title,
    start_at: toLocalInputValue(new Date(event.start_at)),
    end_at: toLocalInputValue(new Date(event.end_at)),
  });
}

function openFormModal(model) {
  els.modalRoot.classList.remove('hidden');
  els.modalRoot.innerHTML = `
    <div class="modal-backdrop" data-close="true"></div>
    <form class="event-form" id="eventForm">
      <header>
        <h2>${model.mode === 'create' ? 'Create event' : 'Edit event'}</h2>
        <button type="button" class="icon-button" data-close="true" aria-label="Close">×</button>
      </header>
      <label>Title
        <input id="eventTitle" name="title" required maxlength="200" value="${escapeAttribute(model.title)}" />
      </label>
      <label>Start
        <input id="eventStart" name="start_at" type="datetime-local" required value="${model.start_at}" />
      </label>
      <label>End
        <input id="eventEnd" name="end_at" type="datetime-local" required value="${model.end_at}" />
      </label>
      <p id="formError" class="form-error" role="alert"></p>
      <footer>
        ${model.mode === 'edit' ? '<button type="button" class="danger" id="deleteEvent">Delete</button>' : '<span></span>'}
        <div>
          <button type="button" data-close="true">Cancel</button>
          <button type="submit" class="primary">Save</button>
        </div>
      </footer>
    </form>
  `;

  els.modalRoot.querySelectorAll('[data-close="true"]').forEach((el) => el.addEventListener('click', closeModal));
  const form = els.modalRoot.querySelector('#eventForm');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    await saveForm(model);
  });

  const deleteButton = els.modalRoot.querySelector('#deleteEvent');
  if (deleteButton) {
    deleteButton.addEventListener('click', async () => {
      if (!confirm('Delete this event?')) return;
      const res = await fetch(`${API_BASE}/api/events/${model.id}`, { method: 'DELETE' });
      if (!res.ok) return showFormError('Delete failed.');
      await loadAndRender();
    });
  }

  setTimeout(() => els.modalRoot.querySelector('#eventTitle')?.focus(), 0);
}

async function saveForm(model) {
  const title = els.modalRoot.querySelector('#eventTitle').value.trim();
  const startValue = els.modalRoot.querySelector('#eventStart').value;
  const endValue = els.modalRoot.querySelector('#eventEnd').value;
  const start = new Date(startValue);
  const end = new Date(endValue);
  if (!title) return showFormError('Title is required.');
  if (!startValue || !endValue || end <= start) return showFormError('End must be after start.');

  const body = JSON.stringify({ title, start_at: start.toISOString(), end_at: end.toISOString() });
  const url = model.mode === 'create' ? `${API_BASE}/api/events` : `${API_BASE}/api/events/${model.id}`;
  const method = model.mode === 'create' ? 'POST' : 'PUT';
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body });
  if (!res.ok) {
    let msg = 'Save failed.';
    try { msg = (await res.json()).error || msg; } catch {}
    return showFormError(msg);
  }
  await loadAndRender();
}

function showFormError(message) {
  const el = els.modalRoot.querySelector('#formError');
  if (el) el.textContent = message;
}

function closeModal() {
  els.modalRoot.classList.add('hidden');
  els.modalRoot.innerHTML = '';
}

function startOfWeek(date) {
  const d = startOfDay(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  return addDays(d, diff);
}
function startOfDay(date) { const d = new Date(date); d.setHours(0, 0, 0, 0); return d; }
function addDays(date, days) { const d = new Date(date); d.setDate(d.getDate() + days); return d; }
function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
function minutesSinceMidnight(date) { return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60 + date.getMilliseconds() / 60000; }
function dateAtMinutes(dayStart, minutes) { const d = new Date(dayStart); d.setMinutes(minutes, 0, 0); return d; }
function clampMinute(minute) { return Math.max(0, Math.min(1440, minute)); }
function snapMinute(minute) { return Math.round(clampMinute(minute) / SNAP_MINUTES) * SNAP_MINUTES; }
function compareEvents(a, b) { return a.startMin - b.startMin || a.endMin - b.endMin || a.id - b.id; }
function formatDate(date) { return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
function formatMonth(date) { return date.toLocaleDateString(undefined, { month: 'short' }); }
function formatTime(date) { return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); }
function toLocalInputValue(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}
function escapeAttribute(value) {
  return escapeHtml(value).replace(/'/g, '&#39;');
}
