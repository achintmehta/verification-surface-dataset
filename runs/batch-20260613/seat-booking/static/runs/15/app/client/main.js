// Seat-booking SPA frontend.
// - Renders the seat map from GET /api/seats
// - Lets the user select available seats and request a hold
// - Shows a TTL countdown, confirm, and release
// - Connects to SSE for live updates from other users
// - Handles 409 conflicts by flagging taken seats and refreshing

const API = '/api';

// --- session id -------------------------------------------------------------

function getSessionId() {
  let id = localStorage.getItem('seat-session-id');
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) || `s-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem('seat-session-id', id);
  }
  return id;
}
const sessionId = getSessionId();

// --- state ------------------------------------------------------------------

const state = {
  seats: new Map(), // id -> { id, row, number, status }
  selected: new Set(), // seat ids selected by this user (not yet held)
  hold: null, // { holdId, seatIds, expiresAt }
  countdownTimer: null,
};

// --- DOM --------------------------------------------------------------------

const els = {
  map: document.getElementById('seat-map'),
  inventory: document.getElementById('inventory'),
  holdBtn: document.getElementById('hold-btn'),
  confirmBtn: document.getElementById('confirm-btn'),
  releaseBtn: document.getElementById('release-btn'),
  holdStatus: document.getElementById('hold-status'),
  message: document.getElementById('message'),
  connDot: document.getElementById('conn-dot'),
  connText: document.getElementById('conn-text'),
  sessionId: document.getElementById('session-id'),
};
els.sessionId.textContent = sessionId;

// --- rendering --------------------------------------------------------------

function renderMap() {
  // Group seats by row preserving order.
  const rows = new Map();
  for (const seat of state.seats.values()) {
    if (!rows.has(seat.row)) rows.set(seat.row, []);
    rows.get(seat.row).push(seat);
  }
  const rowLabels = [...rows.keys()].sort();

  els.map.innerHTML = '';
  for (const label of rowLabels) {
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';

    const labelEl = document.createElement('span');
    labelEl.className = 'row-label';
    labelEl.textContent = label;
    rowEl.appendChild(labelEl);

    const seats = rows.get(label).sort((a, b) => a.number - b.number);
    for (const seat of seats) {
      rowEl.appendChild(makeSeatButton(seat));
    }
    els.map.appendChild(rowEl);
  }
  renderInventory();
  updateButtons();
}

function makeSeatButton(seat) {
  const btn = document.createElement('button');
  btn.className = 'seat';
  btn.dataset.id = seat.id;
  btn.textContent = seat.number;
  btn.title = `${seat.id} — ${seat.status}`;

  const isMine = state.hold && state.hold.seatIds.includes(seat.id);
  if (state.selected.has(seat.id)) {
    btn.classList.add('selected');
  } else if (seat.status === 'held') {
    btn.classList.add('held');
    btn.disabled = !isMine; // my own held seats stay visible but locked
    if (isMine) btn.title = `${seat.id} — held by you`;
  } else if (seat.status === 'booked') {
    btn.classList.add('booked');
    btn.disabled = true;
  }
  // available -> clickable

  if (seat.status === 'available') {
    btn.addEventListener('click', () => toggleSelect(seat.id));
  }
  return btn;
}

function renderInventory() {
  let available = 0;
  let held = 0;
  let booked = 0;
  for (const s of state.seats.values()) {
    if (s.status === 'available') available++;
    else if (s.status === 'held') held++;
    else if (s.status === 'booked') booked++;
  }
  const total = available + held + booked;
  els.inventory.innerHTML =
    `Total: <b>${total}</b><br>` +
    `Available: <b>${available}</b><br>` +
    `Held: <b>${held}</b><br>` +
    `Booked: <b>${booked}</b>`;
}

function updateButtons() {
  const hasSelection = state.selected.size > 0;
  const hasHold = !!state.hold;
  els.holdBtn.disabled = !hasSelection || hasHold;
  els.confirmBtn.disabled = !hasHold;
  els.releaseBtn.disabled = !hasHold;
}

// --- selection --------------------------------------------------------------

function toggleSelect(id) {
  if (state.hold) return; // cannot change selection while holding
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  renderMap();
}

function clearSelection() {
  state.selected.clear();
}

// --- messages ---------------------------------------------------------------

function setMessage(text, kind = 'info') {
  els.message.textContent = text;
  els.message.className = `message ${kind}`;
}

// --- API actions ------------------------------------------------------------

async function refreshSeats() {
  const res = await fetch(`${API}/seats`);
  const data = await res.json();
  applySeats(data.seats);
  renderMap();
}

function applySeats(seats) {
  for (const seat of seats) {
    state.seats.set(seat.id, seat);
  }
}

async function requestHold() {
  const seatIds = [...state.selected];
  if (seatIds.length === 0) return;
  setMessage('Placing hold…', 'info');
  try {
    const res = await fetch(`${API}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId }),
    });
    if (res.status === 409) {
      const data = await res.json();
      handleConflict(data.conflicts || []);
      return;
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setMessage(data.error || 'Failed to hold seats', 'error');
      await refreshSeats();
      return;
    }
    const hold = await res.json();
    state.hold = { holdId: hold.holdId, seatIds: hold.seatIds, expiresAt: hold.expiresAt };
    clearSelection();
    // Optimistically mark our seats held; SSE will confirm.
    for (const id of hold.seatIds) {
      const s = state.seats.get(id);
      if (s) s.status = 'held';
    }
    setMessage(`Held ${hold.seatIds.length} seat(s). Confirm before the timer runs out.`, 'success');
    startCountdown();
    renderMap();
  } catch (e) {
    setMessage('Network error placing hold', 'error');
  }
}

function handleConflict(conflicts) {
  setMessage(
    `Could not hold — these seats were just taken: ${conflicts.join(', ')}`,
    'error'
  );
  // Flash the conflicting seats then refresh from the server.
  for (const id of conflicts) {
    const btn = els.map.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (btn) {
      btn.classList.add('flash');
      setTimeout(() => btn.classList.remove('flash'), 700);
    }
    state.selected.delete(id);
  }
  refreshSeats();
}

async function confirmHold() {
  if (!state.hold) return;
  setMessage('Confirming…', 'info');
  try {
    const res = await fetch(`${API}/holds/${state.hold.holdId}/confirm`, {
      method: 'POST',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setMessage(data.error || 'Confirmation failed; nothing was booked', 'error');
      stopCountdown();
      state.hold = null;
      await refreshSeats();
      updateButtons();
      return;
    }
    for (const id of data.seatIds || []) {
      const s = state.seats.get(id);
      if (s) s.status = 'booked';
    }
    setMessage(`Booked ${data.seatIds.length} seat(s)! Enjoy the show.`, 'success');
    stopCountdown();
    state.hold = null;
    renderMap();
  } catch (e) {
    setMessage('Network error confirming', 'error');
  }
}

async function releaseHold() {
  if (!state.hold) return;
  const holdId = state.hold.holdId;
  try {
    await fetch(`${API}/holds/${holdId}`, { method: 'DELETE' });
  } catch {
    // ignore — SSE / refresh will reconcile
  }
  stopCountdown();
  state.hold = null;
  setMessage('Hold released.', 'info');
  await refreshSeats();
}

// --- countdown --------------------------------------------------------------

function startCountdown() {
  stopCountdown();
  tickCountdown();
  state.countdownTimer = setInterval(tickCountdown, 250);
}

function stopCountdown() {
  if (state.countdownTimer) clearInterval(state.countdownTimer);
  state.countdownTimer = null;
  els.holdStatus.textContent = '';
}

function tickCountdown() {
  if (!state.hold) {
    stopCountdown();
    return;
  }
  const remaining = new Date(state.hold.expiresAt).getTime() - Date.now();
  if (remaining <= 0) {
    els.holdStatus.innerHTML = '<span class="countdown">Hold expired</span>';
    setMessage('Your hold expired and the seats were released.', 'error');
    stopCountdown();
    state.hold = null;
    refreshSeats();
    updateButtons();
    return;
  }
  const secs = Math.ceil(remaining / 1000);
  els.holdStatus.innerHTML = `Hold expires in <span class="countdown">${secs}s</span>`;
}

// --- SSE --------------------------------------------------------------------

function connectStream() {
  const es = new EventSource(`${API}/stream`);

  es.addEventListener('open', () => {
    els.connDot.classList.add('live');
    els.connText.textContent = 'live';
  });

  es.addEventListener('snapshot', (ev) => {
    const data = JSON.parse(ev.data);
    state.seats.clear();
    applySeats(data.seats);
    reconcileHold();
    renderMap();
  });

  es.addEventListener('seats', (ev) => {
    const data = JSON.parse(ev.data);
    applySeats(data.seats);
    reconcileHold();
    renderMap();
  });

  es.addEventListener('error', () => {
    els.connDot.classList.remove('live');
    els.connText.textContent = 'reconnecting…';
    // EventSource auto-reconnects.
  });
}

// If a server update shows our held seats are no longer held by us
// (released/expired/booked elsewhere), drop our local hold tracking.
function reconcileHold() {
  if (!state.hold) return;
  const stillHeld = state.hold.seatIds.every((id) => {
    const s = state.seats.get(id);
    return s && s.status === 'held';
  });
  const allBooked = state.hold.seatIds.every((id) => {
    const s = state.seats.get(id);
    return s && s.status === 'booked';
  });
  if (allBooked) {
    // Our confirm succeeded (possibly observed via broadcast).
    stopCountdown();
    state.hold = null;
  } else if (!stillHeld) {
    // Lost the hold (expired by server sweep).
    stopCountdown();
    state.hold = null;
    setMessage('Your hold expired and the seats were released.', 'error');
    updateButtons();
  }
}

// --- wire up ----------------------------------------------------------------

els.holdBtn.addEventListener('click', requestHold);
els.confirmBtn.addEventListener('click', confirmHold);
els.releaseBtn.addEventListener('click', releaseHold);

// Release hold if the user leaves the page.
window.addEventListener('beforeunload', () => {
  if (state.hold) {
    navigator.sendBeacon?.(`${API}/holds/${state.hold.holdId}`);
    // sendBeacon can't issue DELETE; best-effort. Server TTL will reclaim.
  }
});

(async function init() {
  setMessage('Loading seat map…', 'info');
  try {
    await refreshSeats();
    setMessage('Select available seats to begin.', 'info');
  } catch {
    setMessage('Failed to load seat map.', 'error');
  }
  connectStream();
})();
