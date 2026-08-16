import './style.css';
import { computeLayout } from './layout.js';
import * as api from './api.js';
import {
  DAY_NAMES,
  startOfWeek,
  addDays,
  addWeeks,
  isSameDay,
  minutesFromMidnight,
  formatRange,
  toDatetimeLocal,
  dateAtMinutes,
  formatMonthRange,
} from './dates.js';

const HOUR_HEIGHT = 48; // must match --hour-height in CSS
const AXIS_MINUTES = 1440;
const PX_PER_MIN = HOUR_HEIGHT / 60;
const SNAP_MIN = 15; // snap drag selection to 15 minutes

const app = document.getElementById('app');

const state = {
  weekStart: startOfWeek(new Date()),
  events: [], // raw events from API
};

function fmtDateInput(d) {
  return toDatetimeLocal(d);
}

// ---- Rendering ----------------------------------------------------------

function render() {
  app.innerHTML = '';
  app.appendChild(renderToolbar());
  app.appendChild(renderCalendar());
}

function renderToolbar() {
  const bar = el('div', 'toolbar');
  const title = el('h1', '', 'Week Calendar');

  const nav = el('div', 'nav-group');
  const prev = button('‹ Prev', 'btn', () => {
    state.weekStart = addWeeks(state.weekStart, -1);
    loadAndRender();
  });
  const today = button('Today', 'btn', () => {
    state.weekStart = startOfWeek(new Date());
    loadAndRender();
  });
  const next = button('Next ›', 'btn', () => {
    state.weekStart = addWeeks(state.weekStart, 1);
    loadAndRender();
  });
  nav.append(prev, today, next);

  const newBtn = button('+ New event', 'btn primary', () => {
    const start = new Date(state.weekStart);
    start.setHours(9, 0, 0, 0);
    const end = new Date(start);
    end.setHours(10, 0, 0, 0);
    openCreateModal(start, end);
  });

  const range = el('div', 'range', formatMonthRange(state.weekStart));

  bar.append(title, nav, newBtn, range);
  return bar;
}

function renderCalendar() {
  const calendar = el('div', 'calendar');
  const grid = el('div', 'cal-grid');

  const days = [];
  for (let i = 0; i < 7; i++) days.push(addDays(state.weekStart, i));
  const todayDate = new Date();

  // Headers row
  const headers = el('div', 'day-headers');
  headers.appendChild(el('div', 'corner'));
  for (const d of days) {
    const isToday = isSameDay(d, todayDate);
    const h = el('div', 'day-header' + (isToday ? ' today' : ''));
    h.appendChild(el('div', 'dow', DAY_NAMES[(d.getDay() + 6) % 7]));
    h.appendChild(el('div', 'date', String(d.getDate())));
    headers.appendChild(h);
  }
  grid.appendChild(headers);

  // Time axis
  const axis = el('div', 'axis');
  for (let h = 0; h < 24; h++) {
    const cell = el('div', 'axis-hour');
    const label = el('span', '', `${String(h).padStart(2, '0')}:00`);
    cell.appendChild(label);
    axis.appendChild(cell);
  }
  grid.appendChild(axis);

  // Day columns
  for (let i = 0; i < 7; i++) {
    const day = days[i];
    const isToday = isSameDay(day, todayDate);
    const col = el('div', 'day-col' + (isToday ? ' today' : ''));
    col.style.height = `${AXIS_MINUTES * PX_PER_MIN}px`;

    for (let h = 0; h < 24; h++) {
      col.appendChild(el('div', 'hour-cell'));
    }

    renderDayEvents(col, day);
    enableDragCreate(col, day);
    grid.appendChild(col);
  }

  calendar.appendChild(grid);
  return calendar;
}

function eventsForDay(day) {
  const dayStart = new Date(day);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = addDays(dayStart, 1);

  const out = [];
  for (const ev of state.events) {
    const start = new Date(ev.start_at);
    const end = new Date(ev.end_at);
    // overlaps this day?
    if (start < dayEnd && end > dayStart) {
      out.push({
        id: ev.id,
        raw: ev,
        startMin: minutesFromMidnight(start, dayStart),
        endMin: minutesFromMidnight(end, dayStart),
      });
    }
  }
  return { out, dayStart };
}

function renderDayEvents(col, day) {
  const { out, dayStart } = eventsForDay(day);
  const laid = computeLayout(out);

  for (const item of laid) {
    const top = item.startMin * PX_PER_MIN;
    const height = Math.max(1, (item.endMin - item.startMin) * PX_PER_MIN);
    const widthPct = 100 / item.cols;
    const leftPct = (item.col / item.cols) * 100;

    const block = el('div', 'event');
    block.style.top = `${top}px`;
    block.style.height = `${height}px`;
    block.style.left = `calc(${leftPct}% + 1px)`;
    block.style.width = `calc(${widthPct}% - 2px)`;

    const start = new Date(item.raw.start_at);
    const end = new Date(item.raw.end_at);

    const titleEl = el('div', 'ev-title', item.raw.title);
    const timeEl = el('div', 'ev-time', formatRange(start, end));
    block.append(titleEl, timeEl);

    block.addEventListener('click', (e) => {
      e.stopPropagation();
      openEditModal(item.raw);
    });

    col.appendChild(block);
  }
}

// ---- Drag-to-create -----------------------------------------------------

function enableDragCreate(col, day) {
  let dragging = false;
  let startMin = 0;
  let selectionEl = null;

  const dayStart = new Date(day);
  dayStart.setHours(0, 0, 0, 0);

  function yToMin(clientY) {
    const rect = col.getBoundingClientRect();
    let min = (clientY - rect.top) / PX_PER_MIN;
    min = Math.max(0, Math.min(AXIS_MINUTES, min));
    return Math.round(min / SNAP_MIN) * SNAP_MIN;
  }

  col.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.event')) return;
    dragging = true;
    startMin = yToMin(e.clientY);
    selectionEl = el('div', 'selection');
    col.appendChild(selectionEl);
    updateSelection(startMin, startMin);
    e.preventDefault();
  });

  function updateSelection(a, b) {
    if (!selectionEl) return;
    const top = Math.min(a, b) * PX_PER_MIN;
    const height = Math.abs(b - a) * PX_PER_MIN;
    selectionEl.style.top = `${top}px`;
    selectionEl.style.height = `${height}px`;
  }

  function onMove(e) {
    if (!dragging) return;
    const cur = yToMin(e.clientY);
    updateSelection(startMin, cur);
  }

  function onUp(e) {
    if (!dragging) return;
    dragging = false;
    let endMin = yToMin(e.clientY);
    let a = Math.min(startMin, endMin);
    let b = Math.max(startMin, endMin);
    if (b - a < SNAP_MIN) {
      // treat as a click: default 1-hour slot
      b = Math.min(AXIS_MINUTES, a + 60);
      if (b === a) a = b - 60;
    }
    if (selectionEl) {
      selectionEl.remove();
      selectionEl = null;
    }
    const startDate = dateAtMinutes(dayStart, a);
    const endDate = dateAtMinutes(dayStart, b);
    openCreateModal(startDate, endDate);
  }

  col.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

// ---- Modal --------------------------------------------------------------

function openCreateModal(startDate, endDate) {
  openModal({
    mode: 'create',
    title: '',
    start: startDate,
    end: endDate,
  });
}

function openEditModal(rawEvent) {
  openModal({
    mode: 'edit',
    id: rawEvent.id,
    title: rawEvent.title,
    start: new Date(rawEvent.start_at),
    end: new Date(rawEvent.end_at),
  });
}

function openModal({ mode, id, title, start, end }) {
  const backdrop = el('div', 'modal-backdrop');
  const modal = el('div', 'modal');

  modal.appendChild(
    el('h2', '', mode === 'create' ? 'New event' : 'Edit event')
  );

  const errorEl = el('div', 'modal-error');

  const titleInput = inputField('Title', 'text', title);
  const startInput = inputField('Start', 'datetime-local', fmtDateInput(start));
  const endInput = inputField('End', 'datetime-local', fmtDateInput(end));

  modal.append(titleInput.field, startInput.field, endInput.field, errorEl);

  const actions = el('div', 'modal-actions');

  if (mode === 'edit') {
    const del = button('Delete', 'btn danger', async () => {
      try {
        await api.deleteEvent(id);
        close();
        await loadAndRender();
      } catch (err) {
        errorEl.textContent = err.message;
      }
    });
    actions.appendChild(del);
  }

  actions.appendChild(el('div', 'spacer'));

  const cancel = button('Cancel', 'btn', close);
  const save = button('Save', 'btn primary', async () => {
    errorEl.textContent = '';
    const payload = {
      title: titleInput.input.value,
      start_at: localInputToIso(startInput.input.value),
      end_at: localInputToIso(endInput.input.value),
    };
    if (!payload.title.trim()) {
      errorEl.textContent = 'Title must not be empty';
      return;
    }
    if (!payload.start_at || !payload.end_at) {
      errorEl.textContent = 'Start and end are required';
      return;
    }
    if (!(new Date(payload.end_at) > new Date(payload.start_at))) {
      errorEl.textContent = 'End must be after start';
      return;
    }
    try {
      if (mode === 'create') await api.createEvent(payload);
      else await api.updateEvent(id, payload);
      close();
      await loadAndRender();
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });

  actions.append(cancel, save);
  modal.appendChild(actions);
  backdrop.appendChild(modal);

  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener('keydown', onKey);

  function onKey(e) {
    if (e.key === 'Escape') close();
  }
  function close() {
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
  }

  document.body.appendChild(backdrop);
  titleInput.input.focus();
}

function localInputToIso(value) {
  if (!value) return null;
  const d = new Date(value); // datetime-local parsed as local time
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

// ---- Helpers ------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(label, className, onClick) {
  const b = el('button', className, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function inputField(labelText, type, value) {
  const field = el('div', 'field');
  const label = el('label', '', labelText);
  const input = document.createElement('input');
  input.type = type;
  if (value != null) input.value = value;
  field.append(label, input);
  return { field, input, label };
}

// ---- Data loading -------------------------------------------------------

async function loadAndRender() {
  const weekEnd = addDays(state.weekStart, 7);
  try {
    state.events = await api.fetchEvents(
      state.weekStart.toISOString(),
      weekEnd.toISOString()
    );
  } catch (err) {
    console.error(err);
    state.events = [];
  }
  render();
}

loadAndRender();
