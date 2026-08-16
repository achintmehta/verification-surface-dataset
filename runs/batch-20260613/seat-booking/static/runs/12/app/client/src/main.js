import './style.css';
import {
  fetchSeats,
  fetchInventory,
  createHold,
  confirmHold,
  releaseHold,
} from './api.js';

// ---------------------------------------------------------------------------
// Session id: a stable client-supplied identifier (no real auth needed).
// ---------------------------------------------------------------------------
function getSessionId() {
  let id = localStorage.getItem('seat-session-id');
  if (!id) {
    id =
      (crypto.randomUUID && crypto.randomUUID()) ||
      `s-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem('seat-session-id', id);
  }
  return id;
}

const sessionId = getSessionId();

// ---------------------------------------------------------------------------
// In-memory application state.
// ---------------------------------------------------------------------------
const state = {
  seats: new Map(), // id -> seat { id, row, number, status, holdId, bookedBy }
  selected: new Set(), // seat ids the user has selected (available seats)
  hold: null, // { id, seatIds, expiresAt }
  ttlMs: 60000,
  flashing: new Set(), // seat ids that were just taken by someone else (409)
};

// DOM references.
const seatMapEl = document.getElementById('seat-map');
const statusBar = document.getElementById('status-bar');
const inventoryEl = document.getElementById('inventory');
const holdBtn = document.getElementById('hold-btn');
const confirmBtn = document.getElementById('confirm-btn');
const releaseBtn = document.getElementById('release-btn');
const countdownEl = document.getElementById('countdown');
const connectionEl = document.getElementById('connection');
document.getElementById('session-id').textContent = sessionId.slice(0, 8);

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function effectiveClass(seat) {
  if (state.flashing.has(seat.id)) return 'taken-flash';
  if (state.selected.has(seat.id)) return 'selected';
  if (seat.status === 'held' && state.hold && state.hold.seatIds.includes(seat.id)) {
    return 'mine';
  }
  return seat.status; // available | held | booked
}

function buildSeatMap() {
  // Group seats by row.
  const rows = new Map();
  for (const seat of state.seats.values()) {
    if (!rows.has(seat.row)) rows.set(seat.row, []);
    rows.get(seat.row).push(seat);
  }
  const sortedRowLabels = [...rows.keys()].sort();

  seatMapEl.innerHTML = '';
  for (const label of sortedRowLabels) {
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';

    const rowLabelEl = document.createElement('span');
    rowLabelEl.className = 'row-label';
    rowLabelEl.textContent = label;
    rowEl.appendChild(rowLabelEl);

    const seats = rows.get(label).sort((a, b) => a.number - b.number);
    for (const seat of seats) {
      const btn = document.createElement('button');
      btn.className = `seat ${effectiveClass(seat)}`;
      btn.dataset.id = seat.id;
      btn.textContent = seat.number;
      btn.title = `${seat.id} – ${seat.status}`;
      const cls = effectiveClass(seat);
      const interactive = cls === 'available' || cls === 'selected';
      btn.disabled = !interactive || !!state.hold;
      btn.addEventListener('click', () => toggleSeat(seat.id));
      rowEl.appendChild(btn);
    }
    seatMapEl.appendChild(rowEl);
  }
  updateControls();
}

// Patch just the affected seat buttons for efficient live updates.
function patchSeats(seatIds) {
  for (const id of seatIds) {
    const seat = state.seats.get(id);
    const btn = seatMapEl.querySelector(`.seat[data-id="${cssEscape(id)}"]`);
    if (!seat || !btn) {
      // Structure changed; full rebuild.
      buildSeatMap();
      return;
    }
    const cls = effectiveClass(seat);
    btn.className = `seat ${cls}`;
    btn.title = `${seat.id} – ${seat.status}`;
    const interactive = cls === 'available' || cls === 'selected';
    btn.disabled = !interactive || !!state.hold;
  }
  updateControls();
}

function cssEscape(value) {
  if (window.CSS && CSS.escape) return CSS.escape(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

function updateControls() {
  holdBtn.disabled = state.selected.size === 0 || !!state.hold;
  holdBtn.hidden = !!state.hold;
  confirmBtn.hidden = !state.hold;
  releaseBtn.hidden = !state.hold;
}

function setStatus(message, kind = 'info') {
  statusBar.textContent = message;
  statusBar.className = `status-bar ${kind}`;
}

function renderInventory(inv) {
  if (!inv) {
    inventoryEl.textContent = '';
    return;
  }
  inventoryEl.innerHTML =
    `<span>Available: <b>${inv.available}</b></span>` +
    `<span>Held: <b>${inv.held}</b></span>` +
    `<span>Booked: <b>${inv.booked}</b></span>` +
    `<span>Total: <b>${inv.total}</b></span>`;
}

async function refreshInventory() {
  try {
    renderInventory(await fetchInventory());
  } catch {
    /* non-critical */
  }
}

// ---------------------------------------------------------------------------
// Selection & actions
// ---------------------------------------------------------------------------
function toggleSeat(id) {
  if (state.hold) return; // locked while holding
  const seat = state.seats.get(id);
  if (!seat || seat.status !== 'available') return;
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  patchSeats([id]);
}

async function onHold() {
  const seatIds = [...state.selected];
  if (seatIds.length === 0) return;
  holdBtn.disabled = true;
  setStatus('Requesting hold…');
  try {
    const { hold, ttlMs } = await createHold(seatIds, sessionId);
    state.hold = { id: hold.id, seatIds: hold.seatIds, expiresAt: hold.expiresAt };
    state.ttlMs = ttlMs;
    state.selected.clear();
    // Reflect held locally immediately; SSE will confirm for others.
    for (const sid of hold.seatIds) {
      const seat = state.seats.get(sid);
      if (seat) {
        seat.status = 'held';
        seat.holdId = hold.id;
      }
    }
    buildSeatMap();
    startCountdown();
    setStatus(`Held ${hold.seatIds.length} seat(s). Confirm before the timer runs out.`, 'success');
    refreshInventory();
  } catch (err) {
    if (err.status === 409 && err.body?.conflicts) {
      const taken = err.body.conflicts;
      flashTaken(taken);
      setStatus(
        `These seats were just taken: ${taken.join(', ')}. Refreshing…`,
        'error',
      );
      await reloadSeats();
    } else {
      setStatus(err.message || 'Failed to create hold', 'error');
    }
  } finally {
    updateControls();
  }
}

function flashTaken(ids) {
  for (const id of ids) {
    state.selected.delete(id);
    state.flashing.add(id);
  }
  buildSeatMap();
  setTimeout(() => {
    for (const id of ids) state.flashing.delete(id);
    buildSeatMap();
  }, 1500);
}

async function onConfirm() {
  if (!state.hold) return;
  confirmBtn.disabled = true;
  setStatus('Confirming booking…');
  try {
    const result = await confirmHold(state.hold.id);
    for (const seat of result.booked) {
      const s = state.seats.get(seat.id);
      if (s) {
        s.status = 'booked';
        s.bookedBy = sessionId;
      }
    }
    stopCountdown();
    state.hold = null;
    buildSeatMap();
    setStatus(
      `Booked ${result.booked.length} seat(s)${result.idempotent ? ' (already confirmed)' : ''}: ` +
        result.booked.map((s) => s.id).join(', '),
      'success',
    );
    refreshInventory();
  } catch (err) {
    stopCountdown();
    state.hold = null;
    setStatus(err.message || 'Confirmation failed; seats released.', 'error');
    await reloadSeats();
  } finally {
    confirmBtn.disabled = false;
    updateControls();
  }
}

async function onRelease() {
  if (!state.hold) return;
  releaseBtn.disabled = true;
  const holdId = state.hold.id;
  try {
    await releaseHold(holdId);
    setStatus('Hold released.', 'info');
  } catch (err) {
    setStatus(err.message || 'Release failed.', 'error');
  } finally {
    stopCountdown();
    state.hold = null;
    releaseBtn.disabled = false;
    await reloadSeats();
    refreshInventory();
  }
}

// ---------------------------------------------------------------------------
// Countdown timer reflecting the hold's remaining TTL.
// ---------------------------------------------------------------------------
let countdownTimer = null;

function startCountdown() {
  countdownEl.hidden = false;
  stopCountdown();
  const tick = () => {
    if (!state.hold) {
      stopCountdown();
      return;
    }
    const remaining = state.hold.expiresAt - Date.now();
    if (remaining <= 0) {
      stopCountdown();
      onHoldExpired();
      return;
    }
    const secs = Math.ceil(remaining / 1000);
    countdownEl.textContent = `⏳ ${secs}s`;
    countdownEl.classList.toggle('urgent', secs <= 10);
  };
  tick();
  countdownTimer = setInterval(tick, 250);
}

function stopCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = null;
  countdownEl.hidden = true;
  countdownEl.classList.remove('urgent');
}

async function onHoldExpired() {
  state.hold = null;
  setStatus('Your hold expired and the seats were released.', 'error');
  await reloadSeats();
  refreshInventory();
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
async function reloadSeats() {
  const { seats } = await fetchSeats();
  state.seats = new Map(seats.map((s) => [s.id, s]));
  // Drop selections that are no longer available.
  for (const id of [...state.selected]) {
    const s = state.seats.get(id);
    if (!s || s.status !== 'available') state.selected.delete(id);
  }
  // If our held seats are gone, clear the hold.
  if (state.hold) {
    const stillHeld = state.hold.seatIds.some((id) => {
      const s = state.seats.get(id);
      return s && s.status === 'held' && s.holdId === state.hold.id;
    });
    if (!stillHeld) {
      stopCountdown();
      state.hold = null;
    }
  }
  buildSeatMap();
}

// ---------------------------------------------------------------------------
// Server-Sent Events: live updates from other users.
// ---------------------------------------------------------------------------
function connectSSE() {
  const es = new EventSource('/api/stream');

  es.addEventListener('open', () => {
    connectionEl.textContent = '● live';
    connectionEl.className = 'connection online';
  });

  es.addEventListener('snapshot', (e) => {
    const data = JSON.parse(e.data);
    state.seats = new Map(data.seats.map((s) => [s.id, s]));
    buildSeatMap();
    refreshInventory();
  });

  es.addEventListener('seats', (e) => {
    const data = JSON.parse(e.data);
    const changed = [];
    for (const incoming of data.seats) {
      const existing = state.seats.get(incoming.id);
      // Don't let a broadcast clobber our own optimistic hold view; if this
      // seat is part of our active hold and the broadcast says held with our
      // hold id (or available because of someone else), reconcile carefully.
      state.seats.set(incoming.id, incoming);
      changed.push(incoming.id);

      // If our hold's seat was taken/booked by someone else, clear our hold.
      if (
        state.hold &&
        state.hold.seatIds.includes(incoming.id) &&
        !(incoming.status === 'held' && incoming.holdId === state.hold.id) &&
        !(incoming.status === 'booked' && incoming.bookedBy === sessionId)
      ) {
        stopCountdown();
        state.hold = null;
        setStatus('Your hold is no longer valid (expired or released).', 'error');
      }
    }
    patchSeats(changed);
    refreshInventory();
  });

  es.addEventListener('error', () => {
    connectionEl.textContent = '○ reconnecting…';
    connectionEl.className = 'connection offline';
    // EventSource auto-reconnects; nothing else to do.
  });
}

// ---------------------------------------------------------------------------
// Wire up & boot.
// ---------------------------------------------------------------------------
holdBtn.addEventListener('click', onHold);
confirmBtn.addEventListener('click', onConfirm);
releaseBtn.addEventListener('click', onRelease);

async function boot() {
  try {
    await reloadSeats();
    await refreshInventory();
    setStatus('Select available seats, then place a hold.');
  } catch (err) {
    setStatus('Failed to load seats. Is the server running?', 'error');
  }
  connectSSE();
}

boot();
