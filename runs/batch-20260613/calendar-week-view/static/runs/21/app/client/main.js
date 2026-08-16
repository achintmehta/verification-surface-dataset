// ─── Configuration ───
const API_BASE = '/api/events';
const HOUR_HEIGHT = 60; // px per hour – must match CSS --hour-height
const TOTAL_MINUTES = 24 * 60;
const AXIS_HEIGHT = HOUR_HEIGHT * 24; // 1440px
const DAY_NAMES = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

// ─── State ───
let currentWeekStart = getMonday(new Date());
let events = [];

// ─── Date Helpers ───
function getMonday(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  // JS: 0=Sun, 1=Mon ... 6=Sat → we want Monday=0
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatTime(date) {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function formatTimeFromMinutes(totalMin) {
  const h = String(Math.floor(totalMin / 60)).padStart(2, '0');
  const m = String(totalMin % 60).padStart(2, '0');
  return `${h}:${m}`;
}

function isSameDay(d1, d2) {
  return d1.getFullYear() === d2.getFullYear() &&
         d1.getMonth() === d2.getMonth() &&
         d1.getDate() === d2.getDate();
}

function weekEndDate() {
  return addDays(currentWeekStart, 7);
}

// Get minutes from midnight for a date, relative to a given day start.
// If the event's time is on a different day (before dayStart) clamp to 0;
// if after the end of day clamp to 1440.
function minutesInDay(date, dayStart) {
  const dayEnd = addDays(dayStart, 1);
  if (date <= dayStart) return 0;
  if (date >= dayEnd) return TOTAL_MINUTES;
  return date.getHours() * 60 + date.getMinutes();
}

// ─── API Helpers ───
async function fetchEvents(start, end) {
  const res = await fetch(`${API_BASE}?start=${start.toISOString()}&end=${end.toISOString()}`);
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
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.error || 'Failed to create event');
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
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.error || 'Failed to update event');
  }
  return res.json();
}

async function deleteEvent(id) {
  const res = await fetch(`${API_BASE}/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete event');
}

// ─── Layout Engine ───

/**
 * Given a list of events for a single day (each with startMin and endMin
 * in minutes from midnight), compute the overlap layout.
 *
 * Returns events augmented with: column, totalColumns
 */
function computeOverlapLayout(dayEvents) {
  if (dayEvents.length === 0) return [];

  // Sort by start, then by end (longest first to break ties)
  const sorted = [...dayEvents].sort((a, b) => {
    if (a.startMin !== b.startMin) return a.startMin - b.startMin;
    return b.endMin - a.endMin;
  });

  // 1. Build clusters of transitively overlapping events
  const clusters = [];
  let cluster = [sorted[0]];
  let clusterEnd = sorted[0].endMin;

  for (let i = 1; i < sorted.length; i++) {
    const ev = sorted[i];
    if (ev.startMin < clusterEnd) {
      // Overlaps with current cluster
      cluster.push(ev);
      clusterEnd = Math.max(clusterEnd, ev.endMin);
    } else {
      clusters.push(cluster);
      cluster = [ev];
      clusterEnd = ev.endMin;
    }
  }
  clusters.push(cluster);

  // 2. For each cluster, greedily assign columns
  const result = [];
  for (const clusterEvents of clusters) {
    // columns[i] = end time of the last event placed in column i
    const columns = [];

    for (const ev of clusterEvents) {
      let placed = false;
      for (let c = 0; c < columns.length; c++) {
        if (ev.startMin >= columns[c]) {
          // Event fits in this column
          columns[c] = ev.endMin;
          ev.column = c;
          placed = true;
          break;
        }
      }
      if (!placed) {
        ev.column = columns.length;
        columns.push(ev.endMin);
      }
    }

    const totalColumns = columns.length;
    for (const ev of clusterEvents) {
      ev.totalColumns = totalColumns;
      result.push(ev);
    }
  }

  return result;
}

// ─── Rendering ───

function renderTimeGutter() {
  const gutter = document.getElementById('time-gutter');
  gutter.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'gutter-header';
  gutter.appendChild(header);

  const body = document.createElement('div');
  body.className = 'gutter-body';

  for (let h = 0; h <= 24; h++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = `${h * HOUR_HEIGHT}px`;
    label.textContent = `${String(h).padStart(2, '0')}:00`;
    body.appendChild(label);
  }

  gutter.appendChild(body);
}

function renderWeekGrid() {
  const grid = document.getElementById('week-grid');
  grid.innerHTML = '';

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let d = 0; d < 7; d++) {
    const dayDate = addDays(currentWeekStart, d);
    const col = document.createElement('div');
    col.className = 'day-column';
    col.dataset.dayIndex = d;

    if (isSameDay(dayDate, today)) {
      col.classList.add('today');
    }

    // Header
    const header = document.createElement('div');
    header.className = 'day-header';
    const dayName = document.createElement('span');
    dayName.className = 'day-name';
    dayName.textContent = DAY_NAMES[d];
    const dayNum = document.createElement('span');
    dayNum.className = 'day-number';
    dayNum.textContent = dayDate.getDate();
    header.appendChild(dayName);
    header.appendChild(dayNum);
    col.appendChild(header);

    // Body
    const body = document.createElement('div');
    body.className = 'day-body';
    body.dataset.dayIndex = d;
    body.dataset.date = formatDate(dayDate);

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
    bottomLine.style.top = `${24 * HOUR_HEIGHT}px`;
    body.appendChild(bottomLine);

    col.appendChild(body);
    grid.appendChild(col);
  }

  // Attach interaction handlers
  attachDayBodyListeners();
}

function renderEvents() {
  // Clear existing event blocks
  document.querySelectorAll('.event-block').forEach(el => el.remove());

  // Group events by day
  for (let d = 0; d < 7; d++) {
    const dayStart = addDays(currentWeekStart, d);
    const dayEnd = addDays(dayStart, 1);
    const dayBody = document.querySelector(`.day-body[data-day-index="${d}"]`);
    if (!dayBody) continue;

    // Filter events that overlap this day
    const dayEvents = events
      .filter(ev => {
        const evStart = new Date(ev.start_at);
        const evEnd = new Date(ev.end_at);
        return evStart < dayEnd && evEnd > dayStart;
      })
      .map(ev => {
        const evStart = new Date(ev.start_at);
        const evEnd = new Date(ev.end_at);
        return {
          ...ev,
          startMin: minutesInDay(evStart, dayStart),
          endMin: minutesInDay(evEnd, dayStart),
        };
      })
      .filter(ev => ev.endMin > ev.startMin); // Safety: skip zero-height

    // Compute layout
    const laid = computeOverlapLayout(dayEvents);

    // Render each event block
    for (const ev of laid) {
      const block = document.createElement('div');
      block.className = 'event-block';
      block.dataset.eventId = ev.id;

      // Vertical positioning – exact to the minute
      const top = (ev.startMin / TOTAL_MINUTES) * AXIS_HEIGHT;
      const height = ((ev.endMin - ev.startMin) / TOTAL_MINUTES) * AXIS_HEIGHT;
      block.style.top = `${top}px`;
      block.style.height = `${height}px`;

      // Horizontal positioning within the day column
      const widthPercent = 100 / ev.totalColumns;
      const leftPercent = ev.column * widthPercent;
      // Small right margin to see borders between adjacent events
      block.style.left = `calc(${leftPercent}% + 1px)`;
      block.style.width = `calc(${widthPercent}% - 2px)`;

      // Content
      const titleEl = document.createElement('div');
      titleEl.className = 'event-title';
      titleEl.textContent = ev.title;

      const timeEl = document.createElement('div');
      timeEl.className = 'event-time';
      timeEl.textContent = `${formatTimeFromMinutes(ev.startMin)} – ${formatTimeFromMinutes(ev.endMin)}`;

      block.appendChild(titleEl);
      block.appendChild(timeEl);

      // Click to edit
      block.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditModal(ev);
      });

      dayBody.appendChild(block);
    }
  }
}

function updateWeekTitle() {
  const end = addDays(currentWeekStart, 6);
  const startMonth = MONTH_NAMES[currentWeekStart.getMonth()];
  const endMonth = MONTH_NAMES[end.getMonth()];
  let title;
  if (currentWeekStart.getFullYear() !== end.getFullYear()) {
    title = `${startMonth} ${currentWeekStart.getDate()}, ${currentWeekStart.getFullYear()} – ${endMonth} ${end.getDate()}, ${end.getFullYear()}`;
  } else if (currentWeekStart.getMonth() !== end.getMonth()) {
    title = `${startMonth} ${currentWeekStart.getDate()} – ${endMonth} ${end.getDate()}, ${end.getFullYear()}`;
  } else {
    title = `${startMonth} ${currentWeekStart.getDate()} – ${end.getDate()}, ${end.getFullYear()}`;
  }
  document.getElementById('week-title').textContent = title;
}

// ─── Interaction: Click/Drag to Create ───

let dragState = null;

function attachDayBodyListeners() {
  document.querySelectorAll('.day-body').forEach(body => {
    body.addEventListener('mousedown', onDayMouseDown);
    body.addEventListener('mousemove', onDayMouseMove);
    body.addEventListener('mouseup', onDayMouseUp);
    body.addEventListener('mouseleave', onDayMouseLeave);
  });
}

function getMinutesFromMouseEvent(e, dayBody) {
  const rect = dayBody.getBoundingClientRect();
  const y = e.clientY - rect.top;
  const rawMinutes = (y / AXIS_HEIGHT) * TOTAL_MINUTES;
  // Snap to 15-minute intervals
  return Math.max(0, Math.min(TOTAL_MINUTES, Math.round(rawMinutes / 15) * 15));
}

function onDayMouseDown(e) {
  if (e.button !== 0) return;
  // Don't start drag on event blocks
  if (e.target.closest('.event-block')) return;

  const dayBody = e.currentTarget;
  const minutes = getMinutesFromMouseEvent(e, dayBody);

  dragState = {
    dayBody,
    dayIndex: parseInt(dayBody.dataset.dayIndex),
    date: dayBody.dataset.date,
    startMin: minutes,
    currentMin: minutes,
  };

  // Remove any existing selection highlight
  clearSelectionHighlight();

  // Create selection highlight
  const highlight = document.createElement('div');
  highlight.className = 'selection-highlight';
  highlight.id = 'selection-highlight';
  dayBody.appendChild(highlight);
  updateSelectionHighlight();
}

function onDayMouseMove(e) {
  if (!dragState) return;
  if (e.currentTarget !== dragState.dayBody) return;
  dragState.currentMin = getMinutesFromMouseEvent(e, dragState.dayBody);
  updateSelectionHighlight();
}

function onDayMouseUp(e) {
  if (!dragState) return;

  const finalMin = getMinutesFromMouseEvent(e, dragState.dayBody);
  dragState.currentMin = finalMin;

  let startMin = Math.min(dragState.startMin, dragState.currentMin);
  let endMin = Math.max(dragState.startMin, dragState.currentMin);

  // If just a click (no drag), default to 1-hour event
  if (endMin - startMin < 15) {
    endMin = Math.min(startMin + 60, TOTAL_MINUTES);
    if (endMin === startMin) {
      startMin = Math.max(0, endMin - 60);
    }
  }

  clearSelectionHighlight();

  openCreateModal(dragState.date, startMin, endMin);
  dragState = null;
}

function onDayMouseLeave(e) {
  // If dragging but left the day body, we can still finalize on mouseup
  // But let's handle gracefully – just keep the drag state
}

function updateSelectionHighlight() {
  if (!dragState) return;
  const highlight = document.getElementById('selection-highlight');
  if (!highlight) return;

  const startMin = Math.min(dragState.startMin, dragState.currentMin);
  const endMin = Math.max(dragState.startMin, dragState.currentMin);

  const top = (startMin / TOTAL_MINUTES) * AXIS_HEIGHT;
  const height = Math.max(((endMin - startMin) / TOTAL_MINUTES) * AXIS_HEIGHT, 2);
  highlight.style.top = `${top}px`;
  highlight.style.height = `${height}px`;
}

function clearSelectionHighlight() {
  const existing = document.getElementById('selection-highlight');
  if (existing) existing.remove();
}

// Cancel drag on global mouseup if we left the day body
// Use a short delay so the day body's mouseup fires first
document.addEventListener('mouseup', (e) => {
  // Only cancel if the mouseup wasn't on a day-body (those handle it themselves)
  if (dragState && !e.target.closest('.day-body')) {
    clearSelectionHighlight();
    dragState = null;
  }
});

// ─── Modal ───

function openCreateModal(dateStr, startMin, endMin) {
  document.getElementById('modal-title').textContent = 'Create Event';
  document.getElementById('event-id').value = '';
  document.getElementById('event-title-input').value = '';
  document.getElementById('event-date').value = dateStr;

  // Handle end time at midnight (24:00 = end of day)
  const endsAtMidnight = endMin >= TOTAL_MINUTES;

  document.getElementById('event-start-time').value = formatTimeFromMinutes(startMin);

  if (endsAtMidnight) {
    document.getElementById('event-end-time').value = '00:00';
    document.getElementById('event-ends-midnight').checked = true;
  } else {
    document.getElementById('event-end-time').value = formatTimeFromMinutes(endMin);
    document.getElementById('event-ends-midnight').checked = false;
  }

  document.getElementById('ends-midnight-group').style.display = 'block';
  document.getElementById('btn-delete').style.display = 'none';
  document.getElementById('form-error').style.display = 'none';

  showModal();
  document.getElementById('event-title-input').focus();
}

function openEditModal(ev) {
  const start = new Date(ev.start_at);
  const end = new Date(ev.end_at);

  document.getElementById('modal-title').textContent = 'Edit Event';
  document.getElementById('event-id').value = ev.id;
  document.getElementById('event-title-input').value = ev.title;
  document.getElementById('event-date').value = formatDate(start);
  document.getElementById('event-start-time').value = formatTime(start);

  // Check if ends at midnight of next day
  const nextDay = addDays(start, 1);
  nextDay.setHours(0, 0, 0, 0);
  const endsAtMidnight = end.getTime() === nextDay.getTime();

  if (endsAtMidnight) {
    document.getElementById('event-end-time').value = '00:00';
    document.getElementById('event-ends-midnight').checked = true;
  } else {
    document.getElementById('event-end-time').value = formatTime(end);
    document.getElementById('event-ends-midnight').checked = false;
  }

  document.getElementById('ends-midnight-group').style.display = 'block';
  document.getElementById('btn-delete').style.display = 'inline-block';
  document.getElementById('form-error').style.display = 'none';

  showModal();
  document.getElementById('event-title-input').focus();
}

function showModal() {
  document.getElementById('modal-overlay').style.display = 'flex';
}

function hideModal() {
  document.getElementById('modal-overlay').style.display = 'none';
  document.getElementById('form-error').style.display = 'none';
}

function showFormError(msg) {
  const el = document.getElementById('form-error');
  el.textContent = msg;
  el.style.display = 'block';
}

// ─── Form Submit ───

document.getElementById('event-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const id = document.getElementById('event-id').value;
  const title = document.getElementById('event-title-input').value.trim();
  const dateStr = document.getElementById('event-date').value;
  const startTimeStr = document.getElementById('event-start-time').value;
  const endTimeStr = document.getElementById('event-end-time').value;
  const endsMidnight = document.getElementById('event-ends-midnight').checked;

  if (!title) {
    showFormError('Title is required');
    return;
  }

  if (!dateStr || !startTimeStr || !endTimeStr) {
    showFormError('Date and times are required');
    return;
  }

  const startAt = new Date(`${dateStr}T${startTimeStr}:00`);

  let endAt;
  if (endsMidnight) {
    // End at midnight = start of the next day
    endAt = addDays(new Date(`${dateStr}T00:00:00`), 1);
  } else {
    endAt = new Date(`${dateStr}T${endTimeStr}:00`);
  }

  if (isNaN(startAt.getTime()) || isNaN(endAt.getTime())) {
    showFormError('Invalid date or time');
    return;
  }

  if (endAt <= startAt) {
    showFormError('End time must be after start time');
    return;
  }

  const data = {
    title,
    start_at: startAt.toISOString(),
    end_at: endAt.toISOString(),
  };

  try {
    if (id) {
      await updateEvent(id, data);
    } else {
      await createEvent(data);
    }
    hideModal();
    await loadAndRender();
  } catch (err) {
    showFormError(err.message);
  }
});

// Delete button
document.getElementById('btn-delete').addEventListener('click', async () => {
  const id = document.getElementById('event-id').value;
  if (!id) return;

  if (!confirm('Delete this event?')) return;

  try {
    await deleteEvent(id);
    hideModal();
    await loadAndRender();
  } catch (err) {
    showFormError(err.message);
  }
});

// Cancel button
document.getElementById('btn-cancel').addEventListener('click', hideModal);

// Close modal on overlay click
document.getElementById('modal-overlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) hideModal();
});

// Close modal on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideModal();
});

// ─── Navigation ───

document.getElementById('btn-prev').addEventListener('click', () => {
  currentWeekStart = addDays(currentWeekStart, -7);
  renderFull();
});

document.getElementById('btn-today').addEventListener('click', () => {
  currentWeekStart = getMonday(new Date());
  renderFull();
});

document.getElementById('btn-next').addEventListener('click', () => {
  currentWeekStart = addDays(currentWeekStart, 7);
  renderFull();
});

// ─── Render Pipeline ───

async function loadAndRender() {
  events = await fetchEvents(currentWeekStart, weekEndDate());
  renderEvents();
}

async function renderFull() {
  updateWeekTitle();
  renderWeekGrid();
  await loadAndRender();
}

// ─── Scroll to Current Time ───

function scrollToCurrentTime() {
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const scrollTarget = (minutes / TOTAL_MINUTES) * AXIS_HEIGHT - 200; // 200px above current time
  const container = document.querySelector('.calendar-container');
  container.scrollTop = Math.max(0, scrollTarget);
}

// ─── Init ───

async function init() {
  renderTimeGutter();
  await renderFull();
  scrollToCurrentTime();
}

init();
