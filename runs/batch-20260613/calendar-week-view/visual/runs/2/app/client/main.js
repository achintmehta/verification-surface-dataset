/**
 * Week Calendar — main.js
 * Vanilla JS, no framework.
 */

const API_BASE = 'http://localhost:3001/api';

// ── Layout constants (must match CSS custom properties) ───────────────────────
const HOUR_HEIGHT   = 64;   // px per hour  → --hour-height
const TOTAL_HEIGHT  = HOUR_HEIGHT * 24;

// ── Event colour palette ──────────────────────────────────────────────────────
const PALETTE = [
  { bg: '#dbeafe', text: '#1e40af', border: '#93c5fd' },
  { bg: '#dcfce7', text: '#166534', border: '#86efac' },
  { bg: '#fce7f3', text: '#9d174d', border: '#f9a8d4' },
  { bg: '#fef3c7', text: '#92400e', border: '#fcd34d' },
  { bg: '#ede9fe', text: '#5b21b6', border: '#c4b5fd' },
  { bg: '#ffedd5', text: '#9a3412', border: '#fdba74' },
  { bg: '#cffafe', text: '#155e75', border: '#67e8f9' },
  { bg: '#d1fae5', text: '#065f46', border: '#6ee7b7' },
];
const colorFor = id => PALETTE[Math.abs(Number(id)) % PALETTE.length];

// ── Date / time helpers ───────────────────────────────────────────────────────

/** Monday of the week containing `date` (local time, time zeroed). */
function weekMonday(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay(); // 0=Sun
  d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
  return d;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

/** "YYYY-MM-DDTHH:MM" for datetime-local inputs */
function toInputValue(date) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth()+1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}`;
}

/** "YYYY-MM-DDTHH:MM:SS" — what the server stores */
function toServerISO(date) {
  return toInputValue(date) + ':00';
}

/** "HH:MM" */
function fmtTime(date) {
  const p = n => String(n).padStart(2, '0');
  return `${p(date.getHours())}:${p(date.getMinutes())}`;
}

const DAY_ABBR   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function weekRangeLabel(monday) {
  const sunday = addDays(monday, 6);
  const m1 = MONTH_ABBR[monday.getMonth()];
  const m2 = MONTH_ABBR[sunday.getMonth()];
  const y  = monday.getFullYear();
  return m1 === m2
    ? `${m1} ${monday.getDate()}–${sunday.getDate()}, ${y}`
    : `${m1} ${monday.getDate()} – ${m2} ${sunday.getDate()}, ${y}`;
}

/** Minutes from midnight (0–1440). */
function minsFromMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

/** Minutes → px offset from top of day body. */
function minsToPx(mins) {
  return (mins / 60) * HOUR_HEIGHT;
}

// ── Overlap layout engine ─────────────────────────────────────────────────────
/**
 * Given events with .startMin / .endMin, compute { event, col, totalCols }.
 *
 * Algorithm:
 *  1. Sort by startMin asc, endMin desc.
 *  2. Sweep to build maximal overlap clusters (a cluster ends when no
 *     pending event overlaps the current cluster's max end time).
 *  3. Within each cluster, greedily assign columns:
 *     - colEnds[i] = endMin of the last event placed in column i.
 *     - For each event, pick the first column whose colEnd ≤ event.startMin;
 *       if none, open a new column.
 *  4. totalCols = number of columns opened for the cluster.
 */
function computeLayout(events) {
  if (!events.length) return [];

  const sorted = [...events].sort((a, b) =>
    a.startMin !== b.startMin ? a.startMin - b.startMin : b.endMin - a.endMin
  );

  // Build clusters by sweep
  const clusters = [];
  let cluster = [];
  let clusterMaxEnd = -Infinity;

  for (const ev of sorted) {
    if (cluster.length === 0 || ev.startMin < clusterMaxEnd) {
      cluster.push(ev);
      clusterMaxEnd = Math.max(clusterMaxEnd, ev.endMin);
    } else {
      clusters.push(cluster);
      cluster = [ev];
      clusterMaxEnd = ev.endMin;
    }
  }
  if (cluster.length) clusters.push(cluster);

  const result = [];

  for (const cl of clusters) {
    const colEnds = [];

    const assignments = cl.map(ev => {
      let col = colEnds.findIndex(end => end <= ev.startMin);
      if (col === -1) { col = colEnds.length; colEnds.push(ev.endMin); }
      else            { colEnds[col] = ev.endMin; }
      return { event: ev, col };
    });

    const totalCols = colEnds.length;
    for (const a of assignments) {
      result.push({ event: a.event, col: a.col, totalCols });
    }
  }

  return result;
}

// ── API ───────────────────────────────────────────────────────────────────────

async function apiFetch(path, opts = {}) {
  const res = await fetch(API_BASE + path, opts);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

const api = {
  getEvents: (start, end) =>
    apiFetch(`/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`),
  createEvent: body =>
    apiFetch('/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  updateEvent: (id, body) =>
    apiFetch(`/events/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  deleteEvent: id =>
    apiFetch(`/events/${id}`, { method: 'DELETE' }),
};

// ── State ─────────────────────────────────────────────────────────────────────

let currentMonday = weekMonday(new Date());
let weekEvents    = [];   // raw rows from server

// ── DOM refs ──────────────────────────────────────────────────────────────────

const weekLabel       = document.getElementById('week-label');
const btnPrev         = document.getElementById('btn-prev');
const btnToday        = document.getElementById('btn-today');
const btnNext         = document.getElementById('btn-next');
const stickyHeaderRow = document.getElementById('sticky-header-row');
const scrollArea      = document.getElementById('scroll-area');
const timeGutter      = document.getElementById('time-gutter');
const dayBodiesRow    = document.getElementById('day-bodies-row');
const modalOverlay    = document.getElementById('modal-overlay');
const modalTitle      = document.getElementById('modal-title');
const eventForm       = document.getElementById('event-form');
const eventIdInput    = document.getElementById('event-id');
const titleInput      = document.getElementById('event-title');
const startInput      = document.getElementById('event-start');
const endInput        = document.getElementById('event-end');
const formError       = document.getElementById('form-error');
const btnSave         = document.getElementById('btn-save');
const btnDelete       = document.getElementById('btn-delete');
const btnCancel       = document.getElementById('btn-cancel');

// ── Build static time gutter (once) ──────────────────────────────────────────

function buildTimeGutter() {
  timeGutter.innerHTML = '';
  for (let h = 0; h <= 24; h++) {
    if (h === 0) continue; // skip 00:00 label at very top (looks clipped)
    const el = document.createElement('div');
    el.className = 'time-label';
    el.style.top = `${minsToPx(h * 60)}px`;
    el.textContent = h === 24 ? '' : `${String(h).padStart(2,'0')}:00`;
    timeGutter.appendChild(el);
  }
}

// ── Render week ───────────────────────────────────────────────────────────────

function renderWeek() {
  weekLabel.textContent = weekRangeLabel(currentMonday);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // ── Rebuild sticky header cells ──
  // Remove old day-header-cells (keep gutter-spacer)
  const oldCells = stickyHeaderRow.querySelectorAll('.day-header-cell');
  oldCells.forEach(c => c.remove());

  for (let i = 0; i < 7; i++) {
    const d = addDays(currentMonday, i);
    const isToday = d.getTime() === today.getTime();
    const cell = document.createElement('div');
    cell.className = 'day-header-cell' + (isToday ? ' today' : '');
    cell.innerHTML = `
      <span class="day-name">${DAY_ABBR[d.getDay()]}</span>
      <span class="day-date">${d.getDate()}</span>
    `;
    stickyHeaderRow.appendChild(cell);
  }

  // ── Rebuild day bodies ──
  dayBodiesRow.innerHTML = '';

  // Group events by day index (0=Mon … 6=Sun)
  const byDay = Array.from({ length: 7 }, () => []);
  for (const ev of weekEvents) {
    const evStart = new Date(ev.start_at);
    evStart.setHours(0, 0, 0, 0);
    const diff = Math.round((evStart - currentMonday) / 86400000);
    if (diff >= 0 && diff < 7) byDay[diff].push(ev);
  }

  for (let i = 0; i < 7; i++) {
    const d = addDays(currentMonday, i);
    const isToday = d.getTime() === today.getTime();

    const body = document.createElement('div');
    body.className = 'day-body' + (isToday ? ' today' : '');
    body.dataset.dayIndex = i;

    // Hour & half-hour lines
    for (let h = 0; h < 24; h++) {
      const hl = document.createElement('div');
      hl.className = 'hour-line';
      hl.style.top = `${minsToPx(h * 60)}px`;
      body.appendChild(hl);

      const hh = document.createElement('div');
      hh.className = 'half-hour-line';
      hh.style.top = `${minsToPx(h * 60 + 30)}px`;
      body.appendChild(hh);
    }
    // Final hour line at 24:00
    const lastLine = document.createElement('div');
    lastLine.className = 'hour-line';
    lastLine.style.top = `${minsToPx(24 * 60)}px`;
    body.appendChild(lastLine);

    // Render events
    renderDayEvents(body, byDay[i], d);

    // Current time indicator (today only)
    if (isToday) renderNowLine(body);

    // Drag-to-create
    attachDragCreate(body, d);

    dayBodiesRow.appendChild(body);
  }
}

// ── Render events for one day ─────────────────────────────────────────────────

function renderDayEvents(bodyEl, dayEvents, dayDate) {
  if (!dayEvents.length) return;

  const dayStartMs = new Date(dayDate).setHours(0, 0, 0, 0);
  const dayEndMs   = new Date(dayDate).setHours(24, 0, 0, 0);

  // Attach layout metadata
  const layoutInput = dayEvents.map(ev => {
    const s = new Date(ev.start_at);
    const e = new Date(ev.end_at);
    // Clamp to day
    const cs = Math.max(s.getTime(), dayStartMs);
    const ce = Math.min(e.getTime(), dayEndMs);
    const csDate = new Date(cs);
    const ceDate = new Date(ce);
    const startMin = minsFromMidnight(csDate);
    // If clamped end is exactly midnight of next day, use 1440
    const endMin = ce >= dayEndMs ? 1440 : minsFromMidnight(ceDate);
    return { ...ev, startMin, endMin };
  });

  const layout = computeLayout(layoutInput);

  for (const { event: ev, col, totalCols } of layout) {
    const topPx    = minsToPx(ev.startMin);
    const heightPx = Math.max(minsToPx(ev.endMin - ev.startMin), 18);

    // Horizontal geometry: divide column width equally, 2px outer gap, 1px inner gap
    const pctW  = 100 / totalCols;
    const left  = col * pctW;
    // Outer gap: 2px left of first col, 2px right of last col; 1px between cols
    const gapL  = col === 0 ? 2 : 1;
    const gapR  = col === totalCols - 1 ? 2 : 1;

    const block = document.createElement('div');
    block.className = 'event-block';
    block.style.top    = `${topPx}px`;
    block.style.height = `${heightPx}px`;
    block.style.left   = `calc(${left}% + ${gapL}px)`;
    block.style.width  = `calc(${pctW}% - ${gapL + gapR}px)`;

    const c = colorFor(ev.id);
    block.style.background  = c.bg;
    block.style.color       = c.text;
    block.style.borderColor = c.border;

    const startDate = new Date(ev.start_at);
    const endDate   = new Date(ev.end_at);
    block.innerHTML = `
      <span class="event-title">${esc(ev.title)}</span>
      <span class="event-time">${fmtTime(startDate)}–${fmtTime(endDate)}</span>
    `;

    block.addEventListener('click', e => { e.stopPropagation(); openEditModal(ev); });
    bodyEl.appendChild(block);
  }
}

// ── Current time indicator ────────────────────────────────────────────────────

function renderNowLine(bodyEl) {
  const now = new Date();
  const mins = minsFromMidnight(now);
  const line = document.createElement('div');
  line.className = 'now-line';
  line.style.top = `${minsToPx(mins)}px`;
  bodyEl.appendChild(line);

  // Update every minute
  setTimeout(() => {
    if (line.parentNode) {
      const m = minsFromMidnight(new Date());
      line.style.top = `${minsToPx(m)}px`;
    }
  }, (60 - new Date().getSeconds()) * 1000);
}

function esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Drag-to-create ────────────────────────────────────────────────────────────

function attachDragCreate(bodyEl, dayDate) {
  let dragStartMin = null;
  let selEl = null;

  function clientYToMins(clientY) {
    const rect = bodyEl.getBoundingClientRect();
    const relY  = clientY - rect.top + scrollArea.scrollTop;
    const raw   = (relY / HOUR_HEIGHT) * 60;
    return Math.max(0, Math.min(1440, Math.round(raw / 15) * 15));
  }

  function minsToDate(mins) {
    const d = new Date(dayDate);
    d.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
    return d;
  }

  bodyEl.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    // Only fire on the body background (not on event blocks)
    if (e.target.classList.contains('event-block') ||
        e.target.classList.contains('event-title') ||
        e.target.classList.contains('event-time')) return;

    dragStartMin = clientYToMins(e.clientY);

    selEl = document.createElement('div');
    selEl.className = 'drag-selection';
    selEl.style.top    = `${minsToPx(dragStartMin)}px`;
    selEl.style.height = `${minsToPx(15)}px`;
    bodyEl.appendChild(selEl);
    e.preventDefault();
  });

  function onMove(e) {
    if (dragStartMin === null || !selEl) return;
    const cur = clientYToMins(e.clientY);
    const lo  = Math.min(dragStartMin, cur);
    const hi  = Math.max(dragStartMin, cur);
    selEl.style.top    = `${minsToPx(lo)}px`;
    selEl.style.height = `${Math.max(minsToPx(hi - lo), minsToPx(15))}px`;
  }

  function onUp(e) {
    if (dragStartMin === null || !selEl) return;
    const cur = clientYToMins(e.clientY);
    let lo = Math.min(dragStartMin, cur);
    let hi = Math.max(dragStartMin, cur);
    if (hi - lo < 15) hi = lo + 15;
    hi = Math.min(hi, 1440);

    selEl.remove();
    selEl = null;
    dragStartMin = null;

    openCreateModal(minsToDate(lo), minsToDate(hi));
  }

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup',   onUp);
}

// ── Modal ─────────────────────────────────────────────────────────────────────

function showErr(msg) { formError.textContent = msg; formError.classList.remove('hidden'); }
function hideErr()    { formError.classList.add('hidden'); }

function openCreateModal(startDate, endDate) {
  modalTitle.textContent = 'New Event';
  eventIdInput.value = '';
  titleInput.value   = '';
  startInput.value   = toInputValue(startDate);
  endInput.value     = toInputValue(endDate);
  btnDelete.classList.add('hidden');
  hideErr();
  modalOverlay.classList.remove('hidden');
  setTimeout(() => titleInput.focus(), 50);
}

function openEditModal(ev) {
  modalTitle.textContent = 'Edit Event';
  eventIdInput.value = ev.id;
  titleInput.value   = ev.title;
  startInput.value   = toInputValue(new Date(ev.start_at));
  endInput.value     = toInputValue(new Date(ev.end_at));
  btnDelete.classList.remove('hidden');
  hideErr();
  modalOverlay.classList.remove('hidden');
  setTimeout(() => titleInput.focus(), 50);
}

function closeModal() { modalOverlay.classList.add('hidden'); }

// ── Form events ───────────────────────────────────────────────────────────────

eventForm.addEventListener('submit', async e => {
  e.preventDefault();
  hideErr();

  const title = titleInput.value.trim();
  const sv    = startInput.value;
  const ev    = endInput.value;
  const id    = eventIdInput.value;

  if (!title)    { showErr('Title is required.'); return; }
  if (!sv || !ev){ showErr('Start and end times are required.'); return; }

  const sd = new Date(sv);
  const ed = new Date(ev);
  if (ed <= sd)  { showErr('End time must be after start time.'); return; }

  const payload = { title, start_at: toServerISO(sd), end_at: toServerISO(ed) };

  try {
    if (id) await api.updateEvent(id, payload);
    else    await api.createEvent(payload);
    closeModal();
    await loadAndRender();
  } catch (err) {
    showErr(err.message);
  }
});

btnDelete.addEventListener('click', async () => {
  const id = eventIdInput.value;
  if (!id || !confirm('Delete this event?')) return;
  try {
    await api.deleteEvent(id);
    closeModal();
    await loadAndRender();
  } catch (err) { showErr(err.message); }
});

btnCancel.addEventListener('click', closeModal);
modalOverlay.addEventListener('click', e => { if (e.target === modalOverlay) closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

// ── Navigation ────────────────────────────────────────────────────────────────

btnPrev.addEventListener('click',  () => { currentMonday = addDays(currentMonday, -7); loadAndRender(); });
btnNext.addEventListener('click',  () => { currentMonday = addDays(currentMonday,  7); loadAndRender(); });
btnToday.addEventListener('click', () => { currentMonday = weekMonday(new Date());     loadAndRender(); });

// ── Load & render ─────────────────────────────────────────────────────────────

async function loadAndRender() {
  const start = toServerISO(currentMonday);
  const end   = toServerISO(addDays(currentMonday, 7));
  try {
    weekEvents = await api.getEvents(start, end);
  } catch (err) {
    console.error('Failed to load events:', err);
    weekEvents = [];
  }
  renderWeek();
}

// ── Init ──────────────────────────────────────────────────────────────────────

buildTimeGutter();
loadAndRender().then(() => {
  // Scroll to 08:00 on first load so business hours are visible
  // (or to 22:00 if ?debug=late is in the URL for testing)
  scrollArea.scrollTop = minsToPx(8 * 60) - 32;
});
