const API_BASE = (import.meta.env && import.meta.env.VITE_API_BASE) || window.API_BASE || 'http://localhost:3000';
const HOUR_HEIGHT = 64;
const DAY_HEIGHT = HOUR_HEIGHT * 24;
const SNAP_MINUTES = 15;
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const app = document.querySelector('#app');

const state = {
  weekStart: startOfWeek(new Date()),
  events: [],
  drag: null,
  modalEvent: null
};

app.innerHTML = `
  <header class="topbar">
    <div>
      <h1>Week Calendar</h1>
      <p class="subtitle">Minute-accurate week view with overlap-safe layout</p>
    </div>
    <nav class="nav">
      <button id="prevWeek" type="button">Previous</button>
      <button id="todayWeek" type="button">Today</button>
      <button id="nextWeek" type="button">Next</button>
    </nav>
  </header>
  <main class="calendar-shell">
    <div class="week-label" id="weekLabel"></div>
    <div class="calendar" id="calendar"></div>
  </main>
  <div id="modalRoot" class="modal-root" hidden></div>
`;

const calendarEl = document.querySelector('#calendar');
const weekLabelEl = document.querySelector('#weekLabel');
const modalRoot = document.querySelector('#modalRoot');

document.querySelector('#prevWeek').addEventListener('click', () => moveWeek(-1));
document.querySelector('#todayWeek').addEventListener('click', () => {
  state.weekStart = startOfWeek(new Date());
  loadWeek();
});
document.querySelector('#nextWeek').addEventListener('click', () => moveWeek(1));

loadWeek();

function moveWeek(delta) {
  state.weekStart = addDays(state.weekStart, delta * 7);
  loadWeek();
}

async function loadWeek() {
  const start = state.weekStart;
  const end = addDays(start, 7);
  weekLabelEl.textContent = `${formatLongDate(start)} – ${formatLongDate(addDays(end, -1))}`;
  try {
    const response = await fetch(`${API_BASE}/api/events?start=${encodeURIComponent(toLocalIso(start))}&end=${encodeURIComponent(toLocalIso(end))}`);
    if (!response.ok) throw new Error(await response.text());
    state.events = await response.json();
    renderCalendar();
  } catch (error) {
    calendarEl.innerHTML = `<div class="error">Unable to load events. Is the API server running?<br>${escapeHtml(error.message)}</div>`;
  }
}

function renderCalendar() {
  calendarEl.innerHTML = '';
  const headerSpacer = document.createElement('div');
  headerSpacer.className = 'time-header-spacer';
  calendarEl.append(headerSpacer);

  const todayKey = dateKey(new Date());
  for (let i = 0; i < 7; i += 1) {
    const date = addDays(state.weekStart, i);
    const header = document.createElement('div');
    header.className = 'day-header';
    if (dateKey(date) === todayKey) header.classList.add('today');
    header.innerHTML = `<span class="dow">${DAY_NAMES[i]}</span><span class="date">${date.getDate()}</span>`;
    calendarEl.append(header);
  }

  const timeAxis = document.createElement('div');
  timeAxis.className = 'time-axis';
  timeAxis.style.height = `${DAY_HEIGHT}px`;
  for (let h = 0; h <= 24; h += 1) {
    const tick = document.createElement('div');
    tick.className = 'time-label';
    tick.style.top = `${h * HOUR_HEIGHT}px`;
    tick.textContent = `${String(h).padStart(2, '0')}:00`;
    timeAxis.append(tick);
  }
  calendarEl.append(timeAxis);

  for (let i = 0; i < 7; i += 1) {
    calendarEl.append(renderDayColumn(i));
  }
}

function renderDayColumn(dayIndex) {
  const date = addDays(state.weekStart, dayIndex);
  const dayStart = startOfDay(date);
  const dayEnd = addDays(dayStart, 1);
  const column = document.createElement('div');
  column.className = 'day-column';
  column.dataset.dayIndex = String(dayIndex);
  column.style.height = `${DAY_HEIGHT}px`;
  if (dateKey(date) === dateKey(new Date())) column.classList.add('today');

  for (let h = 0; h < 24; h += 1) {
    const line = document.createElement('div');
    line.className = 'hour-line';
    line.style.top = `${h * HOUR_HEIGHT}px`;
    column.append(line);
  }

  const dayEvents = state.events
    .map(normalizeEvent)
    .filter((event) => event.start < dayEnd && event.end > dayStart)
    .map((event) => ({
      ...event,
      renderStart: maxDate(event.start, dayStart),
      renderEnd: minDate(event.end, dayEnd)
    }))
    .filter((event) => event.renderEnd > event.renderStart);

  const laidOut = layoutEvents(dayEvents);
  for (const item of laidOut) {
    column.append(renderEventBlock(item, dayStart));
  }

  column.addEventListener('pointerdown', (event) => onColumnPointerDown(event, column, dayStart));
  return column;
}

function renderEventBlock(item, dayStart) {
  const block = document.createElement('button');
  block.type = 'button';
  block.className = 'event-block';
  block.dataset.eventId = String(item.id);
  const startM = minutesBetween(dayStart, item.renderStart);
  const endM = minutesBetween(dayStart, item.renderEnd);
  block.style.top = `${minutesToPx(startM)}px`;
  block.style.height = `${Math.max(1, minutesToPx(endM - startM))}px`;
  block.style.left = `calc(${item.leftPct}% + 2px)`;
  block.style.width = `calc(${item.widthPct}% - 4px)`;
  block.innerHTML = `
    <span class="event-title">${escapeHtml(item.title)}</span>
    <span class="event-time">${formatTime(item.start)}–${formatTime(item.end)}</span>
  `;
  block.addEventListener('pointerdown', (event) => event.stopPropagation());
  block.addEventListener('click', (event) => {
    event.stopPropagation();
    openEventModal(item);
  });
  return block;
}

function layoutEvents(events) {
  const sorted = [...events].sort((a, b) => a.renderStart - b.renderStart || a.renderEnd - b.renderEnd || a.id - b.id);
  const clusters = [];
  let current = [];
  let currentEnd = null;

  for (const event of sorted) {
    if (!current.length || event.renderStart < currentEnd) {
      current.push(event);
      currentEnd = currentEnd ? maxDate(currentEnd, event.renderEnd) : event.renderEnd;
    } else {
      clusters.push(current);
      current = [event];
      currentEnd = event.renderEnd;
    }
  }
  if (current.length) clusters.push(current);

  const output = [];
  for (const cluster of clusters) {
    const colEnds = [];
    const assigned = [];
    for (const event of cluster) {
      let col = colEnds.findIndex((end) => end <= event.renderStart);
      if (col === -1) {
        col = colEnds.length;
        colEnds.push(event.renderEnd);
      } else {
        colEnds[col] = event.renderEnd;
      }
      assigned.push({ ...event, column: col });
    }
    const columns = Math.max(1, colEnds.length);
    for (const event of assigned) {
      output.push({
        ...event,
        columnCount: columns,
        leftPct: (event.column / columns) * 100,
        widthPct: 100 / columns
      });
    }
  }
  return output;
}

function onColumnPointerDown(pointerEvent, column, dayStart) {
  if (pointerEvent.button !== 0) return;
  pointerEvent.preventDefault();
  const rect = column.getBoundingClientRect();
  const startY = clamp(pointerEvent.clientY - rect.top, 0, DAY_HEIGHT);
  const preview = document.createElement('div');
  preview.className = 'selection-preview';
  column.append(preview);

  state.drag = { column, dayStart, startY, currentY: startY, preview, moved: false };
  updateSelectionPreview();

  const onMove = (event) => {
    if (!state.drag) return;
    state.drag.currentY = clamp(event.clientY - rect.top, 0, DAY_HEIGHT);
    if (Math.abs(state.drag.currentY - state.drag.startY) > 3) state.drag.moved = true;
    updateSelectionPreview();
  };
  const onUp = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    const drag = state.drag;
    state.drag = null;
    drag.preview.remove();
    const y1 = Math.min(drag.startY, drag.currentY);
    const y2 = Math.max(drag.startY, drag.currentY);
    let startMin = snapMinutes(pxToMinutes(y1));
    let endMin = snapMinutes(pxToMinutes(y2));
    if (!drag.moved || endMin <= startMin) {
      startMin = snapMinutes(pxToMinutes(drag.startY));
      endMin = Math.min(24 * 60, startMin + 60);
      if (endMin <= startMin) startMin = Math.max(0, endMin - 60);
    }
    if (endMin > startMin) {
      openCreateModal(addMinutes(drag.dayStart, startMin), addMinutes(drag.dayStart, endMin));
    }
  };
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

function updateSelectionPreview() {
  const drag = state.drag;
  const top = Math.min(drag.startY, drag.currentY);
  const bottom = Math.max(drag.startY, drag.currentY);
  drag.preview.style.top = `${top}px`;
  drag.preview.style.height = `${Math.max(2, bottom - top)}px`;
}

function openCreateModal(start, end) {
  openModal({ mode: 'create', title: '', start, end });
}

function openEventModal(event) {
  openModal({ mode: 'edit', ...event, start: new Date(event.start), end: new Date(event.end) });
}

function openModal(model) {
  modalRoot.hidden = false;
  const isEdit = model.mode === 'edit';
  modalRoot.innerHTML = `
    <div class="modal-backdrop"></div>
    <form class="modal" id="eventForm">
      <h2>${isEdit ? 'Edit event' : 'Create event'}</h2>
      <label>Title<input id="titleInput" name="title" required value="${escapeAttr(model.title || '')}" /></label>
      <div class="form-grid">
        <label>Start<input id="startInput" name="start" type="datetime-local" required value="${dateTimeLocalValue(model.start)}" /></label>
        <label>End<input id="endInput" name="end" type="datetime-local" required value="${dateTimeLocalValue(model.end)}" /></label>
      </div>
      <p class="form-error" id="formError" role="alert"></p>
      <div class="modal-actions">
        ${isEdit ? '<button id="deleteBtn" class="danger" type="button">Delete</button>' : ''}
        <span class="spacer"></span>
        <button id="cancelBtn" type="button">Cancel</button>
        <button class="primary" type="submit">Save</button>
      </div>
    </form>
  `;
  modalRoot.querySelector('.modal-backdrop').addEventListener('click', closeModal);
  modalRoot.querySelector('#cancelBtn').addEventListener('click', closeModal);
  modalRoot.querySelector('#eventForm').addEventListener('submit', (event) => saveModal(event, model));
  const deleteBtn = modalRoot.querySelector('#deleteBtn');
  if (deleteBtn) deleteBtn.addEventListener('click', () => deleteEvent(model.id));
  setTimeout(() => modalRoot.querySelector('#titleInput')?.focus(), 0);
}

function closeModal() {
  modalRoot.hidden = true;
  modalRoot.innerHTML = '';
}

async function saveModal(event, model) {
  event.preventDefault();
  const errorEl = modalRoot.querySelector('#formError');
  const payload = {
    title: modalRoot.querySelector('#titleInput').value.trim(),
    start_at: modalRoot.querySelector('#startInput').value,
    end_at: modalRoot.querySelector('#endInput').value
  };
  if (!payload.title) return (errorEl.textContent = 'Title is required.');
  if (new Date(payload.end_at) <= new Date(payload.start_at)) return (errorEl.textContent = 'End must be after start.');

  try {
    const response = await fetch(`${API_BASE}/api/events${model.mode === 'edit' ? `/${model.id}` : ''}`, {
      method: model.mode === 'edit' ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const body = await safeJson(response);
      throw new Error(body?.error || 'Save failed');
    }
    closeModal();
    await loadWeek();
  } catch (error) {
    errorEl.textContent = error.message;
  }
}

async function deleteEvent(id) {
  if (!confirm('Delete this event?')) return;
  const errorEl = modalRoot.querySelector('#formError');
  try {
    const response = await fetch(`${API_BASE}/api/events/${id}`, { method: 'DELETE' });
    if (!response.ok) throw new Error('Delete failed');
    closeModal();
    await loadWeek();
  } catch (error) {
    errorEl.textContent = error.message;
  }
}

async function safeJson(response) {
  try { return await response.json(); } catch { return null; }
}

function normalizeEvent(event) {
  return {
    ...event,
    start: new Date(event.start_at),
    end: new Date(event.end_at)
  };
}

function startOfWeek(date) {
  const d = startOfDay(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  return addDays(d, diff);
}
function startOfDay(date) { return new Date(date.getFullYear(), date.getMonth(), date.getDate()); }
function addDays(date, days) { const d = new Date(date); d.setDate(d.getDate() + days); return d; }
function addMinutes(date, minutes) { return new Date(date.getTime() + minutes * 60000); }
function minDate(a, b) { return a < b ? a : b; }
function maxDate(a, b) { return a > b ? a : b; }
function minutesBetween(start, end) { return Math.round((end - start) / 60000); }
function minutesToPx(minutes) { return (minutes / 60) * HOUR_HEIGHT; }
function pxToMinutes(px) { return (px / HOUR_HEIGHT) * 60; }
function snapMinutes(minutes) { return clamp(Math.round(minutes / SNAP_MINUTES) * SNAP_MINUTES, 0, 24 * 60); }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function toLocalIso(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
function dateTimeLocalValue(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function formatTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}
function formatLongDate(date) {
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}
function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}
function escapeAttr(value) { return escapeHtml(value); }
