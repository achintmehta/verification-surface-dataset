const HOUR_HEIGHT = 64;
const DAY_HEIGHT = HOUR_HEIGHT * 24;
const SNAP_MINUTES = 15;
const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const state = {
  weekStart: startOfWeek(new Date()),
  events: [],
  selecting: null,
  modal: null
};

const app = document.getElementById('app');
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
    <div id="calendar" class="calendar" style="--hour-height:${HOUR_HEIGHT}px; --day-height:${DAY_HEIGHT}px"></div>
  </main>
  <div id="modalRoot"></div>
`;

const calendarEl = document.getElementById('calendar');
const weekLabelEl = document.getElementById('weekLabel');
const modalRoot = document.getElementById('modalRoot');
document.getElementById('prevWeek').addEventListener('click', () => moveWeek(-1));
document.getElementById('todayWeek').addEventListener('click', () => { state.weekStart = startOfWeek(new Date()); loadAndRender(); });
document.getElementById('nextWeek').addEventListener('click', () => moveWeek(1));

loadAndRender();

function moveWeek(delta) {
  state.weekStart = addDays(state.weekStart, delta * 7);
  loadAndRender();
}

async function loadAndRender() {
  const start = state.weekStart;
  const end = addDays(start, 7);
  const response = await fetch(`/api/events?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`);
  if (!response.ok) {
    alert('Could not load events');
    return;
  }
  state.events = await response.json();
  render();
}

function render() {
  renderWeekLabel();
  const days = Array.from({ length: 7 }, (_, i) => addDays(state.weekStart, i));
  calendarEl.innerHTML = '';

  const corner = document.createElement('div');
  corner.className = 'corner';
  calendarEl.appendChild(corner);

  days.forEach((day, index) => {
    const header = document.createElement('div');
    header.className = 'day-header';
    if (isSameLocalDate(day, new Date())) header.classList.add('today');
    header.innerHTML = `<span>${dayNames[index]}</span><strong>${formatMonthDay(day)}</strong>`;
    calendarEl.appendChild(header);
  });

  const timeAxis = document.createElement('div');
  timeAxis.className = 'time-axis';
  timeAxis.style.height = `${DAY_HEIGHT}px`;
  for (let h = 0; h <= 24; h++) {
    const tick = document.createElement('div');
    tick.className = 'time-label';
    tick.style.top = `${h * HOUR_HEIGHT}px`;
    tick.textContent = `${String(h).padStart(2, '0')}:00`;
    timeAxis.appendChild(tick);
  }
  calendarEl.appendChild(timeAxis);

  days.forEach((day, index) => {
    const col = document.createElement('div');
    col.className = 'day-column';
    if (isSameLocalDate(day, new Date())) col.classList.add('today');
    col.dataset.dayIndex = String(index);
    col.style.height = `${DAY_HEIGHT}px`;
    for (let h = 0; h < 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${h * HOUR_HEIGHT}px`;
      col.appendChild(line);
    }
    installSelectionHandlers(col, day);
    renderDayEvents(col, day);
    calendarEl.appendChild(col);
  });

  renderModal();
}

function renderWeekLabel() {
  const end = addDays(state.weekStart, 6);
  weekLabelEl.textContent = `${formatLongDate(state.weekStart)} – ${formatLongDate(end)}`;
}

function renderDayEvents(col, day) {
  const dayStart = startOfDay(day);
  const dayEnd = addDays(dayStart, 1);
  const events = state.events
    .map(e => ({ ...e, start: new Date(e.start_at), end: new Date(e.end_at) }))
    .filter(e => e.start < dayEnd && e.end > dayStart)
    .map(e => ({ ...e, renderStart: maxDate(e.start, dayStart), renderEnd: minDate(e.end, dayEnd) }))
    .filter(e => e.renderEnd > e.renderStart);

  const laidOut = layoutEvents(events, dayStart);
  laidOut.forEach(item => {
    const block = document.createElement('button');
    block.type = 'button';
    block.className = 'event-block';
    block.style.top = `${minutesSince(dayStart, item.renderStart) / 60 * HOUR_HEIGHT}px`;
    block.style.height = `${minutesSince(item.renderStart, item.renderEnd) / 60 * HOUR_HEIGHT}px`;
    block.style.left = `calc(${item.leftPct}% + 2px)`;
    block.style.width = `calc(${item.widthPct}% - 4px)`;
    block.style.backgroundColor = colorForId(item.id);
    block.title = `${item.title} ${formatTime(item.start)}–${formatTime(item.end)}`;
    block.innerHTML = `<span class="event-title">${escapeHtml(item.title)}</span><span class="event-time">${formatTime(item.renderStart)}–${formatTime(item.renderEnd)}</span>`;
    block.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openEditModal(item);
    });
    col.appendChild(block);
  });
}

function layoutEvents(events) {
  const sorted = [...events].sort((a, b) => a.renderStart - b.renderStart || a.renderEnd - b.renderEnd || a.id - b.id);
  const clusters = [];
  let cluster = [];
  let clusterEnd = null;

  for (const event of sorted) {
    if (!cluster.length || event.renderStart < clusterEnd) {
      cluster.push(event);
      clusterEnd = clusterEnd ? maxDate(clusterEnd, event.renderEnd) : event.renderEnd;
    } else {
      clusters.push(cluster);
      cluster = [event];
      clusterEnd = event.renderEnd;
    }
  }
  if (cluster.length) clusters.push(cluster);

  const laidOut = [];
  for (const group of clusters) {
    const colEnds = [];
    const placed = [];
    for (const event of group) {
      let colIndex = colEnds.findIndex(end => end <= event.renderStart);
      if (colIndex === -1) {
        colIndex = colEnds.length;
        colEnds.push(event.renderEnd);
      } else {
        colEnds[colIndex] = event.renderEnd;
      }
      placed.push({ ...event, colIndex });
    }
    const colCount = Math.max(1, colEnds.length);
    for (const event of placed) {
      laidOut.push({
        ...event,
        leftPct: event.colIndex * (100 / colCount),
        widthPct: 100 / colCount,
        colCount
      });
    }
  }
  return laidOut;
}

function installSelectionHandlers(col, day) {
  let dragging = false;
  let startMinute = 0;
  let preview = null;

  col.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || ev.target !== col) return;
    dragging = true;
    col.setPointerCapture(ev.pointerId);
    startMinute = minuteFromPointer(ev, col);
    preview = document.createElement('div');
    preview.className = 'selection-preview';
    col.appendChild(preview);
    updatePreview(preview, startMinute, startMinute + 30);
  });

  col.addEventListener('pointermove', (ev) => {
    if (!dragging || !preview) return;
    const current = minuteFromPointer(ev, col);
    updatePreview(preview, startMinute, current);
  });

  col.addEventListener('pointerup', (ev) => {
    if (!dragging) return;
    dragging = false;
    const endMinuteRaw = minuteFromPointer(ev, col);
    if (preview) preview.remove();
    preview = null;
    let a = Math.min(startMinute, endMinuteRaw);
    let b = Math.max(startMinute, endMinuteRaw);
    if (b === a) b = Math.min(1440, a + 60);
    if (b - a < SNAP_MINUTES) b = Math.min(1440, a + SNAP_MINUTES);
    if (b <= a) a = Math.max(0, b - SNAP_MINUTES);
    openCreateModal(addMinutes(startOfDay(day), a), addMinutes(startOfDay(day), b));
  });
}

function minuteFromPointer(ev, col) {
  const rect = col.getBoundingClientRect();
  const y = Math.min(DAY_HEIGHT, Math.max(0, ev.clientY - rect.top));
  return Math.min(1440, Math.max(0, Math.round((y / HOUR_HEIGHT * 60) / SNAP_MINUTES) * SNAP_MINUTES));
}

function updatePreview(el, a, b) {
  const start = Math.min(a, b);
  let end = Math.max(a, b);
  if (end === start) end = Math.min(1440, start + 30);
  el.style.top = `${start / 60 * HOUR_HEIGHT}px`;
  el.style.height = `${(end - start) / 60 * HOUR_HEIGHT}px`;
}

function openCreateModal(start, end) {
  state.modal = { mode: 'create', title: '', start, end };
  renderModal();
}

function openEditModal(event) {
  state.modal = { mode: 'edit', id: event.id, title: event.title, start: new Date(event.start_at), end: new Date(event.end_at) };
  renderModal();
}

function closeModal() {
  state.modal = null;
  renderModal();
}

function renderModal() {
  modalRoot.innerHTML = '';
  if (!state.modal) return;
  const m = state.modal;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <form class="event-form">
      <h2>${m.mode === 'create' ? 'Create event' : 'Edit event'}</h2>
      <label>Title <input name="title" required value="${escapeAttr(m.title)}" /></label>
      <label>Start <input name="start" type="datetime-local" required value="${toDatetimeLocalValue(m.start)}" /></label>
      <label>End <input name="end" type="datetime-local" required value="${toDatetimeLocalValue(m.end)}" /></label>
      <p class="form-error" hidden></p>
      <div class="form-actions">
        ${m.mode === 'edit' ? '<button class="danger" type="button" data-action="delete">Delete</button>' : ''}
        <span class="spacer"></span>
        <button type="button" data-action="cancel">Cancel</button>
        <button class="primary" type="submit">Save</button>
      </div>
    </form>`;
  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) closeModal();
  });
  const form = overlay.querySelector('form');
  const error = overlay.querySelector('.form-error');
  form.querySelector('[data-action="cancel"]').addEventListener('click', closeModal);
  const del = form.querySelector('[data-action="delete"]');
  if (del) del.addEventListener('click', async () => {
    if (!confirm('Delete this event?')) return;
    const response = await fetch(`/api/events/${m.id}`, { method: 'DELETE' });
    if (!response.ok) return showError(error, 'Delete failed');
    closeModal();
    loadAndRender();
  });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const data = new FormData(form);
    const payload = {
      title: String(data.get('title') || '').trim(),
      start_at: localInputToDate(String(data.get('start'))).toISOString(),
      end_at: localInputToDate(String(data.get('end'))).toISOString()
    };
    if (!payload.title || new Date(payload.end_at) <= new Date(payload.start_at)) {
      return showError(error, 'Enter a title and an end time after the start time.');
    }
    const response = await fetch(m.mode === 'create' ? '/api/events' : `/api/events/${m.id}`, {
      method: m.mode === 'create' ? 'POST' : 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      return showError(error, body.error || 'Save failed');
    }
    closeModal();
    loadAndRender();
  });
  modalRoot.appendChild(overlay);
  form.elements.title.focus();
}

function showError(el, message) {
  el.textContent = message;
  el.hidden = false;
}

function startOfWeek(date) {
  const d = startOfDay(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  return addDays(d, diff);
}
function startOfDay(date) { return new Date(date.getFullYear(), date.getMonth(), date.getDate()); }
function addDays(date, days) { const d = new Date(date); d.setDate(d.getDate() + days); return d; }
function addMinutes(date, minutes) { const d = new Date(date); d.setMinutes(d.getMinutes() + minutes); return d; }
function minDate(a, b) { return a < b ? a : b; }
function maxDate(a, b) { return a > b ? a : b; }
function minutesSince(a, b) { return (b - a) / 60000; }
function isSameLocalDate(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
function formatTime(d) { return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
function formatMonthDay(d) { return d.toLocaleDateString([], { month: 'short', day: 'numeric' }); }
function formatLongDate(d) { return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }); }
function toDatetimeLocalValue(date) {
  const d = new Date(date);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function localInputToDate(value) { return new Date(value); }
function escapeHtml(str) {
  return String(str).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}
function escapeAttr(str) { return escapeHtml(str); }
function colorForId(id) {
  const colors = ['#2563eb', '#7c3aed', '#0891b2', '#16a34a', '#d97706', '#dc2626', '#be185d', '#4f46e5'];
  return colors[Math.abs(Number(id) || 0) % colors.length];
}
