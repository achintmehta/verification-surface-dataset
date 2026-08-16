/**
 * Seat Booking – Frontend SPA
 * Vanilla JS, no framework.
 */

// Use relative path so Vite's dev proxy works; falls back to same-origin in production.
const API = '/api';

// ─── Session ID ────────────────────────────────────────────────────────────
function getSessionId() {
  let id = sessionStorage.getItem('seat-booking-session');
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem('seat-booking-session', id);
  }
  return id;
}

const SESSION_ID = getSessionId();
document.getElementById('session-id-display').textContent =
  SESSION_ID.slice(0, 8) + '…';

// ─── State ─────────────────────────────────────────────────────────────────
/** @type {Map<string, object>} seatId → seat object */
const seatMap = new Map();

/** Set of seat ids the user has clicked to select */
const selectedSeats = new Set();

/** Current active hold (or null) */
let activeHold = null;   // { holdId, seatIds, expiresAt }

/** Countdown interval handle */
let countdownInterval = null;

/** Confirmed booking (or null) */
let confirmedBooking = null; // { holdId, seatIds }

// ─── DOM refs ──────────────────────────────────────────────────────────────
const seatMapEl        = document.getElementById('seat-map');
const statusMsg        = document.getElementById('status-msg');
const sseIndicator     = document.getElementById('sse-indicator');
const btnHold          = document.getElementById('btn-hold');
const btnConfirm       = document.getElementById('btn-confirm');
const btnRelease       = document.getElementById('btn-release');
const btnNewBooking    = document.getElementById('btn-new-booking');
const selectedListEl   = document.getElementById('selected-list');
const holdPanel        = document.getElementById('hold-panel');
const activeHoldPanel  = document.getElementById('active-hold-panel');
const bookingPanel     = document.getElementById('booking-panel');
const holdIdDisplay    = document.getElementById('hold-id-display');
const holdSeatsDisplay = document.getElementById('hold-seats-display');
const holdCountdown    = document.getElementById('hold-countdown');
const bookedSeatsEl    = document.getElementById('booked-seats-display');
const bookedHoldIdEl   = document.getElementById('booked-hold-id');
const errorToast       = document.getElementById('error-toast');

// Inventory
const invAvailable = document.getElementById('inv-available');
const invHeld      = document.getElementById('inv-held');
const invBooked    = document.getElementById('inv-booked');
const invTotal     = document.getElementById('inv-total');

// ─── Error toast ───────────────────────────────────────────────────────────
let toastTimeout = null;
function showError(msg) {
  errorToast.textContent = msg;
  errorToast.classList.remove('hidden');
  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => errorToast.classList.add('hidden'), 5000);
}

// ─── Seat rendering ────────────────────────────────────────────────────────
/**
 * Determine the CSS class for a seat given current state.
 */
function seatClass(seat) {
  if (selectedSeats.has(seat.id)) return 'selected';

  if (seat.status === 'available') return 'available';

  if (seat.status === 'held') {
    // Is this our own hold?
    if (activeHold && activeHold.seatIds.includes(seat.id)) return 'held-own';
    return 'held-other';
  }

  if (seat.status === 'booked') {
    if (seat.booked_by === SESSION_ID) return 'booked-own';
    return 'booked-other';
  }

  return 'available';
}

/**
 * Build the full seat map DOM from scratch.
 */
function renderSeatMap() {
  seatMapEl.innerHTML = '';

  // Group by row
  const rows = new Map();
  for (const seat of seatMap.values()) {
    if (!rows.has(seat.row_label)) rows.set(seat.row_label, []);
    rows.get(seat.row_label).push(seat);
  }

  // Sort rows alphabetically, seats numerically
  const sortedRows = [...rows.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  for (const [rowLabel, seats] of sortedRows) {
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';

    const labelEl = document.createElement('div');
    labelEl.className = 'row-label';
    labelEl.textContent = rowLabel;
    rowEl.appendChild(labelEl);

    seats.sort((a, b) => a.seat_number - b.seat_number);

    for (const seat of seats) {
      rowEl.appendChild(createSeatEl(seat));
    }

    seatMapEl.appendChild(rowEl);
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
  el.textContent = seat.seat_number;
  el.title = `${seat.row_label}${seat.seat_number} – ${seat.status}`;

  el.addEventListener('click', () => onSeatClick(seat.id));
  return el;
}

/**
 * Update a single seat element in place (without full re-render).
 */
function updateSeatEl(seat) {
  const el = seatMapEl.querySelector(`[data-id="${seat.id}"]`);
  if (!el) return;
  el.className = `seat ${seatClass(seat)}`;
  el.title = `${seat.row_label}${seat.seat_number} – ${seat.status}`;
}

/**
 * Update inventory counters.
 */
function updateInventory() {
  let available = 0, held = 0, booked = 0;
  for (const seat of seatMap.values()) {
    if (seat.status === 'available') available++;
    else if (seat.status === 'held') held++;
    else if (seat.status === 'booked') booked++;
  }
  invAvailable.textContent = available;
  invHeld.textContent      = held;
  invBooked.textContent    = booked;
  invTotal.textContent     = seatMap.size;
}

// ─── Seat click ────────────────────────────────────────────────────────────
function onSeatClick(seatId) {
  // Ignore clicks when we have an active hold or confirmed booking
  if (activeHold || confirmedBooking) return;

  const seat = seatMap.get(seatId);
  if (!seat) return;

  // Only available seats can be selected
  if (seat.status !== 'available') return;

  if (selectedSeats.has(seatId)) {
    selectedSeats.delete(seatId);
  } else {
    selectedSeats.add(seatId);
  }

  updateSeatEl(seat);
  updateSelectionUI();
}

function updateSelectionUI() {
  const ids = [...selectedSeats];
  if (ids.length === 0) {
    selectedListEl.textContent = 'None selected';
    btnHold.disabled = true;
  } else {
    selectedListEl.textContent = ids.join(', ');
    btnHold.disabled = false;
  }
}

// ─── Panel management ──────────────────────────────────────────────────────
function showPanel(name) {
  holdPanel.classList.add('hidden');
  activeHoldPanel.classList.add('hidden');
  bookingPanel.classList.add('hidden');

  if (name === 'hold')    holdPanel.classList.remove('hidden');
  if (name === 'active')  activeHoldPanel.classList.remove('hidden');
  if (name === 'booking') bookingPanel.classList.remove('hidden');
}

// ─── Countdown ─────────────────────────────────────────────────────────────
function startCountdown(expiresAt) {
  if (countdownInterval) clearInterval(countdownInterval);

  const tick = () => {
    const remaining = Math.max(0, Math.floor((new Date(expiresAt) - Date.now()) / 1000));
    const mins = Math.floor(remaining / 60).toString().padStart(2, '0');
    const secs = (remaining % 60).toString().padStart(2, '0');
    holdCountdown.textContent = `${mins}:${secs}`;

    if (remaining <= 10) {
      holdCountdown.classList.add('urgent');
    } else {
      holdCountdown.classList.remove('urgent');
    }

    if (remaining === 0) {
      clearInterval(countdownInterval);
      countdownInterval = null;
      // Hold expired client-side; SSE will update seats, but also reset UI
      onHoldExpiredLocally();
    }
  };

  tick();
  countdownInterval = setInterval(tick, 1000);
}

function stopCountdown() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
}

function onHoldExpiredLocally() {
  if (!activeHold) return;
  showError('Your hold has expired. The seats have been released.');
  activeHold = null;
  selectedSeats.clear();
  showPanel('hold');
  updateSelectionUI();
  // Seats will be updated via SSE; trigger a refresh just in case
  fetchSeats();
}

// ─── API calls ─────────────────────────────────────────────────────────────
async function fetchSeats() {
  try {
    const res = await fetch(`${API}/seats`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const seats = await res.json();
    for (const seat of seats) {
      seatMap.set(seat.id, seat);
    }
    renderSeatMap();
    statusMsg.textContent = `${seatMap.size} seats loaded.`;
  } catch (err) {
    statusMsg.textContent = 'Failed to load seats.';
    showError('Could not load seat map: ' + err.message);
  }
}

async function placeHold() {
  const seatIds = [...selectedSeats];
  if (seatIds.length === 0) return;

  btnHold.disabled = true;
  statusMsg.textContent = 'Placing hold…';

  try {
    const res = await fetch(`${API}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId: SESSION_ID }),
    });

    const data = await res.json();

    if (res.status === 409) {
      // Conflict – some seats were taken
      const conflictIds = data.conflicts || [];
      showError(
        `Seats already taken: ${conflictIds.join(', ')}. Please choose different seats.`
      );
      // Deselect conflicting seats and refresh
      for (const id of conflictIds) {
        selectedSeats.delete(id);
      }
      await fetchSeats();
      updateSelectionUI();
      btnHold.disabled = selectedSeats.size === 0;
      return;
    }

    if (!res.ok) {
      showError(data.error || 'Failed to place hold.');
      btnHold.disabled = false;
      return;
    }

    // Success
    activeHold = {
      holdId: data.holdId,
      seatIds: data.seatIds,
      expiresAt: data.expiresAt,
    };
    selectedSeats.clear();

    // Update UI
    holdIdDisplay.textContent = data.holdId.slice(0, 8) + '…';
    holdSeatsDisplay.textContent = data.seatIds.join(', ');
    showPanel('active');
    startCountdown(data.expiresAt);
    statusMsg.textContent = 'Hold placed successfully.';

    // Re-render to show held-own state
    for (const id of data.seatIds) {
      const seat = seatMap.get(id);
      if (seat) {
        seat.status = 'held';
        seat.hold_id = data.holdId;
        seat.hold_expires_at = data.expiresAt;
        updateSeatEl(seat);
      }
    }
    updateInventory();

  } catch (err) {
    showError('Network error: ' + err.message);
    btnHold.disabled = false;
  }
}

async function confirmHold() {
  if (!activeHold) return;

  btnConfirm.disabled = true;
  btnRelease.disabled = true;
  statusMsg.textContent = 'Confirming booking…';

  try {
    const res = await fetch(`${API}/holds/${activeHold.holdId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });

    const data = await res.json();

    if (!res.ok) {
      showError(data.error || 'Failed to confirm booking.');
      btnConfirm.disabled = false;
      btnRelease.disabled = false;
      if (res.status === 410) {
        // Hold expired or released
        stopCountdown();
        activeHold = null;
        showPanel('hold');
        updateSelectionUI();
        await fetchSeats();
      }
      return;
    }

    // Success
    stopCountdown();
    confirmedBooking = {
      holdId: activeHold.holdId,
      seatIds: activeHold.seatIds,
    };
    activeHold = null;

    bookedSeatsEl.textContent = confirmedBooking.seatIds.join(', ');
    bookedHoldIdEl.textContent = confirmedBooking.holdId.slice(0, 8) + '…';
    showPanel('booking');
    statusMsg.textContent = 'Booking confirmed!';

    // Update local seat state
    for (const id of confirmedBooking.seatIds) {
      const seat = seatMap.get(id);
      if (seat) {
        seat.status = 'booked';
        seat.booked_by = SESSION_ID;
        seat.hold_expires_at = null;
        updateSeatEl(seat);
      }
    }
    updateInventory();

  } catch (err) {
    showError('Network error: ' + err.message);
    btnConfirm.disabled = false;
    btnRelease.disabled = false;
  }
}

async function releaseHold() {
  if (!activeHold) return;

  btnRelease.disabled = true;
  btnConfirm.disabled = true;
  statusMsg.textContent = 'Releasing hold…';

  try {
    const res = await fetch(`${API}/holds/${activeHold.holdId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });

    const data = await res.json();

    if (!res.ok) {
      showError(data.error || 'Failed to release hold.');
      btnRelease.disabled = false;
      btnConfirm.disabled = false;
      return;
    }

    stopCountdown();
    const releasedIds = activeHold.seatIds;
    activeHold = null;
    selectedSeats.clear();

    showPanel('hold');
    updateSelectionUI();
    statusMsg.textContent = 'Hold released.';

    // Update local seat state
    for (const id of releasedIds) {
      const seat = seatMap.get(id);
      if (seat) {
        seat.status = 'available';
        seat.hold_id = null;
        seat.hold_expires_at = null;
        updateSeatEl(seat);
      }
    }
    updateInventory();

  } catch (err) {
    showError('Network error: ' + err.message);
    btnRelease.disabled = false;
    btnConfirm.disabled = false;
  }
}

// ─── Button handlers ───────────────────────────────────────────────────────
btnHold.addEventListener('click', placeHold);
btnConfirm.addEventListener('click', confirmHold);
btnRelease.addEventListener('click', releaseHold);

btnNewBooking.addEventListener('click', () => {
  confirmedBooking = null;
  selectedSeats.clear();
  showPanel('hold');
  updateSelectionUI();
  fetchSeats();
});

// ─── SSE ───────────────────────────────────────────────────────────────────
function connectSSE() {
  const es = new EventSource(`${API}/stream`);

  es.addEventListener('connected', () => {
    sseIndicator.className = 'sse-dot connected';
    sseIndicator.title = 'Live updates connected';
  });

  es.addEventListener('seat-update', (event) => {
    try {
      const updatedSeats = JSON.parse(event.data);
      handleSeatUpdates(updatedSeats);
    } catch (err) {
      console.error('SSE parse error:', err);
    }
  });

  es.onerror = () => {
    sseIndicator.className = 'sse-dot disconnected';
    sseIndicator.title = 'Live updates disconnected – reconnecting…';
  };

  es.onopen = () => {
    sseIndicator.className = 'sse-dot connected';
  };

  return es;
}

/**
 * Handle incoming seat-update events from SSE.
 * Updates local state and re-renders affected seats.
 */
function handleSeatUpdates(updatedSeats) {
  let inventoryChanged = false;

  for (const seat of updatedSeats) {
    const existing = seatMap.get(seat.id);
    if (!existing) continue;

    const oldStatus = existing.status;

    // Merge updated fields
    Object.assign(existing, seat);

    // If a seat we had selected is no longer available, deselect it
    if (selectedSeats.has(seat.id) && seat.status !== 'available') {
      selectedSeats.delete(seat.id);
      updateSelectionUI();
    }

    // If our active hold's seats were released by expiry (from another tab or sweep)
    if (
      activeHold &&
      activeHold.seatIds.includes(seat.id) &&
      seat.status === 'available'
    ) {
      // The hold expired server-side
      stopCountdown();
      activeHold = null;
      showPanel('hold');
      updateSelectionUI();
      showError('Your hold expired and seats were released.');
    }

    updateSeatEl(existing);

    if (oldStatus !== seat.status) inventoryChanged = true;
  }

  if (inventoryChanged) updateInventory();
}

// ─── Init ──────────────────────────────────────────────────────────────────
(async function init() {
  showPanel('hold');
  updateSelectionUI();
  await fetchSeats();
  connectSSE();
})();
