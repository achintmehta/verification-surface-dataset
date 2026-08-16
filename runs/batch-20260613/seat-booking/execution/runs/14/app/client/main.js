// Seat-booking SPA client.
// State machine: browsing -> (select seats) -> holding -> booked.

const API = '/api';

// --- Session identity -------------------------------------------------------
function getSessionId() {
  let id = localStorage.getItem('sessionId');
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) ||
      's-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('sessionId', id);
  }
  return id;
}
const SESSION_ID = getSessionId();

// --- App state --------------------------------------------------------------
const state = {
  seats: new Map(),        // id -> seat record (effective status)
  selected: new Set(),     // seat ids selected but not yet held
  hold: null,              // { id, seatIds, expiresAt }
  booking: null,           // { holdId, seatIds }
  countdownTimer: null,
};

// --- DOM refs ---------------------------------------------------------------
const el = {
  seatmap: document.getElementById('seatmap'),
  selectionText: document.getElementById('selection-text'),
  holdBtn: document.getElementById('hold-btn'),
  holdBox: document.getElementById('hold-box'),
  holdSeats: document.getElementById('hold-seats'),
  countdown: document.getElementById('countdown'),
  confirmBtn: document.getElementById('confirm-btn'),
  releaseBtn: document.getElementById('release-btn'),
  bookedBox: document.getElementById('booked-box'),
  bookedSeats: document.getElementById('booked-seats'),
  resetBtn: document.getElementById('reset-btn'),
  message: document.getElementById('message'),
  invAvailable: document.getElementById('inv-available'),
  invHeld: document.getElementById('inv-held'),
  invBooked: document.getElementById('inv-booked'),
  connDot: document.getElementById('conn-dot'),
  connText: document.getElementById('conn-text'),
  sessionId: document.getElementById('session-id'),
};
el.sessionId.textContent = SESSION_ID.slice(0, 12);

// --- Helpers ----------------------------------------------------------------
function seatLabel(s) { return `${s.rowLabel}${s.seatNumber}`; }

function showMessage(text, kind = 'info') {
  el.message.textContent = text;
  el.message.className = `message ${kind}`;
}

// Effective UI status for a seat from this client's perspective.
function uiStatus(seat) {
  if (seat.status === 'booked') return 'booked';
  if (seat.status === 'held') {
    // Is it my own active hold?
    if (state.hold && seat.holdId === state.hold.id) return 'mine';
    return 'held';
  }
  // available
  if (state.selected.has(seat.id)) return 'selected';
  return 'available';
}

// --- Rendering --------------------------------------------------------------
function render() {
  const byRow = new Map();
  for (const s of state.seats.values()) {
    if (!byRow.has(s.rowLabel)) byRow.set(s.rowLabel, []);
    byRow.get(s.rowLabel).push(s);
  }

  const rows = [...byRow.keys()].sort();
  el.seatmap.innerHTML = '';
  for (const rowLabel of rows) {
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';

    const label = document.createElement('span');
    label.className = 'row-label';
    label.textContent = rowLabel;
    rowEl.appendChild(label);

    const seats = byRow.get(rowLabel).sort((a, b) => a.seatNumber - b.seatNumber);
    for (const seat of seats) {
      const btn = document.createElement('button');
      const status = uiStatus(seat);
      btn.className = `seat ${status}`;
      btn.textContent = seat.seatNumber;
      btn.title = `${seatLabel(seat)} — ${status}`;
      btn.dataset.id = seat.id;
      // Selectable only when available (and we have no active hold/booking).
      const selectable = status === 'available' || status === 'selected';
      btn.disabled = !selectable || !!state.hold || !!state.booking;
      btn.addEventListener('click', () => toggleSelect(seat.id));
      rowEl.appendChild(btn);
    }
    el.seatmap.appendChild(rowEl);
  }

  updateSelectionUI();
  updateInventory();
}

function updateInventory() {
  let a = 0, h = 0, b = 0;
  for (const s of state.seats.values()) {
    if (s.status === 'available') a++;
    else if (s.status === 'held') h++;
    else if (s.status === 'booked') b++;
  }
  el.invAvailable.textContent = a;
  el.invHeld.textContent = h;
  el.invBooked.textContent = b;
}

function updateSelectionUI() {
  if (state.hold || state.booking) {
    el.holdBtn.disabled = true;
    return;
  }
  const ids = [...state.selected];
  if (ids.length === 0) {
    el.selectionText.textContent = 'No seats selected.';
    el.holdBtn.disabled = true;
  } else {
    const labels = ids
      .map((id) => state.seats.get(id))
      .filter(Boolean)
      .map(seatLabel)
      .sort();
    el.selectionText.textContent = `Selected: ${labels.join(', ')} (${ids.length})`;
    el.holdBtn.disabled = false;
  }
}

function toggleSelect(id) {
  if (state.hold || state.booking) return;
  const seat = state.seats.get(id);
  if (!seat || seat.status !== 'available') return;
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  render();
}

// --- Data flow --------------------------------------------------------------
function upsertSeats(seatList) {
  for (const s of seatList) state.seats.set(s.id, s);
}

async function loadSeats() {
  const res = await fetch(`${API}/seats`);
  const data = await res.json();
  state.seats = new Map(data.seats.map((s) => [s.id, s]));
  // Drop selections that are no longer available.
  for (const id of [...state.selected]) {
    const s = state.seats.get(id);
    if (!s || s.status !== 'available') state.selected.delete(id);
  }
  render();
}

async function requestHold() {
  const seatIds = [...state.selected];
  if (seatIds.length === 0) return;
  el.holdBtn.disabled = true;
  showMessage('Placing hold…', 'info');

  try {
    const res = await fetch(`${API}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId: SESSION_ID }),
    });

    if (res.status === 201) {
      const { hold } = await res.json();
      state.hold = { id: hold.id, seatIds: hold.seatIds, expiresAt: hold.expiresAt };
      state.selected.clear();
      // Optimistically mark seats held by me; SSE will confirm.
      for (const id of hold.seatIds) {
        const s = state.seats.get(id);
        if (s) { s.status = 'held'; s.holdId = hold.id; s.holdExpiresAt = hold.expiresAt; }
      }
      enterHoldUI();
      showMessage('Seats held. Confirm before the timer runs out!', 'success');
      render();
    } else if (res.status === 409) {
      const data = await res.json();
      const taken = (data.conflicts || []).concat(data.missing || []);
      const labels = taken
        .map((id) => state.seats.get(id))
        .filter(Boolean)
        .map(seatLabel);
      flashSeats(taken);
      showMessage(
        `Could not hold — already taken: ${labels.join(', ') || taken.join(', ')}. Refreshing…`,
        'error'
      );
      // Remove taken seats from selection and refresh map.
      for (const id of taken) state.selected.delete(id);
      await loadSeats();
    } else {
      const data = await res.json().catch(() => ({}));
      showMessage(`Hold failed: ${data.message || res.status}`, 'error');
      await loadSeats();
    }
  } catch (e) {
    showMessage(`Network error: ${e.message}`, 'error');
  } finally {
    updateSelectionUI();
  }
}

async function confirmBooking() {
  if (!state.hold) return;
  el.confirmBtn.disabled = true;
  showMessage('Confirming…', 'info');
  try {
    const res = await fetch(`${API}/holds/${state.hold.id}/confirm`, { method: 'POST' });
    if (res.ok) {
      const { booking } = await res.json();
      state.booking = booking;
      const hold = state.hold;
      state.hold = null;
      stopCountdown();
      for (const id of booking.seatIds) {
        const s = state.seats.get(id);
        if (s) { s.status = 'booked'; s.bookedBy = SESSION_ID; s.holdId = null; s.holdExpiresAt = null; }
      }
      enterBookedUI(booking);
      showMessage('Booking confirmed! 🎉', 'success');
      render();
    } else {
      const data = await res.json().catch(() => ({}));
      showMessage(`Could not confirm: ${data.message || res.status}`, 'error');
      // Hold likely expired or invalid -> reset to browsing.
      clearHold();
      await loadSeats();
    }
  } catch (e) {
    showMessage(`Network error: ${e.message}`, 'error');
  } finally {
    el.confirmBtn.disabled = false;
  }
}

async function releaseCurrentHold() {
  if (!state.hold) return;
  const holdId = state.hold.id;
  el.releaseBtn.disabled = true;
  try {
    await fetch(`${API}/holds/${holdId}`, { method: 'DELETE' });
  } catch (e) {
    /* SSE / reload will reconcile */
  }
  clearHold();
  showMessage('Hold released.', 'info');
  await loadSeats();
  el.releaseBtn.disabled = false;
}

// --- UI mode transitions ----------------------------------------------------
function enterHoldUI() {
  el.holdBox.classList.remove('hidden');
  el.bookedBox.classList.add('hidden');
  const labels = state.hold.seatIds
    .map((id) => state.seats.get(id))
    .filter(Boolean)
    .map(seatLabel)
    .sort();
  el.holdSeats.textContent = `Seats: ${labels.join(', ')}`;
  startCountdown(state.hold.expiresAt);
}

function enterBookedUI(booking) {
  el.holdBox.classList.add('hidden');
  el.bookedBox.classList.remove('hidden');
  const labels = booking.seatIds
    .map((id) => state.seats.get(id))
    .filter(Boolean)
    .map(seatLabel)
    .sort();
  el.bookedSeats.textContent = `You booked: ${labels.join(', ')}`;
}

function clearHold() {
  state.hold = null;
  stopCountdown();
  el.holdBox.classList.add('hidden');
}

function resetToBrowsing() {
  state.booking = null;
  state.hold = null;
  state.selected.clear();
  el.bookedBox.classList.add('hidden');
  el.holdBox.classList.add('hidden');
  showMessage('', 'info');
  render();
}

// --- Countdown --------------------------------------------------------------
function startCountdown(expiresAt) {
  stopCountdown();
  const tick = () => {
    const remaining = new Date(expiresAt).getTime() - Date.now();
    if (remaining <= 0) {
      el.countdown.textContent = '0s';
      stopCountdown();
      // Server will have expired the hold; reconcile.
      showMessage('Hold expired. Seats released.', 'error');
      clearHold();
      loadSeats();
      return;
    }
    const s = Math.ceil(remaining / 1000);
    el.countdown.textContent = `${s}s`;
  };
  tick();
  state.countdownTimer = setInterval(tick, 250);
}

function stopCountdown() {
  if (state.countdownTimer) {
    clearInterval(state.countdownTimer);
    state.countdownTimer = null;
  }
}

// --- Flash effect for conflicting seats -------------------------------------
function flashSeats(ids) {
  for (const id of ids) {
    const btn = el.seatmap.querySelector(`.seat[data-id="${id}"]`);
    if (btn) {
      btn.classList.add('flash');
      setTimeout(() => btn.classList.remove('flash'), 600);
    }
  }
}

// --- SSE --------------------------------------------------------------------
function connectSSE() {
  const es = new EventSource(`${API}/stream`);

  es.addEventListener('open', () => {
    el.connDot.className = 'dot online';
    el.connText.textContent = 'live';
  });

  es.addEventListener('snapshot', (e) => {
    const { seats } = JSON.parse(e.data);
    upsertSeats(seats);
    reconcileLocalState();
    render();
  });

  es.addEventListener('seats', (e) => {
    const { seats } = JSON.parse(e.data);
    upsertSeats(seats);
    reconcileLocalState();
    render();
  });

  es.addEventListener('error', () => {
    el.connDot.className = 'dot offline';
    el.connText.textContent = 'reconnecting…';
  });
}

// If my hold's seats got released/booked elsewhere, reconcile UI.
function reconcileLocalState() {
  if (state.hold) {
    const stillMine = state.hold.seatIds.some((id) => {
      const s = state.seats.get(id);
      return s && s.status === 'held' && s.holdId === state.hold.id;
    });
    if (!stillMine) {
      // Either expired/released/booked. If booked by me keep booked UI.
      clearHold();
    }
  }
  // Remove selections that became unavailable.
  for (const id of [...state.selected]) {
    const s = state.seats.get(id);
    if (!s || s.status !== 'available') state.selected.delete(id);
  }
}

// --- Wire up events ---------------------------------------------------------
el.holdBtn.addEventListener('click', requestHold);
el.confirmBtn.addEventListener('click', confirmBooking);
el.releaseBtn.addEventListener('click', releaseCurrentHold);
el.resetBtn.addEventListener('click', resetToBrowsing);

window.addEventListener('beforeunload', () => {
  // Best-effort: release an unconfirmed hold when leaving.
  if (state.hold && navigator.sendBeacon) {
    navigator.sendBeacon(`${API}/holds/${state.hold.id}`, new Blob([], {}));
  }
});

// --- Boot -------------------------------------------------------------------
(async function init() {
  showMessage('Loading seat map…', 'info');
  await loadSeats();
  showMessage('Select available seats to begin.', 'info');
  connectSSE();
})();
