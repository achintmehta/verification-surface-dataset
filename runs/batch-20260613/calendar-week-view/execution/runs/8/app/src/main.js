import './styles.css';

const HOUR_HEIGHT = 60;
const DAY_HEIGHT = 24 * HOUR_HEIGHT;
const MINUTES_PER_DAY = 24 * 60;
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const SHORT_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const state = {
  weekStart: startOfWeek(new Date()),
  events: [],
  selection: null,
};

const app = document.querySelector('#app');
app.innerHTML = `
  <div class="app-shell">
    <div class="toolbar">
      <h1>Week Calendar</h1>
      <button class="btn" id="prevWeek" type="button">← Previous</button>
      <button class="btn" id="todayWeek" type="button">Today</button>
      <button class="btn" id="nextWeek" type="button">Next →</button>
      <button class="btn primary" id="newEvent" type="button">New event</button>
      <div class="range" id="rangeLabel"></div>
    </div>
    <div class="calendar-wrap"><div class="calendar" id="calendar"></div></div>
  </div>
`;

const calendar = document.querySelector('#calendar');
document.querySelector('#prevWeek').addEventListener('click', () => changeWeek(-1));
document.querySelector('#nextWeek').addEventListener('click', () => changeWeek(1));
document.querySelector('#todayWeek').addEventListener('click', () => { state.weekStart = startOfWeek(new Date()); loadAndRender(); });
document.querySelector('#newEvent').addEventListener('click', () => {
  const now = new Date();
  const day = isSameWeek(now, state.weekStart) ? startOfDay(now) : new Date(state.weekStart);
  const startMin = isSameDay(now, day) ? roundToStep(now.getHours() * 60 + now.getMinutes(), 30) : 9 * 60;
  openEventDialog({ title: '', start_at: addMinutes(day, Math.min(startMin, 23 * 60)), end_at: addMinutes(day, Math.min(startMin + 60, 24 * 60)) });
});

loadAndRender();

async function changeWeek(delta) {
  state.weekStart = addDays(state.weekStart, delta * 7);
  await loadAndRender();
}

async function loadAndRender() {
  const start = state.weekStart;
  const end = addDays(start, 7);
  const res = await fetch(`/api/events?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`);
  if (!res.ok) throw new Error('Failed to load events');
  state.events = await res.json();
  render();
}

function render() {
  document.querySelector('#rangeLabel').textContent = `${formatDateLong(state.weekStart)} – ${formatDateLong(addDays(state.weekStart, 6))}`;
  calendar.innerHTML = '';

  const corner = el('div', 'corner');
  calendar.appendChild(corner);

  const today = new Date();
  for (let i = 0; i < 7; i++) {
    const date = addDays(state.weekStart, i);
    const header = el('div', `day-header ${isSameDay(date, today) ? 'today' : ''}`);
    header.style.gridColumn = `${i + 2}`;
    header.innerHTML = `<div class="day-name">${DAY_NAMES[i]}</div><div class="day-date">${date.getDate()}</div>`;
    calendar.appendChild(header);
  }

  const axis = el('div', 'time-axis');
  for (let h = 0; h <= 24; h++) {
    const label = el('div', 'time-label', `${String(h).padStart(2, '0')}:00`);
    label.style.top = `${h * HOUR_HEIGHT}px`;
    axis.appendChild(label);
  }
  calendar.appendChild(axis);

  for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
    const date = addDays(state.weekStart, dayIndex);
    const col = el('div', `day-column ${isSameDay(date, today) ? 'today' : ''}`);
    col.style.gridColumn = `${dayIndex + 2}`;
    col.dataset.dayIndex = String(dayIndex);
    addSelectionHandlers(col, date);

    const segments = segmentsForDay(date, state.events);
    const laidOut = layoutDayEvents(segments);
    for (const item of laidOut) col.appendChild(renderEvent(item));

    calendar.appendChild(col);
  }
}

function renderEvent(item) {
  const node = el('div', 'event');
  const gutter = 3;
  node.style.top = `${minutesToPixels(item.startMinute)}px`;
  node.style.height = `${Math.max(1, minutesToPixels(item.endMinute - item.startMinute))}px`;
  node.style.left = `calc(${item.leftPct}% + ${gutter}px)`;
  node.style.width = `calc(${item.widthPct}% - ${gutter * 2}px)`;
  node.title = `${item.title} (${formatTime(new Date(item.start_at))}–${formatTime(new Date(item.end_at))})`;
  node.innerHTML = `<div class="event-title"></div><div class="event-time"></div>`;
  node.querySelector('.event-title').textContent = item.title;
  node.querySelector('.event-time').textContent = `${formatTime(new Date(item.start_at))}–${formatTime(new Date(item.end_at))}`;
  node.addEventListener('click', (ev) => {
    ev.stopPropagation();
    openEventDialog({ ...item, start_at: new Date(item.start_at), end_at: new Date(item.end_at) });
  });
  return node;
}

function segmentsForDay(day, events) {
  const dayStart = startOfDay(day);
  const dayEnd = addDays(dayStart, 1);
  return events.map(event => {
    const start = new Date(event.start_at);
    const end = new Date(event.end_at);
    if (start >= dayEnd || end <= dayStart) return null;
    const clampedStart = start < dayStart ? dayStart : start;
    const clampedEnd = end > dayEnd ? dayEnd : end;
    const startMinute = Math.max(0, Math.min(MINUTES_PER_DAY, diffMinutes(dayStart, clampedStart)));
    const endMinute = Math.max(0, Math.min(MINUTES_PER_DAY, diffMinutes(dayStart, clampedEnd)));
    if (endMinute <= startMinute) return null;
    return { ...event, startMinute, endMinute, actualStart: start, actualEnd: end };
  }).filter(Boolean);
}

export function layoutDayEvents(events) {
  const sorted = [...events].sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute || a.id - b.id);
  const clusters = [];
  let cluster = [];
  let clusterEnd = -1;

  for (const event of sorted) {
    if (cluster.length === 0 || event.startMinute < clusterEnd) {
      cluster.push(event);
      clusterEnd = Math.max(clusterEnd, event.endMinute);
    } else {
      clusters.push(cluster);
      cluster = [event];
      clusterEnd = event.endMinute;
    }
  }
  if (cluster.length) clusters.push(cluster);

  const result = [];
  for (const group of clusters) {
    const columnEnds = [];
    const assigned = [];
    for (const event of group) {
      let col = columnEnds.findIndex(end => end <= event.startMinute);
      if (col === -1) {
        col = columnEnds.length;
        columnEnds.push(event.endMinute);
      } else {
        columnEnds[col] = event.endMinute;
      }
      assigned.push({ ...event, column: col });
    }
    const columnCount = Math.max(1, columnEnds.length);
    for (const event of assigned) {
      result.push({
        ...event,
        columnCount,
        leftPct: (event.column / columnCount) * 100,
        widthPct: 100 / columnCount,
      });
    }
  }
  return result;
}

function addSelectionHandlers(col, day) {
  let dragging = false;
  let startMinute = 0;
  let selectionNode = null;

  col.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0 || ev.target !== col) return;
    dragging = true;
    startMinute = minuteFromPointer(ev, col);
    selectionNode = el('div', 'selection');
    col.appendChild(selectionNode);
    updateSelection(selectionNode, startMinute, startMinute + 30);
    ev.preventDefault();
  });

  window.addEventListener('mousemove', (ev) => {
    if (!dragging) return;
    const current = minuteFromPointer(ev, col);
    updateSelection(selectionNode, startMinute, current);
  });

  window.addEventListener('mouseup', (ev) => {
    if (!dragging) return;
    dragging = false;
    const current = minuteFromPointer(ev, col);
    selectionNode?.remove();
    const a = Math.max(0, Math.min(startMinute, current));
    const b = Math.min(MINUTES_PER_DAY, Math.max(startMinute, current));
    const s = snapMinute(a);
    let e = snapMinute(b);
    if (e <= s) e = Math.min(MINUTES_PER_DAY, s + 30);
    if (e <= s) return;
    openEventDialog({ title: '', start_at: addMinutes(startOfDay(day), s), end_at: addMinutes(startOfDay(day), e) });
  });
}

function updateSelection(node, a, b) {
  const start = Math.max(0, Math.min(a, b));
  const end = Math.min(MINUTES_PER_DAY, Math.max(a, b));
  node.style.top = `${minutesToPixels(start)}px`;
  node.style.height = `${Math.max(minutesToPixels(end - start), 20)}px`;
}

function minuteFromPointer(ev, col) {
  const rect = col.getBoundingClientRect();
  const y = Math.max(0, Math.min(rect.height, ev.clientY - rect.top));
  return Math.round((y / rect.height) * MINUTES_PER_DAY);
}

function snapMinute(minute) {
  return Math.max(0, Math.min(MINUTES_PER_DAY, Math.round(minute / 15) * 15));
}

async function openEventDialog(event) {
  const isEdit = Boolean(event.id);
  const backdrop = el('div', 'dialog-backdrop');
  backdrop.innerHTML = `
    <form class="dialog">
      <h2>${isEdit ? 'Edit event' : 'Create event'}</h2>
      <label class="field">Title<input name="title" required maxlength="200" /></label>
      <label class="field">Start<input name="start" type="datetime-local" required /></label>
      <label class="field">End<input name="end" type="datetime-local" required /></label>
      <div class="error" role="alert"></div>
      <div class="dialog-actions">
        <span class="delete-slot">${isEdit ? '<button class="btn danger" type="button" data-delete>Delete</button>' : ''}</span>
        <button class="btn" type="button" data-cancel>Cancel</button>
        <button class="btn primary" type="submit">Save</button>
      </div>
    </form>`;
  document.body.appendChild(backdrop);
  const form = backdrop.querySelector('form');
  const error = backdrop.querySelector('.error');
  const titleInput = form.elements.title;
  const startInput = form.elements.start;
  const endInput = form.elements.end;
  titleInput.value = event.title || '';
  startInput.value = toLocalInputValue(new Date(event.start_at));
  endInput.value = toLocalInputValue(new Date(event.end_at));
  setTimeout(() => titleInput.focus(), 0);

  backdrop.addEventListener('mousedown', (ev) => { if (ev.target === backdrop) backdrop.remove(); });
  backdrop.querySelector('[data-cancel]').addEventListener('click', () => backdrop.remove());
  const del = backdrop.querySelector('[data-delete]');
  if (del) del.addEventListener('click', async () => {
    if (!confirm('Delete this event?')) return;
    const res = await fetch(`/api/events/${event.id}`, { method: 'DELETE' });
    if (!res.ok) { error.textContent = 'Delete failed.'; return; }
    backdrop.remove();
    await loadAndRender();
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    error.textContent = '';
    const title = titleInput.value.trim();
    const start = new Date(startInput.value);
    const end = new Date(endInput.value);
    if (!title) { error.textContent = 'Title is required.'; return; }
    if (!(end > start)) { error.textContent = 'End must be after start.'; return; }
    const payload = { title, start_at: start.toISOString(), end_at: end.toISOString() };
    const res = await fetch(isEdit ? `/api/events/${event.id}` : '/api/events', {
      method: isEdit ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      error.textContent = body.error || 'Save failed.';
      return;
    }
    backdrop.remove();
    await loadAndRender();
  });
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function startOfWeek(date) {
  const d = startOfDay(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  return addDays(d, diff);
}
function startOfDay(date) { const d = new Date(date); d.setHours(0, 0, 0, 0); return d; }
function addDays(date, days) { const d = new Date(date); d.setDate(d.getDate() + days); return d; }
function addMinutes(date, minutes) { return new Date(date.getTime() + minutes * 60000); }
function diffMinutes(a, b) { return Math.round((b.getTime() - a.getTime()) / 60000); }
function minutesToPixels(minutes) { return (minutes / 60) * HOUR_HEIGHT; }
function roundToStep(min, step) { return Math.floor(min / step) * step; }
function isSameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
function isSameWeek(date, weekStart) { const s = startOfWeek(date); return isSameDay(s, weekStart); }
function formatTime(date) { return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
function formatDateLong(date) { return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }); }
function toLocalInputValue(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
