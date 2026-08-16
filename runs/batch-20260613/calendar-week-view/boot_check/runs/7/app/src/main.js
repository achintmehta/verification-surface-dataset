import './styles.css';

const HOUR_HEIGHT = 64;
const DAY_HEIGHT = HOUR_HEIGHT * 24;
const SNAP_MINUTES = 15;
const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const fmtTime = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const fmtDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

const state = {
  weekStart: startOfWeek(new Date()),
  events: [],
  selection: null,
  editingEvent: null,
};

const app = document.querySelector('#app');
app.innerHTML = `
  <header class="topbar">
    <div>
      <h1>Week Calendar</h1>
      <p class="subtitle">Minute-accurate single-user week view</p>
    </div>
    <nav class="nav-controls">
      <button id="prevWeek" type="button">Previous</button>
      <button id="today" type="button">Today</button>
      <button id="nextWeek" type="button">Next</button>
    </nav>
  </header>
  <main>
    <section class="calendar-shell">
      <div class="week-title" id="weekTitle"></div>
      <div class="calendar" id="calendar"></div>
    </section>
  </main>
  <dialog id="eventDialog">
    <form method="dialog" id="eventForm" class="event-form">
      <h2 id="dialogTitle">Create event</h2>
      <label>Title <input id="eventTitle" name="title" required autocomplete="off" /></label>
      <div class="form-grid">
        <label>Start <input id="eventStart" name="start" type="datetime-local" required /></label>
        <label>End <input id="eventEnd" name="end" type="datetime-local" required /></label>
      </div>
      <p id="formError" class="error" role="alert"></p>
      <menu>
        <button id="deleteEvent" class="danger" type="button">Delete</button>
        <span class="spacer"></span>
        <button id="cancelDialog" type="button">Cancel</button>
        <button id="saveEvent" type="submit">Save</button>
      </menu>
    </form>
  </dialog>
`;

const calendarEl = document.querySelector('#calendar');
const weekTitleEl = document.querySelector('#weekTitle');
const dialog = document.querySelector('#eventDialog');
const form = document.querySelector('#eventForm');
const dialogTitle = document.querySelector('#dialogTitle');
const titleInput = document.querySelector('#eventTitle');
const startInput = document.querySelector('#eventStart');
const endInput = document.querySelector('#eventEnd');
const errorEl = document.querySelector('#formError');
const deleteBtn = document.querySelector('#deleteEvent');

window.layoutDayEvents = layoutDayEvents;

async function boot() {
  document.querySelector('#prevWeek').addEventListener('click', () => changeWeek(-1));
  document.querySelector('#nextWeek').addEventListener('click', () => changeWeek(1));
  document.querySelector('#today').addEventListener('click', () => {
    state.weekStart = startOfWeek(new Date());
    loadAndRender();
  });
  document.querySelector('#cancelDialog').addEventListener('click', () => dialog.close());
  deleteBtn.addEventListener('click', deleteCurrentEvent);
  form.addEventListener('submit', saveForm);
  await loadAndRender();
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

function toLocalInputValue(date) {
  const d = new Date(date);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function inputValueToIso(value) {
  return new Date(value).toISOString();
}

function minutesFromMidnight(date) {
  return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60 + date.getMilliseconds() / 60000;
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

async function loadAndRender() {
  const start = state.weekStart;
  const end = addDays(start, 7);
  const res = await fetch(`/api/events?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`);
  if (!res.ok) throw new Error('Could not load events');
  state.events = await res.json();
  render();
}

function render() {
  const weekEnd = addDays(state.weekStart, 6);
  weekTitleEl.textContent = `${fmtDate.format(state.weekStart)} – ${fmtDate.format(weekEnd)}`;
  calendarEl.style.setProperty('--hour-height', `${HOUR_HEIGHT}px`);
  calendarEl.innerHTML = '';

  const corner = document.createElement('div');
  corner.className = 'corner';
  calendarEl.append(corner);

  for (let i = 0; i < 7; i++) {
    const day = addDays(state.weekStart, i);
    const header = document.createElement('div');
    header.className = `day-header${isSameDay(day, new Date()) ? ' today' : ''}`;
    header.innerHTML = `<strong>${dayNames[i]}</strong><span>${fmtDate.format(day)}</span>`;
    calendarEl.append(header);
  }

  const timeAxis = document.createElement('div');
  timeAxis.className = 'time-axis';
  timeAxis.style.height = `${DAY_HEIGHT}px`;
  for (let h = 0; h <= 24; h++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = `${h * HOUR_HEIGHT}px`;
    label.textContent = `${String(h).padStart(2, '0')}:00`;
    timeAxis.append(label);
  }
  calendarEl.append(timeAxis);

  for (let i = 0; i < 7; i++) {
    const dayStart = addDays(state.weekStart, i);
    const dayEnd = addDays(dayStart, 1);
    const col = document.createElement('div');
    col.className = `day-column${isSameDay(dayStart, new Date()) ? ' today' : ''}`;
    col.style.height = `${DAY_HEIGHT}px`;
    col.dataset.dayIndex = String(i);
    renderHourLines(col);
    setupSelection(col, dayStart);

    const dayEvents = state.events
      .filter((event) => rangesOverlap(new Date(event.start_at), new Date(event.end_at), dayStart, dayEnd))
      .map((event) => ({ ...event }));
    for (const item of layoutDayEvents(dayEvents, dayStart, dayEnd)) {
      col.append(renderEventBlock(item));
    }
    calendarEl.append(col);
  }
}

function renderHourLines(col) {
  for (let h = 0; h <= 24; h++) {
    const line = document.createElement('div');
    line.className = 'hour-line';
    line.style.top = `${h * HOUR_HEIGHT}px`;
    col.append(line);
  }
}

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function layoutDayEvents(events, dayStart, dayEnd) {
  const normalized = events.map((event) => {
    const actualStart = new Date(event.start_at);
    const actualEnd = new Date(event.end_at);
    const start = new Date(Math.max(actualStart.getTime(), dayStart.getTime()));
    const end = new Date(Math.min(actualEnd.getTime(), dayEnd.getTime()));
    return {
      event,
      start,
      end,
      startMs: start.getTime(),
      endMs: end.getTime(),
      startMin: Math.max(0, Math.min(1440, (start.getTime() - dayStart.getTime()) / 60000)),
      endMin: Math.max(0, Math.min(1440, (end.getTime() - dayStart.getTime()) / 60000)),
    };
  }).filter((e) => e.endMs > e.startMs)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.event.id - b.event.id);

  const clusters = [];
  let current = [];
  let clusterEnd = -Infinity;
  for (const item of normalized) {
    if (!current.length || item.startMs < clusterEnd) {
      current.push(item);
      clusterEnd = Math.max(clusterEnd, item.endMs);
    } else {
      clusters.push(current);
      current = [item];
      clusterEnd = item.endMs;
    }
  }
  if (current.length) clusters.push(current);

  const laidOut = [];
  for (const cluster of clusters) {
    const columns = [];
    for (const item of cluster) {
      let colIndex = columns.findIndex((endMs) => endMs <= item.startMs);
      if (colIndex === -1) {
        colIndex = columns.length;
        columns.push(item.endMs);
      } else {
        columns[colIndex] = item.endMs;
      }
      item.column = colIndex;
    }
    const columnCount = Math.max(1, columns.length);
    for (const item of cluster) {
      laidOut.push({
        ...item.event,
        clippedStart: item.start,
        clippedEnd: item.end,
        topPx: (item.startMin / 60) * HOUR_HEIGHT,
        heightPx: ((item.endMin - item.startMin) / 60) * HOUR_HEIGHT,
        leftPct: (item.column / columnCount) * 100,
        widthPct: 100 / columnCount,
        column: item.column,
        columnCount,
      });
    }
  }
  return laidOut;
}

function renderEventBlock(item) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'event-block';
  el.style.top = `${item.topPx}px`;
  el.style.height = `${item.heightPx}px`;
  el.style.left = `calc(${item.leftPct}% + 2px)`;
  el.style.width = `calc(${item.widthPct}% - 4px)`;
  el.dataset.id = item.id;
  el.innerHTML = `
    <span class="event-title">${escapeHtml(item.title)}</span>
    <span class="event-time">${fmtTime.format(new Date(item.start_at))}–${fmtTime.format(new Date(item.end_at))}</span>
  `;
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    openEdit(item);
  });
  return el;
}

function setupSelection(col, dayStart) {
  let dragStartY = null;
  let preview = null;
  const cleanup = () => {
    preview?.remove();
    preview = null;
    dragStartY = null;
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointermove', onMove);
  };
  const yToMinutes = (clientY) => {
    const rect = col.getBoundingClientRect();
    const y = Math.max(0, Math.min(rect.height, clientY - rect.top));
    return Math.max(0, Math.min(1440, Math.round((y / HOUR_HEIGHT) * 60 / SNAP_MINUTES) * SNAP_MINUTES));
  };
  const renderPreview = (a, b) => {
    if (!preview) {
      preview = document.createElement('div');
      preview.className = 'selection-preview';
      col.append(preview);
    }
    const top = Math.min(a, b);
    const bottom = Math.max(a, b);
    preview.style.top = `${(top / 60) * HOUR_HEIGHT}px`;
    preview.style.height = `${Math.max(8, ((bottom - top) / 60) * HOUR_HEIGHT)}px`;
  };
  const onMove = (ev) => {
    if (dragStartY == null) return;
    renderPreview(dragStartY, yToMinutes(ev.clientY));
  };
  const onUp = (ev) => {
    if (dragStartY == null) return;
    const endMin = yToMinutes(ev.clientY);
    const startMin = Math.min(dragStartY, endMin);
    let finalEnd = Math.max(dragStartY, endMin);
    if (finalEnd === startMin) finalEnd = Math.min(1440, startMin + 60);
    if (finalEnd <= startMin) {
      cleanup();
      return;
    }
    const start = new Date(dayStart.getTime() + startMin * 60000);
    const end = new Date(dayStart.getTime() + finalEnd * 60000);
    cleanup();
    openCreate(start, end);
  };
  col.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || ev.target.closest('.event-block')) return;
    dragStartY = yToMinutes(ev.clientY);
    renderPreview(dragStartY, dragStartY + SNAP_MINUTES);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
}

function openCreate(start, end) {
  state.editingEvent = null;
  dialogTitle.textContent = 'Create event';
  deleteBtn.hidden = true;
  titleInput.value = '';
  startInput.value = toLocalInputValue(start);
  endInput.value = toLocalInputValue(end);
  errorEl.textContent = '';
  dialog.showModal();
  titleInput.focus();
}

function openEdit(event) {
  state.editingEvent = event;
  dialogTitle.textContent = 'Edit event';
  deleteBtn.hidden = false;
  titleInput.value = event.title;
  startInput.value = toLocalInputValue(new Date(event.start_at));
  endInput.value = toLocalInputValue(new Date(event.end_at));
  errorEl.textContent = '';
  dialog.showModal();
  titleInput.focus();
}

async function saveForm(ev) {
  ev.preventDefault();
  errorEl.textContent = '';
  const payload = {
    title: titleInput.value.trim(),
    start_at: inputValueToIso(startInput.value),
    end_at: inputValueToIso(endInput.value),
  };
  if (!payload.title) return (errorEl.textContent = 'Title is required.');
  if (new Date(payload.end_at) <= new Date(payload.start_at)) return (errorEl.textContent = 'End must be after start.');
  const editing = state.editingEvent;
  const res = await fetch(editing ? `/api/events/${editing.id}` : '/api/events', {
    method: editing ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    errorEl.textContent = err.error || 'Could not save event.';
    return;
  }
  dialog.close();
  await loadAndRender();
}

async function deleteCurrentEvent() {
  if (!state.editingEvent) return;
  if (!confirm(`Delete “${state.editingEvent.title}”?`)) return;
  const res = await fetch(`/api/events/${state.editingEvent.id}`, { method: 'DELETE' });
  if (!res.ok) {
    errorEl.textContent = 'Could not delete event.';
    return;
  }
  dialog.close();
  await loadAndRender();
}

function changeWeek(delta) {
  state.weekStart = addDays(state.weekStart, delta * 7);
  loadAndRender();
}

function escapeHtml(str) {
  return String(str).replace(/[&<>'"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}

boot().catch((err) => {
  console.error(err);
  app.innerHTML = `<p class="fatal">${escapeHtml(err.message || 'Failed to start')}</p>`;
});
