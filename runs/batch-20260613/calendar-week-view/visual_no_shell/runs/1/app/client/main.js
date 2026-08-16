/**
 * Week Calendar — main.js
 *
 * Architecture:
 *  - State: currentWeekStart (Monday of the displayed week)
 *  - API helpers: fetchEvents, createEvent, updateEvent, deleteEvent
 *  - Layout engine: computeDayLayout(events) → positioned event descriptors
 *  - Renderer: renderWeekHeader(), renderDayColumns(), renderEvents()
 *  - Interaction: drag-to-create, click-to-edit, navigation
 */

// ============================================================
// Constants  (HOUR_HEIGHT must match CSS --hour-height)
// ============================================================

const HOUR_HEIGHT     = 60;           // px per hour
const TOTAL_HEIGHT    = HOUR_HEIGHT * 24;
const MINUTES_PER_DAY = 24 * 60;     // 1440

const DAY_NAMES   = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

// Colour palette — cycles by event id
const EVENT_COLORS = [
  '#1a73e8', '#0b8043', '#e37400', '#8430ce',
  '#d93025', '#00796b', '#c2185b', '#1565c0',
];

// ============================================================
// Date / time utilities
// ============================================================

/** Return the Monday of the week containing `date` (local time). */
function getWeekStart(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay(); // 0=Sun … 6=Sat
  d.setDate(d.getDate() + (dow === 0 ? -6 : 1 - dow));
  return d;
}

/** Return a new Date offset by `days` calendar days. */
function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

/**
 * Parse a local datetime string (no timezone suffix) into a Date.
 * Handles:
 *   "2026-06-15T09:00"
 *   "2026-06-15T09:00:00"
 *   "2026-06-15T09:00:00.000"
 * Falls back to `new Date(str)` for anything else.
 */
function parseLocalISO(str) {
  if (!str) return new Date(NaN);
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const [, y, mo, d, h, mi, s = '0'] = m;
    return new Date(+y, +mo - 1, +d, +h, +mi, +s, 0);
  }
  return new Date(str);
}

/** Format a Date as "YYYY-MM-DDTHH:MM" for datetime-local inputs. */
function toLocalInputValue(date) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth()+1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}`;
}

/** Format a Date as "HH:MM". */
function formatTime(date) {
  const p = n => String(n).padStart(2, '0');
  return `${p(date.getHours())}:${p(date.getMinutes())}`;
}

/** Minutes from midnight (local) for a Date object. */
function minutesFromMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

/** Convert minutes-from-midnight to px from top of the time axis. */
function minutesToPx(minutes) {
  return (minutes / MINUTES_PER_DAY) * TOTAL_HEIGHT;
}

/** Convert a px offset (within the time axis) to minutes-from-midnight. */
function pxToMinutes(px) {
  return Math.round((px / TOTAL_HEIGHT) * MINUTES_PER_DAY);
}

/** Snap minutes to the nearest 15-minute boundary. */
function snapMinutes(minutes) {
  return Math.round(minutes / 15) * 15;
}

/** Clamp a value between min and max (inclusive). */
function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

/** Pick a colour from the palette based on event id. */
function eventColor(id) {
  return EVENT_COLORS[Number(id) % EVENT_COLORS.length];
}

/** "HH:MM – HH:MM" display string for an event. */
function formatTimeRange(startStr, endStr) {
  return `${formatTime(parseLocalISO(startStr))} – ${formatTime(parseLocalISO(endStr))}`;
}

// ============================================================
// API helpers
// ============================================================

const API_BASE = '/api/events';

async function apiFetch(url, options = {}) {
  const res  = await fetch(url, options);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

/** Fetch events overlapping the given week (sends local datetime strings). */
function fetchEvents(weekStart) {
  const start = toLocalInputValue(weekStart);
  const end   = toLocalInputValue(addDays(weekStart, 7));
  return apiFetch(`${API_BASE}?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
}

function createEvent(data)     { return apiFetch(API_BASE, { method: 'POST',   headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }); }
function updateEvent(id, data) { return apiFetch(`${API_BASE}/${id}`, { method: 'PUT',    headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }); }
function deleteEvent(id)       { return apiFetch(`${API_BASE}/${id}`, { method: 'DELETE' }); }

// ============================================================
// Overlap Layout Engine
// ============================================================

/**
 * Compute visual layout for a single day's events.
 *
 * Algorithm:
 *  1. Sort events by start time (ties: longer event first).
 *  2. Build overlap clusters with union-find:
 *     events A and B overlap iff startA < endB && startB < endA.
 *  3. Within each cluster, assign column indices greedily:
 *     place each event in the first column whose last event ends ≤ this event's start.
 *  4. Width = 100% / numColumnsInCluster; left = colIndex * width.
 *     A 1px inset on each side provides visual separation.
 *
 * @param {Array} events  – raw event objects for one day
 * @returns {Array}       – { event, top, height, leftPct, widthPct }
 */
function computeDayLayout(events) {
  if (!events.length) return [];

  // Normalise times to minutes-from-midnight.
  // Events ending at 00:00 of the next day are treated as ending at 1440.
  const items = events.map(ev => {
    const s = parseLocalISO(ev.start_at);
    const e = parseLocalISO(ev.end_at);
    let endMin = minutesFromMidnight(e);
    // Midnight of next day → 1440
    if (endMin === 0 && e > s) endMin = MINUTES_PER_DAY;
    return {
      event:    ev,
      startMin: clamp(minutesFromMidnight(s), 0, MINUTES_PER_DAY),
      endMin:   clamp(endMin, 0, MINUTES_PER_DAY),
    };
  });

  // Sort: earlier start first; longer event first on ties
  items.sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);

  const n = items.length;

  // ── Union-Find ──────────────────────────────────────────────
  const parent = Array.from({length: n}, (_, i) => i);
  function find(x) {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  }
  function unite(x, y) {
    const px = find(x), py = find(y);
    if (px !== py) parent[px] = py;
  }

  // Two events overlap if their time ranges intersect (open intervals)
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (items[i].startMin < items[j].endMin && items[j].startMin < items[i].endMin) {
        unite(i, j);
      }
    }
  }

  // Group indices by cluster root
  const clusters = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(i);
  }

  const result = new Array(n);

  for (const [, indices] of clusters) {
    // Sort cluster members by start time
    indices.sort((a, b) => items[a].startMin - items[b].startMin || items[b].endMin - items[a].endMin);

    // Greedy column assignment
    // cols[c] = end time of the last event placed in column c
    const cols  = [];
    const colOf = new Array(indices.length);

    for (let ci = 0; ci < indices.length; ci++) {
      const { startMin, endMin } = items[indices[ci]];
      let placed = false;
      for (let c = 0; c < cols.length; c++) {
        if (cols[c] <= startMin) {
          colOf[ci] = c;
          cols[c]   = endMin;
          placed    = true;
          break;
        }
      }
      if (!placed) {
        colOf[ci] = cols.length;
        cols.push(endMin);
      }
    }

    const numCols = cols.length;

    for (let ci = 0; ci < indices.length; ci++) {
      const idx = indices[ci];
      const { event, startMin, endMin } = items[idx];
      const col = colOf[ci];

      const topPx    = minutesToPx(startMin);
      const bottomPx = minutesToPx(endMin);
      const heightPx = Math.max(bottomPx - topPx, 2); // minimum 2px visible

      const widthPct = 100 / numCols;
      const leftPct  = col * widthPct;

      result[idx] = { event, top: topPx, height: heightPx, leftPct, widthPct };
    }
  }

  return result;
}

// ============================================================
// Application State
// ============================================================

let currentWeekStart = getWeekStart(new Date());
let currentEvents    = [];

// ============================================================
// DOM References
// ============================================================

const weekLabel       = document.getElementById('week-label');
const dayHeaders      = document.getElementById('day-headers');
const dayColumnsEl    = document.getElementById('day-columns');
const timeLabelsEl    = document.getElementById('time-labels');
const scrollBody      = document.getElementById('scroll-body');
const modalOverlay    = document.getElementById('modal-overlay');
const modalTitle      = document.getElementById('modal-title');
const eventForm       = document.getElementById('event-form');
const eventIdInput    = document.getElementById('event-id');
const eventTitleInput = document.getElementById('event-title');
const eventStartInput = document.getElementById('event-start');
const eventEndInput   = document.getElementById('event-end');
const formError       = document.getElementById('form-error');
const btnSave         = document.getElementById('btn-save');
const btnDelete       = document.getElementById('btn-delete');
const btnCancel       = document.getElementById('btn-cancel');
const btnPrev         = document.getElementById('btn-prev');
const btnToday        = document.getElementById('btn-today');
const btnNext         = document.getElementById('btn-next');

// ============================================================
// Render: Time Gutter
// ============================================================

function renderTimeGutter() {
  timeLabelsEl.innerHTML = '';
  // Render hour labels 01:00 … 24:00 (24:00 shown as 00:00 at bottom)
  for (let h = 1; h <= 24; h++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    const displayH = h === 24 ? 0 : h;
    label.textContent = `${String(displayH).padStart(2, '0')}:00`;
    label.style.top = `${minutesToPx(h * 60)}px`;
    timeLabelsEl.appendChild(label);
  }
}

// ============================================================
// Render: Week Header
// ============================================================

function renderWeekHeader() {
  const today   = new Date(); today.setHours(0, 0, 0, 0);
  const weekEnd = addDays(currentWeekStart, 6);

  // Week label
  let label;
  if (currentWeekStart.getMonth() === weekEnd.getMonth()) {
    label = `${MONTH_NAMES[currentWeekStart.getMonth()]} ${currentWeekStart.getFullYear()}`;
  } else if (currentWeekStart.getFullYear() === weekEnd.getFullYear()) {
    label = `${MONTH_NAMES[currentWeekStart.getMonth()]} – ${MONTH_NAMES[weekEnd.getMonth()]} ${currentWeekStart.getFullYear()}`;
  } else {
    label = `${MONTH_NAMES[currentWeekStart.getMonth()]} ${currentWeekStart.getFullYear()} – ${MONTH_NAMES[weekEnd.getMonth()]} ${weekEnd.getFullYear()}`;
  }
  weekLabel.textContent = label;

  // Day headers
  dayHeaders.innerHTML = '';
  for (let d = 0; d < 7; d++) {
    const day     = addDays(currentWeekStart, d);
    const isToday = day.getTime() === today.getTime();

    const header = document.createElement('div');
    header.className = 'day-header' + (isToday ? ' today' : '');

    const nameEl = document.createElement('span');
    nameEl.className   = 'day-name';
    nameEl.textContent = DAY_NAMES[d];

    const numEl = document.createElement('span');
    numEl.className   = 'day-number';
    numEl.textContent = day.getDate();

    header.appendChild(nameEl);
    header.appendChild(numEl);
    dayHeaders.appendChild(header);
  }
}

// ============================================================
// Render: Day Columns (grid lines)
// ============================================================

function renderDayColumns() {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  dayColumnsEl.innerHTML = '';

  for (let d = 0; d < 7; d++) {
    const day     = addDays(currentWeekStart, d);
    const isToday = day.getTime() === today.getTime();

    const col = document.createElement('div');
    col.className      = 'day-column' + (isToday ? ' today' : '');
    col.dataset.dayIndex = d;

    // Hour and half-hour lines
    for (let h = 0; h <= 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${minutesToPx(h * 60)}px`;
      col.appendChild(line);

      if (h < 24) {
        const half = document.createElement('div');
        half.className = 'hour-line half';
        half.style.top = `${minutesToPx(h * 60 + 30)}px`;
        col.appendChild(half);
      }
    }

    attachDragToCreate(col, day);
    dayColumnsEl.appendChild(col);
  }

  renderCurrentTimeLine();
}

// ============================================================
// Render: Current Time Line
// ============================================================

let _timeLineInterval = null;

function renderCurrentTimeLine() {
  document.querySelectorAll('.current-time-line').forEach(el => el.remove());

  const now      = new Date();
  const todayMid = new Date(now); todayMid.setHours(0, 0, 0, 0);

  const cols = dayColumnsEl.querySelectorAll('.day-column');
  cols.forEach((col, d) => {
    const day = addDays(currentWeekStart, d);
    if (day.getTime() === todayMid.getTime()) {
      const line = document.createElement('div');
      line.className = 'current-time-line';
      line.style.top = `${minutesToPx(minutesFromMidnight(now))}px`;
      col.appendChild(line);
    }
  });
}

// ============================================================
// Render: Events
// ============================================================

function renderEvents() {
  // Remove old event blocks
  dayColumnsEl.querySelectorAll('.event-block').forEach(el => el.remove());

  const cols = dayColumnsEl.querySelectorAll('.day-column');

  // Bucket events into day columns by their start date
  const byDay = Array.from({length: 7}, () => []);
  for (const ev of currentEvents) {
    const evStart = parseLocalISO(ev.start_at);
    for (let d = 0; d < 7; d++) {
      const dayStart = addDays(currentWeekStart, d);
      const dayEnd   = addDays(currentWeekStart, d + 1);
      if (evStart >= dayStart && evStart < dayEnd) {
        byDay[d].push(ev);
        break;
      }
    }
  }

  for (let d = 0; d < 7; d++) {
    const col = cols[d];
    if (!col) continue;

    const layouts = computeDayLayout(byDay[d]);

    for (const { event, top, height, leftPct, widthPct } of layouts) {
      const block = document.createElement('div');
      block.className        = 'event-block';
      block.dataset.eventId  = event.id;
      block.style.top        = `${top}px`;
      block.style.height     = `${height}px`;
      // 1px inset on each side for visual separation between adjacent events
      block.style.left       = `calc(${leftPct}% + 1px)`;
      block.style.width      = `calc(${widthPct}% - 2px)`;
      block.style.background = eventColor(event.id);
      block.style.zIndex     = '2';

      const titleEl = document.createElement('div');
      titleEl.className   = 'event-title';
      titleEl.textContent = event.title;

      const timeEl = document.createElement('div');
      timeEl.className   = 'event-time';
      timeEl.textContent = formatTimeRange(event.start_at, event.end_at);

      block.appendChild(titleEl);
      block.appendChild(timeEl);

      block.addEventListener('click', e => {
        e.stopPropagation();
        openEditModal(event);
      });

      col.appendChild(block);
    }
  }
}

// ============================================================
// Drag-to-Create
// ============================================================

function attachDragToCreate(col, day) {
  let dragging    = false;
  let anchorMin   = 0;
  let selectionEl = null;

  function minutesFromPointer(e) {
    const rect = col.getBoundingClientRect();
    const y    = e.clientY - rect.top + scrollBody.scrollTop;
    return clamp(snapMinutes(pxToMinutes(y)), 0, MINUTES_PER_DAY);
  }

  col.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    if (e.target.closest('.event-block')) return;

    dragging  = true;
    anchorMin = minutesFromPointer(e);

    selectionEl = document.createElement('div');
    selectionEl.className = 'selection-block';
    updateSelection(anchorMin, anchorMin + 60);
    col.appendChild(selectionEl);
    e.preventDefault();
  });

  function onMove(e) {
    if (!dragging) return;
    const cur = minutesFromPointer(e);
    const lo  = Math.min(anchorMin, cur);
    const hi  = Math.max(anchorMin, cur);
    updateSelection(lo, hi);
  }

  function onUp(e) {
    if (!dragging) return;
    dragging = false;

    const cur = minutesFromPointer(e);
    let lo = Math.min(anchorMin, cur);
    let hi = Math.max(anchorMin, cur);

    // Minimum 15 minutes; default to 1 hour if no meaningful drag
    if (hi - lo < 15) hi = lo + 60;
    hi = clamp(hi, 0, MINUTES_PER_DAY);

    if (selectionEl) { selectionEl.remove(); selectionEl = null; }

    const startDate = new Date(day);
    startDate.setHours(Math.floor(lo / 60), lo % 60, 0, 0);
    const endDate = new Date(day);
    endDate.setHours(Math.floor(hi / 60), hi % 60, 0, 0);

    openCreateModal(startDate, endDate);
  }

  function updateSelection(lo, hi) {
    if (!selectionEl) return;
    const top    = minutesToPx(lo);
    const height = Math.max(minutesToPx(hi) - top, minutesToPx(15));
    selectionEl.style.top    = `${top}px`;
    selectionEl.style.height = `${height}px`;
  }

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup',   onUp);
}

// ============================================================
// Modal
// ============================================================

function showError(msg) {
  formError.textContent = msg;
  formError.classList.remove('hidden');
}

function hideError() {
  formError.textContent = '';
  formError.classList.add('hidden');
}

function openCreateModal(startDate, endDate) {
  modalTitle.textContent    = 'New Event';
  eventIdInput.value        = '';
  eventTitleInput.value     = '';
  eventStartInput.value     = toLocalInputValue(startDate);
  eventEndInput.value       = toLocalInputValue(endDate);
  btnDelete.classList.add('hidden');
  hideError();
  modalOverlay.classList.remove('hidden');
  setTimeout(() => eventTitleInput.focus(), 50);
}

function openEditModal(event) {
  modalTitle.textContent    = 'Edit Event';
  eventIdInput.value        = event.id;
  eventTitleInput.value     = event.title;
  eventStartInput.value     = toLocalInputValue(parseLocalISO(event.start_at));
  eventEndInput.value       = toLocalInputValue(parseLocalISO(event.end_at));
  btnDelete.classList.remove('hidden');
  hideError();
  modalOverlay.classList.remove('hidden');
  setTimeout(() => eventTitleInput.focus(), 50);
}

function closeModal() {
  modalOverlay.classList.add('hidden');
  hideError();
}

// ============================================================
// Form Submission
// ============================================================

eventForm.addEventListener('submit', async e => {
  e.preventDefault();
  hideError();

  const title = eventTitleInput.value.trim();
  const start = eventStartInput.value;   // "YYYY-MM-DDTHH:MM" local string
  const end   = eventEndInput.value;
  const id    = eventIdInput.value;

  if (!title)         { showError('Title is required.');                  return; }
  if (!start || !end) { showError('Start and end times are required.');   return; }

  // Client-side validation
  const startDate = parseLocalISO(start);
  const endDate   = parseLocalISO(end);

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    showError('Invalid date/time values.'); return;
  }
  if (endDate <= startDate) {
    showError('End time must be after start time.'); return;
  }

  // Send local datetime strings — server stores as wall-clock TIMESTAMP
  const payload = { title, start_at: start, end_at: end };

  try {
    btnSave.disabled = true;
    if (id) {
      await updateEvent(id, payload);
    } else {
      await createEvent(payload);
    }
    closeModal();
    await loadAndRender();
  } catch (err) {
    showError(err.message);
  } finally {
    btnSave.disabled = false;
  }
});

btnDelete.addEventListener('click', async () => {
  const id = eventIdInput.value;
  if (!id) return;
  if (!confirm('Delete this event?')) return;
  try {
    btnDelete.disabled = true;
    await deleteEvent(id);
    closeModal();
    await loadAndRender();
  } catch (err) {
    showError(err.message);
  } finally {
    btnDelete.disabled = false;
  }
});

btnCancel.addEventListener('click', closeModal);
document.getElementById('modal-close').addEventListener('click', closeModal);
modalOverlay.addEventListener('click', e => { if (e.target === modalOverlay) closeModal(); });

// ============================================================
// Navigation
// ============================================================

btnPrev.addEventListener('click',  () => { currentWeekStart = addDays(currentWeekStart, -7); loadAndRender(); });
btnNext.addEventListener('click',  () => { currentWeekStart = addDays(currentWeekStart,  7); loadAndRender(); });
btnToday.addEventListener('click', () => { currentWeekStart = getWeekStart(new Date());       loadAndRender(); });

// ============================================================
// Load & Render
// ============================================================

async function loadAndRender() {
  try {
    currentEvents = await fetchEvents(currentWeekStart);
  } catch (err) {
    console.error('Failed to load events:', err);
    currentEvents = [];
  }
  renderWeekHeader();
  renderDayColumns();
  renderEvents();
}

// ============================================================
// Initialise
// ============================================================

function init() {
  renderTimeGutter();
  loadAndRender();

  // Scroll to 07:00 on initial load
  requestAnimationFrame(() => {
    scrollBody.scrollTop = minutesToPx(7 * 60);
  });

  // Refresh current-time line every minute
  if (_timeLineInterval) clearInterval(_timeLineInterval);
  _timeLineInterval = setInterval(renderCurrentTimeLine, 60_000);
}

init();
