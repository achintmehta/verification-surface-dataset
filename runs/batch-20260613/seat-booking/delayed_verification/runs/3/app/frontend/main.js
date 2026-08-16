/**
 * Seat Booking – Frontend SPA
 *
 * State machine:
 *   idle  →  (select seats)  →  selecting
 *   selecting  →  (hold)  →  holding
 *   holding  →  (confirm)  →  booked
 *   holding  →  (release / expire)  →  idle
 *   booked  →  (new booking)  →  idle
 */

// In dev, Vite proxies /api → http://localhost:3001/api
// In production, the backend serves the built frontend from the same origin
const API = '/api';

// ---------------------------------------------------------------------------
// Session ID (persisted in sessionStorage so refreshes keep the same session)
// ---------------------------------------------------------------------------
let SESSION_ID = sessionStorage.getItem('sessionId');
if (!SESSION_ID) {
  SESSION_ID = crypto.randomUUID();
  sessionStorage.setItem('sessionId', SESSION_ID);
}
document.getElementById('session-id-display').textContent = SESSION_ID.slice(0, 8) + '…';

// ---------------------------------------------------------------------------
// Application state
// ---------------------------------------------------------------------------
const state = {
  seats: {},          // id → seat object
  selected: new Set(),// seat ids selected by this user (before hold)
  hold: null,         // { holdId, seatIds, expiresAt }
  booked: null,       // { holdId, seatIds }
  countdownTimer: null,
};

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const seatMapEl        = document.getElementById('seat-map');
const selectionPanel   = document.getElementById('selection-panel');
const holdPanel        = document.getElementById('hold-panel');
const bookedPanel      = document.getElementById('booked-panel');
const errorPanel       = document.getElementById('error-panel');
const idlePanel        = document.getElementById('idle-panel');
const selectedCountEl  = document.getElementById('selected-count');
const holdSeatIdsEl    = document.getElementById('hold-seat-ids');
const holdCountdownEl  = document.getElementById('hold-countdown');
const bookedSeatIdsEl  = document.getElementById('booked-seat-ids');
const errorMessageEl   = document.getElementById('error-message');
const conflictSeatsEl  = document.getElementById('conflict-seats');
const sseStatusEl      = document.getElementById('sse-status');

document.getElementById('btn-hold').addEventListener('click', requestHold);
document.getElementById('btn-clear-selection').addEventListener('click', clearSelection);
document.getElementById('btn-confirm').addEventListener('click', confirmHold);
document.getElementById('btn-release').addEventListener('click', releaseHold);
document.getElementById('btn-new-booking').addEventListener('click', resetToIdle);
document.getElementById('btn-dismiss-error').addEventListener('click', dismissError);

// ---------------------------------------------------------------------------
// Panel management
// ---------------------------------------------------------------------------
function showPanel(name) {
  selectionPanel.classList.add('hidden');
  holdPanel.classList.add('hidden');
  bookedPanel.classList.add('hidden');
  errorPanel.classList.add('hidden');
  idlePanel.classList.add('hidden');

  switch (name) {
    case 'selection': selectionPanel.classList.remove('hidden'); break;
    case 'hold':      holdPanel.classList.remove('hidden');      break;
    case 'booked':    bookedPanel.classList.remove('hidden');    break;
    case 'error':     errorPanel.classList.remove('hidden');     break;
    default:          idlePanel.classList.remove('hidden');      break;
  }
}

// ---------------------------------------------------------------------------
// Seat map rendering
// ---------------------------------------------------------------------------
function renderSeatMap() {
  // Group by row
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

    for (const seat of rows[rowLabel].sort((a, b) => a.seat_number - b.seat_number)) {
      const btn = createSeatButton(seat);
      rowEl.appendChild(btn);
    }

    seatMapEl.appendChild(rowEl);
  }
}

function createSeatButton(seat) {
  const btn = document.createElement('button');
  btn.className = 'seat';
  btn.id = `seat-${seat.id}`;
  btn.textContent = seat.seat_number;
  btn.title = `${seat.row_label}${seat.seat_number} – ${getSeatDisplayStatus(seat)}`;
  btn.setAttribute('data-id', seat.id);

  applySeatClass(btn, seat);

  btn.addEventListener('click', () => onSeatClick(seat.id));
  return btn;
}

function getSeatDisplayStatus(seat) {
  if (state.selected.has(seat.id)) return 'selected';
  if (seat.status === 'held' && state.hold && state.hold.seatIds.includes(seat.id)) return 'your hold';
  return seat.status;
}

function applySeatClass(btn, seat) {
  btn.classList.remove('available', 'held-mine', 'held-other', 'booked', 'selected');

  if (state.selected.has(seat.id)) {
    btn.classList.add('selected');
    return;
  }

  if (seat.status === 'held') {
    if (state.hold && state.hold.seatIds.includes(seat.id)) {
      btn.classList.add('held-mine');
    } else {
      btn.classList.add('held-other');
    }
    return;
  }

  if (seat.status === 'booked') {
    btn.classList.add('booked');
    return;
  }

  btn.classList.add('available');
}

function updateSeatEl(seatId) {
  const seat = state.seats[seatId];
  if (!seat) return;
  const btn = document.getElementById(`seat-${seatId}`);
  if (!btn) return;
  applySeatClass(btn, seat);
  btn.title = `${seat.row_label}${seat.seat_number} – ${getSeatDisplayStatus(seat)}`;
}

function flashSeat(seatId) {
  const btn = document.getElementById(`seat-${seatId}`);
  if (!btn) return;
  btn.classList.remove('flash');
  // Force reflow
  void btn.offsetWidth;
  btn.classList.add('flash');
  btn.addEventListener('animationend', () => btn.classList.remove('flash'), { once: true });
}

// ---------------------------------------------------------------------------
// Seat click handler
// ---------------------------------------------------------------------------
function onSeatClick(seatId) {
  // Ignore clicks when a hold is active or booking is done
  if (state.hold || state.booked) return;

  const seat = state.seats[seatId];
  if (!seat || seat.status !== 'available') return;

  if (state.selected.has(seatId)) {
    state.selected.delete(seatId);
  } else {
    state.selected.add(seatId);
  }

  updateSeatEl(seatId);
  updateSelectionPanel();
}

function updateSelectionPanel() {
  const count = state.selected.size;
  selectedCountEl.textContent = count;
  if (count > 0) {
    showPanel('selection');
  } else {
    showPanel('idle');
  }
}

function clearSelection() {
  for (const id of state.selected) {
    state.selected.delete(id);
    updateSeatEl(id);
  }
  showPanel('idle');
}

// ---------------------------------------------------------------------------
// Hold request
// ---------------------------------------------------------------------------
async function requestHold() {
  const seatIds = [...state.selected];
  if (seatIds.length === 0) return;

  try {
    const res = await fetch(`${API}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId: SESSION_ID }),
    });

    const data = await res.json();

    if (res.status === 409) {
      // Conflict – some seats taken
      showError(
        'Some seats are no longer available.',
        data.conflictingSeatIds || [],
      );
      // Refresh seat map to reflect reality
      await loadSeats();
      // Clear selection of conflicting seats
      for (const id of (data.conflictingSeatIds || [])) {
        state.selected.delete(id);
      }
      return;
    }

    if (!res.ok) {
      showError(data.error || 'Failed to place hold.', []);
      return;
    }

    // Success
    state.hold = {
      holdId: data.holdId,
      seatIds: data.seatIds,
      expiresAt: new Date(data.expiresAt),
    };
    state.selected.clear();

    // Update seat states locally
    for (const id of data.seatIds) {
      if (state.seats[id]) {
        state.seats[id].status = 'held';
        state.seats[id].hold_id = data.holdId;
        state.seats[id].hold_expires_at = data.expiresAt;
        updateSeatEl(id);
      }
    }

    holdSeatIdsEl.textContent = data.seatIds.join(', ');
    showPanel('hold');
    startCountdown();
  } catch (err) {
    console.error('requestHold error:', err);
    showError('Network error. Please try again.', []);
  }
}

// ---------------------------------------------------------------------------
// Countdown timer
// ---------------------------------------------------------------------------
function startCountdown() {
  stopCountdown();
  state.countdownTimer = setInterval(tickCountdown, 500);
  tickCountdown();
}

function stopCountdown() {
  if (state.countdownTimer) {
    clearInterval(state.countdownTimer);
    state.countdownTimer = null;
  }
}

function tickCountdown() {
  if (!state.hold) { stopCountdown(); return; }

  const remaining = Math.max(0, state.hold.expiresAt - Date.now());
  const secs = Math.ceil(remaining / 1000);
  const m = Math.floor(secs / 60).toString().padStart(2, '0');
  const s = (secs % 60).toString().padStart(2, '0');
  holdCountdownEl.textContent = `${m}:${s}`;

  if (secs <= 10) {
    holdCountdownEl.classList.add('urgent');
  } else {
    holdCountdownEl.classList.remove('urgent');
  }

  if (remaining === 0) {
    stopCountdown();
    // Hold expired client-side – reset UI
    handleHoldExpired();
  }
}

function handleHoldExpired() {
  if (!state.hold) return;
  const expiredSeatIds = state.hold.seatIds;
  state.hold = null;
  for (const id of expiredSeatIds) {
    if (state.seats[id]) {
      state.seats[id].status = 'available';
      state.seats[id].hold_id = null;
      state.seats[id].hold_expires_at = null;
      updateSeatEl(id);
    }
  }
  showPanel('idle');
}

// ---------------------------------------------------------------------------
// Confirm hold
// ---------------------------------------------------------------------------
async function confirmHold() {
  if (!state.hold) return;

  try {
    const res = await fetch(`${API}/holds/${state.hold.holdId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });

    const data = await res.json();

    if (!res.ok) {
      const msg = data.error || 'Confirmation failed.';
      // If expired, reset hold state
      if (res.status === 410 || res.status === 404) {
        stopCountdown();
        const expiredIds = state.hold ? state.hold.seatIds : [];
        state.hold = null;
        for (const id of expiredIds) {
          if (state.seats[id]) {
            state.seats[id].status = 'available';
            state.seats[id].hold_id = null;
            state.seats[id].hold_expires_at = null;
            updateSeatEl(id);
          }
        }
      }
      showError(msg, []);
      return;
    }

    // Success (including idempotent re-confirm)
    stopCountdown();
    const bookedSeatIds = data.seats.map((s) => s.id);
    state.booked = { holdId: state.hold.holdId, seatIds: bookedSeatIds };
    state.hold = null;

    for (const id of bookedSeatIds) {
      if (state.seats[id]) {
        state.seats[id].status = 'booked';
        state.seats[id].hold_id = null;
        state.seats[id].hold_expires_at = null;
        state.seats[id].booked_by = data.holdId;
        updateSeatEl(id);
      }
    }

    bookedSeatIdsEl.textContent = bookedSeatIds.join(', ');
    showPanel('booked');
  } catch (err) {
    console.error('confirmHold error:', err);
    showError('Network error. Please try again.', []);
  }
}

// ---------------------------------------------------------------------------
// Release hold
// ---------------------------------------------------------------------------
async function releaseHold() {
  if (!state.hold) return;

  try {
    const res = await fetch(`${API}/holds/${state.hold.holdId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });

    const data = await res.json();

    stopCountdown();
    const releasedIds = state.hold.seatIds;
    state.hold = null;

    for (const id of releasedIds) {
      if (state.seats[id]) {
        state.seats[id].status = 'available';
        state.seats[id].hold_id = null;
        state.seats[id].hold_expires_at = null;
        updateSeatEl(id);
      }
    }

    if (!res.ok) {
      showError(data.error || 'Failed to release hold.', []);
      return;
    }

    showPanel('idle');
  } catch (err) {
    console.error('releaseHold error:', err);
    showError('Network error. Please try again.', []);
  }
}

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------
function showError(message, conflictingIds) {
  errorMessageEl.textContent = message;
  if (conflictingIds && conflictingIds.length > 0) {
    conflictSeatsEl.textContent = `Conflicting seats: ${conflictingIds.join(', ')}`;
    conflictSeatsEl.style.display = '';
    // Flash conflicting seats
    for (const id of conflictingIds) flashSeat(id);
  } else {
    conflictSeatsEl.textContent = '';
    conflictSeatsEl.style.display = 'none';
  }
  showPanel('error');
}

function dismissError() {
  if (state.hold) {
    showPanel('hold');
  } else if (state.booked) {
    showPanel('booked');
  } else if (state.selected.size > 0) {
    showPanel('selection');
  } else {
    showPanel('idle');
  }
}

// ---------------------------------------------------------------------------
// Reset to idle
// ---------------------------------------------------------------------------
function resetToIdle() {
  stopCountdown();
  state.hold = null;
  state.booked = null;
  state.selected.clear();
  showPanel('idle');
}

// ---------------------------------------------------------------------------
// Load seats from API
// ---------------------------------------------------------------------------
async function loadSeats() {
  try {
    const res = await fetch(`${API}/seats`);
    const data = await res.json();

    for (const seat of data.seats) {
      state.seats[seat.id] = seat;
    }

    renderSeatMap();
  } catch (err) {
    console.error('loadSeats error:', err);
  }
}

// ---------------------------------------------------------------------------
// SSE – real-time updates
// ---------------------------------------------------------------------------
function connectSSE() {
  const es = new EventSource(`${API}/stream`);

  es.addEventListener('open', () => {
    sseStatusEl.className = 'sse-status connected';
    sseStatusEl.title = 'SSE connected';
  });

  es.addEventListener('error', () => {
    sseStatusEl.className = 'sse-status disconnected';
    sseStatusEl.title = 'SSE disconnected – reconnecting…';
  });

  // seats:held – someone placed a hold
  es.addEventListener('seats:held', (e) => {
    const { seatIds, holdId, expiresAt, sessionId } = JSON.parse(e.data);

    // Skip if this is our own hold (we already updated state)
    if (sessionId === SESSION_ID) return;

    for (const id of seatIds) {
      if (state.seats[id]) {
        state.seats[id].status = 'held';
        state.seats[id].hold_id = holdId;
        state.seats[id].hold_expires_at = expiresAt;
        // Remove from selection if someone else grabbed it
        if (state.selected.has(id)) {
          state.selected.delete(id);
        }
        updateSeatEl(id);
        flashSeat(id);
      }
    }

    // Update selection panel count
    if (state.selected.size > 0) {
      selectedCountEl.textContent = state.selected.size;
    } else if (!state.hold && !state.booked) {
      showPanel('idle');
    }
  });

  // seats:booked – someone confirmed a hold
  es.addEventListener('seats:booked', (e) => {
    const { seatIds, holdId, sessionId } = JSON.parse(e.data);

    if (sessionId === SESSION_ID) return;

    for (const id of seatIds) {
      if (state.seats[id]) {
        state.seats[id].status = 'booked';
        state.seats[id].hold_id = null;
        state.seats[id].hold_expires_at = null;
        state.seats[id].booked_by = holdId;
        updateSeatEl(id);
        flashSeat(id);
      }
    }
  });

  // seats:released – hold expired or was released
  es.addEventListener('seats:released', (e) => {
    const { seatIds } = JSON.parse(e.data);

    for (const id of seatIds) {
      if (state.seats[id]) {
        state.seats[id].status = 'available';
        state.seats[id].hold_id = null;
        state.seats[id].hold_expires_at = null;
        updateSeatEl(id);
        flashSeat(id);
      }
    }

    // If our own hold was released server-side (e.g. swept by expiry)
    if (state.hold) {
      const ourSeatIds = state.hold.seatIds;
      const overlap = seatIds.filter((id) => ourSeatIds.includes(id));
      if (overlap.length > 0) {
        stopCountdown();
        state.hold = null;
        showPanel('idle');
      }
    }
  });

  return es;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function init() {
  showPanel('idle');
  await loadSeats();
  connectSSE();
}

init();
