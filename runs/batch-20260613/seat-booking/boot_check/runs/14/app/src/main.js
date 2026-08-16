import './style.css';

// Persistent per-browser session id (identifies the holder).
const SESSION_KEY = 'seat-booking-session';
let sessionId = localStorage.getItem(SESSION_KEY);
if (!sessionId) {
  sessionId = crypto.randomUUID();
  localStorage.setItem(SESSION_KEY, sessionId);
}

const state = {
  seats: [],            // [{id,row,number,status,holdId,holdExpiresAt,bookedBy}]
  inventory: { available: 0, held: 0, booked: 0, total: 0 },
  selected: new Set(),  // seat ids selected for a hold request
  currentHold: null,    // {id, seatIds, expiresAt}
  booked: false,
  ttlMs: 60000,
  message: null,
  countdownTimer: null,
};

const app = document.getElementById('app');

function fmtTime(ms) {
  if (ms < 0) ms = 0;
  const s = Math.ceil(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

async function api(path, opts) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  let body = null;
  try { body = await res.json(); } catch (e) { /* ignore */ }
  return { ok: res.ok, status: res.status, body };
}

async function loadSeats() {
  const { ok, body } = await api('/api/seats');
  if (ok && body) {
    state.seats = body.seats;
    state.inventory = body.inventory;
    state.ttlMs = body.ttlMs;
    render();
  }
}

function seatById(id) {
  return state.seats.find((s) => s.id === id);
}

function onSeatClick(id) {
  const seat = seatById(id);
  if (!seat) return;
  if (state.currentHold) return; // can't change selection while holding
  if (seat.status !== 'available') return;
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  render();
}

async function requestHold() {
  if (state.selected.size === 0) return;
  state.message = null;
  const seatIds = [...state.selected];
  const { ok, status, body } = await api('/api/holds', {
    method: 'POST',
    body: JSON.stringify({ seatIds, sessionId }),
  });
  if (ok && body?.hold) {
    state.currentHold = {
      id: body.hold.id,
      seatIds: body.hold.seatIds,
      expiresAt: new Date(body.hold.expiresAt).getTime(),
    };
    state.selected.clear();
    state.booked = false;
    startCountdown();
    await loadSeats();
  } else if (status === 409) {
    const conflicts = body?.conflicts || [];
    state.message = {
      type: 'error',
      text: `Sorry, these seats were just taken: ${conflicts.join(', ')}. Map refreshed.`,
    };
    // Clear conflicting seats from selection and refresh.
    conflicts.forEach((c) => state.selected.delete(c));
    await loadSeats();
  } else {
    state.message = { type: 'error', text: body?.error || 'Hold failed.' };
    render();
  }
}

async function confirmHold() {
  if (!state.currentHold) return;
  const { ok, body } = await api(`/api/holds/${state.currentHold.id}/confirm`, {
    method: 'POST',
  });
  if (ok && body?.booking) {
    state.booked = true;
    state.message = {
      type: 'ok',
      text: `Booked seats: ${body.booking.seatIds.join(', ')}${body.idempotent ? ' (already booked)' : ''}.`,
    };
    stopCountdown();
    state.currentHold = null;
    await loadSeats();
  } else {
    state.message = { type: 'error', text: body?.error || 'Confirm failed.' };
    state.currentHold = null;
    stopCountdown();
    await loadSeats();
  }
}

async function cancelHold() {
  if (!state.currentHold) return;
  const id = state.currentHold.id;
  state.currentHold = null;
  stopCountdown();
  await api(`/api/holds/${id}`, { method: 'DELETE' });
  state.message = { type: 'ok', text: 'Hold released.' };
  await loadSeats();
}

function startCountdown() {
  stopCountdown();
  state.countdownTimer = setInterval(() => {
    if (!state.currentHold) { stopCountdown(); return; }
    const remaining = state.currentHold.expiresAt - Date.now();
    if (remaining <= 0) {
      stopCountdown();
      state.currentHold = null;
      state.message = { type: 'error', text: 'Your hold expired. Seats released.' };
      loadSeats();
      return;
    }
    renderControls();
  }, 250);
}

function stopCountdown() {
  if (state.countdownTimer) {
    clearInterval(state.countdownTimer);
    state.countdownTimer = null;
  }
}

// ---- SSE live updates ----
function connectStream() {
  const es = new EventSource('/api/stream');
  es.addEventListener('seats', () => {
    // Any seat transition: reload authoritative state.
    loadSeats();
  });
  es.addEventListener('connected', (e) => {
    try { state.ttlMs = JSON.parse(e.data).ttlMs; } catch (_) {}
  });
  es.onerror = () => { /* EventSource auto-reconnects */ };
}

// ---- Rendering ----
function render() {
  app.innerHTML = '';

  const h1 = document.createElement('h1');
  h1.textContent = '🎟️ Event Seat Booking';
  app.appendChild(h1);

  const sub = document.createElement('p');
  sub.className = 'sub';
  sub.textContent = `Session: ${sessionId.slice(0, 8)}`;
  app.appendChild(sub);

  const inv = document.createElement('div');
  inv.className = 'inventory';
  inv.innerHTML = `Available: <b>${state.inventory.available}</b> · Held: <b>${state.inventory.held}</b> · Booked: <b>${state.inventory.booked}</b> · Total: <b>${state.inventory.total}</b>`;
  app.appendChild(inv);

  const legend = document.createElement('div');
  legend.className = 'legend';
  legend.innerHTML = `
    <span class="chip"><span class="swatch available"></span>Available</span>
    <span class="chip"><span class="swatch selected"></span>Selected</span>
    <span class="chip"><span class="swatch held"></span>Held</span>
    <span class="chip"><span class="swatch booked"></span>Booked</span>`;
  app.appendChild(legend);

  const screen = document.createElement('div');
  screen.className = 'screen';
  screen.textContent = 'SCREEN';
  app.appendChild(screen);

  const map = document.createElement('div');
  map.className = 'seat-map';

  const rows = {};
  for (const s of state.seats) {
    (rows[s.row] = rows[s.row] || []).push(s);
  }
  for (const rowLabel of Object.keys(rows)) {
    const rowEl = document.createElement('div');
    rowEl.className = 'row';
    const label = document.createElement('div');
    label.className = 'row-label';
    label.textContent = rowLabel;
    rowEl.appendChild(label);

    for (const seat of rows[rowLabel].sort((a, b) => a.number - b.number)) {
      const el = document.createElement('button');
      let cls = 'seat ' + seat.status;
      if (state.selected.has(seat.id)) cls = 'seat selected';
      // mark seats from my current hold
      if (state.currentHold && state.currentHold.seatIds.includes(seat.id)) {
        cls += ' mine';
      }
      el.className = cls;
      el.textContent = seat.id;
      el.title = `${seat.id} — ${seat.status}`;
      el.addEventListener('click', () => onSeatClick(seat.id));
      rowEl.appendChild(el);
    }
    map.appendChild(rowEl);
  }
  app.appendChild(map);

  const controls = document.createElement('div');
  controls.className = 'controls';
  controls.id = 'controls';
  app.appendChild(controls);
  renderControls();
}

function renderControls() {
  const controls = document.getElementById('controls');
  if (!controls) return;
  controls.innerHTML = '';

  const info = document.createElement('div');
  info.className = 'info';

  if (state.currentHold) {
    const remaining = state.currentHold.expiresAt - Date.now();
    info.innerHTML = `Holding ${state.currentHold.seatIds.join(', ')} — expires in <span class="countdown">${fmtTime(remaining)}</span>`;
  } else if (state.selected.size > 0) {
    info.textContent = `Selected: ${[...state.selected].join(', ')}`;
  } else {
    info.textContent = 'Select available seats to begin.';
  }
  controls.appendChild(info);

  if (state.currentHold) {
    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'btn confirm';
    confirmBtn.textContent = 'Confirm Booking';
    confirmBtn.addEventListener('click', confirmHold);
    controls.appendChild(confirmBtn);

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn cancel';
    cancelBtn.textContent = 'Release Hold';
    cancelBtn.addEventListener('click', cancelHold);
    controls.appendChild(cancelBtn);
  } else {
    const holdBtn = document.createElement('button');
    holdBtn.className = 'btn primary';
    holdBtn.textContent = `Hold ${state.selected.size || ''} Seat${state.selected.size === 1 ? '' : 's'}`.replace('  ', ' ');
    holdBtn.disabled = state.selected.size === 0;
    holdBtn.addEventListener('click', requestHold);
    controls.appendChild(holdBtn);
  }

  if (state.message) {
    const msg = document.createElement('div');
    msg.className = 'msg ' + (state.message.type === 'error' ? 'error' : 'ok');
    msg.textContent = state.message.text;
    controls.appendChild(msg);
  }
}

// init
loadSeats();
connectStream();
