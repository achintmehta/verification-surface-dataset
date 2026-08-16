import './styles.css';

const HOUR_HEIGHT = 64;
const DAY_MINUTES = 24 * 60;
const SNAP_MINUTES = 15;
const API = '/api/events';
const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const state = {
  weekStart: startOfWeek(new Date()),
  events: [],
  drag: null,
};

const app = document.getElementById('app');
app.innerHTML = `
  <div class="calendar-app">
    <header class="toolbar">
      <div class="brand">
        <h1>Week Calendar</h1>
        <p>Minute-precision events with collision-free overlap layout</p>
      </div>
      <div class="nav">
        <button id="prevWeek" type="button">← Previous</button>
        <button id="today" type="button">Today</button>
        <button id="nextWeek" type="button">Next →</button>
      </div>
      <div id="weekLabel" class="week-label"></div>
    </header>
    <main class="calendar-shell">
      <div class="time-header-spacer"></div>
      <div id="dayHeaders" class="day-headers"></div>
      <div id="timeAxis" class="time-axis"></div>
      <div id="weekGrid" class="week-grid"></div>
    </main>
  </div>
  <div id="modalBackdrop" class="modal-backdrop hidden" role="dialog" aria-modal="true">
    <form id="eventForm" class="event-form">
      <h2 id="modalTitle">Create event</h2>
      <label>Title <input id="eventTitle" name="title" required autocomplete="off" /></label>
      <div class="form-row">
        <label>Start <input id="eventStart" name="start_at" type="datetime-local" required /></label>
        <label>End <input id="eventEnd" name="end_at" type="datetime-local" required /></label>
      </div>
      <p id="formError" class="form-error" aria-live="polite"></p>
      <div class="form-actions">
        <button id="deleteEvent" type="button" class="danger hidden">Delete</button>
        <span class="grow"></span>
        <button id="cancelForm" type="button">Cancel</button>
        <button type="submit" class="primary">Save</button>
      </div>
    </form>
  </div>
`;

const els = {
  prev: document.getElementById('prevWeek'),
  today: document.getElementById('today'),
  next: document.getElementById('nextWeek'),
  weekLabel: document.getElementById('weekLabel'),
  dayHeaders: document.getElementById('dayHeaders'),
  timeAxis: document.getElementById('timeAxis'),
  weekGrid: document.getElementById('weekGrid'),
  backdrop: document.getElementById('modalBackdrop'),
  form: document.getElementById('eventForm'),
  modalTitle: document.getElementById('modalTitle'),
  title: document.getElementById('eventTitle'),
  start: document.getElementById('eventStart'),
  end: document.getElementById('eventEnd'),
  error: document.getElementById('formError'),
  deleteBtn: document.getElementById('deleteEvent'),
  cancel: document.getElementById('cancelForm'),
};

let editingId = null;

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

function isoLocalDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function toDatetimeLocal(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDay(date) {
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function weekEnd() {
  return addDays(state.weekStart, 7);
}

function minutesFromMidnight(date) {
  return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60 + date.getMilliseconds() / 60000;
}

function minuteToY(minutes) {
  return (minutes / 60) * HOUR_HEIGHT;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

async function api(path = '', options = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      message = body.error || message;
    } catch {}
    throw new Error(message);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function loadEvents() {
  const start = state.weekStart.toISOString();
  const end = weekEnd().toISOString();
  state.events = await api(`?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
  render();
}

function render() {
  renderLabels();
  renderTimeAxis();
  renderGrid();
}

function renderLabels() {
  const end = addDays(state.weekStart, 6);
  els.weekLabel.textContent = `${formatDay(state.weekStart)} – ${formatDay(end)}, ${end.getFullYear()}`;
  els.dayHeaders.innerHTML = '';
  const todayKey = isoLocalDate(new Date());
  for (let i = 0; i < 7; i++) {
    const date = addDays(state.weekStart, i);
    const header = document.createElement('div');
    header.className = 'day-header';
    if (isoLocalDate(date) === todayKey) header.classList.add('today');
    header.innerHTML = `<span>${dayNames[i]}</span><strong>${formatDay(date)}</strong>`;
    els.dayHeaders.appendChild(header);
  }
}

function renderTimeAxis() {
  if (els.timeAxis.childElementCount) return;
  els.timeAxis.style.height = `${24 * HOUR_HEIGHT}px`;
  for (let h = 0; h <= 24; h++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = `${h * HOUR_HEIGHT}px`;
    label.textContent = `${String(h).padStart(2, '0')}:00`;
    els.timeAxis.appendChild(label);
  }
}

function renderGrid() {
  els.weekGrid.innerHTML = '';
  els.weekGrid.style.height = `${24 * HOUR_HEIGHT}px`;
  const todayKey = isoLocalDate(new Date());
  for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
    const date = addDays(state.weekStart, dayIndex);
    const column = document.createElement('div');
    column.className = 'day-column';
    column.dataset.dayIndex = String(dayIndex);
    if (isoLocalDate(date) === todayKey) column.classList.add('today');
    renderHourLines(column);
    attachSelectionHandlers(column, date);
    const dayEvents = getRenderableEventsForDay(dayIndex);
    const laidOut = layoutDayEvents(dayEvents);
    for (const item of laidOut) column.appendChild(createEventElement(item));
    els.weekGrid.appendChild(column);
  }
}

function renderHourLines(column) {
  for (let h = 0; h < 24; h++) {
    const line = document.createElement('div');
    line.className = 'hour-line';
    line.style.top = `${h * HOUR_HEIGHT}px`;
    column.appendChild(line);
  }
}

function getRenderableEventsForDay(dayIndex) {
  const dayStart = addDays(state.weekStart, dayIndex);
  const dayEnd = addDays(dayStart, 1);
  return state.events
    .map((event) => {
      const start = new Date(event.start_at);
      const end = new Date(event.end_at);
      if (start >= dayEnd || end <= dayStart) return null;
      const renderStart = start < dayStart ? dayStart : start;
      const renderEnd = end > dayEnd ? dayEnd : end;
      return {
        ...event,
        realStart: start,
        realEnd: end,
        renderStart,
        renderEnd,
        startMin: clamp(minutesFromMidnight(renderStart), 0, DAY_MINUTES),
        endMin: clamp(renderEnd.getTime() === dayEnd.getTime() ? DAY_MINUTES : minutesFromMidnight(renderEnd), 0, DAY_MINUTES),
      };
    })
    .filter(Boolean)
    .filter((event) => event.endMin > event.startMin);
}

function overlaps(a, b) {
  return a.startMin < b.endMin && b.startMin < a.endMin;
}

function layoutDayEvents(events) {
  const sorted = [...events].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin || a.id - b.id);
  const clusters = [];
  let current = [];
  let clusterEnd = -1;
  for (const event of sorted) {
    if (!current.length || event.startMin < clusterEnd) {
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
    const colEnds = [];
    const assigned = [];
    for (const event of cluster) {
      let col = colEnds.findIndex((end) => end <= event.startMin);
      if (col === -1) {
        col = colEnds.length;
        colEnds.push(event.endMin);
      } else {
        colEnds[col] = event.endMin;
      }
      assigned.push({ ...event, col });
    }
    const totalCols = colEnds.length || 1;
    for (const event of assigned) {
      laidOut.push({ ...event, totalCols });
    }
  }
  return laidOut;
}

function createEventElement(item) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'event-block';
  const top = minuteToY(item.startMin);
  const height = Math.max(1, minuteToY(item.endMin - item.startMin));
  const width = 100 / item.totalCols;
  el.style.top = `${top}px`;
  el.style.height = `${height}px`;
  el.style.left = `calc(${item.col * width}% + 2px)`;
  el.style.width = `calc(${width}% - 4px)`;
  el.dataset.eventId = item.id;
  el.innerHTML = `<span class="event-title">${escapeHtml(item.title)}</span><span class="event-time">${formatTime(item.realStart)} – ${formatTime(item.realEnd)}</span>`;
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    openEditForm(item);
  });
  return el;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}

function attachSelectionHandlers(column, date) {
  column.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('.event-block')) return;
    const rect = column.getBoundingClientRect();
    const startY = clamp(e.clientY - rect.top + column.scrollTop, 0, 24 * HOUR_HEIGHT);
    const selection = document.createElement('div');
    selection.className = 'selection-box';
    column.appendChild(selection);
    state.drag = { column, date, startY, currentY: startY, selection, moved: false };
    updateSelectionBox();
    e.preventDefault();
  });
}

window.addEventListener('mousemove', (e) => {
  if (!state.drag) return;
  const rect = state.drag.column.getBoundingClientRect();
  state.drag.currentY = clamp(e.clientY - rect.top + state.drag.column.scrollTop, 0, 24 * HOUR_HEIGHT);
  if (Math.abs(state.drag.currentY - state.drag.startY) > 4) state.drag.moved = true;
  updateSelectionBox();
});

window.addEventListener('mouseup', () => {
  if (!state.drag) return;
  const drag = state.drag;
  drag.selection.remove();
  state.drag = null;
  const y1 = drag.startY;
  const y2 = drag.moved ? drag.currentY : drag.startY + HOUR_HEIGHT;
  const minA = snapMinutes((Math.min(y1, y2) / HOUR_HEIGHT) * 60);
  const minB = snapMinutes((Math.max(y1, y2) / HOUR_HEIGHT) * 60);
  const startMin = clamp(Math.min(minA, DAY_MINUTES - SNAP_MINUTES), 0, DAY_MINUTES - SNAP_MINUTES);
  const endMin = clamp(Math.max(minB, startMin + SNAP_MINUTES), SNAP_MINUTES, DAY_MINUTES);
  openCreateForm(minutesToDate(drag.date, startMin), minutesToDate(drag.date, endMin));
});

function updateSelectionBox() {
  const { startY, currentY, selection } = state.drag;
  const top = Math.min(startY, currentY);
  const height = Math.max(8, Math.abs(currentY - startY));
  selection.style.top = `${top}px`;
  selection.style.height = `${height}px`;
}

function snapMinutes(minutes) {
  return Math.round(minutes / SNAP_MINUTES) * SNAP_MINUTES;
}

function minutesToDate(day, minutes) {
  const d = new Date(day);
  d.setHours(0, 0, 0, 0);
  d.setMinutes(minutes);
  return d;
}

function openCreateForm(start, end) {
  editingId = null;
  els.modalTitle.textContent = 'Create event';
  els.title.value = '';
  els.start.value = toDatetimeLocal(start);
  els.end.value = toDatetimeLocal(end);
  els.deleteBtn.classList.add('hidden');
  showModal();
}

function openEditForm(event) {
  editingId = event.id;
  els.modalTitle.textContent = 'Edit event';
  els.title.value = event.title;
  els.start.value = toDatetimeLocal(event.realStart || new Date(event.start_at));
  els.end.value = toDatetimeLocal(event.realEnd || new Date(event.end_at));
  els.deleteBtn.classList.remove('hidden');
  showModal();
}

function showModal() {
  els.error.textContent = '';
  els.backdrop.classList.remove('hidden');
  setTimeout(() => els.title.focus(), 0);
}

function closeModal() {
  els.backdrop.classList.add('hidden');
  editingId = null;
}

els.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  els.error.textContent = '';
  try {
    const startDate = new Date(els.start.value);
    const endDate = new Date(els.end.value);
    if (!Number.isFinite(startDate.getTime()) || !Number.isFinite(endDate.getTime())) {
      throw new Error('Valid start and end times are required.');
    }
    const payload = {
      title: els.title.value,
      start_at: startDate.toISOString(),
      end_at: endDate.toISOString(),
    };
    if (editingId) {
      await api(`/${editingId}`, { method: 'PUT', body: JSON.stringify(payload) });
    } else {
      await api('', { method: 'POST', body: JSON.stringify(payload) });
    }
    closeModal();
    await loadEvents();
  } catch (err) {
    els.error.textContent = err.message;
  }
});

els.deleteBtn.addEventListener('click', async () => {
  if (!editingId) return;
  try {
    await api(`/${editingId}`, { method: 'DELETE' });
    closeModal();
    await loadEvents();
  } catch (err) {
    els.error.textContent = err.message;
  }
});

els.cancel.addEventListener('click', closeModal);
els.backdrop.addEventListener('mousedown', (e) => {
  if (e.target === els.backdrop) closeModal();
});

els.prev.addEventListener('click', async () => {
  state.weekStart = addDays(state.weekStart, -7);
  await loadEvents();
});
els.today.addEventListener('click', async () => {
  state.weekStart = startOfWeek(new Date());
  await loadEvents();
});
els.next.addEventListener('click', async () => {
  state.weekStart = addDays(state.weekStart, 7);
  await loadEvents();
});

loadEvents().catch((err) => {
  app.insertAdjacentHTML('beforeend', `<div class="fatal-error">${escapeHtml(err.message)}</div>`);
});
