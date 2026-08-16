import './styles.css';

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTES_PER_DAY = 24 * 60;
const HOUR_HEIGHT = 56;
const AXIS_HEIGHT = HOUR_HEIGHT * 24;
const SNAP_MINUTES = 15;
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const state = {
  weekStart: startOfWeek(new Date()),
  events: [],
  selection: null,
  editingEvent: null
};

const app = document.querySelector('#app');
app.innerHTML = `
  <header class="toolbar">
    <div class="toolbar-left">
      <button id="prevWeek" type="button" aria-label="Previous week">‹</button>
      <button id="todayBtn" type="button">Today</button>
      <button id="nextWeek" type="button" aria-label="Next week">›</button>
    </div>
    <h1 id="weekTitle"></h1>
    <div class="hint">Drag in an empty day column to create an event</div>
  </header>
  <main class="calendar-shell">
    <div class="calendar" id="calendar"></div>
  </main>
  <div class="modal-backdrop hidden" id="modalBackdrop">
    <form class="event-form" id="eventForm">
      <h2 id="formTitle">Create event</h2>
      <label>Title <input id="eventTitle" name="title" required maxlength="200" /></label>
      <div class="form-row">
        <label>Start <input id="eventStart" name="start" type="datetime-local" required /></label>
        <label>End <input id="eventEnd" name="end" type="datetime-local" required /></label>
      </div>
      <p class="form-error" id="formError" role="alert"></p>
      <div class="form-actions">
        <button id="deleteBtn" type="button" class="danger hidden">Delete</button>
        <span class="spacer"></span>
        <button id="cancelBtn" type="button">Cancel</button>
        <button type="submit" class="primary">Save</button>
      </div>
    </form>
  </div>
`;

const els = {
  calendar: document.querySelector('#calendar'),
  weekTitle: document.querySelector('#weekTitle'),
  prevWeek: document.querySelector('#prevWeek'),
  todayBtn: document.querySelector('#todayBtn'),
  nextWeek: document.querySelector('#nextWeek'),
  modal: document.querySelector('#modalBackdrop'),
  form: document.querySelector('#eventForm'),
  formTitle: document.querySelector('#formTitle'),
  eventTitle: document.querySelector('#eventTitle'),
  eventStart: document.querySelector('#eventStart'),
  eventEnd: document.querySelector('#eventEnd'),
  formError: document.querySelector('#formError'),
  deleteBtn: document.querySelector('#deleteBtn'),
  cancelBtn: document.querySelector('#cancelBtn')
};

document.documentElement.style.setProperty('--hour-height', `${HOUR_HEIGHT}px`);
document.documentElement.style.setProperty('--axis-height', `${AXIS_HEIGHT}px`);

els.prevWeek.addEventListener('click', () => changeWeek(-1));
els.nextWeek.addEventListener('click', () => changeWeek(1));
els.todayBtn.addEventListener('click', () => { state.weekStart = startOfWeek(new Date()); loadAndRender(); });
els.cancelBtn.addEventListener('click', closeModal);
els.modal.addEventListener('click', (e) => { if (e.target === els.modal) closeModal(); });
els.form.addEventListener('submit', saveForm);
els.deleteBtn.addEventListener('click', deleteCurrentEvent);

loadAndRender();

function startOfWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const mondayBasedDay = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - mondayBasedDay);
  return d;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function pad(n) { return String(n).padStart(2, '0'); }

function localIso(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function datetimeLocalValue(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseLocalDateTime(value) {
  return new Date(value);
}

function formatDateHeader(date) {
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatTime(date) {
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function sameDate(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function minutesFromMidnight(date) {
  return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
}

function minuteToPx(minutes) {
  return (minutes / MINUTES_PER_DAY) * AXIS_HEIGHT;
}

async function loadEvents() {
  const start = state.weekStart;
  const end = addDays(start, 7);
  const res = await fetch(`/api/events?start=${encodeURIComponent(localIso(start))}&end=${encodeURIComponent(localIso(end))}`);
  if (!res.ok) throw new Error('Could not load events');
  state.events = await res.json();
}

async function loadAndRender() {
  try {
    await loadEvents();
    render();
  } catch (err) {
    els.calendar.innerHTML = `<div class="load-error">${err.message}</div>`;
  }
}

function changeWeek(delta) {
  state.weekStart = addDays(state.weekStart, delta * 7);
  loadAndRender();
}

function render() {
  const weekEnd = addDays(state.weekStart, 6);
  els.weekTitle.textContent = `${formatDateHeader(state.weekStart)} – ${formatDateHeader(weekEnd)} ${weekEnd.getFullYear()}`;
  const days = Array.from({ length: 7 }, (_, i) => addDays(state.weekStart, i));
  const today = new Date();

  els.calendar.innerHTML = `
    <div class="corner"></div>
    <div class="day-headers">
      ${days.map((day, i) => `<div class="day-header ${sameDate(day, today) ? 'today' : ''}">
        <span>${DAY_NAMES[i]}</span><strong>${formatDateHeader(day)}</strong>
      </div>`).join('')}
    </div>
    <div class="time-axis">
      ${Array.from({ length: 25 }, (_, h) => `<div class="time-label" style="top:${h * HOUR_HEIGHT}px">${pad(h)}:00</div>`).join('')}
    </div>
    <div class="week-grid">
      ${days.map((day, i) => `<section class="day-column ${sameDate(day, today) ? 'today-bg' : ''}" data-day-index="${i}" aria-label="${DAY_NAMES[i]} ${formatDateHeader(day)}">
        <div class="hour-lines">${Array.from({ length: 25 }, (_, h) => `<div class="hour-line" style="top:${h * HOUR_HEIGHT}px"></div>`).join('')}</div>
        <div class="events-layer"></div>
      </section>`).join('')}
    </div>
  `;

  const dayColumns = [...els.calendar.querySelectorAll('.day-column')];
  dayColumns.forEach((col, i) => setupSelection(col, days[i]));

  const byDay = days.map((day) => splitEventsForDay(state.events, day));
  byDay.forEach((events, index) => renderDayEvents(dayColumns[index].querySelector('.events-layer'), events));
}

function splitEventsForDay(events, day) {
  const dayStart = new Date(day);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = addDays(dayStart, 1);
  return events.flatMap((event) => {
    const start = new Date(event.start_at);
    const end = new Date(event.end_at);
    if (start < dayEnd && end > dayStart) {
      const clampedStart = start < dayStart ? dayStart : start;
      const clampedEnd = end > dayEnd ? dayEnd : end;
      return [{ ...event, start, end, clampedStart, clampedEnd }];
    }
    return [];
  }).sort((a, b) => a.clampedStart - b.clampedStart || a.clampedEnd - b.clampedEnd || a.id - b.id);
}

function renderDayEvents(layer, events) {
  const laidOut = layoutEvents(events);
  for (const ev of laidOut) {
    const top = minuteToPx(minutesFromMidnight(ev.clampedStart));
    const endMinutes = sameDate(ev.clampedEnd, ev.clampedStart) ? minutesFromMidnight(ev.clampedEnd) : MINUTES_PER_DAY;
    const height = Math.max(1, minuteToPx(endMinutes) - top);
    const block = document.createElement('button');
    block.type = 'button';
    block.className = 'event-block';
    block.style.top = `${top}px`;
    block.style.height = `${height}px`;
    block.style.left = `${ev.leftPct}%`;
    block.style.width = `${ev.widthPct}%`;
    block.innerHTML = `<strong>${escapeHtml(ev.title)}</strong><span>${formatTime(ev.start)} – ${formatTime(ev.end)}</span>`;
    block.title = `${ev.title}\n${formatTime(ev.start)} – ${formatTime(ev.end)}`;
    block.addEventListener('click', (e) => {
      e.stopPropagation();
      openEditForm(ev);
    });
    layer.appendChild(block);
  }
}

export function layoutEvents(events) {
  const sorted = events.slice().sort((a, b) => a.clampedStart - b.clampedStart || a.clampedEnd - b.clampedEnd || a.id - b.id);
  const clusters = [];
  let current = [];
  let clusterEnd = null;
  for (const ev of sorted) {
    if (!current.length || ev.clampedStart < clusterEnd) {
      current.push(ev);
      if (!clusterEnd || ev.clampedEnd > clusterEnd) clusterEnd = ev.clampedEnd;
    } else {
      clusters.push(current);
      current = [ev];
      clusterEnd = ev.clampedEnd;
    }
  }
  if (current.length) clusters.push(current);

  const result = [];
  for (const cluster of clusters) {
    const colEnds = [];
    const assigned = [];
    for (const ev of cluster) {
      let col = colEnds.findIndex((end) => end <= ev.clampedStart);
      if (col === -1) {
        col = colEnds.length;
        colEnds.push(ev.clampedEnd);
      } else {
        colEnds[col] = ev.clampedEnd;
      }
      assigned.push({ ev, col });
    }
    const cols = Math.max(1, colEnds.length);
    for (const item of assigned) {
      result.push({ ...item.ev, column: item.col, columnCount: cols, leftPct: (item.col * 100) / cols, widthPct: 100 / cols });
    }
  }
  return result;
}

function setupSelection(column, day) {
  let dragStartY = null;
  let preview = null;
  let moved = false;

  column.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.event-block')) return;
    const rect = column.getBoundingClientRect();
    dragStartY = clamp(e.clientY - rect.top, 0, AXIS_HEIGHT);
    moved = false;
    preview = document.createElement('div');
    preview.className = 'selection-preview';
    column.appendChild(preview);
    column.setPointerCapture(e.pointerId);
    updateSelectionPreview(preview, dragStartY, dragStartY);
  });

  column.addEventListener('pointermove', (e) => {
    if (dragStartY == null) return;
    const rect = column.getBoundingClientRect();
    const y = clamp(e.clientY - rect.top, 0, AXIS_HEIGHT);
    if (Math.abs(y - dragStartY) > 3) moved = true;
    updateSelectionPreview(preview, dragStartY, y);
  });

  column.addEventListener('pointerup', (e) => {
    if (dragStartY == null) return;
    const rect = column.getBoundingClientRect();
    const y = clamp(e.clientY - rect.top, 0, AXIS_HEIGHT);
    const startY = moved ? Math.min(dragStartY, y) : dragStartY;
    const endY = moved ? Math.max(dragStartY, y) : dragStartY + minuteToPx(60);
    preview?.remove();
    preview = null;
    dragStartY = null;
    const snappedStart = Math.min(pxToSnappedMinutes(startY), MINUTES_PER_DAY - SNAP_MINUTES);
    const snappedEnd = Math.min(MINUTES_PER_DAY, Math.max(pxToSnappedMinutes(endY), snappedStart + SNAP_MINUTES));
    openCreateForm(day, snappedStart, snappedEnd);
  });

  column.addEventListener('pointercancel', () => {
    preview?.remove();
    preview = null;
    dragStartY = null;
  });
}

function updateSelectionPreview(el, y1, y2) {
  const top = Math.min(y1, y2);
  const height = Math.max(2, Math.abs(y2 - y1));
  el.style.top = `${top}px`;
  el.style.height = `${height}px`;
}

function pxToSnappedMinutes(px) {
  const raw = (px / AXIS_HEIGHT) * MINUTES_PER_DAY;
  return clamp(Math.round(raw / SNAP_MINUTES) * SNAP_MINUTES, 0, MINUTES_PER_DAY);
}

function dateWithMinutes(day, minutes) {
  const d = new Date(day);
  d.setHours(0, 0, 0, 0);
  d.setMinutes(minutes);
  return d;
}

function openCreateForm(day, startMinutes, endMinutes) {
  const start = dateWithMinutes(day, startMinutes);
  const end = dateWithMinutes(day, endMinutes);
  state.editingEvent = null;
  els.form.reset();
  els.formTitle.textContent = 'Create event';
  els.eventTitle.value = '';
  els.eventStart.value = datetimeLocalValue(start);
  els.eventEnd.value = datetimeLocalValue(end);
  els.deleteBtn.classList.add('hidden');
  els.formError.textContent = '';
  els.modal.classList.remove('hidden');
  els.eventTitle.focus();
}

function openEditForm(event) {
  state.editingEvent = event;
  els.form.reset();
  els.formTitle.textContent = 'Edit event';
  els.eventTitle.value = event.title;
  els.eventStart.value = datetimeLocalValue(new Date(event.start_at));
  els.eventEnd.value = datetimeLocalValue(new Date(event.end_at));
  els.deleteBtn.classList.remove('hidden');
  els.formError.textContent = '';
  els.modal.classList.remove('hidden');
  els.eventTitle.focus();
}

function closeModal() {
  els.modal.classList.add('hidden');
  state.editingEvent = null;
}

async function saveForm(e) {
  e.preventDefault();
  els.formError.textContent = '';
  const title = els.eventTitle.value.trim();
  const startDate = parseLocalDateTime(els.eventStart.value);
  const endDate = parseLocalDateTime(els.eventEnd.value);
  if (!title) return els.formError.textContent = 'Title is required.';
  if (!(endDate > startDate)) return els.formError.textContent = 'End must be after start.';
  const payload = { title, start_at: localIso(startDate), end_at: localIso(endDate) };
  const url = state.editingEvent ? `/api/events/${state.editingEvent.id}` : '/api/events';
  const method = state.editingEvent ? 'PUT' : 'POST';
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    els.formError.textContent = body.error || 'Could not save event.';
    return;
  }
  closeModal();
  await loadAndRender();
}

async function deleteCurrentEvent() {
  if (!state.editingEvent) return;
  if (!confirm('Delete this event?')) return;
  const res = await fetch(`/api/events/${state.editingEvent.id}`, { method: 'DELETE' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    els.formError.textContent = body.error || 'Could not delete event.';
    return;
  }
  closeModal();
  await loadAndRender();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}
