/**
 * Week Calendar – single-file frontend
 */

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const HOUR_HEIGHT = 64;               // px per hour
const AXIS_HEIGHT = HOUR_HEIGHT * 24; // 1536 px total

const EVENT_INSET = 2; // px – gap between adjacent event columns

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ═══════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════

let weekOffset = 0;
let dragState  = null;

// ═══════════════════════════════════════════════════════════════════════════
// DATE HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function toDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getMondayOfWeek(offset) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dow = today.getDay(); // 0=Sun
  const diffToMonday = (dow === 0) ? -6 : 1 - dow;
  const monday = new Date(today);
  monday.setDate(today.getDate() + diffToMonday + offset * 7);
  return monday;
}

function getWeekDays(offset) {
  const monday = getMondayOfWeek(offset);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });
}

function formatMinutes(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function minutesToISO(dayStr, minutes) {
  if (minutes >= 1440) {
    const d = new Date(dayStr + 'T00:00:00');
    d.setDate(d.getDate() + 1);
    return toDateStr(d) + 'T00:00';
  }
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${dayStr}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function isoToDatetimeLocal(iso) {
  if (!iso) return '';
  return iso.slice(0, 16);
}

function datetimeLocalToISO(val) {
  if (!val) return '';
  return val.length === 16 ? val + ':00' : val;
}

// ═══════════════════════════════════════════════════════════════════════════
// API
// ═══════════════════════════════════════════════════════════════════════════

async function apiFetch(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch('/api' + path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const api = {
  getEvents: (start, end) =>
    apiFetch('GET', `/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`),
  createEvent: (data) => apiFetch('POST', '/events', data),
  updateEvent: (id, data) => apiFetch('PUT', `/events/${id}`, data),
  deleteEvent: (id) => apiFetch('DELETE', `/events/${id}`),
};

// ═══════════════════════════════════════════════════════════════════════════
// LAYOUT ENGINE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Cluster-based overlap layout for events on a single day.
 *
 * Returns: Array<{ event, startMin, endMin, colIndex, numCols }>
 */
function computeLayout(events, dayStr) {
  if (!events || events.length === 0) return [];

  const DAY_START_MS = new Date(dayStr + 'T00:00:00').getTime();

  const items = events.map((ev) => {
    const startMs  = new Date(ev.start_at).getTime();
    const endMs    = new Date(ev.end_at).getTime();
    const startMin = Math.max(0,    Math.round((startMs - DAY_START_MS) / 60000));
    const endMin   = Math.min(1440, Math.round((endMs   - DAY_START_MS) / 60000));
    return { ev, startMin, endMin };
  });

  items.sort((a, b) =>
    a.startMin !== b.startMin ? a.startMin - b.startMin : b.endMin - a.endMin
  );

  const n = items.length;

  // Union-Find
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(x) {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  }
  function union(x, y) {
    const px = find(x), py = find(y);
    if (px !== py) parent[px] = py;
  }
  function overlaps(a, b) {
    return a.startMin < b.endMin && b.startMin < a.endMin;
  }

  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      if (overlaps(items[i], items[j])) union(i, j);

  // Group by cluster root
  const clusterMap = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!clusterMap.has(root)) clusterMap.set(root, []);
    clusterMap.get(root).push(i);
  }

  // Greedy column assignment within each cluster
  const result = new Array(n);

  for (const [, indices] of clusterMap) {
    indices.sort((a, b) =>
      items[a].startMin !== items[b].startMin
        ? items[a].startMin - items[b].startMin
        : items[b].endMin - items[a].endMin
    );

    const colEnds   = [];
    const colAssign = new Array(indices.length);

    for (let k = 0; k < indices.length; k++) {
      const item = items[indices[k]];
      let placed = false;
      for (let c = 0; c < colEnds.length; c++) {
        if (colEnds[c] <= item.startMin) {
          colAssign[k] = c;
          colEnds[c]   = item.endMin;
          placed = true;
          break;
        }
      }
      if (!placed) {
        colAssign[k] = colEnds.length;
        colEnds.push(item.endMin);
      }
    }

    const numCols = colEnds.length;
    for (let k = 0; k < indices.length; k++) {
      const idx = indices[k];
      result[idx] = {
        event:    items[idx].ev,
        startMin: items[idx].startMin,
        endMin:   items[idx].endMin,
        colIndex: colAssign[k],
        numCols,
      };
    }
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// RENDER
// ═══════════════════════════════════════════════════════════════════════════

function renderHeaderRow(days) {
  const headerDays = document.getElementById('header-days');
  headerDays.innerHTML = '';

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  days.forEach((day, i) => {
    const isToday = day.getTime() === today.getTime();

    const hdr = document.createElement('div');
    hdr.className = 'day-header' + (isToday ? ' today' : '');

    const nameEl = document.createElement('span');
    nameEl.className = 'day-name';
    nameEl.textContent = DAY_NAMES[i];

    const dateEl = document.createElement('span');
    dateEl.className = 'day-date';
    dateEl.textContent = day.getDate();

    hdr.appendChild(nameEl);
    hdr.appendChild(dateEl);
    headerDays.appendChild(hdr);
  });
}

function renderTimeGutter() {
  const gutter = document.getElementById('time-gutter');
  gutter.innerHTML = '';
  gutter.style.height = `${AXIS_HEIGHT}px`;

  for (let h = 1; h <= 23; h++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = `${(h / 24) * AXIS_HEIGHT}px`;
    label.textContent = `${String(h).padStart(2, '0')}:00`;
    gutter.appendChild(label);
  }
}

function renderDayColumns(days, layoutByDay) {
  const grid = document.getElementById('days-grid');
  grid.innerHTML = '';
  grid.style.height = `${AXIS_HEIGHT}px`;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  days.forEach((day, i) => {
    const isToday = day.getTime() === today.getTime();
    const dayStr  = toDateStr(day);

    const col = document.createElement('div');
    col.className = 'day-col';
    col.dataset.day = dayStr;

    const area = document.createElement('div');
    area.className = 'day-events-area';
    area.style.height = `${AXIS_HEIGHT}px`;

    // Hour lines
    for (let h = 0; h <= 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line' + (h === 0 || h === 24 ? ' midnight' : '');
      line.style.top = `${(h / 24) * AXIS_HEIGHT}px`;
      area.appendChild(line);
    }

    // Half-hour lines
    for (let h = 0; h < 24; h++) {
      const line = document.createElement('div');
      line.className = 'half-hour-line';
      line.style.top = `${((h + 0.5) / 24) * AXIS_HEIGHT}px`;
      area.appendChild(line);
    }

    // Current time indicator (today only)
    if (isToday) {
      const now = new Date();
      const nowMin = now.getHours() * 60 + now.getMinutes();
      const topPx  = (nowMin / 1440) * AXIS_HEIGHT;

      const nowLine = document.createElement('div');
      nowLine.className = 'now-line';
      nowLine.style.top = `${topPx}px`;
      area.appendChild(nowLine);

      const nowDot = document.createElement('div');
      nowDot.className = 'now-dot';
      nowDot.style.top = `${topPx}px`;
      area.appendChild(nowDot);
    }

    // Drag-to-create
    area.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (e.target.classList.contains('event-block') ||
          e.target.closest('.event-block')) return;
      e.preventDefault();

      const rect = area.getBoundingClientRect();
      const relY = e.clientY - rect.top;
      const snap = (m) => Math.round(m / 15) * 15;
      const startMin = Math.max(0, Math.min(1425, snap((relY / AXIS_HEIGHT) * 1440)));

      const ghost = document.createElement('div');
      ghost.className = 'drag-ghost';
      area.appendChild(ghost);

      dragState = { dayStr, startMin, endMin: startMin + 60, ghost, area };
      updateGhost();
    });

    // Event blocks
    const items = layoutByDay[i] || [];
    items.forEach((item) => area.appendChild(createEventBlock(item)));

    col.appendChild(area);
    grid.appendChild(col);
  });
}

function updateGhost() {
  if (!dragState) return;
  const { startMin, endMin, ghost } = dragState;
  ghost.style.top    = `${(startMin / 1440) * AXIS_HEIGHT}px`;
  ghost.style.height = `${Math.max(((endMin - startMin) / 1440) * AXIS_HEIGHT, 4)}px`;
}

function createEventBlock(item) {
  const { event, startMin, endMin, colIndex, numCols } = item;

  const block = document.createElement('div');
  block.className = `event-block ev-color-${event.id % 8}`;

  const top      = (startMin / 1440) * AXIS_HEIGHT;
  const height   = Math.max(((endMin - startMin) / 1440) * AXIS_HEIGHT, 18);
  const leftPct  = (colIndex / numCols) * 100;
  const widthPct = (1 / numCols) * 100;

  block.style.top    = `${top}px`;
  block.style.height = `${height}px`;
  block.style.left   = `calc(${leftPct}% + ${EVENT_INSET}px)`;
  block.style.width  = `calc(${widthPct}% - ${EVENT_INSET * 2}px)`;

  const titleEl = document.createElement('div');
  titleEl.className = 'ev-title';
  titleEl.textContent = event.title;

  const timeEl = document.createElement('div');
  timeEl.className = 'ev-time';
  timeEl.textContent = `${formatMinutes(startMin)}–${formatMinutes(endMin)}`;

  block.appendChild(titleEl);
  block.appendChild(timeEl);

  block.addEventListener('click', (e) => {
    e.stopPropagation();
    openEditModal(event);
  });

  return block;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN RENDER CYCLE
// ═══════════════════════════════════════════════════════════════════════════

async function loadAndRender() {
  const days = getWeekDays(weekOffset);
  const weekStart = new Date(days[0]); weekStart.setHours(0, 0, 0, 0);
  const weekEnd   = new Date(days[6]); weekEnd.setHours(24, 0, 0, 0);

  // Update week label
  const fmt = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  document.getElementById('week-label').textContent =
    `${fmt(days[0])} – ${fmt(days[6])}, ${days[0].getFullYear()}`;

  let events = [];
  try {
    events = await api.getEvents(weekStart.toISOString(), weekEnd.toISOString());
  } catch (err) {
    console.error('Failed to fetch events:', err);
  }

  // Compute layout per day
  const layoutByDay = days.map((day) => {
    const dayStr   = toDateStr(day);
    const dayStart = new Date(dayStr + 'T00:00:00').getTime();
    const dayEnd   = dayStart + 24 * 60 * 60 * 1000;
    const dayEvents = events.filter((ev) => {
      const s = new Date(ev.start_at).getTime();
      const e = new Date(ev.end_at).getTime();
      return s < dayEnd && e > dayStart;
    });
    return computeLayout(dayEvents, dayStr);
  });

  renderHeaderRow(days);
  renderTimeGutter();
  renderDayColumns(days, layoutByDay);
}

// ═══════════════════════════════════════════════════════════════════════════
// DRAG GLOBAL HANDLERS
// ═══════════════════════════════════════════════════════════════════════════

document.addEventListener('mousemove', (e) => {
  if (!dragState) return;
  const rect = dragState.area.getBoundingClientRect();
  const relY = e.clientY - rect.top;
  const snap = (m) => Math.round(m / 15) * 15;
  const endMin = Math.max(snap((relY / AXIS_HEIGHT) * 1440), dragState.startMin + 15);
  dragState.endMin = Math.min(endMin, 1440);
  updateGhost();
});

document.addEventListener('mouseup', () => {
  if (!dragState) return;
  const { dayStr, startMin, endMin, ghost } = dragState;
  ghost.remove();
  dragState = null;
  openCreateModal(minutesToISO(dayStr, startMin), minutesToISO(dayStr, endMin));
});

// ═══════════════════════════════════════════════════════════════════════════
// MODAL
// ═══════════════════════════════════════════════════════════════════════════

const overlay    = document.getElementById('modal-overlay');
const modalTitle = document.getElementById('modal-title');
const form       = document.getElementById('event-form');
const fTitle     = document.getElementById('f-title');
const fStart     = document.getElementById('f-start');
const fEnd       = document.getElementById('f-end');
const formError  = document.getElementById('form-error');
const btnSave    = document.getElementById('btn-save');
const btnDelete  = document.getElementById('btn-delete');
const btnCancel  = document.getElementById('btn-cancel');

let modalMode = null;
let editingId = null;

function openCreateModal(startISO, endISO) {
  modalMode = 'create';
  editingId = null;
  modalTitle.textContent = 'New Event';
  fTitle.value = '';
  fStart.value = isoToDatetimeLocal(startISO);
  fEnd.value   = isoToDatetimeLocal(endISO);
  btnDelete.classList.add('hidden');
  hideError();
  overlay.classList.remove('hidden');
  setTimeout(() => fTitle.focus(), 50);
}

function openEditModal(event) {
  modalMode = 'edit';
  editingId = event.id;
  modalTitle.textContent = 'Edit Event';
  fTitle.value = event.title;
  fStart.value = isoToDatetimeLocal(event.start_at);
  fEnd.value   = isoToDatetimeLocal(event.end_at);
  btnDelete.classList.remove('hidden');
  hideError();
  overlay.classList.remove('hidden');
  setTimeout(() => fTitle.focus(), 50);
}

function closeModal() {
  overlay.classList.add('hidden');
  modalMode = null;
  editingId = null;
  hideError();
}

function showError(msg) {
  formError.textContent = msg;
  formError.classList.remove('hidden');
}

function hideError() {
  formError.textContent = '';
  formError.classList.add('hidden');
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError();

  const title    = fTitle.value.trim();
  const startVal = fStart.value;
  const endVal   = fEnd.value;

  if (!title) { showError('Title is required.'); return; }
  if (!startVal || !endVal) { showError('Start and end times are required.'); return; }

  const startISO = datetimeLocalToISO(startVal);
  const endISO   = datetimeLocalToISO(endVal);

  if (new Date(endISO) <= new Date(startISO)) {
    showError('End time must be after start time.');
    return;
  }

  btnSave.disabled = true;
  btnSave.textContent = 'Saving…';

  try {
    if (modalMode === 'create') {
      await api.createEvent({ title, start_at: startISO, end_at: endISO });
    } else {
      await api.updateEvent(editingId, { title, start_at: startISO, end_at: endISO });
    }
    closeModal();
    await loadAndRender();
  } catch (err) {
    showError(err.message);
  } finally {
    btnSave.disabled = false;
    btnSave.textContent = 'Save';
  }
});

btnDelete.addEventListener('click', async () => {
  if (!editingId) return;
  if (!confirm('Delete this event?')) return;
  btnDelete.disabled = true;
  try {
    await api.deleteEvent(editingId);
    closeModal();
    await loadAndRender();
  } catch (err) {
    showError(err.message);
  } finally {
    btnDelete.disabled = false;
  }
});

btnCancel.addEventListener('click', closeModal);

overlay.addEventListener('click', (e) => {
  if (e.target === overlay) closeModal();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});

// ═══════════════════════════════════════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════════════════════════════════════

document.getElementById('btn-prev').addEventListener('click', () => {
  weekOffset--;
  loadAndRender();
});

document.getElementById('btn-next').addEventListener('click', () => {
  weekOffset++;
  loadAndRender();
});

document.getElementById('btn-today').addEventListener('click', () => {
  weekOffset = 0;
  loadAndRender();
});

// ═══════════════════════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════════════════════

loadAndRender().then(() => {
  // Scroll to 07:00 so working hours are visible on load
  requestAnimationFrame(() => {
    const scrollArea = document.getElementById('scroll-area');
    if (scrollArea) scrollArea.scrollTop = 7 * HOUR_HEIGHT;
  });
});
