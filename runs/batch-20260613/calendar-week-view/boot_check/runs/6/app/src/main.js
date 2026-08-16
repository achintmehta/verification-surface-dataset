const HOUR_HEIGHT = 64;
const DAY_MINUTES = 24 * 60;
const AXIS_HEIGHT = 24 * HOUR_HEIGHT;
const SNAP_MINUTES = 15;
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const state = {
  weekStart: startOfWeek(new Date()),
  events: [],
  drag: null,
  editingEvent: null
};

const app = document.querySelector('#app');
app.innerHTML = `
  <header class="topbar">
    <div class="brand">Week Calendar</div>
    <nav class="nav">
      <button id="prevWeek" type="button">← Previous</button>
      <button id="todayWeek" type="button">Today</button>
      <button id="nextWeek" type="button">Next →</button>
    </nav>
    <div id="weekLabel" class="week-label"></div>
  </header>
  <main class="calendar-shell">
    <div class="calendar-header">
      <div class="time-header"></div>
      <div id="dayHeaders" class="day-headers"></div>
    </div>
    <div class="calendar-scroll">
      <div class="time-axis" id="timeAxis"></div>
      <div id="weekGrid" class="week-grid"></div>
    </div>
  </main>
  <div id="modalBackdrop" class="modal-backdrop hidden">
    <form id="eventForm" class="modal-card">
      <h2 id="formTitle">Create event</h2>
      <label>Title<input id="eventTitle" name="title" required maxlength="200" /></label>
      <div class="form-row">
        <label>Date<input id="eventDate" name="date" type="date" required /></label>
        <label>Start<input id="eventStart" name="start" type="text" inputmode="numeric" placeholder="09:00" pattern="([01][0-9]|2[0-3]):[0-5][0-9]" required /></label>
        <label>End<input id="eventEnd" name="end" type="text" inputmode="numeric" placeholder="10:00 or 24:00" pattern="(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)" required /></label>
      </div>
      <div id="formError" class="form-error" role="alert"></div>
      <div class="modal-actions">
        <button id="deleteBtn" type="button" class="danger hidden">Delete</button>
        <span class="spacer"></span>
        <button id="cancelBtn" type="button">Cancel</button>
        <button type="submit" class="primary">Save</button>
      </div>
    </form>
  </div>
`;

const els = {
  prev: document.querySelector('#prevWeek'),
  today: document.querySelector('#todayWeek'),
  next: document.querySelector('#nextWeek'),
  weekLabel: document.querySelector('#weekLabel'),
  dayHeaders: document.querySelector('#dayHeaders'),
  timeAxis: document.querySelector('#timeAxis'),
  weekGrid: document.querySelector('#weekGrid'),
  backdrop: document.querySelector('#modalBackdrop'),
  form: document.querySelector('#eventForm'),
  formTitle: document.querySelector('#formTitle'),
  title: document.querySelector('#eventTitle'),
  date: document.querySelector('#eventDate'),
  start: document.querySelector('#eventStart'),
  end: document.querySelector('#eventEnd'),
  error: document.querySelector('#formError'),
  deleteBtn: document.querySelector('#deleteBtn'),
  cancelBtn: document.querySelector('#cancelBtn')
};

boot();

function boot() {
  renderTimeAxis();
  bindEvents();
  loadWeek();
}

function bindEvents() {
  els.prev.addEventListener('click', () => moveWeek(-1));
  els.today.addEventListener('click', () => { state.weekStart = startOfWeek(new Date()); loadWeek(); });
  els.next.addEventListener('click', () => moveWeek(1));
  els.cancelBtn.addEventListener('click', closeModal);
  els.backdrop.addEventListener('mousedown', (e) => { if (e.target === els.backdrop) closeModal(); });
  els.form.addEventListener('submit', submitForm);
  els.deleteBtn.addEventListener('click', deleteCurrentEvent);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
}

function moveWeek(delta) {
  const next = new Date(state.weekStart);
  next.setDate(next.getDate() + delta * 7);
  state.weekStart = startOfWeek(next);
  loadWeek();
}

async function loadWeek() {
  const start = new Date(state.weekStart);
  const end = addDays(start, 7);
  const res = await fetch(`/api/events?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`);
  if (!res.ok) throw new Error('Failed to load events');
  state.events = await res.json();
  renderWeek();
}

function renderTimeAxis() {
  els.timeAxis.style.height = `${AXIS_HEIGHT}px`;
  els.timeAxis.innerHTML = '';
  for (let h = 0; h <= 24; h++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = `${h * HOUR_HEIGHT}px`;
    label.textContent = `${String(h).padStart(2, '0')}:00`;
    els.timeAxis.appendChild(label);
  }
}

function renderWeek() {
  const weekEnd = addDays(state.weekStart, 6);
  els.weekLabel.textContent = `${formatDateLong(state.weekStart)} – ${formatDateLong(weekEnd)}`;
  renderHeaders();
  renderGrid();
}

function renderHeaders() {
  els.dayHeaders.innerHTML = '';
  for (let i = 0; i < 7; i++) {
    const day = addDays(state.weekStart, i);
    const header = document.createElement('div');
    header.className = `day-header ${isSameLocalDate(day, new Date()) ? 'today' : ''}`;
    header.innerHTML = `<span>${DAY_NAMES[i]}</span><strong>${day.getDate()}</strong>`;
    els.dayHeaders.appendChild(header);
  }
}

function renderGrid() {
  els.weekGrid.innerHTML = '';
  els.weekGrid.style.height = `${AXIS_HEIGHT}px`;
  const segmentsByDay = buildDaySegments(state.events);

  for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
    const column = document.createElement('div');
    column.className = `day-column ${isSameLocalDate(addDays(state.weekStart, dayIndex), new Date()) ? 'today' : ''}`;
    column.dataset.dayIndex = String(dayIndex);
    column.style.height = `${AXIS_HEIGHT}px`;
    for (let h = 0; h < 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${h * HOUR_HEIGHT}px`;
      column.appendChild(line);
    }
    attachSelectionHandlers(column, dayIndex);
    els.weekGrid.appendChild(column);

    const laidOut = layoutDayEvents(segmentsByDay[dayIndex] || []);
    for (const item of laidOut) column.appendChild(renderEventBlock(item));
  }
}

function buildDaySegments(events) {
  const byDay = Array.from({ length: 7 }, () => []);
  for (const event of events) {
    const eventStart = new Date(event.start_at);
    const eventEnd = new Date(event.end_at);
    for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
      const dayStart = addDays(state.weekStart, dayIndex);
      const dayEnd = addDays(dayStart, 1);
      if (eventStart < dayEnd && eventEnd > dayStart) {
        const visibleStart = new Date(Math.max(eventStart.getTime(), dayStart.getTime()));
        const visibleEnd = new Date(Math.min(eventEnd.getTime(), dayEnd.getTime()));
        const startMinutes = minutesSinceMidnight(visibleStart);
        const endMinutes = visibleEnd.getTime() === dayEnd.getTime() ? DAY_MINUTES : minutesSinceMidnight(visibleEnd);
        if (endMinutes > startMinutes) {
          byDay[dayIndex].push({
            ...event,
            dayIndex,
            visibleStart,
            visibleEnd,
            startMinutes: clamp(startMinutes, 0, DAY_MINUTES),
            endMinutes: clamp(endMinutes, 0, DAY_MINUTES)
          });
        }
      }
    }
  }
  return byDay;
}

function layoutDayEvents(events) {
  const sorted = [...events].sort((a, b) => a.startMinutes - b.startMinutes || a.endMinutes - b.endMinutes || a.id - b.id);
  const clusters = [];
  let current = [];
  let clusterEnd = -1;
  for (const event of sorted) {
    if (current.length === 0 || event.startMinutes < clusterEnd) {
      current.push(event);
      clusterEnd = Math.max(clusterEnd, event.endMinutes);
    } else {
      clusters.push(current);
      current = [event];
      clusterEnd = event.endMinutes;
    }
  }
  if (current.length) clusters.push(current);

  const laidOut = [];
  for (const cluster of clusters) {
    const columns = [];
    const clusterSorted = [...cluster].sort((a, b) => a.startMinutes - b.startMinutes || a.endMinutes - b.endMinutes || a.id - b.id);
    const assigned = [];
    for (const event of clusterSorted) {
      let col = columns.findIndex((end) => end <= event.startMinutes);
      if (col === -1) {
        col = columns.length;
        columns.push(event.endMinutes);
      } else {
        columns[col] = event.endMinutes;
      }
      assigned.push({ ...event, column: col });
    }
    const columnCount = Math.max(1, columns.length);
    for (const event of assigned) laidOut.push({ ...event, columnCount });
  }
  return laidOut;
}

function renderEventBlock(event) {
  const top = (event.startMinutes / DAY_MINUTES) * AXIS_HEIGHT;
  const height = ((event.endMinutes - event.startMinutes) / DAY_MINUTES) * AXIS_HEIGHT;
  const width = 100 / event.columnCount;
  const left = event.column * width;
  const block = document.createElement('button');
  block.type = 'button';
  block.className = 'event-block';
  block.style.top = `${top}px`;
  block.style.height = `${height}px`;
  block.style.left = `${left}%`;
  block.style.width = `${width}%`;
  block.setAttribute('aria-label', `${event.title}, ${formatTime(new Date(event.start_at))} to ${formatTime(new Date(event.end_at))}`);
  block.innerHTML = `<span class="event-title"></span><span class="event-time">${formatTime(new Date(event.start_at))}–${formatTime(new Date(event.end_at))}</span>`;
  block.querySelector('.event-title').textContent = event.title;
  block.addEventListener('click', (e) => {
    e.stopPropagation();
    openEditForm(state.events.find((it) => it.id === event.id) || event);
  });
  return block;
}

function attachSelectionHandlers(column, dayIndex) {
  column.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('.event-block')) return;
    e.preventDefault();
    const startMin = snapMinutes(positionToMinutes(e, column));
    const preview = document.createElement('div');
    preview.className = 'selection-preview';
    column.appendChild(preview);
    state.drag = { column, dayIndex, startMin, endMin: Math.min(DAY_MINUTES, startMin + SNAP_MINUTES), preview };
    updateSelectionPreview();
    window.addEventListener('mousemove', onSelectionMove);
    window.addEventListener('mouseup', onSelectionEnd, { once: true });
  });
}

function onSelectionMove(e) {
  if (!state.drag) return;
  state.drag.endMin = snapMinutes(positionToMinutes(e, state.drag.column));
  updateSelectionPreview();
}

function onSelectionEnd() {
  window.removeEventListener('mousemove', onSelectionMove);
  if (!state.drag) return;
  const { start, end } = normalizedSelection(state.drag.startMin, state.drag.endMin);
  state.drag.preview.remove();
  const day = addDays(state.weekStart, state.drag.dayIndex);
  state.drag = null;
  if (end > start) openCreateForm(day, start, end);
}

function updateSelectionPreview() {
  if (!state.drag) return;
  const { start, end } = normalizedSelection(state.drag.startMin, state.drag.endMin);
  state.drag.preview.style.top = `${(start / DAY_MINUTES) * AXIS_HEIGHT}px`;
  state.drag.preview.style.height = `${Math.max(2, ((end - start) / DAY_MINUTES) * AXIS_HEIGHT)}px`;
}

function normalizedSelection(a, b) {
  let start = clamp(Math.min(a, b), 0, DAY_MINUTES - SNAP_MINUTES);
  let end = clamp(Math.max(a, b), SNAP_MINUTES, DAY_MINUTES);
  if (end === start) end = Math.min(DAY_MINUTES, start + SNAP_MINUTES);
  return { start, end };
}

function positionToMinutes(e, element) {
  const rect = element.getBoundingClientRect();
  const y = clamp(e.clientY - rect.top, 0, rect.height);
  return (y / rect.height) * DAY_MINUTES;
}

function snapMinutes(minutes) {
  return clamp(Math.round(minutes / SNAP_MINUTES) * SNAP_MINUTES, 0, DAY_MINUTES);
}

function openCreateForm(day, startMin, endMin) {
  state.editingEvent = null;
  els.formTitle.textContent = 'Create event';
  els.deleteBtn.classList.add('hidden');
  els.title.value = '';
  els.date.value = toDateInputValue(day);
  els.start.value = minutesToInputTime(startMin);
  els.end.value = minutesToInputTime(endMin);
  showModal();
}

function openEditForm(event) {
  state.editingEvent = event;
  const start = new Date(event.start_at);
  const end = new Date(event.end_at);
  els.formTitle.textContent = 'Edit event';
  els.deleteBtn.classList.remove('hidden');
  els.title.value = event.title;
  els.date.value = toDateInputValue(start);
  els.start.value = minutesToInputTime(minutesSinceMidnight(start));
  els.end.value = end.getHours() === 0 && end.getMinutes() === 0 && !isSameLocalDate(start, end)
    ? '24:00'
    : minutesToInputTime(minutesSinceMidnight(end));
  showModal();
}

function showModal() {
  els.error.textContent = '';
  els.backdrop.classList.remove('hidden');
  setTimeout(() => els.title.focus(), 0);
}

function closeModal() {
  els.backdrop.classList.add('hidden');
  state.editingEvent = null;
}

async function submitForm(e) {
  e.preventDefault();
  els.error.textContent = '';
  const title = els.title.value.trim();
  const start = localDateTimeFromInputs(els.date.value, els.start.value);
  const end = localDateTimeFromInputs(els.date.value, els.end.value);
  if (!title) return showError('Title is required.');
  if (!start || !end || end <= start) return showError('End time must be after start time.');
  const payload = { title, start_at: start.toISOString(), end_at: end.toISOString() };
  const url = state.editingEvent ? `/api/events/${state.editingEvent.id}` : '/api/events';
  const method = state.editingEvent ? 'PUT' : 'POST';
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!res.ok) {
    const body = await safeJson(res);
    return showError(body?.error || 'Could not save event.');
  }
  closeModal();
  await loadWeek();
}

async function deleteCurrentEvent() {
  if (!state.editingEvent) return;
  if (!confirm('Delete this event?')) return;
  const res = await fetch(`/api/events/${state.editingEvent.id}`, { method: 'DELETE' });
  if (!res.ok) {
    const body = await safeJson(res);
    return showError(body?.error || 'Could not delete event.');
  }
  closeModal();
  await loadWeek();
}

function showError(message) {
  els.error.textContent = message;
}

async function safeJson(res) {
  try { return await res.json(); } catch { return null; }
}

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

function minutesSinceMidnight(date) {
  return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60 + date.getMilliseconds() / 60000;
}

function minutesToInputTime(totalMinutes) {
  const minutes = Math.round(totalMinutes);
  if (minutes >= DAY_MINUTES) return '24:00';
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function localDateTimeFromInputs(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  if (![y, m, d, hh, mm].every(Number.isFinite)) return null;
  const out = new Date(y, m - 1, d, hh, mm, 0, 0);
  if (hh === 24 && mm === 0) out.setDate(out.getDate() + 1);
  return out;
}

function toDateInputValue(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function isSameLocalDate(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function formatDateLong(date) {
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatTime(date) {
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
