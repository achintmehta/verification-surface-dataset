import { computeLayout } from './layout.js';
import { fetchEvents, createEvent, updateEvent, deleteEvent } from './api.js';
import {
  startOfWeek, addDays, isSameDay, minutesFromMidnight,
  fmtTime, fmtMinutes, dateAt, toLocalInputValue, fromLocalInputValue,
  weekdayLabel, monthLabel, MINUTES_PER_DAY, pad2
} from './time.js';

const HOUR_HEIGHT = 48; // must match --hour-height in CSS
const AXIS_HEIGHT = HOUR_HEIGHT * 24; // total pixel height of 00:00..24:00
const SNAP_MINUTES = 15;

const state = {
  weekStart: startOfWeek(new Date()),
  events: [],
};

const app = document.getElementById('app');

function minutesToPx(mins) {
  return (mins / MINUTES_PER_DAY) * AXIS_HEIGHT;
}

async function load() {
  const start = state.weekStart;
  const end = addDays(start, 7);
  state.events = await fetchEvents(start.toISOString(), end.toISOString());
  render();
}

function weekRangeLabel() {
  const start = state.weekStart;
  const end = addDays(start, 6);
  const startStr = `${monthLabel(start.getMonth())} ${start.getDate()}`;
  const endStr =
    start.getFullYear() === end.getFullYear() && start.getMonth() === end.getMonth()
      ? `${end.getDate()}, ${end.getFullYear()}`
      : `${monthLabel(end.getMonth())} ${end.getDate()}, ${end.getFullYear()}`;
  return `${startStr} – ${endStr}`;
}

function render() {
  app.innerHTML = '';

  // Toolbar
  const toolbar = el('div', 'toolbar');
  toolbar.append(
    el('h1', null, 'Week Calendar'),
    btn('‹ Prev', () => navigate(-7)),
    btn('Today', goToday),
    btn('Next ›', () => navigate(7)),
    el('span', 'range-label', weekRangeLabel()),
    el('div', 'spacer'),
    btn('+ New event', () => openCreateDefault(), 'primary')
  );
  app.append(toolbar);

  const today = new Date();
  const days = Array.from({ length: 7 }, (_, i) => addDays(state.weekStart, i));

  // Calendar scroll container
  const calendar = el('div', 'calendar');

  // Header
  const header = el('div', 'cal-header');
  header.append(el('div', 'corner'));
  days.forEach((d, i) => {
    const dh = el('div', 'day-head' + (isSameDay(d, today) ? ' today' : ''));
    dh.append(el('div', 'dow', weekdayLabel(i)));
    dh.append(el('div', 'dnum', String(d.getDate())));
    header.append(dh);
  });
  calendar.append(header);

  // Body
  const body = el('div', 'cal-body');

  // Time gutter
  const gutter = el('div', 'time-gutter');
  gutter.style.height = AXIS_HEIGHT + 'px';
  for (let h = 0; h <= 24; h++) {
    const label = el('div', 'time-label', h === 24 ? '24:00' : `${pad2(h)}:00`);
    label.style.top = minutesToPx(h * 60) + 'px';
    gutter.append(label);
  }
  body.append(gutter);

  // Day columns
  days.forEach((day) => {
    const col = el('div', 'day-col' + (isSameDay(day, today) ? ' today' : ''));
    col.style.height = AXIS_HEIGHT + 'px';

    // hour lines
    for (let h = 0; h <= 24; h++) {
      const line = el('div', 'hour-line');
      line.style.top = minutesToPx(h * 60) + 'px';
      col.append(line);
      if (h < 24) {
        const half = el('div', 'half-line');
        half.style.top = minutesToPx(h * 60 + 30) + 'px';
        col.append(half);
      }
    }

    // now indicator
    if (isSameDay(day, today)) {
      const mins = minutesFromMidnight(today, dayStartOf(day));
      const now = el('div', 'now-line');
      now.style.top = minutesToPx(mins) + 'px';
      col.append(now);
    }

    renderDayEvents(col, day);
    attachDragCreate(col, day);
    body.append(col);
  });

  calendar.append(body);
  app.append(calendar);

  // Scroll to a reasonable time (08:00) on first render
  requestAnimationFrame(() => {
    calendar.scrollTop = minutesToPx(7 * 60);
  });
}

function dayStartOf(day) {
  const d = new Date(day);
  d.setHours(0, 0, 0, 0);
  return d;
}

function renderDayEvents(col, day) {
  const dayStart = dayStartOf(day);
  const dayEnd = addDays(dayStart, 1);

  // Build layout items, clamped to this day.
  const items = state.events
    .map((ev) => {
      const s = new Date(ev.start_at);
      const e = new Date(ev.end_at);
      // overlap with this day?
      if (e <= dayStart || s >= dayEnd) return null;
      const startMin = Math.max(0, minutesFromMidnight(s, dayStart));
      const endMin = Math.min(MINUTES_PER_DAY, minutesFromMidnight(e, dayStart));
      if (endMin <= startMin) return null;
      return {
        id: ev.id,
        ref: ev,
        start: startMin,
        end: endMin,
      };
    })
    .filter(Boolean);

  const laid = computeLayout(items);

  for (const it of laid) {
    const top = minutesToPx(it.start);
    const height = minutesToPx(it.end) - top;
    const block = el('div', 'event');
    block.style.top = top + 'px';
    block.style.height = Math.max(height, 12) + 'px';
    // leave a 1px right gap between adjacent columns
    block.style.left = `calc(${(it.left * 100).toFixed(4)}% + 1px)`;
    block.style.width = `calc(${(it.width * 100).toFixed(4)}% - 2px)`;

    const titleEl = el('div', 'ev-title', it.ref.title);
    const sFull = new Date(it.ref.start_at);
    const eFull = new Date(it.ref.end_at);
    const timeEl = el('div', 'ev-time', `${fmtTime(sFull)}–${fmtTime(eFull)}`);
    block.append(titleEl, timeEl);

    block.addEventListener('click', (e) => {
      e.stopPropagation();
      openEdit(it.ref);
    });

    col.append(block);
  }
}

// ---- Drag-to-create ----
function attachDragCreate(col, day) {
  const dayStart = dayStartOf(day);
  let dragging = false;
  let startMin = 0;
  let sel = null;

  function pxToMin(clientY) {
    const rect = col.getBoundingClientRect();
    let y = clientY - rect.top;
    y = Math.max(0, Math.min(AXIS_HEIGHT, y));
    const mins = (y / AXIS_HEIGHT) * MINUTES_PER_DAY;
    return Math.round(mins / SNAP_MINUTES) * SNAP_MINUTES;
  }

  col.addEventListener('mousedown', (e) => {
    if (e.target.closest('.event')) return;
    if (e.button !== 0) return;
    dragging = true;
    startMin = pxToMin(e.clientY);
    sel = el('div', 'drag-sel');
    col.append(sel);
    updateSel(startMin, startMin);
    e.preventDefault();
  });

  function updateSel(a, b) {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    sel.style.top = minutesToPx(lo) + 'px';
    sel.style.height = minutesToPx(hi - lo) + 'px';
  }

  function onMove(e) {
    if (!dragging) return;
    const cur = pxToMin(e.clientY);
    updateSel(startMin, cur);
  }

  function onUp(e) {
    if (!dragging) return;
    dragging = false;
    const endMin = pxToMin(e.clientY);
    if (sel && sel.parentNode) sel.parentNode.removeChild(sel);
    sel = null;
    let lo = Math.min(startMin, endMin);
    let hi = Math.max(startMin, endMin);
    if (hi - lo < SNAP_MINUTES) {
      // treat as a click: default 1-hour block
      hi = Math.min(MINUTES_PER_DAY, lo + 60);
      if (hi === lo) lo = Math.max(0, hi - 60);
    }
    openCreate(dateAt(dayStart, lo), dateAt(dayStart, hi));
  }

  col.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

// ---- Navigation ----
function navigate(deltaDays) {
  state.weekStart = addDays(state.weekStart, deltaDays);
  load();
}
function goToday() {
  state.weekStart = startOfWeek(new Date());
  load();
}

function openCreateDefault() {
  const d = state.weekStart;
  const s = dateAt(dayStartOf(d), 9 * 60);
  const e = dateAt(dayStartOf(d), 10 * 60);
  openCreate(s, e);
}

// ---- Modal form ----
function openCreate(startDate, endDate) {
  openForm({
    mode: 'create',
    title: '',
    start: startDate,
    end: endDate,
  });
}

function openEdit(ev) {
  openForm({
    mode: 'edit',
    id: ev.id,
    title: ev.title,
    start: new Date(ev.start_at),
    end: new Date(ev.end_at),
  });
}

function openForm(opts) {
  const backdrop = el('div', 'modal-backdrop');
  const modal = el('div', 'modal');

  modal.append(el('h2', null, opts.mode === 'create' ? 'New event' : 'Edit event'));

  const errBox = el('div', 'error');

  const titleInput = inputField(modal, 'Title', 'text', opts.title);
  const startInput = inputField(modal, 'Start', 'datetime-local', toLocalInputValue(opts.start));
  const endInput = inputField(modal, 'End', 'datetime-local', toLocalInputValue(opts.end));

  modal.append(errBox);

  const actions = el('div', 'modal-actions');
  if (opts.mode === 'edit') {
    const del = btn('Delete', async () => {
      try {
        await deleteEvent(opts.id);
        close();
        await load();
      } catch (err) {
        errBox.textContent = err.message;
      }
    }, 'danger');
    del.classList.add('left');
    actions.append(del);
  }
  actions.append(btn('Cancel', close));
  const saveBtn = btn(opts.mode === 'create' ? 'Create' : 'Save', submit, 'primary');
  actions.append(saveBtn);
  modal.append(actions);

  backdrop.append(modal);
  app.append(backdrop);
  titleInput.focus();

  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener('keydown', escClose);

  function escClose(e) {
    if (e.key === 'Escape') close();
  }

  function close() {
    document.removeEventListener('keydown', escClose);
    if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
  }

  async function submit() {
    errBox.textContent = '';
    const title = titleInput.value.trim();
    if (!title) {
      errBox.textContent = 'Title is required.';
      return;
    }
    const start = fromLocalInputValue(startInput.value);
    const end = fromLocalInputValue(endInput.value);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      errBox.textContent = 'Start and end must be valid.';
      return;
    }
    if (end.getTime() <= start.getTime()) {
      errBox.textContent = 'End must be after start.';
      return;
    }
    const payload = { title, start_at: start.toISOString(), end_at: end.toISOString() };
    try {
      if (opts.mode === 'create') {
        await createEvent(payload);
      } else {
        await updateEvent(opts.id, payload);
      }
      close();
      await load();
    } catch (err) {
      errBox.textContent = err.message;
    }
  }
}

// ---- DOM helpers ----
function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

function btn(text, onClick, variant) {
  const b = el('button', variant || null, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function inputField(parent, label, type, value) {
  const field = el('div', 'field');
  field.append(el('label', null, label));
  const input = document.createElement('input');
  input.type = type;
  input.value = value ?? '';
  field.append(input);
  parent.append(field);
  return input;
}

// Boot
load().catch((err) => {
  app.innerHTML = `<div style="padding:24px;color:#dc2626">Failed to load: ${err.message}</div>`;
});
