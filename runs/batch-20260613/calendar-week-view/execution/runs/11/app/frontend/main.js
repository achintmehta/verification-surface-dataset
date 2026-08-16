import './style.css';
import { fetchEvents, createEvent, updateEvent, deleteEvent } from './api.js';
import { layoutDay } from './layout.js';
import {
  startOfWeek, addDays, addWeeks, startOfDay, isSameDay,
  minutesFromMidnight, MINUTES_PER_DAY, dayName, formatTime,
  toLocalInputValue, fromLocalInputValue, pad2
} from './time.js';

// ---- state -----------------------------------------------------------------

let weekStart = startOfWeek(new Date());
let events = []; // events overlapping the current week, as {id,title,start,end:Date}

const grid = document.getElementById('grid');
const timeAxis = document.getElementById('time-axis');
const dayHeaders = document.getElementById('day-headers');
const rangeLabel = document.getElementById('range-label');

// ---- rendering of the static grid scaffolding ------------------------------

function buildTimeAxis() {
  timeAxis.innerHTML = '';
  const hourHeight = 100 / 24; // percent
  for (let h = 0; h <= 24; h++) {
    if (h === 0) continue; // skip top label to avoid clutter; show 1..24
    const label = document.createElement('div');
    label.className = 'hour-label';
    label.style.top = `${(h / 24) * 100}%`;
    label.textContent = `${pad2(h)}:00`;
    timeAxis.appendChild(label);
  }
}

function buildDayColumns() {
  grid.innerHTML = '';
  dayHeaders.innerHTML = '';
  const today = new Date();

  for (let i = 0; i < 7; i++) {
    const date = addDays(weekStart, i);
    const isToday = isSameDay(date, today);

    // header
    const header = document.createElement('div');
    header.className = 'day-header' + (isToday ? ' today' : '');
    const dow = document.createElement('span');
    dow.className = 'dow';
    dow.textContent = dayName(i);
    const dt = document.createElement('span');
    dt.className = 'date';
    dt.textContent = String(date.getDate());
    header.appendChild(dow);
    header.appendChild(dt);
    dayHeaders.appendChild(header);

    // column
    const col = document.createElement('div');
    col.className = 'day-column' + (isToday ? ' today' : '');
    col.dataset.dayIndex = String(i);

    // hour lines
    for (let h = 1; h < 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${(h / 24) * 100}%`;
      col.appendChild(line);
    }

    grid.appendChild(col);
  }
}

function updateRangeLabel() {
  const end = addDays(weekStart, 6);
  const fmt = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const yr = end.getFullYear();
  rangeLabel.textContent = `${fmt(weekStart)} – ${fmt(end)}, ${yr}`;
}

// ---- event rendering --------------------------------------------------------

function renderEvents() {
  // clear existing event nodes
  grid.querySelectorAll('.event').forEach((n) => n.remove());

  const columns = Array.from(grid.querySelectorAll('.day-column'));

  for (let i = 0; i < 7; i++) {
    const dayStart = startOfDay(addDays(weekStart, i));
    const dayEnd = addDays(dayStart, 1);

    // Determine the events that intersect this day, clamped to the day.
    const dayEvents = [];
    for (const ev of events) {
      if (ev.start < dayEnd && ev.end > dayStart) {
        const startMin = Math.max(0, minutesFromMidnight(ev.start, dayStart));
        const endMin = Math.min(MINUTES_PER_DAY, minutesFromMidnight(ev.end, dayStart));
        if (endMin > startMin) {
          dayEvents.push({ ref: ev, start: startMin, end: endMin });
        }
      }
    }

    if (dayEvents.length === 0) continue;

    const layout = layoutDay(dayEvents);
    const col = columns[i];

    for (const item of dayEvents) {
      const place = layout.get(item);
      const node = buildEventNode(item.ref, item.start, item.end, place);
      col.appendChild(node);
    }
  }
}

function buildEventNode(ev, startMin, endMin, place) {
  const node = document.createElement('div');
  node.className = 'event';

  const topPct = (startMin / MINUTES_PER_DAY) * 100;
  const heightPct = ((endMin - startMin) / MINUTES_PER_DAY) * 100;
  node.style.top = `${topPct}%`;
  node.style.height = `${heightPct}%`;

  // Horizontal placement within the day column, with a small gutter.
  const gutter = 2; // px
  const leftPct = place.left * 100;
  const widthPct = place.width * 100;
  node.style.left = `calc(${leftPct}% + ${gutter}px)`;
  node.style.width = `calc(${widthPct}% - ${gutter * 2}px)`;
  node.style.zIndex = String(place.column + 1);

  const title = document.createElement('div');
  title.className = 'event-title';
  title.textContent = ev.title;

  const time = document.createElement('div');
  time.className = 'event-time';
  time.textContent = `${formatTime(ev.start)} – ${formatTime(ev.end)}`;

  node.appendChild(title);
  node.appendChild(time);

  node.addEventListener('mousedown', (e) => e.stopPropagation());
  node.addEventListener('click', (e) => {
    e.stopPropagation();
    openEditForm(ev);
  });

  return node;
}

// ---- data loading -----------------------------------------------------------

async function loadWeek() {
  const start = startOfDay(weekStart);
  const end = addDays(start, 7);
  const rows = await fetchEvents(start.toISOString(), end.toISOString());
  events = rows.map((r) => ({
    id: r.id,
    title: r.title,
    start: new Date(r.start_at),
    end: new Date(r.end_at)
  }));
  renderEvents();
}

function rerenderAll() {
  buildDayColumns();
  updateRangeLabel();
  renderEvents();
}

// ---- navigation -------------------------------------------------------------

document.getElementById('prev').addEventListener('click', async () => {
  weekStart = addWeeks(weekStart, -1);
  rerenderAll();
  await loadWeek();
});
document.getElementById('next').addEventListener('click', async () => {
  weekStart = addWeeks(weekStart, 1);
  rerenderAll();
  await loadWeek();
});
document.getElementById('today').addEventListener('click', async () => {
  weekStart = startOfWeek(new Date());
  rerenderAll();
  await loadWeek();
});

// ---- drag-to-create ---------------------------------------------------------

let dragState = null;

function minutesFromPointer(col, clientY) {
  const rect = col.getBoundingClientRect();
  let ratio = (clientY - rect.top) / rect.height;
  ratio = Math.min(1, Math.max(0, ratio));
  return ratio * MINUTES_PER_DAY;
}

function snap(min, step = 15) {
  return Math.round(min / step) * step;
}

grid.addEventListener('mousedown', (e) => {
  const col = e.target.closest('.day-column');
  if (!col || e.target.classList.contains('event')) return;
  e.preventDefault();
  const dayIndex = Number(col.dataset.dayIndex);
  const startMin = snap(minutesFromPointer(col, e.clientY));

  const sel = document.createElement('div');
  sel.className = 'selection';
  col.appendChild(sel);

  dragState = { col, dayIndex, startMin, currentMin: startMin, sel, moved: false };
  updateSelection();
});

function updateSelection() {
  if (!dragState) return;
  const { startMin, currentMin, sel } = dragState;
  let a = Math.min(startMin, currentMin);
  let b = Math.max(startMin, currentMin);
  sel.style.top = `${(a / MINUTES_PER_DAY) * 100}%`;
  sel.style.height = `${((b - a) / MINUTES_PER_DAY) * 100}%`;
}

window.addEventListener('mousemove', (e) => {
  if (!dragState) return;
  dragState.currentMin = snap(minutesFromPointer(dragState.col, e.clientY));
  if (dragState.currentMin !== dragState.startMin) dragState.moved = true;
  updateSelection();
});

window.addEventListener('mouseup', () => {
  if (!dragState) return;
  const { dayIndex, startMin, currentMin, sel } = dragState;
  sel.remove();

  let a = Math.min(startMin, currentMin);
  let b = Math.max(startMin, currentMin);
  // If it was a plain click (no drag), default to a 1-hour block.
  if (b - a < 15) {
    a = snap(startMin);
    b = Math.min(MINUTES_PER_DAY, a + 60);
    if (b === a) a = b - 60;
  }

  const dayStart = startOfDay(addDays(weekStart, dayIndex));
  const start = new Date(dayStart.getTime() + a * 60000);
  const end = new Date(dayStart.getTime() + b * 60000);

  dragState = null;
  openCreateForm(start, end);
});

// ---- form / modal -----------------------------------------------------------

const backdrop = document.getElementById('modal-backdrop');
const form = document.getElementById('event-form');
const fieldTitle = document.getElementById('field-title');
const fieldStart = document.getElementById('field-start');
const fieldEnd = document.getElementById('field-end');
const formError = document.getElementById('form-error');
const formTitle = document.getElementById('form-title');
const deleteBtn = document.getElementById('form-delete');
const cancelBtn = document.getElementById('form-cancel');

let editingId = null;

function openModal() {
  formError.textContent = '';
  backdrop.hidden = false;
  fieldTitle.focus();
}
function closeModal() {
  backdrop.hidden = true;
  editingId = null;
}

function openCreateForm(start, end) {
  editingId = null;
  formTitle.textContent = 'New event';
  fieldTitle.value = '';
  fieldStart.value = toLocalInputValue(start);
  fieldEnd.value = toLocalInputValue(end);
  deleteBtn.hidden = true;
  openModal();
}

function openEditForm(ev) {
  editingId = ev.id;
  formTitle.textContent = 'Edit event';
  fieldTitle.value = ev.title;
  fieldStart.value = toLocalInputValue(ev.start);
  fieldEnd.value = toLocalInputValue(ev.end);
  deleteBtn.hidden = false;
  openModal();
}

cancelBtn.addEventListener('click', closeModal);
backdrop.addEventListener('mousedown', (e) => {
  if (e.target === backdrop) closeModal();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !backdrop.hidden) closeModal();
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  formError.textContent = '';

  const title = fieldTitle.value.trim();
  if (!title) {
    formError.textContent = 'Title is required.';
    return;
  }
  if (!fieldStart.value || !fieldEnd.value) {
    formError.textContent = 'Start and end are required.';
    return;
  }
  const start = fromLocalInputValue(fieldStart.value);
  const end = fromLocalInputValue(fieldEnd.value);
  if (!(end.getTime() > start.getTime())) {
    formError.textContent = 'End must be after start.';
    return;
  }

  const payload = {
    title,
    start_at: start.toISOString(),
    end_at: end.toISOString()
  };

  try {
    if (editingId == null) {
      await createEvent(payload);
    } else {
      await updateEvent(editingId, payload);
    }
    closeModal();
    await loadWeek();
  } catch (err) {
    formError.textContent = err.message || 'Failed to save event.';
  }
});

deleteBtn.addEventListener('click', async () => {
  if (editingId == null) return;
  try {
    await deleteEvent(editingId);
    closeModal();
    await loadWeek();
  } catch (err) {
    formError.textContent = err.message || 'Failed to delete event.';
  }
});

// ---- boot -------------------------------------------------------------------

buildTimeAxis();
rerenderAll();
loadWeek().catch((err) => console.error('Failed to load events', err));
