import {
  startOfWeek, addDays, startOfDay, sameDate, weekdayLabel,
  formatRangeLabel, formatTime, minutesFromMidnight, MINUTES_PER_DAY,
  toDatetimeLocal, fromDatetimeLocal, pad2
} from './dates.js';
import { computeLayout } from './layout.js';
import { fetchEvents, createEvent, updateEvent, deleteEvent } from './api.js';

const HOUR_HEIGHT = 48; // keep in sync with --hour-height
const AXIS_HEIGHT = HOUR_HEIGHT * 24;
const SNAP_MIN = 15;

const state = {
  weekStart: startOfWeek(new Date()),
  events: []
};

const app = document.getElementById('app');

function minToY(min) {
  return (min / MINUTES_PER_DAY) * AXIS_HEIGHT;
}
function yToMin(y) {
  return (y / AXIS_HEIGHT) * MINUTES_PER_DAY;
}
function snap(min) {
  return Math.round(min / SNAP_MIN) * SNAP_MIN;
}

async function load() {
  const start = state.weekStart;
  const end = addDays(state.weekStart, 7);
  try {
    state.events = await fetchEvents(start.toISOString(), end.toISOString());
  } catch (e) {
    state.events = [];
    console.error(e);
  }
  render();
}

// Split events into per-day positioned items, clamped to each day column.
function eventsForDay(dayStart) {
  const dayEnd = addDays(dayStart, 1);
  const items = [];
  for (const ev of state.events) {
    const s = new Date(ev.start_at);
    const e = new Date(ev.end_at);
    if (s >= dayEnd || e <= dayStart) continue; // not in this day
    const startMin = Math.max(0, minutesFromMidnight(s, dayStart));
    const endMin = Math.min(MINUTES_PER_DAY, minutesFromMidnight(e, dayStart));
    if (endMin <= startMin) continue;
    items.push({ id: ev.id, ev, startMin, endMin });
  }
  return items;
}

function render() {
  app.innerHTML = '';

  // Toolbar
  const toolbar = document.createElement('div');
  toolbar.className = 'toolbar';
  toolbar.innerHTML = `
    <h1>Week Calendar</h1>
    <span class="range-label">${formatRangeLabel(state.weekStart)}</span>
    <div class="spacer"></div>
    <div class="nav-group">
      <button data-nav="prev" title="Previous week">‹ Prev</button>
      <button data-nav="today">Today</button>
      <button data-nav="next" title="Next week">Next ›</button>
    </div>
  `;
  toolbar.querySelector('[data-nav="prev"]').onclick = () => { state.weekStart = addDays(state.weekStart, -7); load(); };
  toolbar.querySelector('[data-nav="next"]').onclick = () => { state.weekStart = addDays(state.weekStart, 7); load(); };
  toolbar.querySelector('[data-nav="today"]').onclick = () => { state.weekStart = startOfWeek(new Date()); load(); };
  app.appendChild(toolbar);

  // Calendar scroll container
  const calendar = document.createElement('div');
  calendar.className = 'calendar';
  const inner = document.createElement('div');
  inner.className = 'cal-inner';
  calendar.appendChild(inner);

  // Corner
  const corner = document.createElement('div');
  corner.className = 'corner';
  inner.appendChild(corner);

  // Day headers
  const today = new Date();
  for (let i = 0; i < 7; i++) {
    const day = addDays(state.weekStart, i);
    const isToday = sameDate(day, today);
    const h = document.createElement('div');
    h.className = 'day-header' + (isToday ? ' today' : '');
    h.innerHTML = `<div class="dow">${weekdayLabel(i)}</div><div class="dom">${day.getDate()}</div>`;
    inner.appendChild(h);
  }

  // Time gutter
  const gutter = document.createElement('div');
  gutter.className = 'time-gutter';
  gutter.style.height = AXIS_HEIGHT + 'px';
  for (let hr = 0; hr < 24; hr++) {
    const lbl = document.createElement('div');
    lbl.className = 'time-label';
    lbl.innerHTML = hr === 0 ? '' : `<span>${pad2(hr)}:00</span>`;
    gutter.appendChild(lbl);
  }
  inner.appendChild(gutter);

  // Day columns
  for (let i = 0; i < 7; i++) {
    const day = addDays(state.weekStart, i);
    const isToday = sameDate(day, today);
    const col = document.createElement('div');
    col.className = 'day-col' + (isToday ? ' today' : '');
    col.style.height = AXIS_HEIGHT + 'px';

    for (let hr = 0; hr < 24; hr++) {
      const cell = document.createElement('div');
      cell.className = 'hour-cell';
      col.appendChild(cell);
    }

    const layer = document.createElement('div');
    layer.className = 'events-layer';
    col.appendChild(layer);

    renderDayEvents(layer, startOfDay(day));
    attachDragCreate(col, layer, startOfDay(day));

    inner.appendChild(col);
  }

  app.appendChild(calendar);

  // Scroll to ~7am on first paint
  requestAnimationFrame(() => { calendar.scrollTop = HOUR_HEIGHT * 7; });
}

function renderDayEvents(layer, dayStart) {
  const items = eventsForDay(dayStart);
  const layout = computeLayout(items);

  for (const item of items) {
    const lay = layout.get(item.id);
    const top = minToY(item.startMin);
    const bottom = minToY(item.endMin);
    const height = Math.max(bottom - top, 14);

    const el = document.createElement('div');
    el.className = 'event';
    el.style.top = top + 'px';
    el.style.height = height + 'px';
    // 1px gap between columns via pixel inset
    el.style.left = `calc(${lay.left * 100}% + 1px)`;
    el.style.width = `calc(${lay.width * 100}% - 2px)`;
    el.style.zIndex = String(2 + lay.col);

    const s = new Date(item.ev.start_at);
    const e = new Date(item.ev.end_at);
    el.innerHTML = `
      <div class="ev-title">${escapeHtml(item.ev.title)}</div>
      <div class="ev-time">${formatTime(s)} – ${formatTime(e)}</div>
    `;
    el.title = `${item.ev.title}\n${formatTime(s)} – ${formatTime(e)}`;
    el.onclick = (evt) => { evt.stopPropagation(); openEditModal(item.ev); };
    layer.appendChild(el);
  }
}

function attachDragCreate(col, layer, dayStart) {
  let startY = null;
  let selEl = null;

  const getY = (clientY) => {
    const rect = col.getBoundingClientRect();
    let y = clientY - rect.top + col.scrollTop;
    return Math.max(0, Math.min(AXIS_HEIGHT, y));
  };

  col.addEventListener('mousedown', (e) => {
    if (e.target.closest('.event')) return; // clicking an event
    if (e.button !== 0) return;
    startY = getY(e.clientY);
    selEl = document.createElement('div');
    selEl.className = 'selection';
    selEl.style.top = startY + 'px';
    selEl.style.height = '0px';
    layer.appendChild(selEl);
    e.preventDefault();

    const onMove = (me) => {
      const y = getY(me.clientY);
      const top = Math.min(startY, y);
      const h = Math.abs(y - startY);
      selEl.style.top = top + 'px';
      selEl.style.height = h + 'px';
    };
    const onUp = (ue) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      const y = getY(ue.clientY);
      let aMin = snap(yToMin(Math.min(startY, y)));
      let bMin = snap(yToMin(Math.max(startY, y)));
      if (selEl && selEl.parentNode) selEl.parentNode.removeChild(selEl);
      selEl = null;
      // If it was basically a click (tiny drag), make a default 1h slot.
      if (bMin - aMin < SNAP_MIN) {
        aMin = snap(yToMin(startY));
        bMin = aMin + 60;
      }
      aMin = Math.max(0, Math.min(MINUTES_PER_DAY - SNAP_MIN, aMin));
      bMin = Math.max(aMin + SNAP_MIN, Math.min(MINUTES_PER_DAY, bMin));
      const start = new Date(dayStart.getTime() + aMin * 60000);
      const end = new Date(dayStart.getTime() + bMin * 60000);
      openCreateModal(start, end);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

/* ---------- Modal ---------- */

function openModal({ title, event, isEdit }) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';

  const start = new Date(event.start_at);
  const end = new Date(event.end_at);

  backdrop.innerHTML = `
    <div class="modal">
      <h2>${title}</h2>
      <div class="error"></div>
      <div class="field">
        <label>Title</label>
        <input type="text" name="title" value="${escapeAttr(event.title || '')}" />
      </div>
      <div class="field">
        <label>Start</label>
        <input type="datetime-local" name="start" value="${toDatetimeLocal(start)}" />
      </div>
      <div class="field">
        <label>End</label>
        <input type="datetime-local" name="end" value="${toDatetimeLocal(end)}" />
      </div>
      <div class="modal-actions">
        ${isEdit ? '<button class="danger" data-act="delete">Delete</button>' : ''}
        <div class="spacer"></div>
        <button data-act="cancel">Cancel</button>
        <button class="primary" data-act="save">Save</button>
      </div>
    </div>
  `;

  const close = () => { if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop); };
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });

  const modal = backdrop.querySelector('.modal');
  const errEl = modal.querySelector('.error');
  const titleInput = modal.querySelector('[name="title"]');
  const startInput = modal.querySelector('[name="start"]');
  const endInput = modal.querySelector('[name="end"]');

  const showErr = (msg) => { errEl.textContent = msg; };

  modal.querySelector('[data-act="cancel"]').onclick = close;

  modal.querySelector('[data-act="save"]').onclick = async () => {
    const t = titleInput.value.trim();
    const s = fromDatetimeLocal(startInput.value);
    const en = fromDatetimeLocal(endInput.value);
    if (!t) return showErr('Title is required.');
    if (!s || !en) return showErr('Valid start and end are required.');
    if (!(en.getTime() > s.getTime())) return showErr('End must be after start.');
    const payload = { title: t, start_at: s.toISOString(), end_at: en.toISOString() };
    try {
      if (isEdit) await updateEvent(event.id, payload);
      else await createEvent(payload);
      close();
      await load();
    } catch (err) {
      showErr(err.message || 'Failed to save.');
    }
  };

  const delBtn = modal.querySelector('[data-act="delete"]');
  if (delBtn) {
    delBtn.onclick = async () => {
      try {
        await deleteEvent(event.id);
        close();
        await load();
      } catch (err) {
        showErr(err.message || 'Failed to delete.');
      }
    };
  }

  document.body.appendChild(backdrop);
  titleInput.focus();
  titleInput.select();
}

function openCreateModal(start, end) {
  openModal({
    title: 'New event',
    event: { title: '', start_at: start.toISOString(), end_at: end.toISOString() },
    isEdit: false
  });
}

function openEditModal(ev) {
  openModal({ title: 'Edit event', event: ev, isEdit: true });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

load();
