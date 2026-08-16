import './styles.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3000';
const MINUTES_PER_DAY = 24 * 60;
const HOUR_HEIGHT = 56;
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const state = {
  weekStart: startOfWeek(new Date()),
  events: [],
  drag: null,
};

const app = document.querySelector('#app');
app.innerHTML = `
  <header class="toolbar">
    <div class="toolbar-left">
      <button id="prevWeek" type="button" aria-label="Previous week">‹</button>
      <button id="today" type="button">Today</button>
      <button id="nextWeek" type="button" aria-label="Next week">›</button>
    </div>
    <h1 id="weekTitle">Week Calendar</h1>
    <div class="toolbar-right"><span class="hint">Drag in an empty day column to create an event</span></div>
  </header>
  <main class="calendar-shell">
    <div class="day-header-row" id="dayHeaders"></div>
    <div class="calendar-scroll" id="calendarScroll">
      <div class="calendar-grid">
        <div class="time-axis" id="timeAxis"></div>
        <div class="days" id="days"></div>
      </div>
    </div>
  </main>
  <div class="modal hidden" id="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
    <form class="event-form" id="eventForm">
      <div class="form-head">
        <h2 id="modalTitle">Event</h2>
        <button class="icon-button" id="closeModal" type="button" aria-label="Close">×</button>
      </div>
      <label>Title<input id="eventTitle" name="title" required maxlength="160" autocomplete="off" /></label>
      <label>Start<input id="eventStart" name="start" type="datetime-local" required step="60" /></label>
      <label>End<input id="eventEnd" name="end" type="datetime-local" required step="60" /></label>
      <p class="form-error" id="formError" aria-live="polite"></p>
      <div class="form-actions">
        <button class="danger hidden" id="deleteEvent" type="button">Delete</button>
        <span class="spacer"></span>
        <button id="cancelForm" type="button">Cancel</button>
        <button class="primary" type="submit">Save</button>
      </div>
    </form>
  </div>
`;

const els = {
  weekTitle: document.querySelector('#weekTitle'),
  dayHeaders: document.querySelector('#dayHeaders'),
  timeAxis: document.querySelector('#timeAxis'),
  days: document.querySelector('#days'),
  prevWeek: document.querySelector('#prevWeek'),
  nextWeek: document.querySelector('#nextWeek'),
  today: document.querySelector('#today'),
  modal: document.querySelector('#modal'),
  form: document.querySelector('#eventForm'),
  modalTitle: document.querySelector('#modalTitle'),
  title: document.querySelector('#eventTitle'),
  start: document.querySelector('#eventStart'),
  end: document.querySelector('#eventEnd'),
  error: document.querySelector('#formError'),
  deleteButton: document.querySelector('#deleteEvent'),
  closeModal: document.querySelector('#closeModal'),
  cancelForm: document.querySelector('#cancelForm'),
};

let editingId = null;

init();

async function init() {
  renderTimeAxis();
  bindControls();
  await loadWeek();
  setTimeout(() => document.querySelector('#calendarScroll').scrollTo({ top: 7 * HOUR_HEIGHT }), 0);
}

function bindControls() {
  els.prevWeek.addEventListener('click', () => changeWeek(-1));
  els.nextWeek.addEventListener('click', () => changeWeek(1));
  els.today.addEventListener('click', () => {
    state.weekStart = startOfWeek(new Date());
    loadWeek();
  });
  els.closeModal.addEventListener('click', closeModal);
  els.cancelForm.addEventListener('click', closeModal);
  els.modal.addEventListener('click', (event) => {
    if (event.target === els.modal) closeModal();
  });
  els.form.addEventListener('submit', saveForm);
  els.deleteButton.addEventListener('click', deleteCurrentEvent);
}

async function changeWeek(delta) {
  state.weekStart = addDays(state.weekStart, delta * 7);
  await loadWeek();
}

async function loadWeek() {
  const start = state.weekStart;
  const end = addDays(start, 7);
  const response = await fetch(`${API_BASE}/api/events?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`);
  if (!response.ok) {
    alert('Could not load events. Is the backend server running?');
    return;
  }
  state.events = await response.json();
  renderWeek();
}

function renderTimeAxis() {
  els.timeAxis.innerHTML = '';
  for (let hour = 0; hour <= 24; hour += 1) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = `${hour * HOUR_HEIGHT}px`;
    label.textContent = `${String(hour).padStart(2, '0')}:00`;
    els.timeAxis.append(label);
  }
}

function renderWeek() {
  const weekEnd = addDays(state.weekStart, 6);
  els.weekTitle.textContent = `${formatDateLong(state.weekStart)} – ${formatDateLong(weekEnd)}`;
  renderHeaders();
  renderDays();
}

function renderHeaders() {
  els.dayHeaders.innerHTML = '<div class="corner"></div>';
  const today = beginningOfDay(new Date()).getTime();
  for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
    const date = addDays(state.weekStart, dayIndex);
    const header = document.createElement('div');
    header.className = `day-header${beginningOfDay(date).getTime() === today ? ' today' : ''}`;
    header.innerHTML = `<span>${DAY_LABELS[dayIndex]}</span><strong>${date.getDate()}</strong>`;
    els.dayHeaders.append(header);
  }
}

function renderDays() {
  els.days.innerHTML = '';
  const today = beginningOfDay(new Date()).getTime();
  for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
    const date = addDays(state.weekStart, dayIndex);
    const column = document.createElement('section');
    column.className = `day-column${beginningOfDay(date).getTime() === today ? ' today' : ''}`;
    column.dataset.dayIndex = String(dayIndex);
    column.style.height = `${MINUTES_PER_DAY / 60 * HOUR_HEIGHT}px`;
    column.addEventListener('pointerdown', startCreateDrag);

    for (let hour = 0; hour < 24; hour += 1) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${hour * HOUR_HEIGHT}px`;
      column.append(line);
    }

    const segments = segmentsForDay(dayIndex);
    for (const segment of layoutDaySegments(segments)) {
      column.append(renderEventBlock(segment));
    }
    els.days.append(column);
  }
}

function segmentsForDay(dayIndex) {
  const dayStart = addDays(state.weekStart, dayIndex);
  const dayEnd = addDays(dayStart, 1);
  return state.events
    .map((event) => {
      const originalStart = new Date(event.start_at);
      const originalEnd = new Date(event.end_at);
      if (originalStart >= dayEnd || originalEnd <= dayStart) return null;
      const clampedStart = originalStart > dayStart ? originalStart : dayStart;
      const clampedEnd = originalEnd < dayEnd ? originalEnd : dayEnd;
      return {
        ...event,
        originalStart,
        originalEnd,
        startDate: clampedStart,
        endDate: clampedEnd,
        startMin: minutesSinceMidnight(clampedStart),
        endMin: clampedEnd.getTime() === dayEnd.getTime() ? MINUTES_PER_DAY : minutesSinceMidnight(clampedEnd),
      };
    })
    .filter(Boolean)
    .filter((event) => event.endMin > event.startMin)
    .sort(compareSegments);
}

function layoutDaySegments(segments) {
  const clusters = [];
  let current = [];
  let clusterEnd = -1;
  for (const segment of segments) {
    if (current.length === 0 || segment.startMin < clusterEnd) {
      current.push(segment);
      clusterEnd = Math.max(clusterEnd, segment.endMin);
    } else {
      clusters.push(current);
      current = [segment];
      clusterEnd = segment.endMin;
    }
  }
  if (current.length) clusters.push(current);

  return clusters.flatMap((cluster) => layoutCluster(cluster));
}

function layoutCluster(cluster) {
  const columns = [];
  const laidOut = [];
  for (const segment of cluster) {
    let columnIndex = columns.findIndex((endMin) => endMin <= segment.startMin);
    if (columnIndex === -1) {
      columnIndex = columns.length;
      columns.push(segment.endMin);
    } else {
      columns[columnIndex] = segment.endMin;
    }
    laidOut.push({ ...segment, columnIndex });
  }
  const columnCount = Math.max(1, columns.length);
  return laidOut.map((segment) => ({ ...segment, columnCount }));
}

function renderEventBlock(segment) {
  const block = document.createElement('button');
  block.type = 'button';
  block.className = 'event-block';
  const top = (segment.startMin / 60) * HOUR_HEIGHT;
  const height = ((segment.endMin - segment.startMin) / 60) * HOUR_HEIGHT;
  const width = 100 / segment.columnCount;
  block.style.top = `${top}px`;
  block.style.height = `${height}px`;
  block.style.left = `${segment.columnIndex * width}%`;
  block.style.width = `${width}%`;
  block.style.zIndex = String(10 + segment.columnIndex);
  block.innerHTML = `
    <span class="event-title">${escapeHtml(segment.title)}</span>
    <span class="event-time">${formatTime(segment.startDate)} – ${formatTime(segment.endDate)}</span>
  `;
  block.addEventListener('pointerdown', (event) => event.stopPropagation());
  block.addEventListener('click', (event) => {
    event.stopPropagation();
    openEditModal(segment.id);
  });
  return block;
}

function startCreateDrag(event) {
  if (event.button !== 0 || event.target.closest('.event-block')) return;
  const column = event.currentTarget;
  const startMinute = coordinateToMinute(event, column);
  const preview = document.createElement('div');
  preview.className = 'selection-preview';
  column.append(preview);
  state.drag = { column, dayIndex: Number(column.dataset.dayIndex), startMinute, endMinute: startMinute + 30, preview };
  updatePreview(state.drag);
  column.setPointerCapture(event.pointerId);
  column.addEventListener('pointermove', updateCreateDrag);
  column.addEventListener('pointerup', finishCreateDrag, { once: true });
  column.addEventListener('pointercancel', cancelCreateDrag, { once: true });
}

function updateCreateDrag(event) {
  if (!state.drag) return;
  state.drag.endMinute = coordinateToMinute(event, state.drag.column);
  updatePreview(state.drag);
}

function finishCreateDrag() {
  const drag = state.drag;
  if (!drag) return;
  drag.column.removeEventListener('pointermove', updateCreateDrag);
  drag.preview.remove();
  state.drag = null;
  let startMinute = Math.min(drag.startMinute, drag.endMinute);
  let endMinute = Math.max(drag.startMinute, drag.endMinute);
  if (startMinute >= MINUTES_PER_DAY) {
    startMinute = MINUTES_PER_DAY - 30;
    endMinute = MINUTES_PER_DAY;
  } else {
    if (endMinute === startMinute) endMinute = startMinute + 30;
    endMinute = Math.min(MINUTES_PER_DAY, Math.max(startMinute + 15, endMinute));
  }
  const date = addDays(state.weekStart, drag.dayIndex);
  openCreateModal(dateWithMinutes(date, startMinute), dateWithMinutes(date, endMinute));
}

function cancelCreateDrag() {
  if (!state.drag) return;
  state.drag.column.removeEventListener('pointermove', updateCreateDrag);
  state.drag.preview.remove();
  state.drag = null;
}

function updatePreview(drag) {
  const start = Math.min(drag.startMinute, drag.endMinute);
  const end = Math.max(drag.startMinute, drag.endMinute) || start + 15;
  drag.preview.style.top = `${(start / 60) * HOUR_HEIGHT}px`;
  drag.preview.style.height = `${(Math.max(15, end - start) / 60) * HOUR_HEIGHT}px`;
}

function coordinateToMinute(event, column) {
  const rect = column.getBoundingClientRect();
  const y = Math.min(rect.height, Math.max(0, event.clientY - rect.top));
  const raw = (y / HOUR_HEIGHT) * 60;
  return Math.min(MINUTES_PER_DAY, Math.max(0, Math.round(raw / 15) * 15));
}

function openCreateModal(start, end) {
  editingId = null;
  els.modalTitle.textContent = 'Create event';
  els.title.value = '';
  els.start.value = toDateTimeLocalValue(start);
  els.end.value = toDateTimeLocalValue(end);
  els.deleteButton.classList.add('hidden');
  showModal();
}

function openEditModal(id) {
  const event = state.events.find((item) => item.id === id);
  if (!event) return;
  editingId = id;
  els.modalTitle.textContent = 'Edit event';
  els.title.value = event.title;
  els.start.value = toDateTimeLocalValue(new Date(event.start_at));
  els.end.value = toDateTimeLocalValue(new Date(event.end_at));
  els.deleteButton.classList.remove('hidden');
  showModal();
}

function showModal() {
  els.error.textContent = '';
  els.modal.classList.remove('hidden');
  els.title.focus();
}

function closeModal() {
  els.modal.classList.add('hidden');
  editingId = null;
}

async function saveForm(event) {
  event.preventDefault();
  els.error.textContent = '';
  const start = new Date(els.start.value);
  const end = new Date(els.end.value);
  const payload = { title: els.title.value.trim(), start_at: start.toISOString(), end_at: end.toISOString() };
  if (!payload.title) return (els.error.textContent = 'Title is required.');
  if (end <= start) return (els.error.textContent = 'End must be after start.');
  const url = editingId ? `${API_BASE}/api/events/${editingId}` : `${API_BASE}/api/events`;
  const response = await fetch(url, {
    method: editingId ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    els.error.textContent = body.error || 'Could not save event.';
    return;
  }
  closeModal();
  await loadWeek();
}

async function deleteCurrentEvent() {
  if (!editingId || !confirm('Delete this event?')) return;
  const response = await fetch(`${API_BASE}/api/events/${editingId}`, { method: 'DELETE' });
  if (!response.ok) {
    els.error.textContent = 'Could not delete event.';
    return;
  }
  closeModal();
  await loadWeek();
}

function startOfWeek(date) {
  const d = beginningOfDay(date);
  const day = d.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  return addDays(d, mondayOffset);
}

function beginningOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function minutesSinceMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

function dateWithMinutes(day, minute) {
  const date = beginningOfDay(day);
  date.setMinutes(minute);
  return date;
}

function toDateTimeLocalValue(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDateLong(date) {
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

function compareSegments(a, b) {
  return a.startMin - b.startMin || a.endMin - b.endMin || a.id - b.id;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
