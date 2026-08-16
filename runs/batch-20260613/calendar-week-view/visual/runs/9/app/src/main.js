import './styles.css';

const HOUR_HEIGHT = 64;
const DAY_MINUTES = 24 * 60;
const PX_PER_MINUTE = HOUR_HEIGHT / 60;
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const state = {
  weekStart: startOfWeek(new Date()),
  events: [],
  selection: null,
  drag: null,
  editingEvent: null
};

const app = document.querySelector('#app');
app.innerHTML = `
  <div class="shell">
    <header class="toolbar">
      <div>
        <h1>Week Calendar</h1>
        <div id="weekLabel" class="week-label"></div>
      </div>
      <nav class="nav-actions" aria-label="Week navigation">
        <button id="prevWeek" type="button">‹ Previous</button>
        <button id="todayWeek" type="button">Today</button>
        <button id="nextWeek" type="button">Next ›</button>
      </nav>
    </header>

    <main class="calendar-wrap">
      <div class="calendar" id="calendar">
        <div class="corner"></div>
        <div id="dayHeaders" class="day-headers"></div>
        <div id="timeAxis" class="time-axis"></div>
        <div id="weekGrid" class="week-grid"></div>
      </div>
    </main>
  </div>

  <div class="modal-backdrop hidden" id="modalBackdrop" role="presentation">
    <form class="event-form" id="eventForm" role="dialog" aria-modal="true" aria-labelledby="formTitle">
      <h2 id="formTitle">Create event</h2>
      <label>
        Title
        <input id="titleInput" name="title" autocomplete="off" required />
      </label>
      <label>
        Start
        <input id="startInput" name="start" type="datetime-local" step="60" required />
      </label>
      <label>
        End
        <input id="endInput" name="end" type="datetime-local" step="60" required />
      </label>
      <p id="formError" class="form-error" aria-live="polite"></p>
      <div class="form-actions">
        <button id="deleteButton" class="danger hidden" type="button">Delete</button>
        <span class="spacer"></span>
        <button id="cancelButton" type="button">Cancel</button>
        <button type="submit">Save</button>
      </div>
    </form>
  </div>
`;

const els = {
  weekLabel: document.querySelector('#weekLabel'),
  dayHeaders: document.querySelector('#dayHeaders'),
  timeAxis: document.querySelector('#timeAxis'),
  weekGrid: document.querySelector('#weekGrid'),
  prevWeek: document.querySelector('#prevWeek'),
  todayWeek: document.querySelector('#todayWeek'),
  nextWeek: document.querySelector('#nextWeek'),
  modalBackdrop: document.querySelector('#modalBackdrop'),
  eventForm: document.querySelector('#eventForm'),
  formTitle: document.querySelector('#formTitle'),
  titleInput: document.querySelector('#titleInput'),
  startInput: document.querySelector('#startInput'),
  endInput: document.querySelector('#endInput'),
  formError: document.querySelector('#formError'),
  deleteButton: document.querySelector('#deleteButton'),
  cancelButton: document.querySelector('#cancelButton')
};

buildStaticGrid();
attachListeners();
loadWeek();

function buildStaticGrid() {
  els.timeAxis.innerHTML = '';
  for (let hour = 0; hour <= 24; hour += 1) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = `${hour * HOUR_HEIGHT}px`;
    label.textContent = `${String(hour).padStart(2, '0')}:00`;
    els.timeAxis.appendChild(label);
  }
}

function attachListeners() {
  els.prevWeek.addEventListener('click', () => changeWeek(-7));
  els.todayWeek.addEventListener('click', () => {
    state.weekStart = startOfWeek(new Date());
    loadWeek();
  });
  els.nextWeek.addEventListener('click', () => changeWeek(7));

  els.cancelButton.addEventListener('click', closeModal);
  els.modalBackdrop.addEventListener('mousedown', (event) => {
    if (event.target === els.modalBackdrop) closeModal();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !els.modalBackdrop.classList.contains('hidden')) closeModal();
  });
  els.eventForm.addEventListener('submit', saveForm);
  els.deleteButton.addEventListener('click', deleteCurrentEvent);
}

function changeWeek(days) {
  state.weekStart = addDays(state.weekStart, days);
  loadWeek();
}

async function loadWeek() {
  const start = state.weekStart;
  const end = addDays(start, 7);
  els.weekLabel.textContent = `${formatLongDate(start)} – ${formatLongDate(addDays(end, -1))}`;
  try {
    const response = await fetch(`/api/events?start=${encodeURIComponent(toInputValue(start))}&end=${encodeURIComponent(toInputValue(end))}`);
    if (!response.ok) throw new Error(await getError(response));
    state.events = await response.json();
    renderWeek();
  } catch (error) {
    console.error(error);
    state.events = [];
    renderWeek();
    alert(`Could not load events: ${error.message}`);
  }
}

function renderWeek() {
  renderHeaders();
  els.weekGrid.innerHTML = '';
  const todayKey = dateKey(new Date());

  for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
    const day = addDays(state.weekStart, dayIndex);
    const column = document.createElement('section');
    column.className = 'day-column';
    column.dataset.dayIndex = String(dayIndex);
    column.setAttribute('aria-label', `${DAY_NAMES[dayIndex]} ${formatLongDate(day)}`);
    if (dateKey(day) === todayKey) column.classList.add('today');

    const lines = document.createElement('div');
    lines.className = 'hour-lines';
    for (let hour = 0; hour < 24; hour += 1) {
      const line = document.createElement('div');
      line.className = 'hour-row';
      lines.appendChild(line);
    }
    column.appendChild(lines);

    const eventsLayer = document.createElement('div');
    eventsLayer.className = 'events-layer';
    eventsLayer.addEventListener('mousedown', startSelection);
    column.appendChild(eventsLayer);
    els.weekGrid.appendChild(column);

    const dayEvents = getRenderableEventsForDay(day, dayIndex);
    for (const positioned of layoutDayEvents(dayEvents)) {
      eventsLayer.appendChild(renderEventBlock(positioned));
    }
  }
}

function renderHeaders() {
  els.dayHeaders.innerHTML = '';
  const todayKey = dateKey(new Date());
  for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
    const day = addDays(state.weekStart, dayIndex);
    const header = document.createElement('div');
    header.className = 'day-header';
    if (dateKey(day) === todayKey) header.classList.add('today');
    header.innerHTML = `<strong>${DAY_NAMES[dayIndex]}</strong><span>${day.getDate()}</span>`;
    els.dayHeaders.appendChild(header);
  }
}

function getRenderableEventsForDay(day, dayIndex) {
  const dayStart = startOfDay(day);
  const dayEnd = addDays(dayStart, 1);
  return state.events
    .map((event) => {
      const start = parseLocalDate(event.start_at);
      const end = parseLocalDate(event.end_at);
      if (!(start < dayEnd && end > dayStart)) return null;
      const clampedStart = maxDate(start, dayStart);
      const clampedEnd = minDate(end, dayEnd);
      const startMinute = minutesSince(dayStart, clampedStart);
      const endMinute = minutesSince(dayStart, clampedEnd);
      if (endMinute <= startMinute) return null;
      return {
        ...event,
        originalStart: start,
        originalEnd: end,
        dayIndex,
        startMinute,
        endMinute
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute || a.id - b.id);
}

function layoutDayEvents(events) {
  const laidOut = [];
  let cluster = [];
  let clusterEnd = -1;

  const flushCluster = () => {
    if (cluster.length === 0) return;
    laidOut.push(...assignColumns(cluster));
    cluster = [];
    clusterEnd = -1;
  };

  for (const event of events) {
    if (cluster.length === 0 || event.startMinute < clusterEnd) {
      cluster.push(event);
      clusterEnd = Math.max(clusterEnd, event.endMinute);
    } else {
      flushCluster();
      cluster.push(event);
      clusterEnd = event.endMinute;
    }
  }
  flushCluster();
  return laidOut;
}

function assignColumns(cluster) {
  const columns = [];
  const assigned = [...cluster]
    .sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute || a.id - b.id)
    .map((event) => {
      let columnIndex = columns.findIndex((endMinute) => endMinute <= event.startMinute);
      if (columnIndex === -1) {
        columnIndex = columns.length;
        columns.push(event.endMinute);
      } else {
        columns[columnIndex] = event.endMinute;
      }
      return { ...event, columnIndex };
    });
  const columnCount = Math.max(1, columns.length);
  return assigned.map((event) => ({
    ...event,
    columnCount,
    top: event.startMinute * PX_PER_MINUTE,
    height: Math.max(1, (event.endMinute - event.startMinute) * PX_PER_MINUTE),
    leftPercent: (event.columnIndex / columnCount) * 100,
    widthPercent: 100 / columnCount
  }));
}

function renderEventBlock(event) {
  const block = document.createElement('button');
  block.type = 'button';
  block.className = 'event-block';
  block.style.top = `${event.top}px`;
  block.style.height = `${event.height}px`;
  block.style.left = `${event.leftPercent}%`;
  block.style.width = `${event.widthPercent}%`;
  block.dataset.eventId = String(event.id);
  block.title = `${event.title}\n${formatTime(event.originalStart)}–${formatTime(event.originalEnd)}`;
  block.innerHTML = `
    <span class="event-title"></span>
    <span class="event-time">${formatTime(event.originalStart)}–${formatTime(event.originalEnd)}</span>
  `;
  block.querySelector('.event-title').textContent = event.title;
  block.addEventListener('mousedown', (e) => e.stopPropagation());
  block.addEventListener('click', (e) => {
    e.stopPropagation();
    const original = state.events.find((item) => String(item.id) === String(event.id));
    if (original) openEditForm(original);
  });
  return block;
}

function startSelection(event) {
  if (event.button !== 0 || event.target.closest('.event-block')) return;
  const layer = event.currentTarget;
  const dayIndex = Number(layer.closest('.day-column').dataset.dayIndex);
  const startMinute = minuteFromPointer(event, layer);
  const selectionEl = document.createElement('div');
  selectionEl.className = 'selection-block';
  layer.appendChild(selectionEl);

  state.drag = { layer, dayIndex, anchor: startMinute, current: startMinute, selectionEl, moved: false };
  updateSelectionElement();

  window.addEventListener('mousemove', continueSelection);
  window.addEventListener('mouseup', finishSelection, { once: true });
  event.preventDefault();
}

function continueSelection(event) {
  if (!state.drag) return;
  state.drag.current = minuteFromPointer(event, state.drag.layer);
  state.drag.moved = state.drag.moved || Math.abs(state.drag.current - state.drag.anchor) > 2;
  updateSelectionElement();
}

function finishSelection() {
  window.removeEventListener('mousemove', continueSelection);
  if (!state.drag) return;
  const { anchor, current, dayIndex, selectionEl, moved } = state.drag;
  selectionEl.remove();
  state.drag = null;

  let startMinute = Math.min(anchor, current);
  let endMinute = Math.max(anchor, current);
  if (!moved || endMinute === startMinute) {
    startMinute = anchor;
    endMinute = Math.min(DAY_MINUTES, anchor + 30);
    if (endMinute === startMinute) startMinute = Math.max(0, endMinute - 30);
  }
  endMinute = Math.max(startMinute + 1, endMinute);

  const day = addDays(state.weekStart, dayIndex);
  openCreateForm(addMinutes(startOfDay(day), startMinute), addMinutes(startOfDay(day), endMinute));
}

function updateSelectionElement() {
  const { anchor, current, selectionEl } = state.drag;
  const start = Math.min(anchor, current);
  const end = Math.max(anchor, current);
  selectionEl.style.top = `${start * PX_PER_MINUTE}px`;
  selectionEl.style.height = `${Math.max(1, (end - start) * PX_PER_MINUTE)}px`;
}

function minuteFromPointer(event, layer) {
  const rect = layer.getBoundingClientRect();
  const y = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
  return Math.max(0, Math.min(DAY_MINUTES, Math.round(y / PX_PER_MINUTE)));
}

function openCreateForm(start, end) {
  state.editingEvent = null;
  els.formTitle.textContent = 'Create event';
  els.titleInput.value = '';
  els.startInput.value = toInputValue(start);
  els.endInput.value = toInputValue(end);
  els.deleteButton.classList.add('hidden');
  showModal();
}

function openEditForm(event) {
  state.editingEvent = event;
  els.formTitle.textContent = 'Edit event';
  els.titleInput.value = event.title;
  els.startInput.value = toInputValue(parseLocalDate(event.start_at));
  els.endInput.value = toInputValue(parseLocalDate(event.end_at));
  els.deleteButton.classList.remove('hidden');
  showModal();
}

function showModal() {
  els.formError.textContent = '';
  els.modalBackdrop.classList.remove('hidden');
  setTimeout(() => els.titleInput.focus(), 0);
}

function closeModal() {
  els.modalBackdrop.classList.add('hidden');
  state.editingEvent = null;
}

async function saveForm(event) {
  event.preventDefault();
  els.formError.textContent = '';
  const payload = {
    title: els.titleInput.value.trim(),
    start_at: els.startInput.value,
    end_at: els.endInput.value
  };
  if (!payload.title) return (els.formError.textContent = 'Title is required.');
  if (new Date(payload.start_at) >= new Date(payload.end_at)) return (els.formError.textContent = 'End must be after start.');

  const editing = state.editingEvent;
  const url = editing ? `/api/events/${editing.id}` : '/api/events';
  const method = editing ? 'PUT' : 'POST';
  try {
    const response = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error(await getError(response));
    closeModal();
    await loadWeek();
  } catch (error) {
    els.formError.textContent = error.message;
  }
}

async function deleteCurrentEvent() {
  if (!state.editingEvent || !confirm('Delete this event?')) return;
  try {
    const response = await fetch(`/api/events/${state.editingEvent.id}`, { method: 'DELETE' });
    if (!response.ok) throw new Error(await getError(response));
    closeModal();
    await loadWeek();
  } catch (error) {
    els.formError.textContent = error.message;
  }
}

async function getError(response) {
  try {
    const body = await response.json();
    return body.error || response.statusText;
  } catch {
    return response.statusText;
  }
}

function startOfWeek(date) {
  const result = startOfDay(date);
  const day = result.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  result.setDate(result.getDate() + diff);
  return result;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function addMinutes(date, minutes) {
  const result = new Date(date);
  result.setMinutes(result.getMinutes() + minutes);
  return result;
}

function minutesSince(start, date) {
  return Math.round((date.getTime() - start.getTime()) / 60000);
}

function maxDate(a, b) {
  return a > b ? a : b;
}

function minDate(a, b) {
  return a < b ? a : b;
}

function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function toInputValue(date) {
  return `${dateKey(date)}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function parseLocalDate(value) {
  if (value instanceof Date) return value;
  const text = String(value).replace(' ', 'T').slice(0, 19);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (match) {
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6] || 0));
  }
  return new Date(value);
}

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatLongDate(date) {
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}
