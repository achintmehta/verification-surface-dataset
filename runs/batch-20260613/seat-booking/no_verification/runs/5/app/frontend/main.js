/**
 * Seat Booking – Frontend SPA
 *
 * State machine:
 *   idle        → user selects seats → hold-pending
 *   hold-pending → POST /api/holds succeeds → holding
 *   holding      → POST /api/holds/:id/confirm → booked
 *   holding      → DELETE /api/holds/:id       → idle
 *   holding      → TTL expires (SSE)            → idle
 *   booked       → btn-new-booking              → idle
 */

// In development, Vite proxies /api → http://localhost:3001/api
// In production (served directly from Express), /api is the same origin.
const API = '/api';

// ── Session ID ────────────────────────────────────────────────────────────────
const SESSION_ID = (() => {
  const key = 'seat-booking-session';
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(key, id);
  }
  return id;
})();

document.getElementById('session-id-display').textContent =
  SESSION_ID.slice(0, 8) + '…';

// ── Application State ─────────────────────────────────────────────────────────
const state = {
  seats: {},           // id → seat object
  selected: new Set(), // ids of seats the user has clicked (pre-hold)
  hold: null,          // { holdId, seatIds, expiresAt } or null
  booked: null,        // { holdId, seatIds } or null
  countdownTimer: null,
};

// ── DOM refs ──────────────────────────────────────────────────────────────────
const seatMapEl        = document.getElementById('seat-map');
const holdPanel        = document.getElementById('hold-panel');
const activeHoldPanel  = document.getElementById('active-hold-panel');
const bookedPanel      = document.getElementById('booked-panel');
const errorPanel       = document.getElementById('error-panel');
const idlePanel        = document.getElementById('idle-panel');

const selectedSeatsList = document.getElementById('selected-seats-list');
const heldSeatsList     = document.getElementById('held-seats-list');
const bookedSeatsList   = document.getElementById('booked-seats-list');
const conflictSeatsEl   = document.getElementById('conflict-seats');
const holdCountdown     = document.getElementById('hold-countdown');

const btnHold           = document.getElementById('btn-hold');
const btnClearSelection = document.getElementById('btn-clear-selection');
const btnConfirm        = document.getElementById('btn-confirm');
const btnRelease        = document.getElementById('btn-release');
const btnNewBooking     = document.getElementById('btn-new-booking');
const btnErrorDismiss   = document.getElementById('btn-error-dismiss');

const invAvailable = document.getElementById('inv-available');
const invHeld      = document.getElementById('inv-held');
const invBooked    = document.getElementById('inv-booked');
const invTotal     = document.getElementById('inv-total');

const sseStatusEl  = document.getElementById('sse-status');

// ── Utility ───────────────────────────────────────────────────────────────────
function seatClass(seat) {
  if (seat.status === 'booked') return 'booked';
  if (seat.status === 'held') {
    return seat.hold_id && state.hold && seat.hold_id === state.hold.holdId
      ? 'held-own'
      : 'held-other';
  }
  if (state.selected.has(seat.id)) return 'selected';
  return 'available';
}

function renderSeatTags(container, ids) {
  container.innerHTML = ids
    .map(id => `<span class="seat-tag">${id}</span>`)
    .join('');
}

function updateInventory() {
  const seats = Object.values(state.seats);
  const total = seats.length;
  const booked = seats.filter(s => s.status === 'booked').length;
  const held   = seats.filter(s => s.status === 'held').length;
  const avail  = total - booked - held;
  invAvailable.textContent = avail;
  invHeld.textContent      = held;
  invBooked.textContent    = booked;
  invTotal.textContent     = total;
}

// ── Panel visibility ──────────────────────────────────────────────────────────
function showPanel(name) {
  holdPanel.classList.add('hidden');
  activeHoldPanel.classList.add('hidden');
  bookedPanel.classList.add('hidden');
  errorPanel.classList.add('hidden');
  idlePanel.classList.add('hidden');

  switch (name) {
    case 'hold':        holdPanel.classList.remove('hidden');       break;
    case 'active-hold': activeHoldPanel.classList.remove('hidden'); break;
    case 'booked':      bookedPanel.classList.remove('hidden');     break;
    case 'error':       errorPanel.classList.remove('hidden');      break;
    default:            idlePanel.classList.remove('hidden');       break;
  }
}

// ── Seat Map Rendering ────────────────────────────────────────────────────────
function buildSeatMap(seats) {
  // Group by row
  const rows = {};
  for (const seat of seats) {
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
      seatsEl.appendChild(createSeatEl(seat));
    }

    rowEl.appendChild(seatsEl);
    seatMapEl.appendChild(rowEl);
  }
}

function createSeatEl(seat) {
  const el = document.createElement('div');
  el.className = `seat ${seatClass(seat)}`;
  el.dataset.id = seat.id;
  el.textContent = seat.seat_number;
  el.title = `${seat.id} – ${seat.status}`;
  el.addEventListener('click', () => onSeatClick(seat.id));
  return el;
}

function updateSeatEl(seat) {
  const el = seatMapEl.querySelector(`[data-id="${seat.id}"]`);
  if (!el) return;
  const cls = seatClass(seat);
  el.className = `seat ${cls}`;
  el.title = `${seat.id} – ${seat.status}`;
}

function flashSeat(seatId, flashClass) {
  const el = seatMapEl.querySelector(`[data-id="${seatId}"]`);
  if (!el) return;
  el.classList.add(flashClass);
  el.addEventListener('animationend', () => el.classList.remove(flashClass), { once: true });
}

// ── Seat Click Handler ────────────────────────────────────────────────────────
function onSeatClick(seatId) {
  // Ignore clicks when we have an active hold or booking
  if (state.hold || state.booked) return;

  const seat = state.seats[seatId];
  if (!seat || seat.status !== 'available') return;

  if (state.selected.has(seatId)) {
    state.selected.delete(seatId);
  } else {
    state.selected.add(seatId);
  }

  updateSeatEl(seat);
  refreshSelectionPanel();
}

function refreshSelectionPanel() {
  if (state.selected.size === 0) {
    showPanel('idle');
    return;
  }
  renderSeatTags(selectedSeatsList, [...state.selected].sort());
  showPanel('hold');
}

// ── Hold Flow ─────────────────────────────────────────────────────────────────
btnHold.addEventListener('click', async () => {
  if (state.selected.size === 0) return;
  btnHold.disabled = true;
  btnHold.textContent = 'Placing hold…';

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
      // Conflict – some seats were taken
      showError(
        'Seats Unavailable',
        'The following seats were taken by another user:',
        data.conflictingSeatIds || []
      );
      // Refresh seat map to reflect current state
      await loadSeats();
      state.selected.clear();
      return;
    }

    if (!res.ok) {
      showError('Hold Failed', data.error || 'Unknown error', []);
      return;
    }

    // Success
    state.hold = {
      holdId:    data.holdId,
      seatIds:   data.seatIds,
      expiresAt: new Date(data.expiresAt),
    };
    state.selected.clear();

    // Update seat states locally (SSE will also arrive, but be fast)
    for (const id of state.hold.seatIds) {
      if (state.seats[id]) {
        state.seats[id].status = 'held';
        state.seats[id].hold_id = state.hold.holdId;
        state.seats[id].hold_expires_at = data.expiresAt;
        updateSeatEl(state.seats[id]);
      }
    }

    renderSeatTags(heldSeatsList, state.hold.seatIds);
    startCountdown();
    showPanel('active-hold');
    updateInventory();
  } finally {
    btnHold.disabled = false;
    btnHold.textContent = 'Hold Selected Seats';
  }
});

btnClearSelection.addEventListener('click', () => {
  state.selected.clear();
  // Re-render all seats to remove selected class
  for (const seat of Object.values(state.seats)) {
    updateSeatEl(seat);
  }
  showPanel('idle');
});

// ── Countdown Timer ───────────────────────────────────────────────────────────
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
  const mm = String(Math.floor(secs / 60)).padStart(2, '0');
  const ss = String(secs % 60).padStart(2, '0');
  holdCountdown.textContent = `${mm}:${ss}`;

  if (secs <= 10) {
    holdCountdown.classList.add('urgent');
  } else {
    holdCountdown.classList.remove('urgent');
  }

  if (remaining === 0) {
    stopCountdown();
    // Hold expired locally – the SSE event will update the map,
    // but also handle it here in case SSE is slow
    handleHoldExpired();
  }
}

function handleHoldExpired() {
  if (!state.hold) return;
  const expiredHold = state.hold;
  state.hold = null;
  stopCountdown();

  // Release seats locally
  for (const id of expiredHold.seatIds) {
    if (state.seats[id] && state.seats[id].status === 'held') {
      state.seats[id].status = 'available';
      state.seats[id].hold_id = null;
      state.seats[id].hold_expires_at = null;
      updateSeatEl(state.seats[id]);
    }
  }

  showError('Hold Expired', 'Your hold has expired. Please select seats again.', []);
  updateInventory();
}

// ── Confirm Flow ──────────────────────────────────────────────────────────────
btnConfirm.addEventListener('click', async () => {
  if (!state.hold) return;
  btnConfirm.disabled = true;
  btnConfirm.textContent = 'Confirming…';

  try {
    const res = await fetch(`${API}/holds/${state.hold.holdId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });

    const data = await res.json();

    if (!res.ok) {
      const msg = data.error || 'Confirmation failed';
      showError('Confirmation Failed', msg, []);
      if (res.status === 410 || res.status === 404) {
        // Hold expired or gone
        state.hold = null;
        stopCountdown();
        await loadSeats();
      }
      return;
    }

    // Success
    const bookedIds = data.bookedSeatIds;
    state.booked = { holdId: data.holdId, seatIds: bookedIds };
    state.hold = null;
    stopCountdown();

    // Update local state
    for (const id of bookedIds) {
      if (state.seats[id]) {
        state.seats[id].status = 'booked';
        state.seats[id].hold_id = null;
        state.seats[id].hold_expires_at = null;
        state.seats[id].booked_by = data.holdId;
        updateSeatEl(state.seats[id]);
      }
    }

    renderSeatTags(bookedSeatsList, bookedIds);
    showPanel('booked');
    updateInventory();
  } finally {
    btnConfirm.disabled = false;
    btnConfirm.textContent = '✓ Confirm Booking';
  }
});

// ── Release Flow ──────────────────────────────────────────────────────────────
btnRelease.addEventListener('click', async () => {
  if (!state.hold) return;
  btnRelease.disabled = true;
  btnRelease.textContent = 'Releasing…';

  try {
    const res = await fetch(`${API}/holds/${state.hold.holdId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });

    const data = await res.json();

    if (!res.ok) {
      showError('Release Failed', data.error || 'Unknown error', []);
      return;
    }

    const releasedIds = data.releasedSeatIds || state.hold.seatIds;
    state.hold = null;
    stopCountdown();

    for (const id of releasedIds) {
      if (state.seats[id]) {
        state.seats[id].status = 'available';
        state.seats[id].hold_id = null;
        state.seats[id].hold_expires_at = null;
        updateSeatEl(state.seats[id]);
      }
    }

    showPanel('idle');
    updateInventory();
  } finally {
    btnRelease.disabled = false;
    btnRelease.textContent = '✗ Release Hold';
  }
});

// ── New Booking ───────────────────────────────────────────────────────────────
btnNewBooking.addEventListener('click', () => {
  state.booked = null;
  showPanel('idle');
});

// ── Error Panel ───────────────────────────────────────────────────────────────
function showError(title, message, conflictIds) {
  document.getElementById('error-title').textContent = title;
  document.getElementById('error-message').textContent = message;

  if (conflictIds && conflictIds.length > 0) {
    renderSeatTags(conflictSeatsEl, conflictIds);
    conflictSeatsEl.classList.remove('hidden');
  } else {
    conflictSeatsEl.innerHTML = '';
    conflictSeatsEl.classList.add('hidden');
  }

  showPanel('error');
}

btnErrorDismiss.addEventListener('click', () => {
  // Re-render all seats to clear any stale selected state
  for (const seat of Object.values(state.seats)) {
    updateSeatEl(seat);
  }
  if (state.hold) {
    showPanel('active-hold');
  } else if (state.booked) {
    showPanel('booked');
  } else {
    showPanel('idle');
  }
});

// ── Load Seats ────────────────────────────────────────────────────────────────
async function loadSeats() {
  try {
    const res = await fetch(`${API}/seats`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    state.seats = {};
    for (const seat of data.seats) {
      state.seats[seat.id] = seat;
    }

    buildSeatMap(data.seats);
    updateInventory();
  } catch (err) {
    console.error('[loadSeats]', err);
    seatMapEl.innerHTML = '<div class="loading">Failed to load seats. Retrying…</div>';
    setTimeout(loadSeats, 3000);
  }
}

// ── SSE ───────────────────────────────────────────────────────────────────────
let sseSource = null;
let sseReconnectTimer = null;

function connectSSE() {
  if (sseSource) {
    sseSource.close();
    sseSource = null;
  }

  sseStatusEl.className = 'sse-status reconnecting';
  sseStatusEl.textContent = '● Connecting…';

  const es = new EventSource(`${API}/stream`);
  sseSource = es;

  es.addEventListener('open', () => {
    sseStatusEl.className = 'sse-status connected';
    sseStatusEl.textContent = '● Live';
    if (sseReconnectTimer) {
      clearTimeout(sseReconnectTimer);
      sseReconnectTimer = null;
    }
  });

  es.addEventListener('seat-update', (e) => {
    try {
      const payload = JSON.parse(e.data);
      handleSeatUpdate(payload);
    } catch (err) {
      console.error('[SSE] parse error', err);
    }
  });

  es.addEventListener('error', () => {
    sseStatusEl.className = 'sse-status disconnected';
    sseStatusEl.textContent = '● Disconnected';
    es.close();
    sseSource = null;
    // Reconnect after 3 s
    sseReconnectTimer = setTimeout(connectSSE, 3000);
  });
}

/**
 * Handle an incoming seat-update SSE event.
 * Updates local state and re-renders affected seats.
 */
function handleSeatUpdate(payload) {
  const { type, seats } = payload;

  for (const seat of seats) {
    // Merge into local state
    state.seats[seat.id] = { ...state.seats[seat.id], ...seat };

    const flashClass =
      type === 'held'     ? 'flash-held'     :
      type === 'booked'   ? 'flash-booked'   :
      type === 'released' ? 'flash-released' : null;

    updateSeatEl(state.seats[seat.id]);
    if (flashClass) flashSeat(seat.id, flashClass);

    // If one of our held seats was released by the server (expiry),
    // clear our local hold state
    if (type === 'released' && state.hold) {
      if (state.hold.seatIds.includes(seat.id)) {
        // All our held seats are being released
        const allReleased = state.hold.seatIds.every(id =>
          seats.some(s => s.id === id)
        );
        if (allReleased) {
          state.hold = null;
          stopCountdown();
          showError('Hold Expired', 'Your hold has expired. Please select seats again.', []);
        }
      }
    }
  }

  updateInventory();
}

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  showPanel('idle');
  await loadSeats();
  connectSSE();
})();
