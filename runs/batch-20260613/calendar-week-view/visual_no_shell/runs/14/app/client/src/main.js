import './style.css';
import { layoutDay } from './layout.js';
import { fetchEvents, createEvent, updateEvent, deleteEvent } from './api.js';
import {
  startOfWeek,
  addDays,
  addWeeks,
  sameDay,
  minutesFromDayStart,
  dayLabel,
  dateLabel,
  weekRangeLabel,
  toDatetimeLocal,
  formatMinutes,
} from './dates.js';

const HOUR_HEIGHT = 48; // px per hour
const DAY_MINUTES = 1440;
const AXIS_HEIGHT = HOUR_HEIGHT * 24; // total height of a day column

let weekStart = startOfWeek(new Date());
let events = []; // raw events for the current week
let currentForm = null; // open form element if any

const app = document.getElementById('app');

function minToPx(min) {
  return (min / DAY_MINUTES) * AXIS_HEIGHT;
}

// ---------- Rendering ----------

function render() {
  app.innerHTML = '';

  const header = renderHeader();
  app.appendChild(header);

  const grid = document.createElement('div');
  grid.className = 'calendar';

  grid.appendChild(renderTimeGutter());

  const daysWrap = document.createElement('div');
  daysWrap.className = 'days';

  for (let i = 0; i < 7; i++) {
    const dayDate = addDays(weekStart, i);
    daysWrap.appendChild(renderDayColumn(dayDate));
  }

  grid.appendChild(daysWrap);
  app.appendChild(grid);

  // restore any open form on top
  if (currentForm) {
    document.body.appendChild(currentForm);
  }
}

function renderHeader() {
  const header = document.createElement('div');
  header.className = 'topbar';

  const title = document.createElement('h1');
  title.textContent = 'Week Calendar';

  const range = document.createElement('div');
  range.className = 'range-label';
  range.textContent = weekRangeLabel(weekStart);

  const nav = document.createElement('div');
  nav.className = 'nav';

  const prev = button('‹ Prev', () => {
    weekStart = addWeeks(weekStart, -1);
    reload();
  });
  const today = button('Today', () => {
    weekStart = startOfWeek(new Date());
    reload();
  });
  const next = button('Next ›', () => {
    weekStart = addWeeks(weekStart, 1);
    reload();
  });
  nav.append(prev, today, next);

  const left = document.createElement('div');
  left.className = 'topbar-left';
  left.append(title, range);

  header.append(left, nav);
  return header;
}

function button(label, onClick, cls = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  if (cls) b.className = cls;
  b.addEventListener('click', onClick);
  return b;
}

function renderTimeGutter() {
  const gutter = document.createElement('div');
  gutter.className = 'time-gutter';

  const spacer = document.createElement('div');
  spacer.className = 'day-header-spacer';
  gutter.appendChild(spacer);

  const axis = document.createElement('div');
  axis.className = 'gutter-axis';
  axis.style.height = `${AXIS_HEIGHT}px`;

  for (let h = 0; h <= 24; h++) {
    const lbl = document.createElement('div');
    lbl.className = 'hour-label';
    lbl.style.top = `${minToPx(h * 60)}px`;
    lbl.textContent = h === 24 ? '24:00' : `${String(h).padStart(2, '0')}:00`;
    axis.appendChild(lbl);
  }
  gutter.appendChild(axis);
  return gutter;
}

function renderDayColumn(dayDate) {
  const col = document.createElement('div');
  col.className = 'day-col';

  const isToday = sameDay(dayDate, new Date());

  const head = document.createElement('div');
  head.className = 'day-header' + (isToday ? ' today' : '');
  head.innerHTML = `<span class="dow">${dayLabel(dayDate)}</span> <span class="dnum">${dateLabel(dayDate)}</span>`;
  col.appendChild(head);

  const body = document.createElement('div');
  body.className = 'day-body' + (isToday ? ' today' : '');
  body.style.height = `${AXIS_HEIGHT}px`;

  // hour grid lines
  for (let h = 0; h <= 24; h++) {
    const line = document.createElement('div');
    line.className = 'hour-line' + (h === 24 ? ' last' : '');
    line.style.top = `${minToPx(h * 60)}px`;
    body.appendChild(line);
  }

  // events for this day
  const dayStart = new Date(dayDate);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = addDays(dayStart, 1);

  const dayEvents = [];
  for (const ev of events) {
    const s = new Date(ev.start_at);
    const e = new Date(ev.end_at);
    // overlaps this day?
    if (s < dayEnd && e > dayStart) {
      const startMin = Math.max(0, minutesFromDayStart(s, dayStart));
      const endMin = Math.min(DAY_MINUTES, minutesFromDayStart(e, dayStart));
      if (endMin > startMin) {
        dayEvents.push({ id: ev.id, raw: ev, startMin, endMin });
      }
    }
  }

  const laid = layoutDay(dayEvents);
  for (const ev of laid) {
    body.appendChild(renderEventBlock(ev));
  }

  // interaction: click/drag to create
  attachCreateInteraction(body, dayStart);

  col.appendChild(body);
  return col;
}

function renderEventBlock(ev) {
  const block = document.createElement('div');
  block.className = 'event';
  const top = minToPx(ev.startMin);
  const height = minToPx(ev.endMin) - minToPx(ev.startMin);
  block.style.top = `${top}px`;
  block.style.height = `${Math.max(height, 2)}px`;

  const widthPct = 100 / ev.cols;
  const leftPct = (ev.col / ev.cols) * 100;
  block.style.left = `calc(${leftPct}% + 1px)`;
  block.style.width = `calc(${widthPct}% - 2px)`;

  const titleEl = document.createElement('div');
  titleEl.className = 'event-title';
  titleEl.textContent = ev.raw.title;

  const timeEl = document.createElement('div');
  timeEl.className = 'event-time';
  timeEl.textContent = `${formatMinutes(ev.startMin)}–${formatMinutes(ev.endMin)}`;

  block.append(titleEl, timeEl);
  block.title = `${ev.raw.title}\n${formatMinutes(ev.startMin)}–${formatMinutes(ev.endMin)}`;

  block.addEventListener('mousedown', (e) => e.stopPropagation());
  block.addEventListener('click', (e) => {
    e.stopPropagation();
    openEditForm(ev.raw);
  });

  return block;
}

// ---------- Create interaction (click / drag) ----------

function attachCreateInteraction(body, dayStart) {
  let dragging = false;
  let startY = 0;
  let selEl = null;

  const snap = (min) => Math.round(min / 15) * 15;

  const yToMin = (clientY) => {
    const rect = body.getBoundingClientRect();
    let y = clientY - rect.top;
    y = Math.max(0, Math.min(AXIS_HEIGHT, y));
    return (y / AXIS_HEIGHT) * DAY_MINUTES;
  };

  body.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    startY = yToMin(e.clientY);
    selEl = document.createElement('div');
    selEl.className = 'selection';
    body.appendChild(selEl);
    updateSelection(startY, startY);
    e.preventDefault();
  });

  function updateSelection(a, b) {
    const top = Math.min(a, b);
    const bottom = Math.max(a, b);
    selEl.style.top = `${minToPx(top)}px`;
    selEl.style.height = `${minToPx(bottom) - minToPx(top)}px`;
  }

  const onMove = (e) => {
    if (!dragging) return;
    updateSelection(startY, yToMin(e.clientY));
  };

  const onUp = (e) => {
    if (!dragging) return;
    dragging = false;
    const endY = yToMin(e.clientY);
    if (selEl) {
      selEl.remove();
      selEl = null;
    }
    let a = snap(Math.min(startY, endY));
    let b = snap(Math.max(startY, endY));
    if (b - a < 15) {
      // treat as a click: default 1-hour slot
      a = snap(startY);
      b = Math.min(DAY_MINUTES, a + 60);
      if (b - a < 15) {
        a = Math.max(0, b - 60);
      }
    }
    const startDate = new Date(dayStart);
    startDate.setMinutes(startDate.getMinutes() + a);
    const endDate = new Date(dayStart);
    endDate.setMinutes(endDate.getMinutes() + b);
    openCreateForm(startDate, endDate);
  };

  body.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

// ---------- Forms ----------

function closeForm() {
  if (currentForm) {
    currentForm.remove();
    currentForm = null;
  }
}

function buildFormShell(titleText) {
  closeForm();
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) closeForm();
  });

  const form = document.createElement('form');
  form.className = 'event-form';

  const h = document.createElement('h2');
  h.textContent = titleText;
  form.appendChild(h);

  overlay.appendChild(form);
  currentForm = overlay;
  document.body.appendChild(overlay);
  return { overlay, form };
}

function field(form, labelText, type, value) {
  const wrap = document.createElement('label');
  wrap.className = 'field';
  const span = document.createElement('span');
  span.textContent = labelText;
  const input = document.createElement('input');
  input.type = type;
  input.value = value;
  wrap.append(span, input);
  form.appendChild(wrap);
  return input;
}

function errorBox(form) {
  const err = document.createElement('div');
  err.className = 'form-error';
  err.style.display = 'none';
  form.appendChild(err);
  return err;
}

function showError(box, msg) {
  box.textContent = msg;
  box.style.display = 'block';
}

function openCreateForm(startDate, endDate) {
  const { form } = buildFormShell('New Event');
  const titleInput = field(form, 'Title', 'text', '');
  const startInput = field(form, 'Start', 'datetime-local', toDatetimeLocal(startDate));
  const endInput = field(form, 'End', 'datetime-local', toDatetimeLocal(endDate));
  const err = errorBox(form);

  const actions = document.createElement('div');
  actions.className = 'form-actions';
  const cancel = button('Cancel', closeForm, 'secondary');
  const save = button('Create', () => {}, 'primary');
  save.type = 'submit';
  actions.append(cancel, save);
  form.appendChild(actions);

  titleInput.focus();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = readForm(titleInput, startInput, endInput, err);
    if (!payload) return;
    try {
      await createEvent(payload);
      closeForm();
      await reload();
    } catch (ex) {
      showError(err, ex.message);
    }
  });
}

function openEditForm(rawEvent) {
  const { form } = buildFormShell('Edit Event');
  const titleInput = field(form, 'Title', 'text', rawEvent.title);
  const startInput = field(form, 'Start', 'datetime-local', toDatetimeLocal(new Date(rawEvent.start_at)));
  const endInput = field(form, 'End', 'datetime-local', toDatetimeLocal(new Date(rawEvent.end_at)));
  const err = errorBox(form);

  const actions = document.createElement('div');
  actions.className = 'form-actions';
  const del = button('Delete', async () => {
    try {
      await deleteEvent(rawEvent.id);
      closeForm();
      await reload();
    } catch (ex) {
      showError(err, ex.message);
    }
  }, 'danger');
  const cancel = button('Cancel', closeForm, 'secondary');
  const save = button('Save', () => {}, 'primary');
  save.type = 'submit';
  actions.append(del, cancel, save);
  form.appendChild(actions);

  titleInput.focus();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = readForm(titleInput, startInput, endInput, err);
    if (!payload) return;
    try {
      await updateEvent(rawEvent.id, payload);
      closeForm();
      await reload();
    } catch (ex) {
      showError(err, ex.message);
    }
  });
}

function readForm(titleInput, startInput, endInput, err) {
  const title = titleInput.value.trim();
  if (!title) {
    showError(err, 'Title must not be empty.');
    return null;
  }
  if (!startInput.value || !endInput.value) {
    showError(err, 'Start and end times are required.');
    return null;
  }
  const start = new Date(startInput.value);
  const end = new Date(endInput.value);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    showError(err, 'Invalid date/time.');
    return null;
  }
  if (!(end.getTime() > start.getTime())) {
    showError(err, 'End must be after start.');
    return null;
  }
  return {
    title,
    start_at: start.toISOString(),
    end_at: end.toISOString(),
  };
}

// ---------- Data loading ----------

async function reload() {
  const start = new Date(weekStart);
  const end = addDays(weekStart, 7);
  try {
    events = await fetchEvents(start.toISOString(), end.toISOString());
  } catch (ex) {
    console.error('Failed to load events', ex);
    events = [];
  }
  render();
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeForm();
});

reload().then(() => {
  // Scroll to a sensible default position (around 08:00) on first load.
  const cal = document.querySelector('.calendar');
  if (cal) cal.scrollTop = minToPx(8 * 60) - 8;
});
