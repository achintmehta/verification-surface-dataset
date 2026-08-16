const API_BASE = `${window.location.origin}/api`;
const HOUR_HEIGHT = 64;
const DAY_HEIGHT = HOUR_HEIGHT * 24;
const SNAP_MINUTES = 15;
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const app = document.querySelector('#app');
app.innerHTML = `
  <header class="toolbar">
    <div class="brand">
      <h1>Week Calendar</h1>
      <p>Minute-precision week view</p>
    </div>
    <nav class="nav-actions">
      <button id="prevWeek" type="button">← Previous</button>
      <button id="today" type="button">Today</button>
      <button id="nextWeek" type="button">Next →</button>
    </nav>
    <div id="rangeLabel" class="range-label"></div>
  </header>
  <main class="calendar-shell">
    <div class="calendar-header">
      <div class="header-gutter"></div>
      <div id="dayHeaders" class="day-headers"></div>
    </div>
    <div class="calendar-scroll">
      <div class="time-gutter" id="timeGutter"></div>
      <div id="weekGrid" class="week-grid"></div>
    </div>
  </main>

  <div id="modalBackdrop" class="modal-backdrop hidden">
    <form id="eventForm" class="event-form">
      <h2 id="formTitle">New event</h2>
      <label>
        Title
        <input id="eventTitle" name="title" type="text" required maxlength="120" />
      </label>
      <div class="form-row">
        <label>
          Start
          <input id="eventStart" name="start" type="datetime-local" required />
        </label>
        <label>
          End
          <input id="eventEnd" name="end" type="datetime-local" required />
        </label>
      </div>
      <p id="formError" class="form-error" role="alert"></p>
      <div class="form-actions">
        <button id="deleteEvent" class="danger hidden" type="button">Delete</button>
        <span class="spacer"></span>
        <button id="cancelForm" type="button">Cancel</button>
        <button class="primary" type="submit">Save</button>
      </div>
    </form>
  </div>
`;

let weekStart = startOfWeek(new Date());
let events = [];
let editingEvent = null;
let dragState = null;

const els = {
  prevWeek: document.querySelector('#prevWeek'),
  today: document.querySelector('#today'),
  nextWeek: document.querySelector('#nextWeek'),
  rangeLabel: document.querySelector('#rangeLabel'),
  dayHeaders: document.querySelector('#dayHeaders'),
  timeGutter: document.querySelector('#timeGutter'),
  weekGrid: document.querySelector('#weekGrid'),
  modalBackdrop: document.querySelector('#modalBackdrop'),
  eventForm: document.querySelector('#eventForm'),
  formTitle: document.querySelector('#formTitle'),
  eventTitle: document.querySelector('#eventTitle'),
  eventStart: document.querySelector('#eventStart'),
  eventEnd: document.querySelector('#eventEnd'),
  formError: document.querySelector('#formError'),
  deleteEvent: document.querySelector('#deleteEvent'),
  cancelForm: document.querySelector('#cancelForm'),
};

initStaticGrid();
attachHandlers();
loadWeek();

function initStaticGrid() {
  els.timeGutter.innerHTML = '';
  for (let h = 0; h <= 24; h++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = `${h * HOUR_HEIGHT}px`;
    label.textContent = `${String(h).padStart(2, '0')}:00`;
    els.timeGutter.appendChild(label);
  }
}

function attachHandlers() {
  els.prevWeek.addEventListener('click', () => changeWeek(-7));
  els.nextWeek.addEventListener('click', () => changeWeek(7));
  els.today.addEventListener('click', () => { weekStart = startOfWeek(new Date()); loadWeek(); });
  els.cancelForm.addEventListener('click', closeModal);
  els.modalBackdrop.addEventListener('mousedown', (e) => { if (e.target === els.modalBackdrop) closeModal(); });
  els.eventForm.addEventListener('submit', saveEvent);
  els.deleteEvent.addEventListener('click', deleteCurrentEvent);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
}

async function loadWeek() {
  renderHeaders();
  try {
    const start = weekStart.toISOString();
    const end = addDays(weekStart, 7).toISOString();
    const res = await fetch(`${API_BASE}/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
    if (!res.ok) throw new Error('Failed to load events');
    events = await res.json();
    renderWeekGrid();
  } catch (err) {
    console.error(err);
    events = [];
    renderWeekGrid('Could not load events. Is the API server running?');
  }
}

function renderHeaders() {
  const end = addDays(weekStart, 6);
  els.rangeLabel.textContent = `${formatMonthDay(weekStart)} – ${formatMonthDay(end)} ${end.getFullYear()}`;
  els.dayHeaders.innerHTML = '';
  const todayKey = dateKey(new Date());
  for (let i = 0; i < 7; i++) {
    const d = addDays(weekStart, i);
    const header = document.createElement('div');
    header.className = `day-header ${dateKey(d) === todayKey ? 'today' : ''}`;
    header.innerHTML = `<span>${DAY_NAMES[i]}</span><strong>${d.getDate()}</strong>`;
    els.dayHeaders.appendChild(header);
  }
}

function renderWeekGrid(errorMessage = '') {
  els.weekGrid.innerHTML = '';
  els.weekGrid.style.height = `${DAY_HEIGHT}px`;
  for (let i = 0; i < 7; i++) {
    const day = addDays(weekStart, i);
    const col = document.createElement('section');
    col.className = `day-column ${dateKey(day) === dateKey(new Date()) ? 'today' : ''}`;
    col.dataset.dayIndex = String(i);
    col.style.height = `${DAY_HEIGHT}px`;
    for (let h = 0; h <= 24; h++) {
      const line = document.createElement('div');
      line.className = h === 24 ? 'hour-line last' : 'hour-line';
      line.style.top = `${h * HOUR_HEIGHT}px`;
      col.appendChild(line);
    }
    setupSelectionHandlers(col, day);
    els.weekGrid.appendChild(col);
  }

  if (errorMessage) {
    const msg = document.createElement('div');
    msg.className = 'grid-message';
    msg.textContent = errorMessage;
    els.weekGrid.appendChild(msg);
    return;
  }

  const byDay = splitAndGroupEventsByDay(events);
  byDay.forEach((dayEvents, dayIndex) => {
    const col = els.weekGrid.querySelector(`[data-day-index="${dayIndex}"]`);
    layoutDayEvents(dayEvents).forEach((item) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'event-block';
      el.style.top = `${item.top}px`;
      el.style.height = `${item.height}px`;
      el.style.left = `calc(${item.leftPct}% + 3px)`;
      el.style.width = `calc(${item.widthPct}% - 6px)`;
      el.innerHTML = `<strong title="${escapeHtml(item.event.title)}">${escapeHtml(item.event.title)}</strong><span>${formatTime(item.visibleStart)}–${formatTime(item.visibleEnd)}</span>`;
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditForm(item.event);
      });
      col.appendChild(el);
    });
  });
}

function splitAndGroupEventsByDay(rawEvents) {
  const days = Array.from({ length: 7 }, () => []);
  const weekEnd = addDays(weekStart, 7);
  rawEvents.forEach((event) => {
    const originalStart = new Date(event.start_at);
    const originalEnd = new Date(event.end_at);
    for (let i = 0; i < 7; i++) {
      const dayStart = addDays(weekStart, i);
      const dayEnd = addDays(dayStart, 1);
      const visibleStart = maxDate(originalStart, dayStart);
      const visibleEnd = minDate(originalEnd, dayEnd, weekEnd);
      if (visibleStart < visibleEnd) {
        days[i].push({ event, visibleStart, visibleEnd });
      }
    }
  });
  return days;
}

function layoutDayEvents(dayEvents) {
  const sorted = [...dayEvents].sort((a, b) => a.visibleStart - b.visibleStart || a.visibleEnd - b.visibleEnd || a.event.id - b.event.id);
  const clusters = [];
  let current = [];
  let clusterEnd = null;

  sorted.forEach((item) => {
    if (current.length === 0 || item.visibleStart < clusterEnd) {
      current.push(item);
      clusterEnd = clusterEnd ? maxDate(clusterEnd, item.visibleEnd) : item.visibleEnd;
    } else {
      clusters.push(current);
      current = [item];
      clusterEnd = item.visibleEnd;
    }
  });
  if (current.length) clusters.push(current);

  const laidOut = [];
  clusters.forEach((cluster) => {
    const columns = [];
    const placements = [];
    cluster.forEach((item) => {
      let colIndex = columns.findIndex((end) => end <= item.visibleStart);
      if (colIndex === -1) {
        colIndex = columns.length;
        columns.push(item.visibleEnd);
      } else {
        columns[colIndex] = item.visibleEnd;
      }
      placements.push({ item, colIndex });
    });
    const colCount = Math.max(columns.length, 1);
    placements.forEach(({ item, colIndex }) => {
      const startMin = minutesSinceMidnight(item.visibleStart);
      const endMin = minutesSinceMidnight(item.visibleEnd);
      laidOut.push({
        ...item,
        top: (startMin / 60) * HOUR_HEIGHT,
        height: Math.max(1, ((endMin - startMin) / 60) * HOUR_HEIGHT),
        leftPct: (colIndex / colCount) * 100,
        widthPct: 100 / colCount,
      });
    });
  });
  return laidOut;
}

function setupSelectionHandlers(col, day) {
  col.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('.event-block')) return;
    const rect = col.getBoundingClientRect();
    const startY = clamp(e.clientY - rect.top, 0, DAY_HEIGHT);
    const preview = document.createElement('div');
    preview.className = 'selection-preview';
    preview.style.top = `${startY}px`;
    preview.style.height = '1px';
    col.appendChild(preview);
    dragState = { col, day, rect, startY, currentY: startY, preview, moved: false };
    e.preventDefault();
  });

  col.addEventListener('click', (e) => {
    if (e.target.closest('.event-block') || dragState) return;
    const rect = col.getBoundingClientRect();
    const y = clamp(e.clientY - rect.top, 0, DAY_HEIGHT - 1);
    const startMin = snapMinutes((y / DAY_HEIGHT) * 1440);
    openCreateForm(dateAtMinutes(day, startMin), dateAtMinutes(day, Math.min(startMin + 60, 1440)));
  });
}

document.addEventListener('mousemove', (e) => {
  if (!dragState) return;
  const y = clamp(e.clientY - dragState.rect.top, 0, DAY_HEIGHT);
  dragState.currentY = y;
  if (Math.abs(y - dragState.startY) > 3) dragState.moved = true;
  const top = Math.min(dragState.startY, y);
  const height = Math.max(1, Math.abs(y - dragState.startY));
  dragState.preview.style.top = `${top}px`;
  dragState.preview.style.height = `${height}px`;
});

document.addEventListener('mouseup', () => {
  if (!dragState) return;
  const state = dragState;
  dragState = null;
  state.preview.remove();
  if (!state.moved) return;
  let a = snapMinutes((Math.min(state.startY, state.currentY) / DAY_HEIGHT) * 1440);
  let b = snapMinutes((Math.max(state.startY, state.currentY) / DAY_HEIGHT) * 1440);
  if (b <= a) b = Math.min(a + SNAP_MINUTES, 1440);
  openCreateForm(dateAtMinutes(state.day, a), dateAtMinutes(state.day, b));
});

function openCreateForm(start, end) {
  editingEvent = null;
  els.formTitle.textContent = 'New event';
  els.eventTitle.value = '';
  els.eventStart.value = toDatetimeLocalValue(start);
  els.eventEnd.value = toDatetimeLocalValue(end);
  els.deleteEvent.classList.add('hidden');
  els.formError.textContent = '';
  els.modalBackdrop.classList.remove('hidden');
  els.eventTitle.focus();
}

function openEditForm(event) {
  editingEvent = event;
  els.formTitle.textContent = 'Edit event';
  els.eventTitle.value = event.title;
  els.eventStart.value = toDatetimeLocalValue(new Date(event.start_at));
  els.eventEnd.value = toDatetimeLocalValue(new Date(event.end_at));
  els.deleteEvent.classList.remove('hidden');
  els.formError.textContent = '';
  els.modalBackdrop.classList.remove('hidden');
  els.eventTitle.focus();
}

function closeModal() {
  els.modalBackdrop.classList.add('hidden');
  editingEvent = null;
}

async function saveEvent(e) {
  e.preventDefault();
  els.formError.textContent = '';
  const payload = {
    title: els.eventTitle.value.trim(),
    start_at: new Date(els.eventStart.value).toISOString(),
    end_at: new Date(els.eventEnd.value).toISOString(),
  };
  if (!payload.title) return (els.formError.textContent = 'Title is required.');
  if (new Date(payload.end_at) <= new Date(payload.start_at)) return (els.formError.textContent = 'End must be after start.');
  try {
    const url = editingEvent ? `${API_BASE}/events/${editingEvent.id}` : `${API_BASE}/events`;
    const method = editingEvent ? 'PUT' : 'POST';
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Save failed');
    }
    closeModal();
    await loadWeek();
  } catch (err) {
    els.formError.textContent = err.message;
  }
}

async function deleteCurrentEvent() {
  if (!editingEvent) return;
  if (!confirm('Delete this event?')) return;
  try {
    const res = await fetch(`${API_BASE}/events/${editingEvent.id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Delete failed');
    closeModal();
    await loadWeek();
  } catch (err) {
    els.formError.textContent = err.message;
  }
}

function changeWeek(days) {
  weekStart = addDays(weekStart, days);
  loadWeek();
}

function startOfWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  const diff = (day + 6) % 7;
  d.setDate(d.getDate() - diff);
  return d;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function dateAtMinutes(day, minutes) {
  const d = new Date(day);
  d.setHours(0, 0, 0, 0);
  d.setMinutes(minutes);
  return d;
}

function minutesSinceMidnight(date) {
  return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60 + date.getMilliseconds() / 60000;
}

function snapMinutes(minutes) {
  return clamp(Math.round(minutes / SNAP_MINUTES) * SNAP_MINUTES, 0, 1440);
}

function toDatetimeLocalValue(date) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatTime(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function formatMonthDay(date) {
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function dateKey(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function minDate(...dates) {
  return new Date(Math.min(...dates.map((d) => new Date(d).getTime())));
}

function maxDate(...dates) {
  return new Date(Math.max(...dates.map((d) => new Date(d).getTime())));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}
