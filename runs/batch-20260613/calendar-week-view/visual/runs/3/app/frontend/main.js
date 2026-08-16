/**
 * Week Calendar — Main Entry Point
 */
import { computeLayout } from './layout.js';
import { fetchEvents, createEvent, updateEvent, deleteEvent } from './api.js';

const HOUR_HEIGHT  = 60;
const TOTAL_HEIGHT = HOUR_HEIGHT * 24;
const DAY_NAMES    = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
const EVENT_COLORS = ['#4f46e5','#0891b2','#059669','#d97706','#dc2626','#7c3aed','#db2777','#0284c7'];

// ─── Date helpers ─────────────────────────────────────────────────────────────
function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay();
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  d.setHours(0,0,0,0);
  return d;
}
function getWeekDays(ws) {
  return Array.from({length:7}, (_,i) => { const d=new Date(ws); d.setDate(d.getDate()+i); return d; });
}
function fmtWeekRange(ws) {
  const we = new Date(ws); we.setDate(we.getDate()+6);
  const o = {month:'short',day:'numeric'};
  return ws.toLocaleDateString(undefined,o)+' – '+we.toLocaleDateString(undefined,{...o,year:'numeric'});
}
function toDatetimeLocal(d) {
  const p = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtTime(d) { return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); }
function snapMins(m) { return Math.round(m/15)*15; }
function clamp(v,a,b) { return Math.max(a,Math.min(b,v)); }
function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ─── State ────────────────────────────────────────────────────────────────────
let currentWeekStart = getWeekStart(new Date());
let events = [];
let dragState = null;
let modalMode = null;
let editingId = null;

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const weekLabel       = $('week-label');
const dayHeaders      = $('day-headers');
const dayColumns      = $('day-columns');
const hourLines       = $('hour-lines');
const timeGutterInner = $('time-gutter-inner');
const timeGutter      = $('time-gutter');
const gridBodyScroll  = $('grid-body-scroll');
const modalOverlay    = $('modal-overlay');
const modalTitle      = $('modal-title');
const eventForm       = $('event-form');
const inputTitle      = $('input-title');
const inputStart      = $('input-start');
const inputEnd        = $('input-end');
const formError       = $('form-error');
const btnSave         = $('btn-save');
const btnDelete       = $('btn-delete');
const btnCancel       = $('btn-cancel');
const modalClose      = $('modal-close');

// ─── Build static grid ────────────────────────────────────────────────────────
function buildGrid() {
  for (let h = 0; h <= 24; h++) {
    const line = document.createElement('div');
    line.className = 'hour-line';
    line.style.top = (h * HOUR_HEIGHT) + 'px';
    hourLines.appendChild(line);
    if (h < 24) {
      const half = document.createElement('div');
      half.className = 'hour-line half';
      half.style.top = (h * HOUR_HEIGHT + HOUR_HEIGHT/2) + 'px';
      hourLines.appendChild(half);
    }
  }
  for (let h = 1; h <= 23; h++) {
    const lbl = document.createElement('div');
    lbl.className = 'time-label';
    lbl.style.top = (h * HOUR_HEIGHT) + 'px';
    lbl.textContent = String(h).padStart(2,'0') + ':00';
    timeGutterInner.appendChild(lbl);
  }
  gridBodyScroll.addEventListener('scroll', () => { timeGutter.scrollTop = gridBodyScroll.scrollTop; });
}

// ─── Render ───────────────────────────────────────────────────────────────────
function render() {
  const weekDays = getWeekDays(currentWeekStart);
  const today = new Date(); today.setHours(0,0,0,0);

  weekLabel.textContent = fmtWeekRange(weekDays[0]);

  // Day headers
  dayHeaders.innerHTML = '';
  weekDays.forEach((day, i) => {
    const isToday = day.getTime() === today.getTime();
    const h = document.createElement('div');
    h.className = 'day-header' + (isToday ? ' today' : '');
    h.innerHTML = `<div class="day-name">${DAY_NAMES[i]}</div><div class="day-num">${day.getDate()}</div>`;
    dayHeaders.appendChild(h);
  });

  // Day columns + events
  dayColumns.innerHTML = '';
  weekDays.forEach((day, dayIndex) => {
    const isToday = day.getTime() === today.getTime();
    const col = document.createElement('div');
    col.className = 'day-col' + (isToday ? ' today' : '');
    col.dataset.dayIndex = dayIndex;
    col.addEventListener('mousedown', onDayMouseDown);
    dayColumns.appendChild(col);

    const dayStart = new Date(day); dayStart.setHours(0,0,0,0);
    const dayEnd   = new Date(day); dayEnd.setHours(24,0,0,0);
    const dayEvts  = events.filter(ev => new Date(ev.start_at) < dayEnd && new Date(ev.end_at) > dayStart);
    const items    = computeLayout(dayEvts, dayStart);

    items.forEach(({event: ev, top, height, left, width}) => {
      const GAP = 1;
      const block = document.createElement('div');
      block.className = 'event-block';
      block.style.top    = top + 'px';
      block.style.height = Math.max(height, 18) + 'px';
      block.style.left   = `calc(${left*100}% + ${GAP}px)`;
      block.style.width  = `calc(${width*100}% - ${GAP*2}px)`;

      const idx = ((ev.id||0) % EVENT_COLORS.length + EVENT_COLORS.length) % EVENT_COLORS.length;
      const color = EVENT_COLORS[idx];
      block.style.background      = color + 'dd';
      block.style.color           = '#fff';
      block.style.borderLeftColor = color;

      const s = new Date(ev.start_at), e = new Date(ev.end_at);
      block.innerHTML = `<div class="event-title">${escHtml(ev.title)}</div>` +
        (height >= 28 ? `<div class="event-time">${fmtTime(s)} – ${fmtTime(e)}</div>` : '');

      block.addEventListener('click', evt => { evt.stopPropagation(); openEdit(ev); });
      col.appendChild(block);
    });
  });
}

// ─── Drag to create ───────────────────────────────────────────────────────────
function onDayMouseDown(e) {
  if (e.button !== 0 || e.target.closest('.event-block')) return;
  const col = e.currentTarget;
  const rect = col.getBoundingClientRect();
  const y = e.clientY - rect.top + gridBodyScroll.scrollTop;
  const startMin = clamp(Math.floor(y), 0, TOTAL_HEIGHT);

  const sel = document.createElement('div');
  sel.className = 'drag-selection';
  sel.style.top = startMin + 'px';
  sel.style.height = '1px';
  col.appendChild(sel);

  dragState = { dayIndex: parseInt(col.dataset.dayIndex,10), startMin, currentMin: startMin, el: sel, col };
  e.preventDefault();
}

document.addEventListener('mousemove', e => {
  if (!dragState) return;
  const rect = dragState.col.getBoundingClientRect();
  const y = e.clientY - rect.top + gridBodyScroll.scrollTop;
  const cur = clamp(Math.floor(y), 0, TOTAL_HEIGHT);
  dragState.currentMin = cur;
  dragState.el.style.top    = Math.min(dragState.startMin, cur) + 'px';
  dragState.el.style.height = Math.max(Math.abs(cur - dragState.startMin), 1) + 'px';
});

document.addEventListener('mouseup', () => {
  if (!dragState) return;
  const {dayIndex, startMin, currentMin, el} = dragState;
  el.remove(); dragState = null;

  let s = snapMins(Math.min(startMin, currentMin));
  let e = snapMins(Math.max(startMin, currentMin));
  if (e <= s) e = s + 15;
  s = clamp(s, 0, 24*60-15);
  e = clamp(e, s+15, 24*60);

  const day = getWeekDays(currentWeekStart)[dayIndex];
  const sd = new Date(day); sd.setHours(Math.floor(s/60), s%60, 0, 0);
  const ed = new Date(day); ed.setHours(Math.floor(e/60), e%60, 0, 0);
  openCreate(sd, ed);
});

// ─── Modal ────────────────────────────────────────────────────────────────────
function showErr(msg) { formError.textContent = msg; formError.classList.remove('hidden'); }
function hideErr()    { formError.classList.add('hidden'); }

function openCreate(sd, ed) {
  modalMode = 'create'; editingId = null;
  modalTitle.textContent = 'New Event';
  inputTitle.value = '';
  inputStart.value = toDatetimeLocal(sd);
  inputEnd.value   = toDatetimeLocal(ed);
  btnDelete.classList.add('hidden');
  hideErr();
  modalOverlay.classList.remove('hidden');
  setTimeout(() => inputTitle.focus(), 50);
}

function openEdit(ev) {
  modalMode = 'edit'; editingId = ev.id;
  modalTitle.textContent = 'Edit Event';
  inputTitle.value = ev.title;
  inputStart.value = toDatetimeLocal(new Date(ev.start_at));
  inputEnd.value   = toDatetimeLocal(new Date(ev.end_at));
  btnDelete.classList.remove('hidden');
  hideErr();
  modalOverlay.classList.remove('hidden');
  setTimeout(() => inputTitle.focus(), 50);
}

function closeModal() { modalOverlay.classList.add('hidden'); modalMode = null; editingId = null; }

modalClose.addEventListener('click', closeModal);
btnCancel.addEventListener('click', closeModal);
modalOverlay.addEventListener('click', e => { if (e.target === modalOverlay) closeModal(); });

eventForm.addEventListener('submit', async e => {
  e.preventDefault(); hideErr();
  const title = inputTitle.value.trim();
  if (!title) { showErr('Title is required.'); return; }
  const sd = new Date(inputStart.value), ed = new Date(inputEnd.value);
  if (isNaN(sd.getTime())||isNaN(ed.getTime())) { showErr('Invalid dates.'); return; }
  if (ed <= sd) { showErr('End must be after start.'); return; }

  const payload = { title, start_at: sd.toISOString(), end_at: ed.toISOString() };
  try {
    btnSave.disabled = true; btnSave.textContent = 'Saving…';
    if (modalMode === 'create') await createEvent(payload);
    else await updateEvent(editingId, payload);
    closeModal(); await loadAndRender();
  } catch(err) { showErr(err.message||'Save failed.'); }
  finally { btnSave.disabled = false; btnSave.textContent = 'Save'; }
});

btnDelete.addEventListener('click', async () => {
  if (!editingId || !confirm('Delete this event?')) return;
  try {
    btnDelete.disabled = true;
    await deleteEvent(editingId);
    closeModal(); await loadAndRender();
  } catch(err) { showErr(err.message||'Delete failed.'); }
  finally { btnDelete.disabled = false; }
});

// ─── Navigation ───────────────────────────────────────────────────────────────
$('btn-prev').addEventListener('click', () => { currentWeekStart.setDate(currentWeekStart.getDate()-7); loadAndRender(); });
$('btn-next').addEventListener('click', () => { currentWeekStart.setDate(currentWeekStart.getDate()+7); loadAndRender(); });
$('btn-today').addEventListener('click', () => { currentWeekStart = getWeekStart(new Date()); loadAndRender(); });

// ─── Load & Render ────────────────────────────────────────────────────────────
async function loadAndRender() {
  const days = getWeekDays(currentWeekStart);
  const end  = new Date(days[6]); end.setHours(24,0,0,0);
  try { events = await fetchEvents(days[0].toISOString(), end.toISOString()); }
  catch(err) { console.error('fetchEvents failed:', err); events = []; }
  render();
}

// ─── Init ─────────────────────────────────────────────────────────────────────
buildGrid();
loadAndRender();
requestAnimationFrame(() => { gridBodyScroll.scrollTop = 7 * HOUR_HEIGHT; });
