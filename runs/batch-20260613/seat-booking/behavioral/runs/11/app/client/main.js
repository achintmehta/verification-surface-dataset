// Seat-booking SPA frontend.

const API = '/api';

// Stable per-tab session id identifying this holder.
const sessionId = (() => {
  let s = sessionStorage.getItem('seatbooking.sessionId');
  if (!s) {
    s =
      (crypto.randomUUID && crypto.randomUUID()) ||
      `sess_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    sessionStorage.setItem('seatbooking.sessionId', s);
  }
  return s;
})();

// --- App state ------------------------------------------------------------
const state = {
  seats: new Map(), // id -> seat object
  selected: new Set(), // seat ids selected (not yet held)
  hold: null, // { id, seatIds, expiresAt }
  booking: null,
};

let countdownTimer = null;

// --- DOM refs -------------------------------------------------------------
const seatmapEl = document.getElementById('seatmap');
const inventoryEl = document.getElementById('inventory');
const connEl = document.getElementById('connection');
const selectionInfoEl = document.getElementById('selection-info');
const holdBtn = document.getElementById('hold-btn');
const confirmBtn = document.getElementById('confirm-btn');
const releaseBtn = document.getElementById('release-btn');
const countdownEl = document.getElementById('countdown');
const messageEl = document.getElementById('message');

// --- Rendering ------------------------------------------------------------
function effectiveStatus(seat) {
  if (
    seat.status === 'held' &&
    seat.hold_expires_at &&
    new Date(seat.hold_expires_at).getTime() <= Date.now()
  ) {
    return 'available';
  }
  return seat.status;
}

function renderSeatMap() {
  // Group by row.
  const rows = new Map();
  for (const seat of state.seats.values()) {
    if (!rows.has(seat.row_label)) rows.set(seat.row_label, []);
    rows.get(seat.row_label).push(seat);
  }
  const sortedRows = [...rows.keys()].sort();

  seatmapEl.innerHTML = '';
  for (const rowLabel of sortedRows) {
    const rowEl = document.createElement('div');
    rowEl.className = 'row';
    const label = document.createElement('span');
    label.className = 'row-label';
    label.textContent = rowLabel;
    rowEl.appendChild(label);

    const seats = rows.get(rowLabel).sort((a, b) => a.seat_number - b.seat_number);
    for (const seat of seats) {
      rowEl.appendChild(renderSeat(seat));
    }
    seatmapEl.appendChild(rowEl);
  }
}

function renderSeat(seat) {
  const status = effectiveStatus(seat);
  const btn = document.createElement('button');
  btn.className = 'seat';
  btn.dataset.id = seat.id;
  btn.textContent = seat.seat_number;
  btn.title = seat.id;

  const isMine =
    (state.hold && state.hold.seatIds.includes(seat.id)) ||
    (status === 'booked' && seat.booked_by === sessionId);

  let cls = status;
  if (status === 'available' && state.selected.has(seat.id)) cls = 'selected';
  else if (status === 'held' && isMine) cls = 'mine';
  btn.classList.add(cls);

  // Interaction: can only toggle-select available seats when no active hold.
  const selectable = status === 'available' && !state.hold;
  btn.disabled = !selectable;
  if (selectable) {
    btn.addEventListener('click', () => toggleSelect(seat.id));
  }
  return btn;
}

function renderInventory(inv) {
  if (!inv) return;
  inventoryEl.innerHTML = `
    <span>Available <b>${inv.available}</b></span>
    <span>Held <b>${inv.held}</b></span>
    <span>Booked <b>${inv.booked}</b></span>
    <span>Total <b>${inv.total}</b></span>`;
}

function renderControls() {
  const hasSelection = state.selected.size > 0;
  holdBtn.disabled = !hasSelection || !!state.hold;
  confirmBtn.disabled = !state.hold;
  releaseBtn.disabled = !state.hold;

  if (state.hold) {
    selectionInfoEl.textContent = `Holding ${state.hold.seatIds.length} seat(s): ${state.hold.seatIds.join(', ')}`;
  } else if (hasSelection) {
    selectionInfoEl.textContent = `Selected: ${[...state.selected].join(', ')}`;
  } else {
    selectionInfoEl.textContent = 'No seats selected.';
  }
}

function setMessage(text, kind = '') {
  messageEl.textContent = text;
  messageEl.className = `message ${kind}`;
}

// --- Selection ------------------------------------------------------------
function toggleSelect(id) {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  renderSeatMap();
  renderControls();
}

function clearSelection() {
  state.selected.clear();
}

// --- Countdown ------------------------------------------------------------
function startCountdown() {
  stopCountdown();
  countdownEl.hidden = false;
  const tick = () => {
    if (!state.hold) return stopCountdown();
    const remaining = new Date(state.hold.expiresAt).getTime() - Date.now();
    if (remaining <= 0) {
      countdownEl.textContent = 'Hold expired.';
      onHoldExpiredLocally();
      return;
    }
    const s = Math.ceil(remaining / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    countdownEl.textContent = `Hold expires in ${mm}:${ss}`;
  };
  tick();
  countdownTimer = setInterval(tick, 250);
}

function stopCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = null;
  countdownEl.hidden = true;
}

function onHoldExpiredLocally() {
  stopCountdown();
  state.hold = null;
  setMessage('Your hold expired and the seats were released.', 'error');
  renderControls();
  refreshSeats();
}

// --- API calls ------------------------------------------------------------
async function refreshSeats() {
  try {
    const res = await fetch(`${API}/seats`);
    const data = await res.json();
    state.seats = new Map(data.seats.map((s) => [s.id, s]));
    renderInventory(data.inventory);
    renderSeatMap();
    renderControls();
  } catch (err) {
    setMessage('Failed to load seats.', 'error');
  }
}

async function requestHold() {
  const seatIds = [...state.selected];
  if (seatIds.length === 0) return;
  holdBtn.disabled = true;
  try {
    const res = await fetch(`${API}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId }),
    });
    if (res.status === 409) {
      const body = await res.json();
      const conflicts = body.conflicts || [];
      setMessage(
        `Could not hold — already taken: ${conflicts.join(', ')}. Refreshing…`,
        'error',
      );
      // Drop conflicting seats from selection, refresh map.
      conflicts.forEach((id) => state.selected.delete(id));
      await refreshSeats();
      return;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setMessage(body.error || 'Hold failed.', 'error');
      await refreshSeats();
      return;
    }
    const hold = await res.json();
    state.hold = { id: hold.id, seatIds: hold.seatIds, expiresAt: hold.expiresAt };
    clearSelection();
    setMessage(`Held ${hold.seatIds.length} seat(s). Confirm before the timer runs out.`, 'success');
    startCountdown();
    await refreshSeats();
  } catch (err) {
    setMessage('Network error placing hold.', 'error');
  } finally {
    renderControls();
  }
}

async function confirmHold() {
  if (!state.hold) return;
  confirmBtn.disabled = true;
  try {
    const res = await fetch(`${API}/holds/${state.hold.id}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setMessage(body.error || 'Confirmation failed — nothing booked.', 'error');
      stopCountdown();
      state.hold = null;
      await refreshSeats();
      return;
    }
    state.booking = body.booking;
    setMessage(
      `Booked ${body.booking.seatIds.length} seat(s): ${body.booking.seatIds.join(', ')} 🎉`,
      'success',
    );
    stopCountdown();
    state.hold = null;
    await refreshSeats();
  } catch (err) {
    setMessage('Network error confirming.', 'error');
  } finally {
    renderControls();
  }
}

async function releaseHold() {
  if (!state.hold) return;
  releaseBtn.disabled = true;
  const holdId = state.hold.id;
  try {
    await fetch(`${API}/holds/${holdId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    setMessage('Hold released.', '');
  } catch (err) {
    setMessage('Network error releasing hold.', 'error');
  } finally {
    stopCountdown();
    state.hold = null;
    await refreshSeats();
    renderControls();
  }
}

// --- SSE ------------------------------------------------------------------
function applyChanges(changes) {
  let mutated = false;
  for (const c of changes) {
    const seat = state.seats.get(c.seatId);
    if (!seat) continue;
    seat.status = c.status;
    if (c.status === 'held') {
      seat.hold_id = c.hold_id || seat.hold_id;
      seat.hold_expires_at = c.hold_expires_at || seat.hold_expires_at;
      seat.booked_by = null;
    } else if (c.status === 'booked') {
      seat.booked_by = c.booked_by || seat.booked_by;
      seat.hold_expires_at = null;
    } else if (c.status === 'available') {
      seat.hold_id = null;
      seat.hold_expires_at = null;
      seat.booked_by = null;
      // If our own held seat got released externally, drop our hold.
      if (state.hold && state.hold.seatIds.includes(seat.id)) {
        onHoldExpiredLocally();
      }
    }
    mutated = true;
  }
  if (mutated) {
    renderSeatMap();
    recomputeInventory();
    renderControls();
  }
}

function recomputeInventory() {
  const inv = { available: 0, held: 0, booked: 0, total: 0 };
  for (const seat of state.seats.values()) {
    inv[effectiveStatus(seat)]++;
    inv.total++;
  }
  renderInventory(inv);
}

function connectSSE() {
  const es = new EventSource(`${API}/stream`);
  es.addEventListener('open', () => {
    connEl.classList.remove('offline');
    connEl.classList.add('online');
  });
  es.addEventListener('seats', (ev) => {
    try {
      const { changes } = JSON.parse(ev.data);
      applyChanges(changes);
    } catch {
      /* ignore malformed */
    }
  });
  es.addEventListener('error', () => {
    connEl.classList.remove('online');
    connEl.classList.add('offline');
    // EventSource auto-reconnects; refresh on recovery via open handler.
  });
}

// --- Wire up --------------------------------------------------------------
holdBtn.addEventListener('click', requestHold);
confirmBtn.addEventListener('click', confirmHold);
releaseBtn.addEventListener('click', releaseHold);

window.addEventListener('beforeunload', () => {
  // Best-effort release so abandoned holds free faster than TTL.
  if (state.hold) {
    navigator.sendBeacon?.(
      `${API}/holds/${state.hold.id}`,
      new Blob([JSON.stringify({ sessionId })], { type: 'application/json' }),
    );
  }
});

(async function init() {
  await refreshSeats();
  connectSSE();
})();
