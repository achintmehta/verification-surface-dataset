// ─── Constants ──────────────────────────────────────────────────
const HOUR_HEIGHT = 60; // pixels per hour
const TOTAL_HEIGHT = HOUR_HEIGHT * 24; // total height of a day column body
const API_BASE = '/api/events';
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

// ─── State ──────────────────────────────────────────────────────
let currentWeekStart = getMonday(new Date()); // Monday 00:00 local time
let events = [];

// ─── DOM References ─────────────────────────────────────────────
const weekTitleEl = document.getElementById('week-title');
const timeGutterEl = document.getElementById('time-gutter');
const daysContainerEl = document.getElementById('days-container');
const modalOverlay = document.getElementById('modal-overlay');
const modalTitle = document.getElementById('modal-title');
const eventForm = document.getElementById('event-form');
const eventIdInput = document.getElementById('event-id');
const eventTitleInput = document.getElementById('event-title');
const eventStartInput = document.getElementById('event-start');
const eventEndInput = document.getElementById('event-end');
const btnSave = document.getElementById('btn-save');
const btnDelete = document.getElementById('btn-delete');
const btnCancel = document.getElementById('btn-cancel');
const formError = document.getElementById('form-error');

// ─── Date Utilities ─────────────────────────────────────────────
function getMonday(d) {
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  const day = date.getDay(); // 0=Sun,1=Mon,...
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  return date;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}

function formatDate(d) {
  return d.getDate();
}

function formatWeekTitle(monday) {
  const sunday = addDays(monday, 6);
  const mMonth = MONTH_NAMES[monday.getMonth()];
  const sMonth = MONTH_NAMES[sunday.getMonth()];
  const year = monday.getFullYear();
  if (monday.getMonth() === sunday.getMonth()) {
    return `${mMonth} ${monday.getDate()} – ${sunday.getDate()}, ${year}`;
  }
  return `${mMonth} ${monday.getDate()} – ${sMonth} ${sunday.getDate()}, ${year}`;
}

/** Convert a Date to "YYYY-MM-DDTHH:MM" for datetime-local input */
function toLocalDatetimeString(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Minutes from midnight for a Date, in local time */
function minutesFromMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

// ─── API Helpers ────────────────────────────────────────────────
async function fetchEvents(weekStart) {
  const start = weekStart.toISOString();
  const end = addDays(weekStart, 7).toISOString();
  const res = await fetch(`${API_BASE}?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
  if (!res.ok) throw new Error('Failed to fetch events');
  return res.json();
}

async function createEvent(data) {
  const res = await fetch(API_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to create event');
  }
  return res.json();
}

async function updateEvent(id, data) {
  const res = await fetch(`${API_BASE}/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to update event');
  }
  return res.json();
}

async function deleteEvent(id) {
  const res = await fetch(`${API_BASE}/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to delete event');
  }
  return res.json();
}

// ─── Layout Engine ──────────────────────────────────────────────

/**
 * Given an array of events for a single day, compute their layout positions.
 * Each event object should have: startMin, endMin (minutes from midnight, clamped 0-1440).
 * Returns an array of { event, column, totalColumns } objects.
 */
function computeOverlapLayout(dayEvents) {
  if (dayEvents.length === 0) return [];

  // Sort by start time, then by end time (longer events first for tie-breaking)
  const sorted = [...dayEvents].sort((a, b) => {
    if (a.startMin !== b.startMin) return a.startMin - b.startMin;
    return b.endMin - a.endMin; // longer event first
  });

  // Build overlap clusters: maximal sets of transitively overlapping events
  const clusters = [];
  let currentCluster = [sorted[0]];
  let clusterEnd = sorted[0].endMin;

  for (let i = 1; i < sorted.length; i++) {
    const ev = sorted[i];
    if (ev.startMin < clusterEnd) {
      // Overlaps with the current cluster
      currentCluster.push(ev);
      clusterEnd = Math.max(clusterEnd, ev.endMin);
    } else {
      // Start a new cluster
      clusters.push(currentCluster);
      currentCluster = [ev];
      clusterEnd = ev.endMin;
    }
  }
  clusters.push(currentCluster);

  // For each cluster, assign columns greedily
  const results = [];

  for (const cluster of clusters) {
    // cluster events are already sorted by start time
    const columns = []; // columns[i] = end time of the last event in column i

    for (const ev of cluster) {
      // Find the first column where this event fits (its start >= column's last end)
      let placed = false;
      for (let c = 0; c < columns.length; c++) {
        if (ev.startMin >= columns[c]) {
          columns[c] = ev.endMin;
          results.push({ event: ev, column: c, totalColumns: 0 }); // totalColumns set later
          placed = true;
          break;
        }
      }
      if (!placed) {
        const c = columns.length;
        columns.push(ev.endMin);
        results.push({ event: ev, column: c, totalColumns: 0 });
      }
    }

    // Set totalColumns for all events in this cluster
    const totalCols = columns.length;
    // The last `cluster.length` items in results belong to this cluster
    const startIdx = results.length - cluster.length;
    for (let i = startIdx; i < results.length; i++) {
      results[i].totalColumns = totalCols;
    }
  }

  return results;
}

// ─── Rendering ──────────────────────────────────────────────────

function renderTimeGutter() {
  timeGutterEl.innerHTML = '';
  // Set height to match day bodies + header
  // We'll set a padding-top to account for the day header
  const headerHeight = 56; // approximate, matches CSS
  timeGutterEl.style.paddingTop = `${headerHeight}px`;
  timeGutterEl.style.height = `${TOTAL_HEIGHT + headerHeight}px`;

  for (let h = 0; h <= 24; h++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = `${headerHeight + h * HOUR_HEIGHT}px`;
    const hour = h % 24;
    label.textContent = `${String(hour).padStart(2, '0')}:00`;
    timeGutterEl.appendChild(label);
  }
}

function renderWeek() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  weekTitleEl.textContent = formatWeekTitle(currentWeekStart);
  daysContainerEl.innerHTML = '';

  for (let i = 0; i < 7; i++) {
    const dayDate = addDays(currentWeekStart, i);
    const isToday = isSameDay(dayDate, today);

    const col = document.createElement('div');
    col.className = 'day-column' + (isToday ? ' today' : '');
    col.dataset.dayIndex = i;

    // Day header
    const header = document.createElement('div');
    header.className = 'day-header';
    header.innerHTML = `<span class="day-name">${DAY_NAMES[i]}</span><span class="day-number">${formatDate(dayDate)}</span>`;
    col.appendChild(header);

    // Day body
    const body = document.createElement('div');
    body.className = 'day-body';
    body.style.height = `${TOTAL_HEIGHT}px`;
    body.dataset.date = dayDate.toISOString();

    // Hour lines
    for (let h = 0; h < 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${h * HOUR_HEIGHT}px`;
      body.appendChild(line);
    }
    // Bottom line at 24:00
    const bottomLine = document.createElement('div');
    bottomLine.className = 'hour-line';
    bottomLine.style.top = `${TOTAL_HEIGHT}px`;
    body.appendChild(bottomLine);

    // Clickable area for creating events
    const clickArea = document.createElement('div');
    clickArea.className = 'day-body-click-area';
    setupDayClickHandler(clickArea, dayDate);
    body.appendChild(clickArea);

    col.appendChild(body);
    daysContainerEl.appendChild(col);
  }

  renderEvents();
}

function renderEvents() {
  // Remove old event blocks
  document.querySelectorAll('.event-block').forEach(el => el.remove());

  // Group events by day
  const dayBuckets = new Map(); // dayIndex -> [{event, startMin, endMin}]

  for (const ev of events) {
    const start = new Date(ev.start_at);
    const end = new Date(ev.end_at);

    // An event can span multiple days; we render it in each day column it touches
    for (let i = 0; i < 7; i++) {
      const dayStart = addDays(currentWeekStart, i);
      const dayEnd = addDays(currentWeekStart, i + 1);

      // Check if event overlaps this day
      if (start < dayEnd && end > dayStart) {
        // Clamp to this day
        const clampedStart = start < dayStart ? dayStart : start;
        const clampedEnd = end > dayEnd ? dayEnd : end;

        const startMin = minutesFromMidnight(clampedStart);
        // If clampedEnd is the next day midnight, endMin = 1440
        let endMin;
        if (clampedEnd.getTime() === dayEnd.getTime()) {
          endMin = 1440;
        } else {
          endMin = minutesFromMidnight(clampedEnd);
        }

        // Ensure minimum render height
        if (endMin <= startMin) continue;

        if (!dayBuckets.has(i)) dayBuckets.set(i, []);
        dayBuckets.get(i).push({ ...ev, startMin, endMin });
      }
    }
  }

  // For each day, compute layout and render
  const dayBodies = document.querySelectorAll('.day-body');

  for (const [dayIndex, dayEvents] of dayBuckets) {
    const dayBody = dayBodies[dayIndex];
    if (!dayBody) continue;

    const layoutItems = computeOverlapLayout(dayEvents);

    for (const item of layoutItems) {
      const { event, column, totalColumns } = item;
      const block = document.createElement('div');
      block.className = 'event-block';

      const top = (event.startMin / 1440) * TOTAL_HEIGHT;
      const height = ((event.endMin - event.startMin) / 1440) * TOTAL_HEIGHT;
      const widthPercent = 100 / totalColumns;
      const leftPercent = column * widthPercent;

      block.style.top = `${top}px`;
      block.style.height = `${height}px`;
      block.style.left = `${leftPercent}%`;
      block.style.width = `calc(${widthPercent}% - 2px)`; // small gap between side-by-side events
      block.style.minHeight = '0';

      // Format times
      const startDate = new Date(event.start_at);
      const endDate = new Date(event.end_at);
      const fmt = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

      block.innerHTML = `
        <div class="event-block-title">${escapeHtml(event.title)}</div>
        <div class="event-block-time">${fmt(startDate)} – ${fmt(endDate)}</div>
      `;

      block.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditModal(event);
      });

      dayBody.appendChild(block);
    }
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ─── Day Click for Creating Events ──────────────────────────────

function setupDayClickHandler(clickArea, dayDate) {
  let dragStartY = null;
  let selectionEl = null;

  function getMinutesFromY(y) {
    const rect = clickArea.getBoundingClientRect();
    const relY = y - rect.top;
    const minutes = (relY / TOTAL_HEIGHT) * 1440;
    // Snap to 15-minute intervals
    return Math.max(0, Math.min(1440, Math.round(minutes / 15) * 15));
  }

  clickArea.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragStartY = e.clientY;

    selectionEl = document.createElement('div');
    selectionEl.className = 'selection-highlight';
    clickArea.parentElement.appendChild(selectionEl);

    const startMin = getMinutesFromY(e.clientY);
    const top = (startMin / 1440) * TOTAL_HEIGHT;
    selectionEl.style.top = `${top}px`;
    selectionEl.style.height = '0px';

    function onMouseMove(e) {
      if (!selectionEl) return;
      const currentMin = getMinutesFromY(e.clientY);
      const startMin = getMinutesFromY(dragStartY);
      const minStart = Math.min(startMin, currentMin);
      const minEnd = Math.max(startMin, currentMin);
      const topPx = (minStart / 1440) * TOTAL_HEIGHT;
      const heightPx = ((minEnd - minStart) / 1440) * TOTAL_HEIGHT;
      selectionEl.style.top = `${topPx}px`;
      selectionEl.style.height = `${heightPx}px`;
    }

    function onMouseUp(e) {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);

      if (selectionEl) {
        selectionEl.remove();
        selectionEl = null;
      }

      const startMin = getMinutesFromY(dragStartY);
      const endMin = getMinutesFromY(e.clientY);

      const actualStart = Math.min(startMin, endMin);
      let actualEnd = Math.max(startMin, endMin);

      // If click without drag, default to 1 hour
      if (actualEnd - actualStart < 15) {
        actualEnd = Math.min(actualStart + 60, 1440);
      }

      const startDate = new Date(dayDate);
      startDate.setHours(0, actualStart, 0, 0);
      const endDate = new Date(dayDate);
      endDate.setHours(0, actualEnd, 0, 0);

      openCreateModal(startDate, endDate);

      dragStartY = null;
    }

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}

// ─── Modal ──────────────────────────────────────────────────────

function openCreateModal(startDate, endDate) {
  modalTitle.textContent = 'New Event';
  eventIdInput.value = '';
  eventTitleInput.value = '';
  eventStartInput.value = toLocalDatetimeString(startDate);
  eventEndInput.value = toLocalDatetimeString(endDate);
  btnDelete.classList.add('hidden');
  formError.classList.add('hidden');
  modalOverlay.classList.remove('hidden');
  eventTitleInput.focus();
}

function openEditModal(event) {
  modalTitle.textContent = 'Edit Event';
  eventIdInput.value = event.id;
  eventTitleInput.value = event.title;
  eventStartInput.value = toLocalDatetimeString(new Date(event.start_at));
  eventEndInput.value = toLocalDatetimeString(new Date(event.end_at));
  btnDelete.classList.remove('hidden');
  formError.classList.add('hidden');
  modalOverlay.classList.remove('hidden');
  eventTitleInput.focus();
}

function closeModal() {
  modalOverlay.classList.add('hidden');
  formError.classList.add('hidden');
}

// ─── Event Handlers ─────────────────────────────────────────────

eventForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  formError.classList.add('hidden');

  const title = eventTitleInput.value.trim();
  const start_at = new Date(eventStartInput.value).toISOString();
  const end_at = new Date(eventEndInput.value).toISOString();
  const id = eventIdInput.value;

  if (!title) {
    formError.textContent = 'Title is required';
    formError.classList.remove('hidden');
    return;
  }

  if (new Date(end_at) <= new Date(start_at)) {
    formError.textContent = 'End time must be after start time';
    formError.classList.remove('hidden');
    return;
  }

  try {
    if (id) {
      await updateEvent(id, { title, start_at, end_at });
    } else {
      await createEvent({ title, start_at, end_at });
    }
    closeModal();
    await loadWeek();
  } catch (err) {
    formError.textContent = err.message;
    formError.classList.remove('hidden');
  }
});

btnDelete.addEventListener('click', async () => {
  const id = eventIdInput.value;
  if (!id) return;

  try {
    await deleteEvent(id);
    closeModal();
    await loadWeek();
  } catch (err) {
    formError.textContent = err.message;
    formError.classList.remove('hidden');
  }
});

btnCancel.addEventListener('click', closeModal);

modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeModal();
});

document.getElementById('btn-prev').addEventListener('click', () => {
  currentWeekStart = addDays(currentWeekStart, -7);
  loadWeek();
});

document.getElementById('btn-today').addEventListener('click', () => {
  currentWeekStart = getMonday(new Date());
  loadWeek();
});

document.getElementById('btn-next').addEventListener('click', () => {
  currentWeekStart = addDays(currentWeekStart, 7);
  loadWeek();
});

// ─── Load & Init ────────────────────────────────────────────────

async function loadWeek() {
  try {
    events = await fetchEvents(currentWeekStart);
  } catch (err) {
    console.error('Failed to load events:', err);
    events = [];
  }
  renderWeek();
}

// Initial render
renderTimeGutter();
loadWeek();
