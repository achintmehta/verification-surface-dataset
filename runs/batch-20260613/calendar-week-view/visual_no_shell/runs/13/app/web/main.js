import { layoutDayEvents } from './layout.js';

const API = '/api';
const HOUR_HEIGHT = 48; // px per hour
const AXIS_HEIGHT = HOUR_HEIGHT * 24; // total height of the time axis
const SNAP_MIN = 15; // snap drag selection to 15-minute increments

const app = document.getElementById('app');

// ---- State ----
let currentMonday = startOfWeek(new Date());
let events = []; // raw events from API for the visible week

// ---- Date helpers ----
function startOfWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  // getDay: 0=Sun..6=Sat. We want Monday as the first day.
  const day = (d.getDay() + 6) % 7; // 0=Mon..6=Sun
  d.setDate(d.getDate() - day);
  return d;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function isSameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function fmtTime(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Format a Date for a datetime-local input (local time, no timezone offset).
function toLocalInputValue(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate()
  )}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

// ---- API ----
async function fetchEvents() {
  const start = currentMonday;
  const end = addDays(currentMonday, 7);
  const url = `${API}/events?start=${encodeURIComponent(
    start.toISOString()
  )}&end=${encodeURIComponent(end.toISOString())}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to fetch events');
  events = await res.json();
}

async function createEvent(payload) {
  const res = await fetch(`${API}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res;
}

async function updateEvent(id, payload) {
  const res = await fetch(`${API}/events/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res;
}

async function deleteEvent(id) {
  const res = await fetch(`${API}/events/${id}`, { method: 'DELETE' });
  return res;
}

// ---- Geometry ----
// Compute the minute-range an event occupies within a particular day column,
// clamped to [0, 1440]. Returns null if the event does not intersect the day.
function minutesInDay(ev, dayStart) {
  const dayEnd = addDays(dayStart, 1);
  const start = new Date(ev.start_at);
  const end = new Date(ev.end_at);
  if (end <= dayStart || start >= dayEnd) return null;
  const clampedStart = start < dayStart ? dayStart : start;
  const clampedEnd = end > dayEnd ? dayEnd : end;
  const startMin = (clampedStart - dayStart) / 60000;
  const endMin = (clampedEnd - dayStart) / 60000;
  return { startMin, endMin };
}

// ---- Rendering ----
function render() {
  app.innerHTML = '';
  app.appendChild(renderHeader());
  app.appendChild(renderGrid());
}

function renderHeader() {
  const header = document.createElement('div');
  header.className = 'toolbar';

  const weekEnd = addDays(currentMonday, 6);
  const label = document.createElement('div');
  label.className = 'week-label';
  label.textContent = `${MONTH_NAMES[currentMonday.getMonth()]} ${currentMonday.getDate()} – ${MONTH_NAMES[weekEnd.getMonth()]} ${weekEnd.getDate()}, ${weekEnd.getFullYear()}`;

  const nav = document.createElement('div');
  nav.className = 'nav';

  const prev = button('‹ Prev', () => {
    currentMonday = addDays(currentMonday, -7);
    reload();
  });
  const today = button('Today', () => {
    currentMonday = startOfWeek(new Date());
    reload();
  });
  const next = button('Next ›', () => {
    currentMonday = addDays(currentMonday, 7);
    reload();
  });

  nav.append(prev, today, next);

  const title = document.createElement('h1');
  title.textContent = 'Week Calendar';
  title.className = 'app-title';

  header.append(title, label, nav);
  return header;
}

function button(text, onClick) {
  const b = document.createElement('button');
  b.textContent = text;
  b.className = 'btn';
  b.addEventListener('click', onClick);
  return b;
}

function renderGrid() {
  const grid = document.createElement('div');
  grid.className = 'calendar';

  // Day headers row
  const headerRow = document.createElement('div');
  headerRow.className = 'day-headers';
  const corner = document.createElement('div');
  corner.className = 'time-gutter-corner';
  headerRow.appendChild(corner);

  const now = new Date();
  for (let i = 0; i < 7; i++) {
    const day = addDays(currentMonday, i);
    const dh = document.createElement('div');
    dh.className = 'day-header';
    if (isSameDay(day, now)) dh.classList.add('today');
    dh.innerHTML = `<span class="dh-name">${DAY_NAMES[i]}</span> <span class="dh-date">${day.getDate()}</span>`;
    headerRow.appendChild(dh);
  }
  grid.appendChild(headerRow);

  // Scrollable body: time gutter + 7 day columns
  const body = document.createElement('div');
  body.className = 'calendar-body';

  // Time gutter
  const gutter = document.createElement('div');
  gutter.className = 'time-gutter';
  gutter.style.height = `${AXIS_HEIGHT}px`;
  for (let h = 0; h <= 24; h++) {
    const lbl = document.createElement('div');
    lbl.className = 'hour-label';
    lbl.style.top = `${h * HOUR_HEIGHT}px`;
    lbl.textContent = `${pad(h % 24)}:00`;
    gutter.appendChild(lbl);
  }
  body.appendChild(gutter);

  const columns = document.createElement('div');
  columns.className = 'day-columns';

  for (let i = 0; i < 7; i++) {
    const day = addDays(currentMonday, i);
    columns.appendChild(renderDayColumn(day, isSameDay(day, now)));
  }

  body.appendChild(columns);
  grid.appendChild(body);
  return grid;
}

function renderDayColumn(dayStart, isToday) {
  const col = document.createElement('div');
  col.className = 'day-column';
  if (isToday) col.classList.add('today-column');
  col.style.height = `${AXIS_HEIGHT}px`;

  // Hour grid lines
  for (let h = 0; h <= 24; h++) {
    const line = document.createElement('div');
    line.className = 'hour-line';
    line.style.top = `${h * HOUR_HEIGHT}px`;
    col.appendChild(line);
  }

  // Gather events for this day with computed minute ranges.
  const dayEvents = [];
  for (const ev of events) {
    const range = minutesInDay(ev, dayStart);
    if (range) {
      dayEvents.push({
        id: ev.id,
        ref: ev,
        startMin: range.startMin,
        endMin: range.endMin,
      });
    }
  }

  const laid = layoutDayEvents(dayEvents);
  for (const e of laid) {
    col.appendChild(renderEventBlock(e));
  }

  // Drag-to-create interaction
  attachCreateInteraction(col, dayStart);

  return col;
}

function renderEventBlock(e) {
  const block = document.createElement('div');
  block.className = 'event';
  const top = (e.startMin / 60) * HOUR_HEIGHT;
  const height = ((e.endMin - e.startMin) / 60) * HOUR_HEIGHT;
  block.style.top = `${top}px`;
  block.style.height = `${Math.max(height, 1)}px`;
  block.style.left = `calc(${e.left * 100}% + 1px)`;
  block.style.width = `calc(${e.width * 100}% - 2px)`;

  const start = new Date(e.ref.start_at);
  const end = new Date(e.ref.end_at);

  const titleEl = document.createElement('div');
  titleEl.className = 'event-title';
  titleEl.textContent = e.ref.title;

  const timeEl = document.createElement('div');
  timeEl.className = 'event-time';
  timeEl.textContent = `${fmtTime(start)} – ${fmtTime(end)}`;

  block.append(titleEl, timeEl);

  block.addEventListener('mousedown', (ev) => ev.stopPropagation());
  block.addEventListener('click', (ev) => {
    ev.stopPropagation();
    openEditForm(e.ref);
  });

  return block;
}

// ---- Drag-to-create ----
function attachCreateInteraction(col, dayStart) {
  let dragging = false;
  let startY = 0;
  let selectionEl = null;

  function yToMinutes(y) {
    const min = (y / AXIS_HEIGHT) * 1440;
    return Math.max(0, Math.min(1440, Math.round(min / SNAP_MIN) * SNAP_MIN));
  }

  col.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return;
    dragging = true;
    const rect = col.getBoundingClientRect();
    startY = ev.clientY - rect.top;
    selectionEl = document.createElement('div');
    selectionEl.className = 'selection';
    col.appendChild(selectionEl);
    updateSelection(ev);
    ev.preventDefault();
  });

  function updateSelection(ev) {
    const rect = col.getBoundingClientRect();
    const curY = Math.max(0, Math.min(AXIS_HEIGHT, ev.clientY - rect.top));
    const top = Math.min(startY, curY);
    const bottom = Math.max(startY, curY);
    selectionEl.style.top = `${top}px`;
    selectionEl.style.height = `${bottom - top}px`;
  }

  function onMove(ev) {
    if (!dragging) return;
    updateSelection(ev);
  }

  function onUp(ev) {
    if (!dragging) return;
    dragging = false;
    const rect = col.getBoundingClientRect();
    const curY = Math.max(0, Math.min(AXIS_HEIGHT, ev.clientY - rect.top));
    let startMin = yToMinutes(Math.min(startY, curY));
    let endMin = yToMinutes(Math.max(startY, curY));
    if (selectionEl) {
      selectionEl.remove();
      selectionEl = null;
    }
    // A plain click (no real drag) defaults to a 1-hour slot.
    if (endMin - startMin < SNAP_MIN) {
      endMin = Math.min(1440, startMin + 60);
      if (endMin === startMin) startMin = endMin - 60;
    }
    const startDate = new Date(dayStart);
    startDate.setMinutes(startMin);
    const endDate = new Date(dayStart);
    endDate.setMinutes(endMin);
    openCreateForm(startDate, endDate);
  }

  col.addEventListener('mousemove', onMove);
  // Use window-level mouseup so a drag ending outside the column still works.
  window.addEventListener('mouseup', onUp);
}

// ---- Forms (modal) ----
function openCreateForm(startDate, endDate) {
  openForm({
    mode: 'create',
    title: '',
    start: startDate,
    end: endDate,
  });
}

function openEditForm(ev) {
  openForm({
    mode: 'edit',
    id: ev.id,
    title: ev.title,
    start: new Date(ev.start_at),
    end: new Date(ev.end_at),
  });
}

function openForm(opts) {
  closeModal();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) closeModal();
  });

  const modal = document.createElement('div');
  modal.className = 'modal';

  const h = document.createElement('h2');
  h.textContent = opts.mode === 'create' ? 'New event' : 'Edit event';

  const form = document.createElement('form');

  const titleInput = field(form, 'Title', 'text', opts.title);
  titleInput.required = true;
  const startInput = field(form, 'Start', 'datetime-local', toLocalInputValue(opts.start));
  const endInput = field(form, 'End', 'datetime-local', toLocalInputValue(opts.end));

  const errorEl = document.createElement('div');
  errorEl.className = 'form-error';

  const actions = document.createElement('div');
  actions.className = 'form-actions';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.className = 'btn btn-primary';
  saveBtn.textContent = 'Save';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', closeModal);

  actions.append(saveBtn, cancelBtn);

  if (opts.mode === 'edit') {
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn btn-danger';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', async () => {
      const res = await deleteEvent(opts.id);
      if (res.ok) {
        closeModal();
        await reload();
      } else {
        errorEl.textContent = 'Failed to delete event.';
      }
    });
    actions.appendChild(delBtn);
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.textContent = '';
    const title = titleInput.value.trim();
    const start = new Date(startInput.value);
    const end = new Date(endInput.value);
    if (!title) {
      errorEl.textContent = 'Title must not be empty.';
      return;
    }
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      errorEl.textContent = 'Please enter valid start and end times.';
      return;
    }
    if (!(end > start)) {
      errorEl.textContent = 'End must be after start.';
      return;
    }
    const payload = {
      title,
      start_at: start.toISOString(),
      end_at: end.toISOString(),
    };
    const res =
      opts.mode === 'create'
        ? await createEvent(payload)
        : await updateEvent(opts.id, payload);
    if (res.ok) {
      closeModal();
      await reload();
    } else {
      let msg = 'Failed to save event.';
      try {
        const body = await res.json();
        if (body.error) msg = body.error;
      } catch (_) {}
      errorEl.textContent = msg;
    }
  });

  form.append(actions, errorEl);
  modal.append(h, form);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  titleInput.focus();
}

function field(form, label, type, value) {
  const wrap = document.createElement('label');
  wrap.className = 'field';
  const span = document.createElement('span');
  span.textContent = label;
  const input = document.createElement('input');
  input.type = type;
  input.value = value;
  wrap.append(span, input);
  form.appendChild(wrap);
  return input;
}

function closeModal() {
  const existing = document.querySelector('.modal-overlay');
  if (existing) existing.remove();
}

// ---- Lifecycle ----
async function reload() {
  try {
    await fetchEvents();
  } catch (err) {
    console.error(err);
    events = [];
  }
  render();
  // Keep the modal closed after a re-render.
}

reload();
