/**
 * Seat Booking – Frontend SPA
 *
 * State machine:
 *   idle       → user selects seats → selection
 *   selection  → user clicks "Hold" → holding (or back to idle on 409)
 *   holding    → user confirms      → booked
 *   holding    → TTL expires        → idle (seats released by server)
 *   holding    → user releases      → idle
 *   booked     → user clicks "New"  → idle
 */

const API = 'http://localhost:3001/api';

// ── Session ID ────────────────────────────────────────────────────────────────
function getSessionId() {
  let id = sessionStorage.getItem('sessionId');
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem('sessionId', id);
  }
  return id;
}

const SESSION_ID = getSessionId();
document.getElementById('session-id-display').textContent =
  SESSION_ID.slice(0, 8) + '…';

// ── Application state ─────────────────────────────────────────────────────────
const state = {
  seats: {},          // id → seat object
  selected: new Set(),// ids of seats the user has clicked (pre-hold)
  hold: null,         // { holdId, seatIds, expiresAt }
  booked: null,       // { holdId, seatIds }
  countdownTimer: null,
};

// ── DOM refs ──────────────────────────────────────────────────────────────────
const seatMapEl       = document.getElementById('seat-map');
const selectionPanel  = document.getElementById('selection-panel');
const holdPanel       = document.getElementById('hold-panel');
const bookedPanel     = document.getElementById('booked-panel');
const messageArea     = document.getElementById('message-area');

const selectedCountEl = document.getElementById('selected-count');
const selectedIdsEl   = document.getElementById('selected-ids');
const holdSeatIdsEl   = document.getElementById('hold-seat-ids');
const bookedSeatIdsEl = document.getElementById('booked-seat-ids');
const countdownEl     = document.getElementById('countdown');

const btnHold         = document.getElementById('btn-hold');
const btnClear        = document.getElementById('btn-clear');
const btnConfirm      = document.getElementById('btn-confirm');
const btnRelease      = document.getElementById('btn-release');
const btnNewBooking   = document.getElementById('btn-new-booking');

// ── Utility ───────────────────────────────────────────────────────────────────
function showMessage(text, type = 'info') {
  messageArea.textContent = text;
  messageArea.className = `message-area ${type}`;
}

function hideMessage() {
  messageArea.className = 'message-area hidden';
}

function showPanel(name) {
  selectionPanel.classList.add('hidden');
  holdPanel.classList.add('hidden');
  bookedPanel.classList.add('hidden');
  if (name) document.getElementById(`${name}-panel`).classList.remove('hidden');
}

// ── Seat rendering ────────────────────────────────────────────────────────────
function seatClass(seat) {
  if (state.booked && state.booked.seatIds.includes(seat.id)) return 'booked-own';
  if (state.selected.has(seat.id)) return 'selected';
  if (state.hold && state.hold.seatIds.includes(seat.id)) return 'held-own';
  if (seat.status === 'available') return 'available';
  if (seat.status === 'held')      return 'held-other';
  if (seat.status === 'booked') {
    if (seat.booked_by && state.booked && seat.booked_by === state.booked.holdId) {
      return 'booked-own';
    }
    return 'booked';
  }
  return 'available';
}

function isSeatClickable(seat) {
  // Can only click available seats when not in hold/booked state
  if (state.hold || state.booked) return false;
  return seat.status === 'available';
}

function renderSeatMap() {
  // Group seats by row
  const rows = {};
  for (const seat of Object.values(state.seats)) {
    if (!rows[seat.row_label]) rows[seat.row_label] = [];
    rows[seat.row_label].push(seat);
  }

  seatMapEl.innerHTML = '';

  for (const rowLabel of Object.keys(rows).sort()) {
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';

    const labelEl = document.createElement('div');
    labelEl.className = 'row-label';
    labelEl.textContent = rowLabel;
    rowEl.appendChild(labelEl);

    const seatsEl = document.createElement('div');
    seatsEl.className = 'seats-in-row';

    for (const seat of rows[rowLabel].sort((a, b) => a.seat_number - b.seat_number)) {
      const btn = document.createElement('button');
      btn.className = `seat ${seatClass(seat)}`;
      btn.textContent = seat.seat_number;
      btn.dataset.id = seat.id;
      btn.title = `${seat.row_label}${seat.seat_number} – ${seat.status}`;
      btn.disabled = !isSeatClickable(seat);
      btn.addEventListener('click', () => onSeatClick(seat.id));
      seatsEl.appendChild(btn);
    }

    rowEl.appendChild(seatsEl);
    seatMapEl.appendChild(rowEl);
  }
}

function updateSeatElement(seat) {
  const btn = seatMapEl.querySelector(`[data-id="${seat.id}"]`);
  if (!btn) return;
  btn.className = `seat ${seatClass(seat)}`;
  btn.disabled = !isSeatClickable(seat);
  btn.title = `${seat.row_label}${seat.seat_number} – ${seat.status}`;
}

// ── Seat click handler ────────────────────────────────────────────────────────
function onSeatClick(id) {
  if (state.hold || state.booked) return;
  const seat = state.seats[id];
  if (!seat || seat.status !== 'available') return;

  if (state.selected.has(id)) {
    state.selected.delete(id);
  } else {
    state.selected.add(id);
  }

  updateSeatElement(seat);
  updateSelectionPanel();
  hideMessage();
}

function updateSelectionPanel() {
  if (state.selected.size === 0) {
    showPanel(null);
    return;
  }
  showPanel('selection');
  selectedCountEl.textContent = state.selected.size;
  selectedIdsEl.textContent = [...state.selected].join(', ');
}

// ── Hold flow ─────────────────────────────────────────────────────────────────
async function requestHold() {
  if (state.selected.size === 0) return;
  btnHold.disabled = true;

  try {
    const res = await fetch(`${API}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        seatIds: [...state.selected],
        sessionId: SESSION_ID,
      }),
    });

    const data = await res.json();

    if (res.status === 409) {
      // Some seats were taken
      const conflicting = data.conflictingIds || [];
      showMessage(
        `Seats already taken: ${conflicting.join(', ')}. Please choose different seats.`,
        'error'
      );
      // Refresh seat map to show current state
      await loadSeats();
      // Clear selection of conflicting seats
      for (const id of conflicting) state.selected.delete(id);
      updateSelectionPanel();
      renderSeatMap();
      return;
    }

    if (!res.ok) {
      showMessage(data.error || 'Failed to place hold', 'error');
      return;
    }

    // Success
    state.hold = {
      holdId: data.holdId,
      seatIds: data.seatIds,
      expiresAt: new Date(data.expiresAt),
    };
    state.selected.clear();
    hideMessage();
    showPanel('hold');
    holdSeatIdsEl.textContent = data.seatIds.join(', ');
    startCountdown();
    renderSeatMap();
  } catch (err) {
    showMessage('Network error. Please try again.', 'error');
    console.error(err);
  } finally {
    btnHold.disabled = false;
  }
}

// ── Countdown ─────────────────────────────────────────────────────────────────
function startCountdown() {
  stopCountdown();
  state.countdownTimer = setInterval(updateCountdown, 500);
  updateCountdown();
}

function stopCountdown() {
  if (state.countdownTimer) {
    clearInterval(state.countdownTimer);
    state.countdownTimer = null;
  }
}

function updateCountdown() {
  if (!state.hold) { stopCountdown(); return; }
  const remaining = Math.max(0, state.hold.expiresAt - Date.now());
  const secs = Math.ceil(remaining / 1000);
  const mm = String(Math.floor(secs / 60)).padStart(2, '0');
  const ss = String(secs % 60).padStart(2, '0');
  countdownEl.textContent = `${mm}:${ss}`;
  countdownEl.classList.toggle('urgent', secs <= 10);

  if (remaining === 0) {
    stopCountdown();
    // The server will release the hold; SSE will update the map.
    // Transition UI back to idle.
    showMessage('Your hold has expired. Seats are now available again.', 'info');
    state.hold = null;
    showPanel(null);
    renderSeatMap();
  }
}

// ── Confirm flow ──────────────────────────────────────────────────────────────
async function confirmHold() {
  if (!state.hold) return;
  btnConfirm.disabled = true;
  btnRelease.disabled = true;

  try {
    const res = await fetch(`${API}/holds/${state.hold.holdId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });

    const data = await res.json();

    if (!res.ok) {
      showMessage(data.error || 'Confirmation failed', 'error');
      if (res.status === 410) {
        // Hold expired on server side
        stopCountdown();
        state.hold = null;
        showPanel(null);
        renderSeatMap();
      }
      return;
    }

    // Booked!
    stopCountdown();
    state.booked = {
      holdId: state.hold.holdId,
      seatIds: data.booked,
    };
    state.hold = null;
    hideMessage();
    showPanel('booked');
    bookedSeatIdsEl.textContent = data.booked.join(', ');
    renderSeatMap();
  } catch (err) {
    showMessage('Network error. Please try again.', 'error');
    console.error(err);
  } finally {
    btnConfirm.disabled = false;
    btnRelease.disabled = false;
  }
}

// ── Release flow ──────────────────────────────────────────────────────────────
async function releaseHold() {
  if (!state.hold) return;
  btnRelease.disabled = true;
  btnConfirm.disabled = true;

  try {
    const res = await fetch(`${API}/holds/${state.hold.holdId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });

    if (!res.ok) {
      const data = await res.json();
      showMessage(data.error || 'Failed to release hold', 'error');
      return;
    }

    stopCountdown();
    state.hold = null;
    hideMessage();
    showPanel(null);
    renderSeatMap();
  } catch (err) {
    showMessage('Network error. Please try again.', 'error');
    console.error(err);
  } finally {
    btnRelease.disabled = false;
    btnConfirm.disabled = false;
  }
}

// ── New booking ───────────────────────────────────────────────────────────────
function resetToIdle() {
  state.booked = null;
  state.selected.clear();
  hideMessage();
  showPanel(null);
  renderSeatMap();
}

// ── Load seats ────────────────────────────────────────────────────────────────
async function loadSeats() {
  try {
    const res = await fetch(`${API}/seats`);
    if (!res.ok) throw new Error('Failed to load seats');
    const seats = await res.json();
    for (const seat of seats) {
      state.seats[seat.id] = seat;
    }
  } catch (err) {
    seatMapEl.innerHTML = '<div class="loading">Failed to load seats. Is the server running?</div>';
    console.error(err);
  }
}

// ── SSE ───────────────────────────────────────────────────────────────────────
function connectSSE() {
  const es = new EventSource(`${API}/stream`);

  es.addEventListener('seats:updated', (e) => {
    const updatedSeats = JSON.parse(e.data);
    let holdExpiredByServer = false;

    for (const seat of updatedSeats) {
      state.seats[seat.id] = seat;

      // If one of our held seats was released by the server (expiry sweep)
      if (
        state.hold &&
        state.hold.seatIds.includes(seat.id) &&
        seat.status !== 'held'
      ) {
        holdExpiredByServer = true;
      }
    }

    if (holdExpiredByServer) {
      stopCountdown();
      state.hold = null;
      showMessage('Your hold expired and seats were released.', 'info');
      showPanel(null);
    }

    renderSeatMap();
  });

  es.addEventListener('ping', () => {
    // keepalive – no action needed
  });

  es.onerror = () => {
    console.warn('[sse] Connection lost, will retry…');
  };
}

// ── Button wiring ─────────────────────────────────────────────────────────────
btnHold.addEventListener('click', requestHold);
btnClear.addEventListener('click', () => {
  state.selected.clear();
  hideMessage();
  showPanel(null);
  renderSeatMap();
});
btnConfirm.addEventListener('click', confirmHold);
btnRelease.addEventListener('click', releaseHold);
btnNewBooking.addEventListener('click', resetToIdle);

// ── Bootstrap ─────────────────────────────────────────────────────────────────
(async () => {
  await loadSeats();
  renderSeatMap();
  connectSSE();
})();
