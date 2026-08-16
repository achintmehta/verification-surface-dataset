import { layoutDay } from './layout.js';

const MIN_PER_DAY = 1440;
const HOUR_HEIGHT = 48; // must match --hour-height in CSS
const AXIS_HEIGHT = HOUR_HEIGHT * 24;
const SNAP_MIN = 15; // snap drag selections to 15 minutes

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ---- date helpers (local time) ----
function startOfWeek(d) {
  const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = (date.getDay() + 6) % 7; // Monday = 0
  date.setDate(date.getDate() - day);
  date.setHours(0, 0, 0, 0);
  return date;
}
function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}
function minutesIntoDay(date, dayStart) {
  return (date.getTime() - dayStart.getTime()) / 60000;
}
function fmtTime(date) {
  const h = date.getHours();
  const m = date.getMinutes();
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
function pad(n) { return String(n).padStart(2, '0'); }
function toLocalDateInput(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ---- state ----
let weekStart = startOfWeek(new Date());
let events = [];

const headersEl = document.getElementById('headers');
const daysEl = document.getElementById('days');
const gutterEl = document.getElementById('time-gutter');
const rangeLabel = document.getElementById('range-label');

// ---- API ----
async function fetchEvents() {
  const start = weekStart.toISOString();
  const end = addDays(weekStart, 7).toISOString();
  const res = await fetch(`/api/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
  if (!res.ok) throw new Error('failed to load events');
  events = await res.json();
}
async function createEvent(payload) {
  const res = await fetch('/api/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw await res.json().catch(() => ({ error: 'error' }));
  return res.json();
}
async function updateEvent(id, payload) {
  const res = await fetch(`/api/events/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw await res.json().catch(() => ({ error: 'error' }));
  return res.json();
}
async function deleteEvent(id) {
  const res = await fetch(`/api/events/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('delete failed');
}

// ---- rendering ----
function renderGutter() {
  gutterEl.innerHTML = '';
  for (let h = 0; h <= 24; h++) {
    const label = document.createElement('div');
    label.className = 'hour-label';
    label.style.top = `${(h / 24) * AXIS_HEIGHT}px`;
    label.textContent = h === 24 ? '24:00' : `${pad(h)}:00`;
    gutterEl.appendChild(label);
  }
}

function renderHeaders() {
  headersEl.innerHTML = '';
  const today = new Date();
  for (let i = 0; i < 7; i++) {
    const day = addDays(weekStart, i);
    const el = document.createElement('div');
    el.className = 'day-header' + (sameDay(day, today) ? ' today' : '');
    el.innerHTML = `<div class="dow">${DOW[i]}</div><div class="dnum">${day.getDate()}</div>`;
    headersEl.appendChild(el);
  }
  const last = addDays(weekStart, 6);
  const opts = { month: 'short', day: 'numeric' };
  rangeLabel.textContent =
    `${weekStart.toLocaleDateString(undefined, opts)} – ${last.toLocaleDateString(undefined, { ...opts, year: 'numeric' })}`;
}

function renderDays() {
  daysEl.innerHTML = '';
  const today = new Date();

  for (let i = 0; i < 7; i++) {
    const dayStart = addDays(weekStart, i);
    const dayEnd = addDays(dayStart, 1);
    const col = document.createElement('div');
    col.className = 'day-col' + (sameDay(dayStart, today) ? ' today' : '');
    col.dataset.dayIndex = String(i);

    // hour lines
    for (let h = 0; h <= 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${(h / 24) * AXIS_HEIGHT}px`;
      col.appendChild(line);
    }

    // events overlapping this day
    const dayEvents = [];
    for (const ev of events) {
      const s = new Date(ev.start_at);
      const e = new Date(ev.end_at);
      if (e <= dayStart || s >= dayEnd) continue;
      const startMin = Math.max(0, minutesIntoDay(s, dayStart));
      const endMin = Math.min(MIN_PER_DAY, minutesIntoDay(e, dayStart));
      if (endMin <= startMin) continue;
      dayEvents.push({ ev, startMin, endMin });
    }

    const laid = layoutDay(dayEvents);
    for (const item of laid) {
      col.appendChild(renderEvent(item));
    }

    attachDragCreate(col, dayStart);
    daysEl.appendChild(col);
  }
}

function renderEvent(item) {
  const { ev, startMin, endMin, colIndex, colCount } = item;
  const el = document.createElement('div');
  el.className = 'event';
  const top = (startMin / MIN_PER_DAY) * AXIS_HEIGHT;
  const height = ((endMin - startMin) / MIN_PER_DAY) * AXIS_HEIGHT;
  el.style.top = `${top}px`;
  el.style.height = `${height}px`;

  const widthPct = 100 / colCount;
  const gap = 1; // px gap between adjacent columns
  el.style.left = `calc(${colIndex * widthPct}% + ${colIndex === 0 ? 0 : gap}px)`;
  el.style.width = `calc(${widthPct}% - ${colCount === 1 ? 0 : gap + 1}px)`;

  const s = new Date(ev.start_at);
  const e = new Date(ev.end_at);
  el.innerHTML =
    `<div class="ev-title">${escapeHtml(ev.title)}</div>` +
    `<div class="ev-time">${fmtTime(s)} – ${fmtTime(e)}</div>`;

  el.addEventListener('click', (e) => {
    e.stopPropagation();
    openEditForm(ev);
  });
  return el;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ---- drag to create ----
function attachDragCreate(col, dayStart) {
  let dragging = false;
  let startY = 0;
  let ghost = null;

  function yToMin(y) {
    const min = (y / AXIS_HEIGHT) * MIN_PER_DAY;
    return Math.max(0, Math.min(MIN_PER_DAY, min));
  }
  function snap(min) {
    return Math.round(min / SNAP_MIN) * SNAP_MIN;
  }

  col.addEventListener('mousedown', (e) => {
    if (e.target.closest('.event')) return;
    if (e.button !== 0) return;
    dragging = true;
    const rect = col.getBoundingClientRect();
    startY = e.clientY - rect.top;
    ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    col.appendChild(ghost);
    updateGhost(startY, startY);
    e.preventDefault();
  });

  function updateGhost(y1, y2) {
    const top = Math.min(y1, y2);
    const bottom = Math.max(y1, y2);
    ghost.style.top = `${top}px`;
    ghost.style.height = `${Math.max(2, bottom - top)}px`;
  }

  function onMove(e) {
    if (!dragging) return;
    const rect = col.getBoundingClientRect();
    const y = e.clientY - rect.top;
    updateGhost(startY, y);
  }

  function onUp(e) {
    if (!dragging) return;
    dragging = false;
    const rect = col.getBoundingClientRect();
    const y = e.clientY - rect.top;
    let m1 = snap(yToMin(startY));
    let m2 = snap(yToMin(y));
    if (ghost) { ghost.remove(); ghost = null; }
    let startMin = Math.min(m1, m2);
    let endMin = Math.max(m1, m2);
    if (endMin - startMin < SNAP_MIN) {
      // treat as a click: default 1 hour slot
      endMin = Math.min(MIN_PER_DAY, startMin + 60);
      if (endMin === startMin) startMin = endMin - 60;
    }
    openCreateForm(dayStart, startMin, endMin);
  }

  col.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

// ---- modal form ----
const modal = document.getElementById('modal');
const form = document.getElementById('event-form');
const fTitle = document.getElementById('f-title');
const fDate = document.getElementById('f-date');
const fStart = document.getElementById('f-start');
const fEnd = document.getElementById('f-end');
const fDelete = document.getElementById('f-delete');
const fCancel = document.getElementById('f-cancel');
const modalTitle = document.getElementById('modal-title');
const formError = document.getElementById('form-error');

let editingId = null;

function minToTime(min) {
  const h = Math.floor(min / 60);
  const m = Math.floor(min % 60);
  return `${pad(h)}:${pad(m)}`;
}

function openCreateForm(dayStart, startMin, endMin) {
  editingId = null;
  modalTitle.textContent = 'New event';
  fDelete.classList.add('hidden');
  fTitle.value = '';
  fDate.value = toLocalDateInput(dayStart);
  fStart.value = minToTime(startMin);
  fEnd.value = endMin >= MIN_PER_DAY ? '23:59' : minToTime(endMin);
  formError.textContent = '';
  showModal();
  fTitle.focus();
}

function openEditForm(ev) {
  editingId = ev.id;
  modalTitle.textContent = 'Edit event';
  fDelete.classList.remove('hidden');
  const s = new Date(ev.start_at);
  const e = new Date(ev.end_at);
  fTitle.value = ev.title;
  fDate.value = toLocalDateInput(s);
  fStart.value = fmtTime(s);
  // if event ends on the same day show its time, else clamp display
  fEnd.value = fmtTime(e);
  formError.textContent = '';
  showModal();
  fTitle.focus();
}

function showModal() { modal.classList.remove('hidden'); }
function hideModal() { modal.classList.add('hidden'); }

function buildPayload() {
  const title = fTitle.value.trim();
  const [y, mo, d] = fDate.value.split('-').map(Number);
  const [sh, sm] = fStart.value.split(':').map(Number);
  const [eh, em] = fEnd.value.split(':').map(Number);
  const start = new Date(y, mo - 1, d, sh, sm, 0, 0);
  let end = new Date(y, mo - 1, d, eh, em, 0, 0);
  // allow end == 23:59 to mean end of input but keep as given;
  // if end <= start, treat as crossing to next day only when user set 00:00
  if (end <= start && (eh === 0 && em === 0)) {
    end = new Date(y, mo - 1, d + 1, 0, 0, 0, 0);
  }
  return { title, start_at: start.toISOString(), end_at: end.toISOString() };
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  formError.textContent = '';
  const payload = buildPayload();
  if (!payload.title) {
    formError.textContent = 'Title is required.';
    return;
  }
  if (new Date(payload.end_at) <= new Date(payload.start_at)) {
    formError.textContent = 'End must be after start.';
    return;
  }
  try {
    if (editingId == null) {
      await createEvent(payload);
    } else {
      await updateEvent(editingId, payload);
    }
    hideModal();
    await reload();
  } catch (err) {
    formError.textContent = err.error || 'Could not save event.';
  }
});

fDelete.addEventListener('click', async () => {
  if (editingId == null) return;
  await deleteEvent(editingId);
  hideModal();
  await reload();
});

fCancel.addEventListener('click', hideModal);
modal.addEventListener('mousedown', (e) => {
  if (e.target === modal) hideModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modal.classList.contains('hidden')) hideModal();
});

// ---- navigation ----
document.getElementById('prev').addEventListener('click', () => {
  weekStart = addDays(weekStart, -7);
  reload();
});
document.getElementById('next').addEventListener('click', () => {
  weekStart = addDays(weekStart, 7);
  reload();
});
document.getElementById('today').addEventListener('click', () => {
  weekStart = startOfWeek(new Date());
  reload();
});

async function reload() {
  renderHeaders();
  try {
    await fetchEvents();
  } catch (err) {
    console.error(err);
    events = [];
  }
  renderDays();
}

// ---- init ----
renderGutter();
reload();
