// Seat-booking SPA frontend.
//
// Responsibilities:
//  - render the seat map from GET /api/seats
//  - allow selecting available seats and requesting a hold
//  - show a TTL countdown for the active hold
//  - confirm or release the hold
//  - stay live via SSE (EventSource), reconciling other users' actions
//  - handle 409 conflicts by highlighting taken seats and refreshing

const API = '/api';

// ----- Session id (client-supplied, persisted) -----
function getSessionId() {
  let id = localStorage.getItem('seat-session-id');
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) ||
      'sess-' + Math.random().toString(36).slice(2);
    localStorage.setItem('seat-session-id', id);
  }
  return id;
}
const sessionId = getSessionId();

// ----- App state -----
const state = {
  seats: new Map(),        // id -> seat object {id,row,number,status,holdId,holdExpiresAt,bookedBy}
  selected: new Set(),     // selected seat ids (pre-hold)
  hold: null,              // { holdId, expiresAt, seatIds }
  holdTtlMs: 120000,
  confirmed: false,
};

// ----- DOM refs -----
const els = {
  seatmap: document.getElementById('seatmap'),
  connection: document.getElementById('connection'),
  inventory: document.getElementById('inventory'),
  sessionId: document.getElementById('session-id'),
  selectionInfo: document.getElementById('selection-info'),
  holdBtn: document.getElementById('hold-btn'),
  confirmBtn: document.getElementById('confirm-btn'),
  releaseBtn: document.getElementById('release-btn'),
  countdown: document.getElementById('countdown'),
  message: document.getElementById('message'),
};

els.sessionId.textContent = sessionId;

// ----- Messaging -----
function showMessage(text, kind = 'info') {
  els.message.textContent = text;
  els.message.className = `message ${kind}`;
}
function clearMessage() {
  els.message.textContent = '';
  els.message.className = 'message';
}

// ----- Rendering -----
function seatClass(seat) {
  // Determine the visual class for a seat given app state.
  if (seat.status === 'booked') return 'booked';
  if (seat.status === 'held') {
    // Is it our own hold?
    if (state.hold && seat.holdId === state.hold.holdId) return 'mine';
    return 'held';
  }
  // available
  if (state.selected.has(seat.id)) return 'selected';
  return 'available';
}

function renderSeatMap() {
  // Group seats by row.
  const rows = new Map();
  for (const seat of state.seats.values()) {
    if (!rows.has(seat.row)) rows.set(seat.row, []);
    rows.get(seat.row).push(seat);
  }

  const rowLabels = [...rows.keys()].sort();
  els.seatmap.innerHTML = '';

  for (const label of rowLabels) {
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';

    const labelEl = document.createElement('span');
    labelEl.className = 'row-label';
    labelEl.textContent = label;
    rowEl.appendChild(labelEl);

    const seats = rows.get(label).sort((a, b) => a.number - b.number);
    for (const seat of seats) {
      const btn = document.createElement('button');
      btn.className = `seat ${seatClass(seat)}`;
      btn.textContent = seat.number;
      btn.title = `${seat.row}${seat.number} — ${seat.status}`;
      btn.dataset.id = seat.id;
      btn.addEventListener('click', () => onSeatClick(seat.id));
      rowEl.appendChild(btn);
    }
    els.seatmap.appendChild(rowEl);
  }

  updateInventory();
  updateControls();
}

function updateInventory() {
  const counts = { available: 0, held: 0, booked: 0 };
  for (const s of state.seats.values()) counts[s.status]++;
  const total = state.seats.size;
  els.inventory.textContent =
    `${counts.available} avail · ${counts.held} held · ${counts.booked} booked · ${total} total`;
}

function updateControls() {
  const hasSelection = state.selected.size > 0;
  const hasHold = !!state.hold && !state.confirmed;

  els.holdBtn.disabled = !hasSelection || hasHold;
  els.confirmBtn.disabled = !hasHold;
  els.releaseBtn.disabled = !hasHold;

  if (hasHold) {
    els.selectionInfo.textContent =
      `Holding ${state.hold.seatIds.length} seat(s): ` +
      state.hold.seatIds.map(seatLabel).join(', ');
  } else if (state.confirmed && state.hold) {
    els.selectionInfo.textContent =
      `Booked ${state.hold.seatIds.length} seat(s): ` +
      state.hold.seatIds.map(seatLabel).join(', ');
  } else if (hasSelection) {
    els.selectionInfo.textContent =
      `Selected ${state.selected.size} seat(s): ` +
      [...state.selected].map(seatLabel).join(', ');
  } else {
    els.selectionInfo.textContent = 'No seats selected.';
  }
}

function seatLabel(id) {
  const s = state.seats.get(id);
  return s ? `${s.row}${s.number}` : `#${id}`;
}

// ----- Seat selection -----
function onSeatClick(id) {
  const seat = state.seats.get(id);
  if (!seat) return;

  // While holding, ignore selection changes (must release/confirm first).
  if (state.hold && !state.confirmed) {
    showMessage('Release or confirm your current hold before selecting more seats.', 'info');
    return;
  }
  if (state.confirmed) return;

  if (seat.status === 'booked') return;
  if (seat.status === 'held') return; // someone else holds it

  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);

  renderSeatMap();
}

// ----- API calls -----
async function loadSeats() {
  const res = await fetch(`${API}/seats`);
  const data = await res.json();
  state.holdTtlMs = data.holdTtlMs ?? state.holdTtlMs;
  state.seats = new Map(data.seats.map((s) => [s.id, s]));
  renderSeatMap();
}

async function requestHold() {
  if (state.selected.size === 0) return;
  const seatIds = [...state.selected];
  clearMessage();

  try {
    const res = await fetch(`${API}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId }),
    });

    if (res.status === 409) {
      const err = await res.json();
      const conflicts = err.conflictingSeatIds || [];
      showMessage(
        `Could not hold — these seats were already taken: ${conflicts.map(seatLabel).join(', ')}. Refreshing…`,
        'error',
      );
      state.selected.clear();
      await loadSeats();
      return;
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showMessage(`Hold failed: ${err.message || res.statusText}`, 'error');
      await loadSeats();
      return;
    }

    const hold = await res.json();
    state.hold = hold;
    state.confirmed = false;
    state.selected.clear();

    // Optimistically mark our seats as held-by-us; SSE will confirm.
    for (const id of hold.seatIds) {
      const seat = state.seats.get(id);
      if (seat) {
        seat.status = 'held';
        seat.holdId = hold.holdId;
        seat.holdExpiresAt = hold.expiresAt;
      }
    }

    showMessage(`Held ${hold.seatIds.length} seat(s). Confirm before the timer runs out!`, 'success');
    startCountdown();
    renderSeatMap();
  } catch (e) {
    showMessage(`Network error: ${e.message}`, 'error');
  }
}

async function confirmBooking() {
  if (!state.hold) return;
  clearMessage();
  try {
    const res = await fetch(`${API}/holds/${state.hold.holdId}/confirm`, {
      method: 'POST',
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showMessage(`Confirm failed: ${err.message || res.statusText}`, 'error');
      stopCountdown();
      state.hold = null;
      await loadSeats();
      return;
    }
    const result = await res.json();
    state.confirmed = true;
    stopCountdown();

    // Mark seats booked.
    for (const id of result.seatIds) {
      const seat = state.seats.get(id);
      if (seat) {
        seat.status = 'booked';
        seat.holdId = null;
        seat.bookedBy = state.hold.holdId;
      }
    }
    showMessage(
      result.idempotent
        ? 'Already confirmed — your booking stands.'
        : `Confirmed! Booked ${result.seatIds.length} seat(s).`,
      'success',
    );
    renderSeatMap();
  } catch (e) {
    showMessage(`Network error: ${e.message}`, 'error');
  }
}

async function releaseCurrentHold() {
  if (!state.hold) return;
  clearMessage();
  try {
    const res = await fetch(`${API}/holds/${state.hold.holdId}`, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showMessage(`Release failed: ${err.message || res.statusText}`, 'error');
    } else {
      showMessage('Hold released.', 'info');
    }
  } catch (e) {
    showMessage(`Network error: ${e.message}`, 'error');
  }
  stopCountdown();
  state.hold = null;
  state.confirmed = false;
  await loadSeats();
}

// ----- Countdown -----
let countdownTimer = null;
function startCountdown() {
  stopCountdown();
  els.countdown.classList.remove('hidden');
  const tick = () => {
    if (!state.hold) return stopCountdown();
    const remaining = new Date(state.hold.expiresAt).getTime() - Date.now();
    if (remaining <= 0) {
      // The hold has expired client-side; the server sweep will release it.
      els.countdown.textContent = 'Hold expired';
      els.countdown.classList.add('urgent');
      showMessage('Your hold expired. The seats have been released.', 'error');
      state.hold = null;
      state.confirmed = false;
      stopCountdown();
      loadSeats();
      return;
    }
    const secs = Math.ceil(remaining / 1000);
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    els.countdown.textContent = `Hold expires in ${m}:${String(s).padStart(2, '0')}`;
    els.countdown.classList.toggle('urgent', secs <= 15);
  };
  tick();
  countdownTimer = setInterval(tick, 250);
}
function stopCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = null;
  els.countdown.classList.add('hidden');
  els.countdown.classList.remove('urgent');
}

// ----- SSE live updates -----
function connectSSE() {
  const es = new EventSource(`${API}/stream`);

  es.addEventListener('open', () => {
    els.connection.textContent = '● live';
    els.connection.className = 'conn connected';
  });

  es.addEventListener('error', () => {
    els.connection.textContent = '● reconnecting…';
    els.connection.className = 'conn disconnected';
    // EventSource auto-reconnects.
  });

  es.addEventListener('seat-update', (ev) => {
    try {
      const data = JSON.parse(ev.data);
      applySeatUpdates(data.seats);
    } catch {
      /* ignore malformed */
    }
  });
}

function applySeatUpdates(updates) {
  let changed = false;
  for (const u of updates) {
    const seat = state.seats.get(u.id);
    if (!seat) continue;

    seat.status = u.status;
    seat.holdId = u.holdId ?? null;
    seat.holdExpiresAt = u.holdExpiresAt ?? null;
    if (u.status !== 'booked') seat.bookedBy = null;

    // If a seat we have selected got taken by someone else, deselect it.
    if (u.status !== 'available' && state.selected.has(u.id)) {
      // Only deselect if it's not our own hold.
      if (!(state.hold && u.holdId === state.hold.holdId)) {
        state.selected.delete(u.id);
      }
    }

    // If our held seats were released by expiry on the server, clear our hold.
    if (
      state.hold &&
      !state.confirmed &&
      state.hold.seatIds.includes(u.id) &&
      u.status === 'available'
    ) {
      // The server released our hold (expiry). Drop our local hold.
      state.hold = null;
      stopCountdown();
      showMessage('Your hold expired and seats were released.', 'error');
    }
    changed = true;
  }
  if (changed) renderSeatMap();
}

// ----- Wire up -----
els.holdBtn.addEventListener('click', requestHold);
els.confirmBtn.addEventListener('click', confirmBooking);
els.releaseBtn.addEventListener('click', releaseCurrentHold);

// Best-effort: release the hold if the user navigates away. (The server's TTL
// expiry/sweep is the real guarantee; this just frees seats sooner.)
window.addEventListener('beforeunload', () => {
  if (state.hold && !state.confirmed) {
    // sendBeacon can't issue DELETE, so use fetch with keepalive.
    fetch(`${API}/holds/${state.hold.holdId}`, {
      method: 'DELETE',
      keepalive: true,
    }).catch(() => {});
  }
});

// ----- Boot -----
(async function boot() {
  showMessage('Loading seat map…', 'info');
  try {
    await loadSeats();
    clearMessage();
  } catch (e) {
    showMessage(`Failed to load seats: ${e.message}`, 'error');
  }
  connectSSE();
})();
