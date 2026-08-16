import './style.css';
import { layoutDay } from './layout.js';
import {
  fetchEvents,
  createEvent,
  updateEvent,
  deleteEvent,
} from './api.js';
import {
  MINUTES_PER_DAY,
  startOfWeek,
  startOfDay,
  addDays,
  addWeeks,
  isSameDay,
  minutesFrom,
  formatTime,
  toLocalInputValue,
  fromLocalInputValue,
  dayName,
  formatRangeLabel,
} from './time.js';

// ---- Geometry constants -----------------------------------------------------
// A single hour-row is HOUR_HEIGHT px tall. The full axis is 24 * HOUR_HEIGHT.
// All vertical placement is derived from these two numbers so geometry is exact.
const HOUR_HEIGHT = 48;
const AXIS_HEIGHT = HOUR_HEIGHT * 24; // 1152 px = exactly 24:00
const PX_PER_MIN = AXIS_HEIGHT / MINUTES_PER_DAY;
const SNAP_MIN = 15; // drag-create snaps to 15-minute increments

// ---- State ------------------------------------------------------------------
const state = {
  weekStart: startOfWeek(new Date()),
  events: [], // raw events from the API, with Date objects added
};

const root = document.getElementById('app');

// ---- Top-level render -------------------------------------------------------
function render() {
  root.innerHTML = '';

  const header = buildHeader();
  const grid = buildGrid();

  root.appendChild(header);
  root.appendChild(grid);

  placeEvents(grid);
}

function buildHeader() {
  const header = document.createElement('header');
  header.className = 'cal-header';

  const nav = document.createElement('div');
  nav.className = 'cal-nav';

  const prev = document.createElement('button');
  prev.textContent = '‹ Prev';
  prev.addEventListener('click', () => navigate(-1));

  const today = document.createElement('button');
  today.textContent = 'Today';
  today.addEventListener('click', () => goToday());

  const next = document.createElement('button');
  next.textContent = 'Next ›';
  next.addEventListener('click', () => navigate(1));

  nav.append(prev, today, next);

  const label = document.createElement('h1');
  label.className = 'cal-range-label';
  label.textContent = formatRangeLabel(state.weekStart);

  header.append(nav, label);
  return header;
}

function buildGrid() {
  const grid = document.createElement('div');
  grid.className = 'cal-grid';

  // --- Day headers row (spans the time-gutter + 7 days) ---
  const headerRow = document.createElement('div');
  headerRow.className = 'cal-day-headers';

  const corner = document.createElement('div');
  corner.className = 'cal-corner';
  headerRow.appendChild(corner);

  const todayDate = startOfDay(new Date());
  for (let i = 0; i < 7; i++) {
    const dayDate = addDays(state.weekStart, i);
    const dh = document.createElement('div');
    dh.className = 'cal-day-header';
    if (isSameDay(dayDate, todayDate)) dh.classList.add('is-today');
    dh.innerHTML = `<span class="dh-name">${dayName(i)}</span><span class="dh-date">${dayDate.getDate()}</span>`;
    headerRow.appendChild(dh);
  }
  grid.appendChild(headerRow);

  // --- Body: scrollable area with time gutter + day columns ---
  const body = document.createElement('div');
  body.className = 'cal-body';

  // Time gutter
  const gutter = document.createElement('div');
  gutter.className = 'cal-gutter';
  gutter.style.height = `${AXIS_HEIGHT}px`;
  for (let h = 0; h <= 24; h++) {
    const lbl = document.createElement('div');
    lbl.className = 'cal-hour-label';
    lbl.style.top = `${h * HOUR_HEIGHT}px`;
    lbl.textContent = h === 24 ? '24:00' : `${String(h).padStart(2, '0')}:00`;
    gutter.appendChild(lbl);
  }
  body.appendChild(gutter);

  // Day columns
  const cols = document.createElement('div');
  cols.className = 'cal-columns';

  const todayDate2 = startOfDay(new Date());
  for (let i = 0; i < 7; i++) {
    const dayDate = addDays(state.weekStart, i);
    const col = document.createElement('div');
    col.className = 'cal-col';
    col.dataset.dayIndex = String(i);
    col.style.height = `${AXIS_HEIGHT}px`;
    if (isSameDay(dayDate, todayDate2)) col.classList.add('is-today');

    // Hour grid lines
    for (let h = 0; h < 24; h++) {
      const line = document.createElement('div');
      line.className = 'cal-hour-line';
      line.style.top = `${h * HOUR_HEIGHT}px`;
      line.style.height = `${HOUR_HEIGHT}px`;
      col.appendChild(line);
    }

    // Layer for absolutely positioned event blocks
    const layer = document.createElement('div');
    layer.className = 'cal-events-layer';
    col.appendChild(layer);

    attachDragCreate(col, layer, dayDate);

    cols.appendChild(col);
  }

  body.appendChild(cols);
  grid.appendChild(body);
  return grid;
}

// ---- Event placement --------------------------------------------------------
function placeEvents(grid) {
  const cols = grid.querySelectorAll('.cal-col');

  for (let i = 0; i < 7; i++) {
    const dayStart = startOfDay(addDays(state.weekStart, i));
    const dayEnd = addDays(dayStart, 1);
    const layer = cols[i].querySelector('.cal-events-layer');

    // Collect events that intersect this day, clamped to [00:00, 24:00].
    const dayEvents = [];
    for (const ev of state.events) {
      if (ev.start < dayEnd && ev.end > dayStart) {
        const startMin = Math.max(0, minutesFrom(dayStart, ev.start));
        const endMin = Math.min(MINUTES_PER_DAY, minutesFrom(dayStart, ev.end));
        if (endMin > startMin) {
          dayEvents.push({ id: ev.id, startMin, endMin, _ev: ev });
        }
      }
    }

    const placed = layoutDay(dayEvents);
    const byId = new Map(dayEvents.map((d) => [d.id, d._ev]));

    for (const p of placed) {
      const ev = byId.get(p.id);
      const block = buildEventBlock(ev, p);
      layer.appendChild(block);
    }
  }
}

function buildEventBlock(ev, placed) {
  const block = document.createElement('div');
  block.className = 'cal-event';

  const top = placed.startMin * PX_PER_MIN;
  const height = (placed.endMin - placed.startMin) * PX_PER_MIN;

  block.style.top = `${top}px`;
  block.style.height = `${height}px`;
  // Horizontal: left/width are fractions of the day-column width.
  block.style.left = `calc(${placed.left * 100}% + 1px)`;
  block.style.width = `calc(${placed.width * 100}% - 2px)`;

  const title = document.createElement('div');
  title.className = 'ev-title';
  title.textContent = ev.title;

  const time = document.createElement('div');
  time.className = 'ev-time';
  time.textContent = `${formatTime(ev.start)} – ${formatTime(ev.end)}`;

  block.append(title, time);

  block.addEventListener('click', (e) => {
    e.stopPropagation();
    openEditForm(ev);
  });

  return block;
}

// ---- Drag-to-create ---------------------------------------------------------
function attachDragCreate(col, layer, dayDate) {
  let dragging = false;
  let startY = 0;
  let ghost = null;

  const dayStart = startOfDay(dayDate);

  function yToMinutes(clientY) {
    const rect = col.getBoundingClientRect();
    let min = (clientY - rect.top) / PX_PER_MIN;
    min = Math.max(0, Math.min(MINUTES_PER_DAY, min));
    return Math.round(min / SNAP_MIN) * SNAP_MIN;
  }

  col.addEventListener('mousedown', (e) => {
    // Ignore clicks that originate on an existing event block.
    if (e.target.closest('.cal-event')) return;
    dragging = true;
    startY = yToMinutes(e.clientY);

    ghost = document.createElement('div');
    ghost.className = 'cal-event ghost';
    layer.appendChild(ghost);
    updateGhost(startY, startY);
    e.preventDefault();
  });

  function updateGhost(a, b) {
    const top = Math.min(a, b) * PX_PER_MIN;
    const height = Math.abs(b - a) * PX_PER_MIN;
    ghost.style.top = `${top}px`;
    ghost.style.height = `${Math.max(height, 2)}px`;
    ghost.style.left = '1px';
    ghost.style.width = 'calc(100% - 2px)';
  }

  function onMove(e) {
    if (!dragging) return;
    const cur = yToMinutes(e.clientY);
    updateGhost(startY, cur);
  }

  function onUp(e) {
    if (!dragging) return;
    dragging = false;
    let endMin = yToMinutes(e.clientY);
    let a = Math.min(startY, endMin);
    let b = Math.max(startY, endMin);

    if (ghost) {
      ghost.remove();
      ghost = null;
    }

    // A plain click (no drag) defaults to a 1-hour slot.
    if (b - a < SNAP_MIN) {
      b = Math.min(MINUTES_PER_DAY, a + 60);
      if (b === a) a = Math.max(0, b - 60);
    }

    const start = new Date(dayStart.getTime() + a * 60000);
    const end = new Date(dayStart.getTime() + b * 60000);
    openCreateForm(start, end);
  }

  col.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

// ---- Forms / modal ----------------------------------------------------------
function openModal(contentBuilder) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });

  const modal = document.createElement('div');
  modal.className = 'modal';
  overlay.appendChild(modal);

  const close = () => overlay.remove();
  contentBuilder(modal, close);

  document.body.appendChild(overlay);
  return close;
}

function buildFormFields(modal, { title, start, end }) {
  const titleLabel = document.createElement('label');
  titleLabel.textContent = 'Title';
  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.value = title;
  titleLabel.appendChild(titleInput);

  const startLabel = document.createElement('label');
  startLabel.textContent = 'Start';
  const startInput = document.createElement('input');
  startInput.type = 'datetime-local';
  startInput.value = toLocalInputValue(start);
  startLabel.appendChild(startInput);

  const endLabel = document.createElement('label');
  endLabel.textContent = 'End';
  const endInput = document.createElement('input');
  endInput.type = 'datetime-local';
  endInput.value = toLocalInputValue(end);
  endLabel.appendChild(endInput);

  const err = document.createElement('div');
  err.className = 'form-error';

  modal.append(titleLabel, startLabel, endLabel, err);
  return { titleInput, startInput, endInput, err };
}

function validateLocal(titleInput, startInput, endInput) {
  const title = titleInput.value.trim();
  if (!title) return { ok: false, error: 'Title cannot be empty.' };
  const start = fromLocalInputValue(startInput.value);
  const end = fromLocalInputValue(endInput.value);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return { ok: false, error: 'Start and end must be valid times.' };
  }
  if (!(end.getTime() > start.getTime())) {
    return { ok: false, error: 'End must be after start.' };
  }
  return { ok: true, value: { title, start, end } };
}

function openCreateForm(start, end) {
  openModal((modal, close) => {
    const heading = document.createElement('h2');
    heading.textContent = 'New event';
    modal.appendChild(heading);

    const { titleInput, startInput, endInput, err } = buildFormFields(modal, {
      title: '',
      start,
      end,
    });

    const actions = document.createElement('div');
    actions.className = 'modal-actions';

    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.type = 'button';
    cancel.addEventListener('click', close);

    const save = document.createElement('button');
    save.textContent = 'Create';
    save.className = 'primary';
    save.addEventListener('click', async () => {
      const v = validateLocal(titleInput, startInput, endInput);
      if (!v.ok) {
        err.textContent = v.error;
        return;
      }
      try {
        await createEvent({
          title: v.value.title,
          start_at: v.value.start.toISOString(),
          end_at: v.value.end.toISOString(),
        });
        close();
        await reload();
      } catch (e) {
        err.textContent = e.message;
      }
    });

    actions.append(cancel, save);
    modal.appendChild(actions);
    titleInput.focus();
  });
}

function openEditForm(ev) {
  openModal((modal, close) => {
    const heading = document.createElement('h2');
    heading.textContent = 'Edit event';
    modal.appendChild(heading);

    const { titleInput, startInput, endInput, err } = buildFormFields(modal, {
      title: ev.title,
      start: ev.start,
      end: ev.end,
    });

    const actions = document.createElement('div');
    actions.className = 'modal-actions';

    const del = document.createElement('button');
    del.textContent = 'Delete';
    del.className = 'danger';
    del.type = 'button';
    del.addEventListener('click', async () => {
      try {
        await deleteEvent(ev.id);
        close();
        await reload();
      } catch (e) {
        err.textContent = e.message;
      }
    });

    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.type = 'button';
    cancel.addEventListener('click', close);

    const save = document.createElement('button');
    save.textContent = 'Save';
    save.className = 'primary';
    save.addEventListener('click', async () => {
      const v = validateLocal(titleInput, startInput, endInput);
      if (!v.ok) {
        err.textContent = v.error;
        return;
      }
      try {
        await updateEvent(ev.id, {
          title: v.value.title,
          start_at: v.value.start.toISOString(),
          end_at: v.value.end.toISOString(),
        });
        close();
        await reload();
      } catch (e) {
        err.textContent = e.message;
      }
    });

    actions.append(del, cancel, save);
    modal.appendChild(actions);
    titleInput.focus();
  });
}

// ---- Data loading / navigation ----------------------------------------------
async function reload() {
  const start = startOfDay(state.weekStart);
  const end = addDays(start, 7);
  try {
    const raw = await fetchEvents(start.toISOString(), end.toISOString());
    state.events = raw.map((e) => ({
      ...e,
      start: new Date(e.start_at),
      end: new Date(e.end_at),
    }));
  } catch (e) {
    console.error(e);
    state.events = [];
  }
  render();
}

function navigate(deltaWeeks) {
  state.weekStart = addWeeks(state.weekStart, deltaWeeks);
  reload();
}

function goToday() {
  state.weekStart = startOfWeek(new Date());
  reload();
}

// ---- Boot -------------------------------------------------------------------
reload();
