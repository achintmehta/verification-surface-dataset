import { api } from './api.js';
import { computeDayLayout, toMinutes, clampMinutes } from './layout.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const HOUR_HEIGHT  = 64;              // px per hour — must match CSS --hour-height
const TOTAL_HEIGHT = HOUR_HEIGHT * 24;
const MINS_PER_DAY = 1440;
const DAY_NAMES    = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_NAMES  = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

// ── State ─────────────────────────────────────────────────────────────────────
let weekStart = getWeekStart(new Date()); // Monday of the current week
let events    = [];                       // events for the current week
let drag      = null;                     // active drag state

// ── DOM refs ──────────────────────────────────────────────────────────────────
const weekLabel    = document.getElementById('week-label');
const dayHeaders   = document.getElementById('day-headers');
const timeGutter   = document.getElementById('time-gutter');
const hourLines    = document.getElementById('hour-lines');
const dayColumns   = document.getElementById('day-columns');
const gridScroll   = document.getElementById('grid-scroll');
const modalOverlay = document.getElementById('modal-overlay');
const modalTitle   = document.getElementById('modal-title');
const eventForm    = document.getElementById('event-form');
const fTitle       = document.getElementById('f-title');
const fStart       = document.getElementById('f-start');
const fEnd         = document.getElementById('f-end');
const formError    = document.getElementById('form-error');
const btnSave      = document.getElementById('btn-save');
const btnDelete    = document.getElementById('btn-delete');
const btnCancel    = document.getElementById('btn-cancel');

// ── Week helpers ──────────────────────────────────────────────────────────────

function getWeekStart(date) {
  const d   = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day  = d.getDay();                    // 0=Sun … 6=Sat
  const diff = day === 0 ? -6 : 1 - day;     // shift to Monday
  d.setDate(d.getDate() + diff);
  return d;
}

function weekDays(monday) {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(d.getDate() + i);
    return d;
  });
}

function dayStart(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function dayEnd(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  return d;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function toDatetimeLocal(date) {
  const d = new Date(date);
  return (
    d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
  );
}

function formatTime(date) {
  const d = new Date(date);
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Time ↔ pixel helpers ──────────────────────────────────────────────────────

function minsToPixels(mins) {
  return (clampMinutes(mins) / MINS_PER_DAY) * TOTAL_HEIGHT;
}

function pixelsToMins(px) {
  return Math.round((px / TOTAL_HEIGHT) * MINS_PER_DAY);
}

function snapMins(mins) {
  return Math.round(mins / 15) * 15;
}

// ── Static grid (built once) ──────────────────────────────────────────────────

function buildStaticGrid() {
  // Time gutter hour labels
  timeGutter.innerHTML = '';
  for (let h = 0; h < 24; h++) {
    const div = document.createElement('div');
    div.className   = 'gutter-hour';
    div.textContent = h === 0 ? '' : pad2(h) + ':00';
    timeGutter.appendChild(div);
  }

  // Hour lines and half-hour dashed lines
  hourLines.innerHTML = '';
  for (let h = 0; h <= 24; h++) {
    const line = document.createElement('div');
    line.className  = 'hour-line';
    line.style.top  = minsToPixels(h * 60) + 'px';
    hourLines.appendChild(line);

    if (h < 24) {
      const half = document.createElement('div');
      half.className = 'half-line';
      half.style.top = minsToPixels(h * 60 + 30) + 'px';
      hourLines.appendChild(half);
    }
  }
}

// ── Week render ───────────────────────────────────────────────────────────────

function renderWeek() {
  const days  = weekDays(weekStart);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Week label
  const endDay     = days[6];
  const startMonth = MONTH_NAMES[days[0].getMonth()];
  const endMonth   = MONTH_NAMES[endDay.getMonth()];
  const year       = endDay.getFullYear();
  weekLabel.textContent =
    startMonth === endMonth
      ? startMonth + ' ' + days[0].getDate() + '\u2013' + endDay.getDate() + ', ' + year
      : startMonth + ' ' + days[0].getDate() + ' \u2013 ' + endMonth + ' ' + endDay.getDate() + ', ' + year;

  // Day headers
  dayHeaders.innerHTML = '';
  days.forEach(function(day, i) {
    const isToday = day.getTime() === today.getTime();
    const hdr     = document.createElement('div');
    hdr.className = 'day-header' + (isToday ? ' today' : '');
    hdr.innerHTML =
      '<span class="day-name">' + DAY_NAMES[i] + '</span>' +
      '<span class="day-num">'  + day.getDate() + '</span>';
    dayHeaders.appendChild(hdr);
  });

  // Day columns
  dayColumns.innerHTML = '';
  days.forEach(function(day, dayIdx) {
    const isToday = day.getTime() === today.getTime();
    const col     = document.createElement('div');
    col.className       = 'day-col' + (isToday ? ' today-col' : '');
    col.dataset.dayIdx  = String(dayIdx);
    dayColumns.appendChild(col);
  });

  renderEvents(days);
}

// ── Event rendering ───────────────────────────────────────────────────────────

function renderEvents(days) {
  // Remove existing event blocks
  var existing = document.querySelectorAll('.event-block');
  for (var k = 0; k < existing.length; k++) {
    existing[k].remove();
  }

  // Group events by day column
  var byDay = [];
  for (var d = 0; d < 7; d++) {
    byDay.push([]);
  }

  events.forEach(function(ev) {
    var evStart = new Date(ev.start_at);
    for (var i = 0; i < 7; i++) {
      var colStart = dayStart(days[i]);
      var colEnd   = dayEnd(days[i]);
      if (evStart >= colStart && evStart < colEnd) {
        var startMins = clampMinutes(toMinutes(evStart));
        var evEnd     = new Date(ev.end_at);
        var endMins;
        if (evEnd >= colEnd) {
          endMins = 1440; // clamp to end of day
        } else {
          endMins = clampMinutes(toMinutes(evEnd));
        }
        byDay[i].push(Object.assign({}, ev, { startMin: startMins, endMin: endMins }));
        break;
      }
    }
  });

  var colEls = document.querySelectorAll('.day-col');

  byDay.forEach(function(dayEvents, dayIdx) {
    var colEl = colEls[dayIdx];
    if (!colEl) return;

    var layout = computeDayLayout(dayEvents);

    layout.forEach(function(item) {
      var ev       = item.event;
      var colIndex = item.colIndex;
      var colCount = item.colCount;

      var top    = minsToPixels(ev.startMin);
      var bottom = minsToPixels(ev.endMin);
      var height = Math.max(bottom - top, 18);

      var block = document.createElement('div');
      block.className       = 'event-block';
      block.dataset.eventId = String(ev.id);

      block.style.top    = top + 'px';
      block.style.height = height + 'px';

      if (colCount === 1) {
        block.style.left  = '0%';
        block.style.width = '100%';
      } else {
        // Distribute a 2px gap between adjacent event columns.
        // Total gap = 2 * (colCount - 1) px spread across colCount columns.
        var GAP        = 2;
        var totalGap   = GAP * (colCount - 1);
        var widthPct   = 100 / colCount;
        var leftPct    = (colIndex / colCount) * 100;
        var widthDebit = totalGap / colCount;
        block.style.left  = 'calc(' + leftPct  + '% + ' + (colIndex * GAP) + 'px)';
        block.style.width = 'calc(' + widthPct + '% - ' + widthDebit + 'px)';
      }

      var startLabel = formatTime(new Date(ev.start_at));
      var endLabel   = formatTime(new Date(ev.end_at));

      block.innerHTML =
        '<div class="ev-title">' + escapeHtml(ev.title) + '</div>' +
        '<div class="ev-time">'  + startLabel + '\u2013' + endLabel + '</div>';

      block.addEventListener('click', (function(capturedEv) {
        return function(e) {
          e.stopPropagation();
          openEditModal(capturedEv);
        };
      })(ev));

      colEl.appendChild(block);
    });
  });
}

// ── Drag-to-create ────────────────────────────────────────────────────────────

function getMinsFromMouseEvent(e, colEl) {
  var rect = colEl.getBoundingClientRect();
  var y    = e.clientY - rect.top + gridScroll.scrollTop;
  return snapMins(clampMinutes(pixelsToMins(y)));
}

// Single mousedown listener on the columns container (event delegation)
dayColumns.addEventListener('mousedown', function(e) {
  if (e.button !== 0) return;
  var colEl = e.target.closest('.day-col');
  if (!colEl) return;
  if (e.target.closest('.event-block')) return;

  e.preventDefault();

  var dayIdx     = parseInt(colEl.dataset.dayIdx, 10);
  var days       = weekDays(weekStart);
  var day        = days[dayIdx];
  var startMins  = getMinsFromMouseEvent(e, colEl);

  var selectionEl = document.createElement('div');
  selectionEl.className  = 'drag-selection';
  selectionEl.style.top  = minsToPixels(startMins) + 'px';
  selectionEl.style.height = minsToPixels(15) + 'px';
  colEl.appendChild(selectionEl);

  drag = { colEl: colEl, day: day, startMins: startMins, selectionEl: selectionEl };
});

window.addEventListener('mousemove', function(e) {
  if (!drag) return;
  var current = getMinsFromMouseEvent(e, drag.colEl);
  var lo      = Math.min(drag.startMins, current);
  var hi      = Math.max(drag.startMins, current);
  var top     = minsToPixels(lo);
  var height  = Math.max(minsToPixels(hi) - top, minsToPixels(15));
  drag.selectionEl.style.top    = top + 'px';
  drag.selectionEl.style.height = height + 'px';
});

window.addEventListener('mouseup', function(e) {
  if (!drag) return;

  var current = getMinsFromMouseEvent(e, drag.colEl);
  var lo      = Math.min(drag.startMins, current);
  var hi      = Math.max(drag.startMins, current);

  // Ensure at least 30 minutes if the user just clicked without dragging
  if (hi - lo < 15) {
    hi = lo + 30;
  }

  drag.selectionEl.remove();
  var day = drag.day;
  drag = null;

  var startDate = new Date(day);
  startDate.setHours(Math.floor(lo / 60), lo % 60, 0, 0);

  var endMins = Math.min(hi, 1440);
  var endDate = new Date(day);
  endDate.setHours(Math.floor(endMins / 60), endMins % 60, 0, 0);

  openCreateModal(startDate, endDate);
});

// ── Modal ─────────────────────────────────────────────────────────────────────

var editingEventId = null;

function showError(msg) {
  formError.textContent = msg;
  formError.classList.remove('hidden');
}

function hideError() {
  formError.classList.add('hidden');
}

function openCreateModal(startDate, endDate) {
  editingEventId    = null;
  modalTitle.textContent = 'New Event';
  fTitle.value = '';
  fStart.value = toDatetimeLocal(startDate);
  fEnd.value   = toDatetimeLocal(endDate);
  btnDelete.classList.add('hidden');
  hideError();
  modalOverlay.classList.remove('hidden');
  fTitle.focus();
}

function openEditModal(ev) {
  editingEventId    = ev.id;
  modalTitle.textContent = 'Edit Event';
  fTitle.value = ev.title;
  fStart.value = toDatetimeLocal(new Date(ev.start_at));
  fEnd.value   = toDatetimeLocal(new Date(ev.end_at));
  btnDelete.classList.remove('hidden');
  hideError();
  modalOverlay.classList.remove('hidden');
  fTitle.focus();
}

function closeModal() {
  modalOverlay.classList.add('hidden');
  editingEventId = null;
}

function localDatetimeToISO(str) {
  return new Date(str).toISOString();
}

eventForm.addEventListener('submit', async function(e) {
  e.preventDefault();
  hideError();

  var title    = fTitle.value.trim();
  var startVal = fStart.value;
  var endVal   = fEnd.value;

  if (!title)    { showError('Title is required.');      return; }
  if (!startVal) { showError('Start time is required.'); return; }
  if (!endVal)   { showError('End time is required.');   return; }

  var startISO = localDatetimeToISO(startVal);
  var endISO   = localDatetimeToISO(endVal);

  if (new Date(endISO) <= new Date(startISO)) {
    showError('End time must be after start time.');
    return;
  }

  btnSave.disabled = true;
  try {
    if (editingEventId === null) {
      await api.createEvent(title, startISO, endISO);
    } else {
      await api.updateEvent(editingEventId, title, startISO, endISO);
    }
    closeModal();
    await loadAndRender();
  } catch (err) {
    showError(err.message || 'Failed to save event.');
  } finally {
    btnSave.disabled = false;
  }
});

btnDelete.addEventListener('click', async function() {
  if (editingEventId === null) return;
  if (!confirm('Delete this event?')) return;
  btnDelete.disabled = true;
  try {
    await api.deleteEvent(editingEventId);
    closeModal();
    await loadAndRender();
  } catch (err) {
    showError(err.message || 'Failed to delete event.');
  } finally {
    btnDelete.disabled = false;
  }
});

btnCancel.addEventListener('click', closeModal);

modalOverlay.addEventListener('click', function(e) {
  if (e.target === modalOverlay) closeModal();
});

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') closeModal();
});

// ── Navigation ────────────────────────────────────────────────────────────────

document.getElementById('btn-prev').addEventListener('click', function() {
  weekStart = new Date(weekStart);
  weekStart.setDate(weekStart.getDate() - 7);
  loadAndRender();
});

document.getElementById('btn-next').addEventListener('click', function() {
  weekStart = new Date(weekStart);
  weekStart.setDate(weekStart.getDate() + 7);
  loadAndRender();
});

document.getElementById('btn-today').addEventListener('click', function() {
  weekStart = getWeekStart(new Date());
  loadAndRender();
});

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadAndRender() {
  var days       = weekDays(weekStart);
  var rangeStart = dayStart(days[0]);
  var rangeEnd   = dayEnd(days[6]);

  try {
    events = await api.getEvents(rangeStart, rangeEnd);
  } catch (err) {
    console.error('Failed to load events:', err);
    events = [];
  }

  renderWeek();
}

// ── Initialization ────────────────────────────────────────────────────────────

buildStaticGrid();
loadAndRender().then(function() {
  // Scroll to 07:00 on initial load
  gridScroll.scrollTop = minsToPixels(7 * 60);
});
