const MINUTES_PER_DAY = 24 * 60;
const HOUR_HEIGHT = 64;
const DAY_HEIGHT = HOUR_HEIGHT * 24;
const SNAP_MINUTES = 15;
const API = '/api/events';

let weekStart = startOfWeek(new Date());
let events = [];
let selection = null;
let modalState = null;
let dragState = null;

const app = document.getElementById('app');
app.innerHTML = `
  <header class="toolbar">
    <div class="nav">
      <button id="prevWeek" type="button">← Previous</button>
      <button id="todayWeek" type="button">Today</button>
      <button id="nextWeek" type="button">Next →</button>
    </div>
    <h1>Week Calendar</h1>
    <div id="weekLabel" class="week-label"></div>
  </header>
  <main class="calendar-shell">
    <div class="corner"></div>
    <div id="dayHeaders" class="day-headers"></div>
    <div id="timeGutter" class="time-gutter"></div>
    <div id="weekGrid" class="week-grid"></div>
  </main>
  <div id="modalBackdrop" class="modal-backdrop hidden" role="dialog" aria-modal="true">
    <form id="eventForm" class="event-form">
      <h2 id="formTitle">Create event</h2>
      <label>Title <input id="eventTitle" name="title" required /></label>
      <div class="form-row">
        <label>Start <input id="eventStart" name="start" type="datetime-local" required /></label>
        <label>End <input id="eventEnd" name="end" type="datetime-local" required /></label>
      </div>
      <p id="formError" class="form-error"></p>
      <div class="form-actions">
        <button id="deleteEvent" class="danger hidden" type="button">Delete</button>
        <span class="spacer"></span>
        <button id="cancelForm" type="button">Cancel</button>
        <button type="submit">Save</button>
      </div>
    </form>
  </div>
`;

const els = {
  prev: document.getElementById('prevWeek'),
  today: document.getElementById('todayWeek'),
  next: document.getElementById('nextWeek'),
  label: document.getElementById('weekLabel'),
  headers: document.getElementById('dayHeaders'),
  gutter: document.getElementById('timeGutter'),
  grid: document.getElementById('weekGrid'),
  backdrop: document.getElementById('modalBackdrop'),
  form: document.getElementById('eventForm'),
  formTitle: document.getElementById('formTitle'),
  title: document.getElementById('eventTitle'),
  start: document.getElementById('eventStart'),
  end: document.getElementById('eventEnd'),
  error: document.getElementById('formError'),
  delete: document.getElementById('deleteEvent'),
  cancel: document.getElementById('cancelForm')
};

els.prev.addEventListener('click', () => moveWeek(-1));
els.today.addEventListener('click', () => { weekStart = startOfWeek(new Date()); loadWeek(); });
els.next.addEventListener('click', () => moveWeek(1));
els.cancel.addEventListener('click', closeModal);
els.backdrop.addEventListener('click', (e) => { if (e.target === els.backdrop) closeModal(); });
els.form.addEventListener('submit', saveForm);
els.delete.addEventListener('click', deleteCurrentEvent);

renderStaticGrid();
loadWeek();

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

function moveWeek(delta) {
  weekStart = addDays(weekStart, delta * 7);
  loadWeek();
}

function renderStaticGrid() {
  els.gutter.style.height = `${DAY_HEIGHT}px`;
  els.gutter.innerHTML = '';
  for (let h = 0; h <= 24; h++) {
    const mark = document.createElement('div');
    mark.className = 'time-mark';
    mark.style.top = `${h * HOUR_HEIGHT}px`;
    mark.textContent = `${String(h).padStart(2, '0')}:00`;
    els.gutter.appendChild(mark);
  }
}

async function loadWeek() {
  const end = addDays(weekStart, 7);
  els.label.textContent = `${formatShortDate(weekStart)} – ${formatShortDate(addDays(end, -1))}`;
  const res = await fetch(`${API}?start=${encodeURIComponent(weekStart.toISOString())}&end=${encodeURIComponent(end.toISOString())}`);
  if (!res.ok) throw new Error('Failed to load events');
  events = await res.json();
  renderWeek();
}

function renderWeek() {
  els.headers.innerHTML = '';
  els.grid.innerHTML = '';
  els.grid.style.height = `${DAY_HEIGHT}px`;
  const todayKey = dateKey(new Date());

  for (let i = 0; i < 7; i++) {
    const day = addDays(weekStart, i);
    const header = document.createElement('div');
    header.className = 'day-header' + (dateKey(day) === todayKey ? ' today' : '');
    header.innerHTML = `<strong>${weekday(day)}</strong><span>${formatShortDate(day)}</span>`;
    els.headers.appendChild(header);

    const col = document.createElement('div');
    col.className = 'day-column' + (dateKey(day) === todayKey ? ' today' : '');
    col.dataset.dayIndex = String(i);
    col.style.height = `${DAY_HEIGHT}px`;
    renderHourLines(col);
    attachSelectionHandlers(col, day);
    els.grid.appendChild(col);

    const dayEvents = eventsForDay(day).map(e => clampEventToDay(e, day)).filter(Boolean);
    const laidOut = layoutEvents(dayEvents);
    for (const item of laidOut) col.appendChild(eventElement(item));
  }
}

function renderHourLines(col) {
  for (let h = 0; h <= 24; h++) {
    const line = document.createElement('div');
    line.className = 'hour-line';
    line.style.top = `${h * HOUR_HEIGHT}px`;
    col.appendChild(line);
  }
}

function eventsForDay(day) {
  const start = new Date(day); start.setHours(0, 0, 0, 0);
  const end = addDays(start, 1);
  return events.filter(ev => new Date(ev.start_at) < end && new Date(ev.end_at) > start);
}

function clampEventToDay(ev, day) {
  const dayStart = new Date(day); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = addDays(dayStart, 1);
  const rawStart = new Date(ev.start_at);
  const rawEnd = new Date(ev.end_at);
  const start = rawStart < dayStart ? dayStart : rawStart;
  const end = rawEnd > dayEnd ? dayEnd : rawEnd;
  if (end <= start) return null;
  return {
    ...ev,
    _start: start,
    _end: end,
    startMin: minutesFromMidnight(start),
    endMin: minutesFromMidnight(end) === 0 && end.getTime() === dayEnd.getTime() ? MINUTES_PER_DAY : minutesFromMidnight(end)
  };
}

function layoutEvents(dayEvents) {
  const sorted = [...dayEvents].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin || a.id - b.id);
  const clusters = [];
  let current = [];
  let clusterEnd = -1;

  for (const ev of sorted) {
    if (!current.length || ev.startMin < clusterEnd) {
      current.push(ev);
      clusterEnd = Math.max(clusterEnd, ev.endMin);
    } else {
      clusters.push(current);
      current = [ev];
      clusterEnd = ev.endMin;
    }
  }
  if (current.length) clusters.push(current);

  const output = [];
  for (const cluster of clusters) {
    const columns = [];
    const assigned = cluster.map(ev => {
      let colIndex = columns.findIndex(end => end <= ev.startMin);
      if (colIndex === -1) {
        colIndex = columns.length;
        columns.push(ev.endMin);
      } else {
        columns[colIndex] = ev.endMin;
      }
      return { ev, colIndex };
    });
    const colCount = Math.max(1, columns.length);
    for (const a of assigned) {
      output.push({
        ...a.ev,
        colIndex: a.colIndex,
        colCount,
        top: a.ev.startMin / 60 * HOUR_HEIGHT,
        height: Math.max(1, (a.ev.endMin - a.ev.startMin) / 60 * HOUR_HEIGHT)
      });
    }
  }
  return output;
}

function eventElement(ev) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'event-block';
  const gap = 3;
  const width = 100 / ev.colCount;
  el.style.top = `${ev.top}px`;
  el.style.height = `${ev.height}px`;
  el.style.left = `calc(${ev.colIndex * width}% + ${gap}px)`;
  el.style.width = `calc(${width}% - ${gap * 2}px)`;
  el.innerHTML = `<span class="event-title">${escapeHtml(ev.title)}</span><span class="event-time">${formatTime(new Date(ev.start_at))}–${formatTime(new Date(ev.end_at))}</span>`;
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    openEditModal(ev);
  });
  return el;
}

function attachSelectionHandlers(col, day) {
  col.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.event-block')) return;
    const rect = col.getBoundingClientRect();
    const startY = clamp(e.clientY - rect.top, 0, DAY_HEIGHT);
    dragState = { col, day, rect, startY, currentY: startY };
    col.setPointerCapture(e.pointerId);
    showSelection(col, startY, startY + HOUR_HEIGHT / 4);
  });
  col.addEventListener('pointermove', (e) => {
    if (!dragState || dragState.col !== col) return;
    dragState.currentY = clamp(e.clientY - dragState.rect.top, 0, DAY_HEIGHT);
    showSelection(col, dragState.startY, dragState.currentY);
  });
  col.addEventListener('pointerup', (e) => {
    if (!dragState || dragState.col !== col) return;
    const a = yToMinutes(dragState.startY);
    const b = yToMinutes(dragState.currentY);
    let startMin = Math.min(a, b);
    let endMin = Math.max(a, b);
    if (endMin === startMin) endMin = Math.min(MINUTES_PER_DAY, startMin + 60);
    if (endMin <= startMin) startMin = Math.max(0, endMin - 60);
    clearSelection(col);
    dragState = null;
    const start = dateWithMinutes(day, startMin);
    const end = dateWithMinutes(day, endMin);
    openCreateModal(start, end);
  });
}

function showSelection(col, y1, y2) {
  clearSelection(col);
  const sel = document.createElement('div');
  sel.className = 'selection-range';
  const top = Math.min(y1, y2);
  const bottom = Math.max(y1, y2);
  sel.style.top = `${top}px`;
  sel.style.height = `${Math.max(8, bottom - top)}px`;
  col.appendChild(sel);
  selection = sel;
}

function clearSelection(col) {
  if (selection && selection.parentNode === col) selection.remove();
  selection = null;
}

function yToMinutes(y) {
  return clamp(Math.round((y / DAY_HEIGHT * MINUTES_PER_DAY) / SNAP_MINUTES) * SNAP_MINUTES, 0, MINUTES_PER_DAY);
}

function openCreateModal(start, end) {
  modalState = { mode: 'create' };
  els.formTitle.textContent = 'Create event';
  els.title.value = '';
  els.start.value = toLocalInput(start);
  els.end.value = toLocalInput(end);
  els.delete.classList.add('hidden');
  showModal();
}

function openEditModal(ev) {
  modalState = { mode: 'edit', id: ev.id };
  els.formTitle.textContent = 'Edit event';
  els.title.value = ev.title;
  els.start.value = toLocalInput(new Date(ev.start_at));
  els.end.value = toLocalInput(new Date(ev.end_at));
  els.delete.classList.remove('hidden');
  showModal();
}

function showModal() {
  els.error.textContent = '';
  els.backdrop.classList.remove('hidden');
  setTimeout(() => els.title.focus(), 0);
}

function closeModal() {
  els.backdrop.classList.add('hidden');
  modalState = null;
}

async function saveForm(e) {
  e.preventDefault();
  els.error.textContent = '';
  const payload = {
    title: els.title.value,
    start_at: new Date(els.start.value).toISOString(),
    end_at: new Date(els.end.value).toISOString()
  };
  const editing = modalState?.mode === 'edit';
  const url = editing ? `${API}/${modalState.id}` : API;
  const res = await fetch(url, {
    method: editing ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const err = await safeJson(res);
    els.error.textContent = err.error || 'Could not save event';
    return;
  }
  closeModal();
  await loadWeek();
}

async function deleteCurrentEvent() {
  if (modalState?.mode !== 'edit') return;
  const res = await fetch(`${API}/${modalState.id}`, { method: 'DELETE' });
  if (!res.ok) {
    const err = await safeJson(res);
    els.error.textContent = err.error || 'Could not delete event';
    return;
  }
  closeModal();
  await loadWeek();
}

async function safeJson(res) {
  try { return await res.json(); } catch { return {}; }
}

function minutesFromMidnight(date) {
  return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
}

function dateWithMinutes(day, minutes) {
  const d = new Date(day);
  d.setHours(0, minutes, 0, 0);
  return d;
}

function toLocalInput(date) {
  const d = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatShortDate(date) {
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function weekday(date) {
  return date.toLocaleDateString([], { weekday: 'short' });
}

function dateKey(date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function escapeHtml(str) {
  return String(str).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}
