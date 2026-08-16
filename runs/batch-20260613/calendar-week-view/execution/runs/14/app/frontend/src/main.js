import {
  DAY_LABELS,
  weekDays,
  startOfWeek,
  addWeeks,
  isSameDay,
  dayStart,
  dayEnd,
  formatTime,
  formatMinutes,
  dateFromDayAndMinutes,
  toDatetimeLocalValue,
  fromDatetimeLocalValue,
  formatDateRangeLabel,
} from './dates.js';
import { layoutEventsForDay, MINUTES_PER_DAY } from './layout.js';
import {
  fetchEvents,
  createEvent,
  updateEvent,
  deleteEvent,
} from './api.js';

const HOUR_HEIGHT = 48; // must match --hour-height in styles.css
const MINUTE_HEIGHT = HOUR_HEIGHT / 60;
const GRID_HEIGHT = HOUR_HEIGHT * 24;
const SNAP_MINUTES = 15;

const app = document.getElementById('app');

const state = {
  anchorDate: new Date(), // any date within the displayed week
  events: [], // events overlapping the displayed week
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  const days = weekDays(state.anchorDate);
  app.innerHTML = '';

  app.appendChild(renderToolbar(days));

  const calendar = document.createElement('div');
  calendar.className = 'calendar';

  const grid = document.createElement('div');
  grid.className = 'grid';

  // Header row: corner + 7 day headers.
  const corner = document.createElement('div');
  corner.className = 'corner';
  grid.appendChild(corner);

  const today = new Date();
  days.forEach((day, i) => {
    const h = document.createElement('div');
    h.className = 'day-header' + (isSameDay(day, today) ? ' today' : '');
    const dow = document.createElement('div');
    dow.className = 'dow';
    dow.textContent = DAY_LABELS[i];
    const date = document.createElement('div');
    date.className = 'date';
    date.textContent = String(day.getDate());
    h.appendChild(dow);
    h.appendChild(date);
    grid.appendChild(h);
  });

  // Body row: axis + 7 day columns. We put these in a second implicit grid row.
  const axis = document.createElement('div');
  axis.className = 'axis';
  axis.style.height = `${GRID_HEIGHT}px`;
  for (let h = 0; h <= 24; h++) {
    const label = document.createElement('div');
    label.className = 'hour-label';
    label.style.top = `${h * HOUR_HEIGHT}px`;
    label.textContent = h === 24 ? '24:00' : `${String(h).padStart(2, '0')}:00`;
    if (h === 0) label.style.transform = 'translateY(0)';
    if (h === 24) label.style.transform = 'translateY(-100%)';
    axis.appendChild(label);
  }
  grid.appendChild(axis);

  days.forEach((day) => {
    grid.appendChild(renderDayColumn(day));
  });

  calendar.appendChild(grid);
  app.appendChild(calendar);
}

function renderToolbar(days) {
  const bar = document.createElement('div');
  bar.className = 'toolbar';

  const title = document.createElement('h1');
  title.textContent = 'Week Calendar';
  bar.appendChild(title);

  const range = document.createElement('span');
  range.className = 'range-label';
  range.textContent = formatDateRangeLabel(days);
  bar.appendChild(range);

  const spacer = document.createElement('div');
  spacer.className = 'spacer';
  bar.appendChild(spacer);

  const prev = document.createElement('button');
  prev.textContent = '‹ Prev';
  prev.addEventListener('click', () => navigate(-1));

  const todayBtn = document.createElement('button');
  todayBtn.textContent = 'Today';
  todayBtn.addEventListener('click', () => {
    state.anchorDate = new Date();
    refresh();
  });

  const next = document.createElement('button');
  next.textContent = 'Next ›';
  next.addEventListener('click', () => navigate(1));

  bar.appendChild(prev);
  bar.appendChild(todayBtn);
  bar.appendChild(next);

  return bar;
}

function renderDayColumn(day) {
  const col = document.createElement('div');
  col.className = 'day-column' + (isSameDay(day, new Date()) ? ' today' : '');
  col.style.height = `${GRID_HEIGHT}px`;
  col.dataset.day = day.toISOString();

  // Hour & half-hour lines.
  for (let h = 0; h <= 24; h++) {
    const line = document.createElement('div');
    line.className = 'hour-line';
    line.style.top = `${h * HOUR_HEIGHT}px`;
    col.appendChild(line);
    if (h < 24) {
      const half = document.createElement('div');
      half.className = 'half-hour-line';
      half.style.top = `${h * HOUR_HEIGHT + HOUR_HEIGHT / 2}px`;
      col.appendChild(half);
    }
  }

  // Events for this day, laid out.
  const ds = dayStart(day);
  const de = dayEnd(day);
  const placements = layoutEventsForDay(state.events, ds, de);

  for (const p of placements) {
    col.appendChild(renderEvent(p));
  }

  attachDragToCreate(col, day);

  return col;
}

function renderEvent(p) {
  const el = document.createElement('div');
  el.className = 'event';

  const top = p.topMin * MINUTE_HEIGHT;
  const height = Math.max(p.heightMin * MINUTE_HEIGHT, 14); // min visual height

  el.style.top = `${top}px`;
  el.style.height = `${height}px`;
  // Inset slightly so adjacent columns show a visible gap (no overlap).
  const GAP = 0.5; // percent
  el.style.left = `calc(${p.leftFrac * 100}% + 1px)`;
  el.style.width = `calc(${p.widthFrac * 100}% - 2px)`;

  const start = new Date(p.event.start_at);
  const end = new Date(p.event.end_at);

  const titleEl = document.createElement('div');
  titleEl.className = 'ev-title';
  titleEl.textContent = p.event.title;

  const timeEl = document.createElement('div');
  timeEl.className = 'ev-time';
  // Show clamped times against the visible day for clarity.
  const startMin = p.topMin;
  const endMin = p.topMin + p.heightMin;
  timeEl.textContent = `${formatMinutes(startMin)} – ${formatMinutes(endMin)}`;

  el.appendChild(titleEl);
  if (height >= 28) el.appendChild(timeEl);

  el.title = `${p.event.title}\n${formatTime(start)} – ${formatTime(end)}`;

  el.addEventListener('click', (e) => {
    e.stopPropagation();
    openEditModal(p.event);
  });

  return el;
}

// ---------------------------------------------------------------------------
// Drag-to-create
// ---------------------------------------------------------------------------

function minutesFromOffsetY(y) {
  const min = (y / MINUTE_HEIGHT);
  return Math.max(0, Math.min(MINUTES_PER_DAY, min));
}

function snap(min) {
  return Math.round(min / SNAP_MINUTES) * SNAP_MINUTES;
}

function attachDragToCreate(col, day) {
  let dragging = false;
  let startMin = 0;
  let ghost = null;
  let moved = false;

  const getY = (e) => {
    const rect = col.getBoundingClientRect();
    return e.clientY - rect.top + col.scrollTop;
  };

  const onDown = (e) => {
    // Only react to clicks on the column background (not on events).
    if (e.target !== col && !e.target.classList.contains('hour-line') &&
        !e.target.classList.contains('half-hour-line')) {
      return;
    }
    if (e.button !== 0) return;
    dragging = true;
    moved = false;
    startMin = snap(minutesFromOffsetY(getY(e)));
    ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    col.appendChild(ghost);
    updateGhost(startMin, startMin);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    e.preventDefault();
  };

  const updateGhost = (a, b) => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    ghost.style.top = `${lo * MINUTE_HEIGHT}px`;
    ghost.style.height = `${Math.max((hi - lo) * MINUTE_HEIGHT, 2)}px`;
    ghost.style.left = '1px';
    ghost.style.right = '1px';
  };

  const onMove = (e) => {
    if (!dragging) return;
    moved = true;
    const cur = snap(minutesFromOffsetY(getY(e)));
    updateGhost(startMin, cur);
  };

  const onUp = (e) => {
    if (!dragging) return;
    dragging = false;
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);

    let endMin = snap(minutesFromOffsetY(getY(e)));
    let lo = Math.min(startMin, endMin);
    let hi = Math.max(startMin, endMin);

    if (ghost) {
      ghost.remove();
      ghost = null;
    }

    // A plain click (no real drag) creates a default 1-hour slot.
    if (!moved || hi - lo < SNAP_MINUTES) {
      lo = snap(startMin);
      hi = Math.min(lo + 60, MINUTES_PER_DAY);
      if (hi <= lo) {
        lo = Math.max(0, hi - 60);
      }
    }

    const startDate = dateFromDayAndMinutes(day, lo);
    const endDate = dateFromDayAndMinutes(day, hi);
    openCreateModal(startDate, endDate);
  };

  col.addEventListener('mousedown', onDown);
}

// ---------------------------------------------------------------------------
// Modal: create / edit
// ---------------------------------------------------------------------------

function openCreateModal(startDate, endDate) {
  openModal({
    mode: 'create',
    title: '',
    start: startDate,
    end: endDate,
  });
}

function openEditModal(event) {
  openModal({
    mode: 'edit',
    id: event.id,
    title: event.title,
    start: new Date(event.start_at),
    end: new Date(event.end_at),
  });
}

function openModal(opts) {
  closeModal();

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) closeModal();
  });

  const modal = document.createElement('div');
  modal.className = 'modal';

  const h2 = document.createElement('h2');
  h2.textContent = opts.mode === 'create' ? 'New event' : 'Edit event';
  modal.appendChild(h2);

  const form = document.createElement('form');

  const titleLabel = document.createElement('label');
  titleLabel.textContent = 'Title';
  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.value = opts.title;
  titleInput.placeholder = 'Event title';

  const startLabel = document.createElement('label');
  startLabel.textContent = 'Start';
  const startInput = document.createElement('input');
  startInput.type = 'datetime-local';
  startInput.value = toDatetimeLocalValue(opts.start);

  const endLabel = document.createElement('label');
  endLabel.textContent = 'End';
  const endInput = document.createElement('input');
  endInput.type = 'datetime-local';
  endInput.value = toDatetimeLocalValue(opts.end);

  const errorEl = document.createElement('div');
  errorEl.className = 'error';

  const actions = document.createElement('div');
  actions.className = 'actions';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.className = 'primary';
  saveBtn.textContent = 'Save';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', closeModal);

  actions.appendChild(saveBtn);
  actions.appendChild(cancelBtn);

  const spacer = document.createElement('div');
  spacer.className = 'spacer';
  actions.appendChild(spacer);

  if (opts.mode === 'edit') {
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'danger';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', async () => {
      try {
        await deleteEvent(opts.id);
        closeModal();
        await refresh();
      } catch (err) {
        errorEl.textContent = err.message;
      }
    });
    actions.appendChild(delBtn);
  }

  form.appendChild(titleLabel);
  form.appendChild(titleInput);
  form.appendChild(startLabel);
  form.appendChild(startInput);
  form.appendChild(endLabel);
  form.appendChild(endInput);
  form.appendChild(errorEl);
  form.appendChild(actions);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.textContent = '';

    const title = titleInput.value.trim();
    if (!title) {
      errorEl.textContent = 'Title is required.';
      return;
    }
    if (!startInput.value || !endInput.value) {
      errorEl.textContent = 'Start and end are required.';
      return;
    }
    const start = fromDatetimeLocalValue(startInput.value);
    const end = fromDatetimeLocalValue(endInput.value);
    if (!(end.getTime() > start.getTime())) {
      errorEl.textContent = 'End must be after start.';
      return;
    }

    const payload = {
      title,
      start_at: start.toISOString(),
      end_at: end.toISOString(),
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
      errorEl.textContent = err.message;
    }
  });

  modal.appendChild(form);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  titleInput.focus();
  titleInput.select();

  document.addEventListener('keydown', escHandler);
}

function escHandler(e) {
  if (e.key === 'Escape') closeModal();
}

function closeModal() {
  const existing = document.querySelector('.modal-backdrop');
  if (existing) existing.remove();
  document.removeEventListener('keydown', escHandler);
}

// ---------------------------------------------------------------------------
// Data flow
// ---------------------------------------------------------------------------

function navigate(deltaWeeks) {
  state.anchorDate = addWeeks(state.anchorDate, deltaWeeks);
  refresh();
}

async function refresh() {
  const start = startOfWeek(state.anchorDate);
  const end = addWeeks(start, 1); // exclusive end = next Monday 00:00
  try {
    state.events = await fetchEvents(start.toISOString(), end.toISOString());
  } catch (err) {
    console.error('Failed to load events', err);
    state.events = [];
  }
  render();
}

// Initial paint then load (so the grid shows immediately).
render();
refresh();
