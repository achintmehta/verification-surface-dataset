import './styles.css';

const HOUR_HEIGHT = 64;
const DAY_MINUTES = 24 * 60;
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const SHORT_DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

let currentWeekStart = startOfWeek(new Date());
let events = [];
let selection = null;
let selectionEl = null;

const app = document.querySelector('#app');
app.innerHTML = `
  <div class="app-shell">
    <header class="toolbar">
      <h1>Week Calendar</h1>
      <div class="toolbar-actions">
        <button id="prevWeek" type="button">Previous</button>
        <button id="today" type="button">Today</button>
        <button id="nextWeek" type="button">Next</button>
      </div>
      <div id="weekLabel" class="week-label"></div>
    </header>
    <main class="calendar-wrap">
      <section id="calendar" class="calendar" aria-label="Week calendar"></section>
    </main>
  </div>
`;

const calendar = document.querySelector('#calendar');
const weekLabel = document.querySelector('#weekLabel');
document.querySelector('#prevWeek').addEventListener('click', () => changeWeek(-1));
document.querySelector('#today').addEventListener('click', () => { currentWeekStart = startOfWeek(new Date()); loadAndRender(); });
document.querySelector('#nextWeek').addEventListener('click', () => changeWeek(1));

loadAndRender();

function changeWeek(delta) {
  currentWeekStart = addDays(currentWeekStart, delta * 7);
  loadAndRender();
}

async function loadAndRender() {
  const start = currentWeekStart;
  const end = addDays(start, 7);
  weekLabel.textContent = `${formatMonthDay(start)} – ${formatMonthDay(addDays(start, 6))}, ${addDays(start, 6).getFullYear()}`;
  try {
    const response = await fetch(`/api/events?start=${encodeURIComponent(toLocalIso(start))}&end=${encodeURIComponent(toLocalIso(end))}`);
    if (!response.ok) throw new Error(await response.text());
    events = await response.json();
  } catch (error) {
    console.error(error);
    events = [];
  }
  renderCalendar();
}

function renderCalendar() {
  calendar.innerHTML = '';
  const todayKey = dateKey(new Date());

  const corner = document.createElement('div');
  corner.className = 'corner';
  corner.textContent = 'Time';
  calendar.appendChild(corner);

  for (let i = 0; i < 7; i += 1) {
    const day = addDays(currentWeekStart, i);
    const header = document.createElement('div');
    header.className = `day-header${dateKey(day) === todayKey ? ' today' : ''}`;
    header.innerHTML = `<div class="day-name">${DAY_NAMES[i]}</div><div class="day-date">${day.getDate()}</div>`;
    calendar.appendChild(header);
  }

  const axis = document.createElement('div');
  axis.className = 'time-axis';
  for (let hour = 0; hour <= 24; hour += 1) {
    const label = document.createElement('div');
    label.className = `time-label${hour === 0 ? ' midnight' : ''}`;
    label.style.top = `${hour * HOUR_HEIGHT}px`;
    label.textContent = `${String(hour).padStart(2, '0')}:00`;
    axis.appendChild(label);
  }
  calendar.appendChild(axis);

  const segmentsByDay = makeSegmentsByDay(events, currentWeekStart);
  for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
    const day = addDays(currentWeekStart, dayIndex);
    const column = document.createElement('div');
    column.className = `day-column${dateKey(day) === todayKey ? ' today' : ''}`;
    column.dataset.dayIndex = String(dayIndex);
    column.addEventListener('pointerdown', onColumnPointerDown);
    renderEventsForDay(column, segmentsByDay[dayIndex] || []);
    calendar.appendChild(column);
  }
}

function renderEventsForDay(columnEl, daySegments) {
  const laidOut = layoutDayEvents(daySegments);
  for (const item of laidOut) {
    const eventEl = document.createElement('button');
    eventEl.type = 'button';
    eventEl.className = 'event';
    eventEl.style.top = `${minutesToPixels(item.startMinute)}px`;
    eventEl.style.height = `${Math.max(1, minutesToPixels(item.endMinute - item.startMinute))}px`;
    eventEl.style.left = `calc(${item.leftPct}% + 2px)`;
    eventEl.style.width = `calc(${item.widthPct}% - 4px)`;
    eventEl.title = `${item.title}: ${formatTime(parseLocalDate(item.start_at))}–${formatTime(parseLocalDate(item.end_at))}`;
    eventEl.innerHTML = `<div class="event-title"></div><div class="event-time"></div>`;
    eventEl.querySelector('.event-title').textContent = item.title;
    eventEl.querySelector('.event-time').textContent = `${formatTime(parseLocalDate(item.start_at))}–${formatTime(parseLocalDate(item.end_at))}`;
    eventEl.addEventListener('pointerdown', (e) => e.stopPropagation());
    eventEl.addEventListener('click', (e) => {
      e.stopPropagation();
      openEventModal(item);
    });
    columnEl.appendChild(eventEl);
  }
}

function makeSegmentsByDay(sourceEvents, weekStart) {
  const byDay = Array.from({ length: 7 }, () => []);
  for (const event of sourceEvents) {
    const eventStart = parseLocalDate(event.start_at);
    const eventEnd = parseLocalDate(event.end_at);
    for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
      const dayStart = addDays(weekStart, dayIndex);
      const dayEnd = addDays(dayStart, 1);
      if (eventStart < dayEnd && eventEnd > dayStart) {
        const visibleStart = eventStart > dayStart ? eventStart : dayStart;
        const visibleEnd = eventEnd < dayEnd ? eventEnd : dayEnd;
        byDay[dayIndex].push({
          ...event,
          _segmentKey: `${event.id}-${dayIndex}`,
          _visibleStart: visibleStart,
          _visibleEnd: visibleEnd,
          startMinute: minutesFromDayStart(visibleStart, dayStart),
          endMinute: minutesFromDayStart(visibleEnd, dayStart)
        });
      }
    }
  }
  return byDay;
}

function layoutDayEvents(dayEvents) {
  const sorted = [...dayEvents]
    .filter(e => e.endMinute > e.startMinute)
    .sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute || Number(a.id) - Number(b.id));
  const output = [];
  let i = 0;
  while (i < sorted.length) {
    const cluster = [sorted[i]];
    let clusterEnd = sorted[i].endMinute;
    i += 1;
    while (i < sorted.length && sorted[i].startMinute < clusterEnd) {
      cluster.push(sorted[i]);
      clusterEnd = Math.max(clusterEnd, sorted[i].endMinute);
      i += 1;
    }

    const columnEnds = [];
    const assignments = [];
    for (const event of cluster) {
      let columnIndex = columnEnds.findIndex(end => end <= event.startMinute);
      if (columnIndex === -1) {
        columnIndex = columnEnds.length;
        columnEnds.push(event.endMinute);
      } else {
        columnEnds[columnIndex] = event.endMinute;
      }
      assignments.push({ event, columnIndex });
    }

    const columnCount = Math.max(1, columnEnds.length);
    for (const { event, columnIndex } of assignments) {
      output.push({
        ...event,
        columnIndex,
        columnCount,
        leftPct: (columnIndex * 100) / columnCount,
        widthPct: 100 / columnCount
      });
    }
  }
  return output;
}

function onColumnPointerDown(e) {
  if (e.button !== 0 || e.target !== e.currentTarget) return;
  const column = e.currentTarget;
  const dayIndex = Number(column.dataset.dayIndex);
  const rect = column.getBoundingClientRect();
  const startMinute = yToMinute(e.clientY - rect.top);
  selection = { column, dayIndex, anchor: startMinute, current: startMinute, moved: false };

  selectionEl = document.createElement('div');
  selectionEl.className = 'selection';
  column.appendChild(selectionEl);
  updateSelectionElement();

  column.setPointerCapture(e.pointerId);
  column.classList.add('selecting');
  column.addEventListener('pointermove', onColumnPointerMove);
  column.addEventListener('pointerup', onColumnPointerUp, { once: true });
  column.addEventListener('pointercancel', cancelSelection, { once: true });
}

function onColumnPointerMove(e) {
  if (!selection) return;
  const rect = selection.column.getBoundingClientRect();
  const minute = yToMinute(e.clientY - rect.top);
  if (Math.abs(minute - selection.anchor) >= 1) selection.moved = true;
  selection.current = minute;
  updateSelectionElement();
}

function onColumnPointerUp(e) {
  if (!selection) return;
  const { column, dayIndex, anchor, current } = selection;
  cleanupSelectionListeners(column);
  let startMinute = Math.min(anchor, current);
  let endMinute = Math.max(anchor, current);
  if (endMinute === startMinute) endMinute = Math.min(DAY_MINUTES, startMinute + 30);
  if (endMinute === startMinute) startMinute = Math.max(0, endMinute - 30);
  removeSelectionElement();
  selection = null;

  const dayStart = addDays(currentWeekStart, dayIndex);
  openEventModal({
    title: '',
    start_at: toLocalIso(addMinutes(dayStart, startMinute)),
    end_at: toLocalIso(addMinutes(dayStart, endMinute))
  });
}

function cancelSelection() {
  if (!selection) return;
  cleanupSelectionListeners(selection.column);
  removeSelectionElement();
  selection = null;
}

function cleanupSelectionListeners(column) {
  column.classList.remove('selecting');
  column.removeEventListener('pointermove', onColumnPointerMove);
}

function updateSelectionElement() {
  if (!selectionEl || !selection) return;
  const start = Math.min(selection.anchor, selection.current);
  const end = Math.max(selection.anchor, selection.current);
  selectionEl.style.top = `${minutesToPixels(start)}px`;
  selectionEl.style.height = `${Math.max(2, minutesToPixels(end - start))}px`;
}

function removeSelectionElement() {
  if (selectionEl) selectionEl.remove();
  selectionEl = null;
}

function openEventModal(event) {
  const isEdit = Boolean(event.id);
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <form class="modal">
      <h2>${isEdit ? 'Edit event' : 'Create event'}</h2>
      <div class="form-row">
        <label for="eventTitle">Title</label>
        <input id="eventTitle" name="title" maxlength="200" required />
      </div>
      <div class="form-row">
        <label for="eventStart">Start</label>
        <input id="eventStart" name="start" type="datetime-local" step="60" required />
      </div>
      <div class="form-row">
        <label for="eventEnd">End</label>
        <input id="eventEnd" name="end" type="datetime-local" step="60" required />
      </div>
      <div class="error" role="alert"></div>
      <div class="modal-actions">
        <div>${isEdit ? '<button type="button" class="danger" id="deleteEvent">Delete</button>' : ''}</div>
        <div class="modal-actions-right">
          <button type="button" id="cancelModal">Cancel</button>
          <button type="submit" class="primary">Save</button>
        </div>
      </div>
    </form>
  `;
  document.body.appendChild(backdrop);

  const form = backdrop.querySelector('form');
  const titleInput = backdrop.querySelector('#eventTitle');
  const startInput = backdrop.querySelector('#eventStart');
  const endInput = backdrop.querySelector('#eventEnd');
  const errorEl = backdrop.querySelector('.error');
  titleInput.value = event.title || '';
  startInput.value = toDateTimeLocalValue(parseLocalDate(event.start_at));
  endInput.value = toDateTimeLocalValue(parseLocalDate(event.end_at));
  titleInput.focus();

  function close() { backdrop.remove(); }
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  backdrop.querySelector('#cancelModal').addEventListener('click', close);
  window.addEventListener('keydown', function onKey(e) {
    if (!document.body.contains(backdrop)) return window.removeEventListener('keydown', onKey);
    if (e.key === 'Escape') close();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.textContent = '';
    const payload = {
      title: titleInput.value.trim(),
      start_at: startInput.value,
      end_at: endInput.value
    };
    if (!payload.title) return errorEl.textContent = 'Title is required.';
    if (!payload.start_at || !payload.end_at || new Date(payload.end_at) <= new Date(payload.start_at)) {
      return errorEl.textContent = 'End must be after start.';
    }
    try {
      const response = await fetch(isEdit ? `/api/events/${event.id}` : '/api/events', {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Unable to save event.');
      }
      close();
      await loadAndRender();
    } catch (error) {
      errorEl.textContent = error.message;
    }
  });

  const deleteBtn = backdrop.querySelector('#deleteEvent');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', async () => {
      if (!confirm('Delete this event?')) return;
      try {
        const response = await fetch(`/api/events/${event.id}`, { method: 'DELETE' });
        if (!response.ok) throw new Error('Unable to delete event.');
        close();
        await loadAndRender();
      } catch (error) {
        errorEl.textContent = error.message;
      }
    });
  }
}

function startOfWeek(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds());
}

function addMinutes(date, minutes) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes() + minutes, date.getSeconds(), date.getMilliseconds());
}

function parseLocalDate(value) {
  if (value instanceof Date) return new Date(value);
  const text = String(value || '');
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (match) {
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6] || 0));
  }
  return new Date(value);
}

function toLocalIso(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function toDateTimeLocalValue(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function pad(n) { return String(n).padStart(2, '0'); }
function dateKey(date) { return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`; }
function formatMonthDay(date) { return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
function formatTime(date) { return `${pad(date.getHours())}:${pad(date.getMinutes())}`; }
function minutesToPixels(minutes) { return (minutes / 60) * HOUR_HEIGHT; }
function yToMinute(y) { return Math.max(0, Math.min(DAY_MINUTES, Math.round((y / HOUR_HEIGHT) * 60))); }
function minutesFromDayStart(date, dayStart) {
  return Math.max(0, Math.min(DAY_MINUTES, Math.round((date.getTime() - dayStart.getTime()) / 60000)));
}
