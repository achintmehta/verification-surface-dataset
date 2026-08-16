/**
 * Seat Booking – Vanilla JS SPA
 *
 * State machine:
 *   IDLE      → user selects seats → SELECTING
 *   SELECTING → user clicks "Hold" → HOLDING (or back to IDLE on error)
 *   HOLDING   → user confirms      → BOOKED
 *   HOLDING   → user releases      → IDLE
 *   HOLDING   → TTL expires        → IDLE (SSE update clears the hold)
 *   BOOKED    → user clicks "New"  → IDLE
 */

// ─── Constants ────────────────────────────────────────────────────────────────
const API = '/api';

// ─── Session ID ───────────────────────────────────────────────────────────────
const SESSION_ID = (() => {
  const key = 'seat_booking_session';
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(key, id);
  }
  return id;
})();

// ─── Application State ────────────────────────────────────────────────────────
const state = {
  seats: {},          // id → seat object
  selected: new Set(),// ids of seats the user has clicked (pre-hold)
  hold: null,         // { id, seatIds, expiresAt }
  booking: null,      // { holdId, seatIds }
  countdownTimer: null,
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const $seatMap       = document.getElementById('seat-map');
const $btnHold       = document.getElementById('btn-hold');
const $btnConfirm    = document.getElementById('btn-confirm');
const $btnRelease    = document.getElementById('btn-release');
const $btnNewBooking = document.getElementById('btn-new-booking');
const $btnDismiss    = document.getElementById('btn-dismiss-error');
const $selectionInfo = document.getElementById('selection-info');
const $holdSeatList  = document.getElementById('hold-seat-list');
const $holdCountdown = document.getElementById('hold-countdown');
const $bookedSeatList= document.getElementById('booked-seat-list');
const $errorMsg      = document.getElementById('error-msg');
const $sseStatus     = document.getElementById('sse-status');
const $sessionDisplay= document.getElementById('session-id-display');
const $invAvailable  = document.getElementById('inv-available');
const $invHeld       = document.getElementById('inv-held');
const $invBooked     = document.getElementById('inv-booked');
const $invTotal      = document.getElementById('inv-total');

// Panels
const panels = {
  select: document.getElementById('panel-select'),
  hold:   document.getElementById('panel-hold'),
  booked: document.getElementById('panel-booked'),
  error:  document.getElementById('panel-error'),
};

// ─── Utility ──────────────────────────────────────────────────────────────────
function showPanel(name) {
  for (const [key, el] of Object.entries(panels)) {
    el.classList.toggle('hidden', key !== name);
  }
}

function formatCountdown(ms) {
  if (ms <= 0) return '0s';
  const s = Math.ceil(ms / 1000);
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${s}s`;
}

function updateInventory() {
  const all = Object.values(state.seats);
  const available = all.filter(s => s.status === 'available').length;
  const held      = all.filter(s => s.status === 'held').length;
  const booked    = all.filter(s => s.status === 'booked').length;
  $invAvailable.textContent = available;
  $invHeld.textContent      = held;
  $invBooked.textContent    = booked;
  $invTotal.textContent     = all.length;
}

// ─── Seat rendering ───────────────────────────────────────────────────────────

/**
 * Determine the CSS class for a seat given current app state.
 */
function seatClass(seat) {
  if (state.selected.has(seat.id)) return 'selected';
  if (seat.status === 'available') return 'available';
  if (seat.status === 'booked')    return 'booked';
  if (seat.status === 'held') {
    // Is this seat part of MY active hold?
    if (state.hold && state.hold.seatIds.includes(seat.id)) return 'held-mine';
    return 'held-other';
  }
  return 'available';
}

/**
 * Build the full seat map DOM from scratch.
 */
function renderSeatMap() {
  $seatMap.innerHTML = '';

  // Group seats by row
  const rows = {};
  for (const seat of Object.values(state.seats)) {
    if (!rows[seat.rowLabel]) rows[seat.rowLabel] = [];
    rows[seat.rowLabel].push(seat);
  }

  for (const rowLabel of Object.keys(rows).sort()) {
    const rowSeats = rows[rowLabel].sort((a, b) => a.seatNumber - b.seatNumber);

    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';

    const labelEl = document.createElement('div');
    labelEl.className = 'row-label';
    labelEl.textContent = rowLabel;
    rowEl.appendChild(labelEl);

    for (const seat of rowSeats) {
      rowEl.appendChild(createSeatEl(seat));
    }

    $seatMap.appendChild(rowEl);
  }

  updateInventory();
}

/**
 * Create a single seat DOM element.
 */
function createSeatEl(seat) {
  const el = document.createElement('div');
  el.className = `seat ${seatClass(seat)}`;
  el.dataset.id = seat.id;
  el.title = `${seat.id} – ${seat.status}`;
  el.textContent = seat.seatNumber;
  el.addEventListener('click', () => onSeatClick(seat.id));
  return el;
}

/**
 * Update only the seats that changed (avoids full re-render flicker).
 */
function patchSeatMap(updatedSeats) {
  for (const seat of updatedSeats) {
    // Update state
    state.seats[seat.id] = {
      ...state.seats[seat.id],
      ...seat,
    };

    // Update DOM element
    const el = $seatMap.querySelector(`[data-id="${seat.id}"]`);
    if (el) {
      const newClass = seatClass(state.seats[seat.id]);
      el.className = `seat ${newClass}`;
      el.title = `${seat.id} – ${seat.status}`;

      // Brief pulse animation
      el.classList.add('pulse');
      el.addEventListener('animationend', () => el.classList.remove('pulse'), { once: true });
    }
  }
  updateInventory();
}

// ─── Seat click handler ───────────────────────────────────────────────────────
function onSeatClick(seatId) {
  // Only allow selection when no hold is active
  if (state.hold || state.booking) return;

  const seat = state.seats[seatId];
  if (!seat || seat.status !== 'available') return;

  if (state.selected.has(seatId)) {
    state.selected.delete(seatId);
  } else {
    state.selected.add(seatId);
  }

  // Re-render just the affected seat
  const el = $seatMap.querySelector(`[data-id="${seatId}"]`);
  if (el) {
    el.className = `seat ${seatClass(seat)}`;
  }

  updateSelectionUI();
}

function updateSelectionUI() {
  const count = state.selected.size;
  $btnHold.disabled = count === 0;
  $selectionInfo.textContent =
    count === 0
      ? 'Select available seats to hold them.'
      : `${count} seat${count > 1 ? 's' : ''} selected: ${[...state.selected].join(', ')}`;
}

// ─── Hold flow ────────────────────────────────────────────────────────────────
async function requestHold() {
  if (state.selected.size === 0) return;

  const seatIds = [...state.selected];
  $btnHold.disabled = true;

  try {
    const resp = await fetch(`${API}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId: SESSION_ID }),
    });

    const data = await resp.json();

    if (resp.status === 201) {
      // Success
      state.hold = {
        id: data.hold.id,
        seatIds: data.hold.seatIds,
        expiresAt: new Date(data.hold.expiresAt),
      };
      state.selected.clear();

      // Update seat states locally (SSE will also arrive, but be fast)
      for (const id of state.hold.seatIds) {
        if (state.seats[id]) state.seats[id].status = 'held';
      }
      renderSeatMap();
      showHoldPanel();

    } else if (resp.status === 409) {
      // Conflict – some seats were taken
      const conflicting = data.conflictingSeatIds || [];
      showError(
        `Seats ${conflicting.join(', ')} are no longer available. Please re-select.`
      );
      // Refresh seat map to show current state
      await loadSeats();
      state.selected.clear();
      updateSelectionUI();

    } else {
      showError(data.error || 'Failed to place hold.');
    }
  } catch (err) {
    showError('Network error: ' + err.message);
  }
}

function showHoldPanel() {
  $holdSeatList.textContent = state.hold.seatIds.join(', ');
  showPanel('hold');
  startCountdown();
}

function startCountdown() {
  if (state.countdownTimer) clearInterval(state.countdownTimer);

  const tick = () => {
    if (!state.hold) { clearInterval(state.countdownTimer); return; }
    const remaining = state.hold.expiresAt - Date.now();
    if (remaining <= 0) {
      $holdCountdown.textContent = 'Expired';
      clearInterval(state.countdownTimer);
      // The SSE event will handle the actual state reset
    } else {
      $holdCountdown.textContent = formatCountdown(remaining);
    }
  };

  tick();
  state.countdownTimer = setInterval(tick, 500);
}

// ─── Confirm flow ─────────────────────────────────────────────────────────────
async function confirmHold() {
  if (!state.hold) return;

  $btnConfirm.disabled = true;
  $btnRelease.disabled = true;

  try {
    const resp = await fetch(`${API}/holds/${state.hold.id}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });

    const data = await resp.json();

    if (resp.ok) {
      const seatIds = data.booking.seatIds;
      state.booking = { holdId: state.hold.id, seatIds };
      clearHold();

      // Update local state
      for (const id of seatIds) {
        if (state.seats[id]) {
          state.seats[id].status = 'booked';
          state.seats[id].holdId = null;
          state.seats[id].holdExpiresAt = null;
        }
      }
      renderSeatMap();

      $bookedSeatList.textContent = seatIds.join(', ');
      showPanel('booked');
    } else {
      showError(data.error || 'Failed to confirm booking.');
      // If hold expired, reset to idle
      if (resp.status === 410) {
        clearHold();
        await loadSeats();
        showPanel('select');
      } else {
        $btnConfirm.disabled = false;
        $btnRelease.disabled = false;
      }
    }
  } catch (err) {
    showError('Network error: ' + err.message);
    $btnConfirm.disabled = false;
    $btnRelease.disabled = false;
  }
}

// ─── Release flow ─────────────────────────────────────────────────────────────
async function releaseHold() {
  if (!state.hold) return;

  $btnConfirm.disabled = true;
  $btnRelease.disabled = true;

  try {
    const resp = await fetch(`${API}/holds/${state.hold.id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });

    const data = await resp.json();

    if (resp.ok) {
      clearHold();
      await loadSeats();
      showPanel('select');
      updateSelectionUI();
    } else {
      showError(data.error || 'Failed to release hold.');
      $btnConfirm.disabled = false;
      $btnRelease.disabled = false;
    }
  } catch (err) {
    showError('Network error: ' + err.message);
    $btnConfirm.disabled = false;
    $btnRelease.disabled = false;
  }
}

function clearHold() {
  if (state.countdownTimer) {
    clearInterval(state.countdownTimer);
    state.countdownTimer = null;
  }
  state.hold = null;
}

// ─── Error display ────────────────────────────────────────────────────────────
function showError(msg) {
  $errorMsg.textContent = msg;
  showPanel('error');
}

// ─── New booking ──────────────────────────────────────────────────────────────
function resetToIdle() {
  state.booking = null;
  state.selected.clear();
  updateSelectionUI();
  showPanel('select');
}

// ─── Load seats from API ──────────────────────────────────────────────────────
async function loadSeats() {
  try {
    const resp = await fetch(`${API}/seats`);
    const data = await resp.json();

    state.seats = {};
    for (const seat of data.seats) {
      state.seats[seat.id] = seat;
    }

    renderSeatMap();
  } catch (err) {
    $seatMap.innerHTML = `<div class="loading">Error loading seats: ${err.message}</div>`;
  }
}

// ─── SSE ──────────────────────────────────────────────────────────────────────
function connectSSE() {
  const es = new EventSource(`${API}/stream`);

  es.onopen = () => {
    $sseStatus.textContent = '⚡ Live';
    $sseStatus.className = 'sse-status connected';
  };

  es.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'seat_update') {
        handleSseUpdate(msg.seats);
      }
    } catch (err) {
      console.warn('SSE parse error:', err);
    }
  };

  es.onerror = () => {
    $sseStatus.textContent = '⚡ Reconnecting…';
    $sseStatus.className = 'sse-status disconnected';
    // EventSource auto-reconnects; we just update the UI
  };
}

/**
 * Handle incoming SSE seat updates.
 * If any of our held seats became available (expired), reset hold state.
 */
function handleSseUpdate(updatedSeats) {
  // Check if our hold was externally released (expired)
  if (state.hold) {
    const myHeldIds = new Set(state.hold.seatIds);
    const releasedMine = updatedSeats.filter(
      (s) => myHeldIds.has(s.id) && s.status === 'available'
    );
    if (releasedMine.length > 0) {
      // Our hold expired
      clearHold();
      patchSeatMap(updatedSeats);
      showError('Your hold expired. Please select seats again.');
      return;
    }
  }

  patchSeatMap(updatedSeats);
}

// ─── Event listeners ──────────────────────────────────────────────────────────
$btnHold.addEventListener('click', requestHold);
$btnConfirm.addEventListener('click', confirmHold);
$btnRelease.addEventListener('click', releaseHold);
$btnNewBooking.addEventListener('click', resetToIdle);
$btnDismiss.addEventListener('click', () => {
  showPanel(state.hold ? 'hold' : 'select');
});

// ─── Bootstrap ────────────────────────────────────────────────────────────────
$sessionDisplay.textContent = SESSION_ID.slice(0, 8) + '…';

(async () => {
  await loadSeats();
  showPanel('select');
  updateSelectionUI();
  connectSSE();
})();
