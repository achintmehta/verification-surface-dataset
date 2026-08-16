import {
  startOfWeek,
  addDays,
  addWeeks,
  startOfDay,
  isSameDay,
  dayName,
  formatMinutes,
  formatTime,
  toDatetimeLocal,
  dateAtMinutes,
} from './dates.js';
import { layoutDay, clampToDayMinutes, MINUTES_PER_DAY } from './layout.js';
import { fetchEvents, createEvent, updateEvent, deleteEvent } from './api.js';

// --- Constants -------------------------------------------------------------
const HOUR_HEIGHT = 48; // px per hour
const AXIS_HEIGHT = HOUR_HEIGHT * 24; // total px for 00:00 -> 24:00
const PX_PER_MIN = AXIS_HEIGHT / MINUTES_PER_DAY;
const SNAP_MINUTES = 15;

// --- State -----------------------------------------------------------------
const state = {
  weekStart: startOfWeek(new Date()),
  events: [], // raw events from API: {id, title, start_at, end_at}
};

const root = document.getElementById('app');

// --- Data loading ----------------------------------------------------------
async function loadWeek() {
  const start = startOfDay(state.weekStart);
  const end = addDays(start, 7);
  try {
    state.events = await fetchEvents(start.toISOString(), end.toISOString());
  } catch (err) {
    console.error('Failed to load events:', err);
    state.events = [];
  }
  render();
}

// --- Rendering -------------------------------------------------------------
function render() {
  root.innerHTML = '';
  root.appendChild(renderHeader());
  root.appendChild(renderGrid());
}

function renderHeader() {
  const header = el('header', 'cal-header');

  const nav = el('div', 'cal-nav');
  const prev = button('‹ Prev', () => {
    state.weekStart = addWeeks(state.weekStart, -1);
    loadWeek();
  });
  const today = button('Today', () => {
    state.weekStart = startOfWeek(new Date());
    loadWeek();
  });
  const next = button('Next ›', () => {
    state.weekStart = addWeeks(state.weekStart, 1);
    loadWeek();
  });
  nav.append(prev, today, next);

  const weekEnd = addDays(state.weekStart, 6);
  const title = el('div', 'cal-title');
  title.textContent = `${fmtDate(state.weekStart)} – ${fmtDate(weekEnd)}`;

  header.append(nav, title);
  return header;
}

function fmtDate(d) {
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function renderGrid() {
  const wrapper = el('div', 'cal-grid');

  // Column headers row
  const headRow = el('div', 'cal-head-row');
  headRow.appendChild(el('div', 'cal-corner'));
  const today = new Date();
  for (let i = 0; i < 7; i++) {
    const date = addDays(state.weekStart, i);
    const cell = el('div', 'cal-day-head');
    if (isSameDay(date, today)) cell.classList.add('is-today');
    const name = el('div', 'cal-day-name');
    name.textContent = dayName(i);
    const num = el('div', 'cal-day-date');
    num.textContent = date.getDate();
    cell.append(name, num);
    headRow.appendChild(cell);
  }
  wrapper.appendChild(headRow);

  // Scroll body: time gutter + 7 day columns
  const body = el('div', 'cal-body');

  const gutter = el('div', 'cal-gutter');
  gutter.style.height = `${AXIS_HEIGHT}px`;
  for (let h = 0; h <= 24; h++) {
    const label = el('div', 'cal-hour-label');
    label.style.top = `${h * HOUR_HEIGHT}px`;
    if (h < 24) label.textContent = `${String(h).padStart(2, '0')}:00`;
    gutter.appendChild(label);
  }
  body.appendChild(gutter);

  const columns = el('div', 'cal-columns');
  for (let i = 0; i < 7; i++) {
    columns.appendChild(renderDayColumn(i));
  }
  body.appendChild(columns);

  wrapper.appendChild(body);
  return wrapper;
}

function renderDayColumn(dayIndex) {
  const date = addDays(state.weekStart, dayIndex);
  const dayStart = startOfDay(date);
  const dayEnd = addDays(dayStart, 1);
  const dayStartMs = dayStart.getTime();
  const dayEndMs = dayEnd.getTime();

  const col = el('div', 'cal-col');
  col.style.height = `${AXIS_HEIGHT}px`;
  if (isSameDay(date, new Date())) col.classList.add('is-today');

  // Hour grid lines
  for (let h = 0; h <= 24; h++) {
    const line = el('div', 'cal-hour-line');
    line.style.top = `${h * HOUR_HEIGHT}px`;
    col.appendChild(line);
  }

  // Compute clamped minute extents for this day's events.
  const items = [];
  for (const ev of state.events) {
    const startMs = new Date(ev.start_at).getTime();
    const endMs = new Date(ev.end_at).getTime();
    const clamped = clampToDayMinutes(startMs, endMs, dayStartMs, dayEndMs);
    if (!clamped) continue;
    items.push({
      id: ev.id,
      raw: ev,
      startMin: clamped.startMin,
      endMin: clamped.endMin,
    });
  }

  const laid = layoutDay(items);
  for (const item of laid) {
    col.appendChild(renderEventBlock(item, dayStart));
  }

  // Drag-to-create interaction on empty space.
  attachCreateInteraction(col, dayStart);

  return col;
}

function renderEventBlock(item, dayStart) {
  const block = el('div', 'cal-event');
  const top = item.startMin * PX_PER_MIN;
  const height = (item.endMin - item.startMin) * PX_PER_MIN;
  block.style.top = `${top}px`;
  block.style.height = `${Math.max(height, 1)}px`;
  // Horizontal placement as percentages of the day-column width.
  const GAP = 1; // px visual gap between side-by-side columns
  block.style.left = `calc(${item.left * 100}% + ${item.left > 0 ? GAP : 0}px)`;
  block.style.width = `calc(${item.width * 100}% - ${GAP}px)`;

  const titleEl = el('div', 'cal-event-title');
  titleEl.textContent = item.raw.title;
  const timeEl = el('div', 'cal-event-time');
  timeEl.textContent = `${formatMinutes(item.startMin)} – ${formatMinutes(
    item.endMin
  )}`;
  block.append(titleEl, timeEl);

  block.addEventListener('click', (e) => {
    e.stopPropagation();
    openEditForm(item.raw);
  });
  block.addEventListener('mousedown', (e) => e.stopPropagation());

  return block;
}

// --- Create interaction (click / drag) -------------------------------------
function attachCreateInteraction(col, dayStart) {
  let dragging = false;
  let startMin = 0;
  let ghost = null;

  function minutesFromEvent(e) {
    const rect = col.getBoundingClientRect();
    let y = e.clientY - rect.top;
    y = Math.max(0, Math.min(AXIS_HEIGHT, y));
    const min = y / PX_PER_MIN;
    return Math.round(min / SNAP_MINUTES) * SNAP_MINUTES;
  }

  col.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    startMin = minutesFromEvent(e);
    ghost = el('div', 'cal-event cal-ghost');
    col.appendChild(ghost);
    updateGhost(startMin, startMin);
    e.preventDefault();
  });

  function updateGhost(a, b) {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    ghost.style.top = `${lo * PX_PER_MIN}px`;
    ghost.style.height = `${Math.max((hi - lo) * PX_PER_MIN, 2)}px`;
    ghost.style.left = '0';
    ghost.style.width = '100%';
  }

  function onMove(e) {
    if (!dragging) return;
    const cur = minutesFromEvent(e);
    updateGhost(startMin, cur);
  }

  function onUp(e) {
    if (!dragging) return;
    dragging = false;
    const endMinRaw = minutesFromEvent(e);
    if (ghost) {
      ghost.remove();
      ghost = null;
    }
    let lo = Math.min(startMin, endMinRaw);
    let hi = Math.max(startMin, endMinRaw);
    if (hi - lo < SNAP_MINUTES) {
      // Treat as a click: default 1-hour event.
      hi = Math.min(lo + 60, MINUTES_PER_DAY);
      if (hi === lo) lo = Math.max(0, hi - 60);
    }
    openCreateForm(dateAtMinutes(dayStart, lo), dateAtMinutes(dayStart, hi));
  }

  col.addEventListener('mousemove', onMove);
  // Track up on window so a release outside the column still works.
  col.addEventListener('mouseup', onUp);
  window.addEventListener('mouseup', () => {
    if (dragging) {
      dragging = false;
      if (ghost) {
        ghost.remove();
        ghost = null;
      }
    }
  });
}

// --- Forms (modal) ---------------------------------------------------------
function openCreateForm(start, end) {
  showForm({
    mode: 'create',
    title: '',
    start,
    end,
  });
}

function openEditForm(ev) {
  showForm({
    mode: 'edit',
    id: ev.id,
    title: ev.title,
    start: new Date(ev.start_at),
    end: new Date(ev.end_at),
  });
}

function showForm({ mode, id, title, start, end }) {
  closeForm();

  const overlay = el('div', 'modal-overlay');
  overlay.id = 'modal-overlay';
  const modal = el('div', 'modal');

  const h = el('h2', 'modal-title');
  h.textContent = mode === 'create' ? 'New event' : 'Edit event';

  const form = document.createElement('form');
  form.className = 'event-form';

  const titleInput = labeledInput('Title', 'text', title);
  const startInput = labeledInput('Start', 'datetime-local', toDatetimeLocal(start));
  const endInput = labeledInput('End', 'datetime-local', toDatetimeLocal(end));

  const errBox = el('div', 'form-error');

  const actions = el('div', 'form-actions');
  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.className = 'btn btn-primary';
  saveBtn.textContent = 'Save';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', closeForm);

  actions.append(saveBtn, cancelBtn);

  if (mode === 'edit') {
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn btn-danger';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', async () => {
      try {
        await deleteEvent(id);
        closeForm();
        await loadWeek();
      } catch (err) {
        errBox.textContent = err.message;
      }
    });
    actions.appendChild(delBtn);
  }

  form.append(
    titleInput.wrapper,
    startInput.wrapper,
    endInput.wrapper,
    errBox,
    actions
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errBox.textContent = '';
    const titleVal = titleInput.input.value.trim();
    const startVal = startInput.input.value;
    const endVal = endInput.input.value;

    if (!titleVal) {
      errBox.textContent = 'Title must not be empty.';
      return;
    }
    const startDate = new Date(startVal);
    const endDate = new Date(endVal);
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
      errBox.textContent = 'Please provide valid start and end times.';
      return;
    }
    if (!(endDate.getTime() > startDate.getTime())) {
      errBox.textContent = 'End time must be after start time.';
      return;
    }

    const payload = {
      title: titleVal,
      start_at: startDate.toISOString(),
      end_at: endDate.toISOString(),
    };

    try {
      if (mode === 'create') {
        await createEvent(payload);
      } else {
        await updateEvent(id, payload);
      }
      closeForm();
      await loadWeek();
    } catch (err) {
      errBox.textContent = err.message;
    }
  });

  modal.append(h, form);
  overlay.appendChild(modal);
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) closeForm();
  });
  document.body.appendChild(overlay);
  titleInput.input.focus();
}

function closeForm() {
  const existing = document.getElementById('modal-overlay');
  if (existing) existing.remove();
}

function labeledInput(label, type, value) {
  const wrapper = el('label', 'field');
  const span = el('span', 'field-label');
  span.textContent = label;
  const input = document.createElement('input');
  input.type = type;
  input.value = value ?? '';
  if (type === 'datetime-local') input.step = 60;
  wrapper.append(span, input);
  return { wrapper, input };
}

// --- DOM helpers -----------------------------------------------------------
function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function button(label, onClick) {
  const b = document.createElement('button');
  b.className = 'btn';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

// --- Boot ------------------------------------------------------------------
loadWeek();
