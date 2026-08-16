import { fetchEvents, createEvent, updateEvent, deleteEvent } from './api.js';
import { layoutDay } from './layout.js';
import {
  DAY_NAMES,
  startOfWeek,
  addDays,
  isSameDay,
  minutesFromDayStart,
  formatTime,
  minutesToTimeString,
  toLocalInputValue,
  fromLocalInputValue,
  formatRangeLabel,
} from './dates.js';

const HOUR_HEIGHT = 48; // px per hour
const DAY_HEIGHT = HOUR_HEIGHT * 24; // 1152px = full day axis
const MINUTES_PER_DAY = 1440;
const SNAP_MINUTES = 15;

const state = {
  weekStart: startOfWeek(new Date()),
  events: [],
};

const app = document.getElementById('app');

function pxFromMinutes(min) {
  return (min / MINUTES_PER_DAY) * DAY_HEIGHT;
}

function minutesFromOffsetPx(px) {
  return (px / DAY_HEIGHT) * MINUTES_PER_DAY;
}

function snap(min) {
  return Math.round(min / SNAP_MINUTES) * SNAP_MINUTES;
}

// ---- Rendering ----

function render() {
  app.innerHTML = '';
  app.appendChild(renderToolbar());

  const grid = document.createElement('div');
  grid.className = 'calendar';
  grid.appendChild(renderHeaderRow());
  grid.appendChild(renderBody());
  app.appendChild(grid);
}

function renderToolbar() {
  const bar = document.createElement('div');
  bar.className = 'toolbar';

  const nav = document.createElement('div');
  nav.className = 'nav';

  const prev = button('‹ Prev', () => changeWeek(-7));
  const today = button('Today', () => goToday());
  const next = button('Next ›', () => changeWeek(7));
  nav.append(prev, today, next);

  const weekEnd = addDays(state.weekStart, 6);
  const label = document.createElement('div');
  label.className = 'range-label';
  label.textContent = formatRangeLabel(state.weekStart, weekEnd);

  const newBtn = button('+ New event', () => openCreateFormDefault());
  newBtn.className = 'btn primary';

  bar.append(nav, label, newBtn);
  return bar;
}

function button(text, onClick, className = 'btn') {
  const b = document.createElement('button');
  b.className = className;
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

function renderHeaderRow() {
  const row = document.createElement('div');
  row.className = 'header-row';

  const corner = document.createElement('div');
  corner.className = 'time-gutter-head';
  row.appendChild(corner);

  const today = new Date();
  for (let i = 0; i < 7; i++) {
    const day = addDays(state.weekStart, i);
    const cell = document.createElement('div');
    cell.className = 'day-head';
    if (isSameDay(day, today)) cell.classList.add('today');
    const name = document.createElement('div');
    name.className = 'day-name';
    name.textContent = DAY_NAMES[i];
    const date = document.createElement('div');
    date.className = 'day-date';
    date.textContent = day.getDate();
    cell.append(name, date);
    row.appendChild(cell);
  }
  return row;
}

function renderBody() {
  const body = document.createElement('div');
  body.className = 'body-row';

  body.appendChild(renderTimeGutter());

  const today = new Date();
  for (let i = 0; i < 7; i++) {
    const dayStart = addDays(state.weekStart, i);
    const col = renderDayColumn(dayStart, isSameDay(dayStart, today));
    body.appendChild(col);
  }
  return body;
}

function renderTimeGutter() {
  const gutter = document.createElement('div');
  gutter.className = 'time-gutter';
  gutter.style.height = `${DAY_HEIGHT}px`;
  for (let h = 0; h <= 24; h++) {
    const label = document.createElement('div');
    label.className = 'hour-label';
    label.style.top = `${pxFromMinutes(h * 60)}px`;
    label.textContent = h === 24 ? '24:00' : `${String(h).padStart(2, '0')}:00`;
    gutter.appendChild(label);
  }
  return gutter;
}

function renderDayColumn(dayStart, isToday) {
  const col = document.createElement('div');
  col.className = 'day-col';
  if (isToday) col.classList.add('today');
  col.style.height = `${DAY_HEIGHT}px`;

  // Hour grid lines
  for (let h = 0; h <= 24; h++) {
    const line = document.createElement('div');
    line.className = 'hour-line';
    line.style.top = `${pxFromMinutes(h * 60)}px`;
    col.appendChild(line);
  }

  // Events for this day (compute clamped minutes per day)
  const dayEnd = addDays(dayStart, 1);
  const dayEvents = [];
  for (const ev of state.events) {
    const start = new Date(ev.start_at);
    const end = new Date(ev.end_at);
    if (start < dayEnd && end > dayStart) {
      const rawStart = minutesFromDayStart(start, dayStart);
      const rawEnd = minutesFromDayStart(end, dayStart);
      const startMin = Math.max(0, rawStart);
      const endMin = Math.min(MINUTES_PER_DAY, rawEnd);
      if (endMin > startMin) {
        dayEvents.push({ ...ev, startMin, endMin });
      }
    }
  }

  const laid = layoutDay(dayEvents);
  for (const ev of laid) {
    col.appendChild(renderEventBlock(ev));
  }

  attachDragCreate(col, dayStart);
  return col;
}

function renderEventBlock(ev) {
  const block = document.createElement('div');
  block.className = 'event-block';
  const top = pxFromMinutes(ev.startMin);
  const height = pxFromMinutes(ev.endMin - ev.startMin);
  block.style.top = `${top}px`;
  block.style.height = `${Math.max(height, 2)}px`;

  const widthPct = 100 / ev.colCount;
  block.style.left = `calc(${ev.colIndex * widthPct}% + 1px)`;
  // 2px total gap between adjacent blocks; outer edges inset by 1px too.
  block.style.width = `calc(${widthPct}% - 2px)`;

  const title = document.createElement('div');
  title.className = 'event-title';
  title.textContent = ev.title;

  const time = document.createElement('div');
  time.className = 'event-time';
  const start = new Date(ev.start_at);
  const end = new Date(ev.end_at);
  time.textContent = `${formatTime(start)} – ${formatTime(end)}`;

  block.append(title, time);

  block.addEventListener('click', (e) => {
    e.stopPropagation();
    openEditForm(ev);
  });
  // Prevent drag-create starting on an event
  block.addEventListener('mousedown', (e) => e.stopPropagation());

  return block;
}

// ---- Drag to create ----

function attachDragCreate(col, dayStart) {
  let dragging = false;
  let startY = 0;
  let ghost = null;

  function yToMinutes(clientY) {
    const rect = col.getBoundingClientRect();
    let y = clientY - rect.top;
    y = Math.max(0, Math.min(DAY_HEIGHT, y));
    return minutesFromOffsetPx(y);
  }

  col.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    startY = yToMinutes(e.clientY);
    ghost = document.createElement('div');
    ghost.className = 'event-ghost';
    col.appendChild(ghost);
    updateGhost(startY, startY);
    e.preventDefault();
  });

  function updateGhost(a, b) {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    ghost.style.top = `${pxFromMinutes(lo)}px`;
    ghost.style.height = `${pxFromMinutes(Math.max(hi - lo, 2))}px`;
  }

  function onMove(e) {
    if (!dragging) return;
    updateGhost(startY, yToMinutes(e.clientY));
  }

  function onUp(e) {
    if (!dragging) return;
    dragging = false;
    const endY = yToMinutes(e.clientY);
    if (ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost);
    ghost = null;

    let lo = snap(Math.min(startY, endY));
    let hi = snap(Math.max(startY, endY));
    if (hi - lo < SNAP_MINUTES) {
      // a simple click -> default 1 hour slot
      hi = Math.min(MINUTES_PER_DAY, lo + 60);
      if (hi === lo) lo = hi - 60;
    }
    const startDate = new Date(dayStart);
    startDate.setMinutes(lo);
    const endDate = new Date(dayStart);
    endDate.setMinutes(hi);
    openCreateForm(startDate, endDate);
  }

  col.addEventListener('mousemove', onMove);
  // Listen on window for mouseup so releasing outside the column still works
  window.addEventListener('mouseup', onUp);
}

// ---- Forms (modal) ----

function openCreateFormDefault() {
  const start = new Date(state.weekStart);
  start.setHours(9, 0, 0, 0);
  const end = new Date(state.weekStart);
  end.setHours(10, 0, 0, 0);
  openCreateForm(start, end);
}

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

  const heading = document.createElement('h2');
  heading.textContent = opts.mode === 'create' ? 'New event' : 'Edit event';

  const form = document.createElement('form');

  const titleField = labeledInput('Title', 'text', opts.title);
  titleField.input.name = 'title';
  titleField.input.required = true;

  const startField = labeledInput('Start', 'datetime-local', toLocalInputValue(opts.start));
  const endField = labeledInput('End', 'datetime-local', toLocalInputValue(opts.end));

  const error = document.createElement('div');
  error.className = 'form-error';

  const actions = document.createElement('div');
  actions.className = 'form-actions';

  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'btn primary';
  save.textContent = 'Save';

  const cancel = button('Cancel', closeModal);
  cancel.type = 'button';

  actions.append(cancel);
  if (opts.mode === 'edit') {
    const del = button('Delete', async () => {
      try {
        await deleteEvent(opts.id);
        closeModal();
        await refresh();
      } catch (err) {
        error.textContent = err.message;
      }
    }, 'btn danger');
    del.type = 'button';
    actions.append(del);
  }
  actions.append(save);

  form.append(titleField.wrap, startField.wrap, endField.wrap, error, actions);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.textContent = '';
    const title = titleField.input.value.trim();
    const startVal = startField.input.value;
    const endVal = endField.input.value;
    if (!title) {
      error.textContent = 'Title is required.';
      return;
    }
    if (!startVal || !endVal) {
      error.textContent = 'Start and end are required.';
      return;
    }
    const startDate = fromLocalInputValue(startVal);
    const endDate = fromLocalInputValue(endVal);
    if (!(endDate.getTime() > startDate.getTime())) {
      error.textContent = 'End must be after start.';
      return;
    }
    const payload = {
      title,
      start_at: startDate.toISOString(),
      end_at: endDate.toISOString(),
    };
    try {
      if (opts.mode === 'create') {
        await createEvent(payload);
      } else {
        await updateEvent(opts.id, payload);
      }
      closeModal();
      await refresh();
    } catch (err) {
      error.textContent = err.message;
    }
  });

  modal.append(heading, form);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  titleField.input.focus();
}

function labeledInput(labelText, type, value) {
  const wrap = document.createElement('label');
  wrap.className = 'field';
  const span = document.createElement('span');
  span.textContent = labelText;
  const input = document.createElement('input');
  input.type = type;
  input.value = value ?? '';
  wrap.append(span, input);
  return { wrap, input };
}

function closeModal() {
  const existing = document.querySelector('.modal-overlay');
  if (existing) existing.remove();
}

// ---- Data + navigation ----

async function refresh() {
  const start = state.weekStart;
  const end = addDays(state.weekStart, 7);
  try {
    state.events = await fetchEvents(start.toISOString(), end.toISOString());
  } catch (err) {
    console.error('Failed to load events', err);
    state.events = [];
  }
  render();
}

function changeWeek(deltaDays) {
  state.weekStart = addDays(state.weekStart, deltaDays);
  refresh();
}

function goToday() {
  state.weekStart = startOfWeek(new Date());
  refresh();
}

async function maybeSeed() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has('seed')) return;
  const mon = state.weekStart;
  const mk = (dayOffset, sh, sm, eh, em, title) => {
    const s = new Date(mon);
    s.setDate(s.getDate() + dayOffset);
    s.setHours(sh, sm, 0, 0);
    const e = new Date(mon);
    e.setDate(e.getDate() + dayOffset);
    e.setHours(eh, em, 0, 0);
    return { title, start_at: s.toISOString(), end_at: e.toISOString() };
  };
  const seeds = [
    // Mon: three identical 09:00-10:00 -> 3 equal columns
    mk(0, 9, 0, 10, 0, 'Standup A'),
    mk(0, 9, 0, 10, 0, 'Standup B'),
    mk(0, 9, 0, 10, 0, 'Standup C'),
    // Mon: a non-overlapping later event -> full width
    mk(0, 14, 0, 15, 30, 'Solo afternoon'),
    // Tue: partial chain
    mk(1, 9, 0, 11, 0, 'Chain 1'),
    mk(1, 10, 0, 12, 0, 'Chain 2'),
    mk(1, 11, 30, 13, 0, 'Chain 3'),
    // Wed: event ending at 24:00
    mk(2, 22, 0, 24, 0, 'Late night'),
    // Wed: 09:15-10:45 precise
    mk(2, 9, 15, 10, 45, 'Precise 9:15'),
  ];
  for (const s of seeds) {
    try { await createEvent(s); } catch (e) { /* ignore */ }
  }
  // strip the param so reload doesn't double-seed
  window.history.replaceState({}, '', window.location.pathname);
}

render();
maybeSeed().then(refresh);
