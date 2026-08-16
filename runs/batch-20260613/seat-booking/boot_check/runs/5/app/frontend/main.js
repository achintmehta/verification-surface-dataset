/**
 * Seat Booking Frontend
 * Vanilla JS SPA with SSE for real-time updates.
 */

const API_BASE = 'http://localhost:3001/api';

// ===== Session ID =====
function getSessionId() {
  let id = sessionStorage.getItem('seat-booking-session');
  if (!id) {
    id = 'sess-' + Math.random().toString(36).slice(2, 11) + '-' + Date.now().toString(36);
    sessionStorage.setItem('seat-booking-session', id);
  }
  return id;
}

const SESSION_ID = getSessionId();

// ===== State =====
const state = {
  seats: {},           // id -> seat object
  selectedIds: new Set(),
  currentHold: null,   // { holdId, seatIds, expiresAt, ttlSeconds }
  bookedHoldId: null,  // holdId of confirmed booking this session
  bookedSeatIds: [],
  countdownTimer: null,
};

// ===== DOM References =====
const $ = id => document.getElementById(id);
const seatMapEl = $('seat-map');
const sessionIdDisplay = $('session-id-display');
const sseStatusEl = $('sse-status');
const selectionInfo = $('selection-info');
const btnHold = $('btn-hold');
const btnConfirm = $('btn-confirm');
const btnRelease = $('btn-release');
const btnNewBooking = $('btn-new-booking');
const btnErrorDismiss = $('btn-error-dismiss');
const holdSeatList = $('hold-seat-list');
const holdCountdown = $('hold-countdown');
const bookedSeatList = $('booked-seat-list');
const bookingHoldId = $('booking-hold-id');
const errorMessage = $('error-message');
const invAvailable = $('inv-available');
const invHeld = $('inv-held');
const invBooked = $('inv-booked');
const invTotal = $('inv-total');

// Panel sections
const panelSelect = $('panel-select');
const panelHold = $('panel-hold');
const panelBooked = $('panel-booked');
const panelError = $('panel-error');

// ===== Init =====
sessionIdDisplay.textContent = SESSION_ID.slice(0, 16) + '…';

// ===== API Helpers =====
async function apiFetch(path, options = {}) {
  const res = await fetch(API_BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) throw { status: res.status, ...data };
  return data;
}

// ===== Seat Map Rendering =====
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

    for (const seat of rows[rowLabel].sort((a, b) => a.seat_number - b.seat_number)) {
      rowEl.appendChild(createSeatEl(seat));
    }

    seatMapEl.appendChild(rowEl);
  }

  updateInventory();
}

function createSeatEl(seat) {
  const el = document.createElement('div');
  el.className = 'seat';
  el.id = `seat-${seat.id}`;
  el.title = `${seat.row_label}${seat.seat_number}`;
  el.textContent = seat.seat_number;

  applySeatClass(el, seat);

  el.addEventListener('click', () => onSeatClick(seat.id));
  return el;
}

function getSeatVisualState(seat) {
  // If we have an active hold and this seat is in it
  if (state.currentHold && state.currentHold.seatIds.includes(seat.id)) {
    return 'held-own';
  }
  // If this seat is booked by our session
  if (state.bookedSeatIds.includes(seat.id)) {
    return 'booked-own';
  }
  // If selected
  if (state.selectedIds.has(seat.id)) {
    return 'selected';
  }
  return seat.status; // available, held, booked
}

function applySeatClass(el, seat) {
  el.className = 'seat';
  const visualState = getSeatVisualState(seat);
  el.classList.add(visualState);
}

function updateSeatEl(seatId, animate) {
  const seat = state.seats[seatId];
  if (!seat) return;

  let el = document.getElementById(`seat-${seatId}`);
  if (!el) return;

  applySeatClass(el, seat);

  if (animate) {
    el.classList.add(animate);
    el.addEventListener('animationend', () => el.classList.remove(animate), { once: true });
  }
}

function updateInventory() {
  let available = 0, held = 0, booked = 0;
  for (const seat of Object.values(state.seats)) {
    if (seat.status === 'available') available++;
    else if (seat.status === 'held') held++;
    else if (seat.status === 'booked') booked++;
  }
  const total = available + held + booked;
  invAvailable.textContent = available;
  invHeld.textContent = held;
  invBooked.textContent = booked;
  invTotal.textContent = total;
}

// ===== Seat Click =====
function onSeatClick(seatId) {
  // Ignore clicks if we have an active hold or booking
  if (state.currentHold || state.bookedHoldId) return;

  const seat = state.seats[seatId];
  if (!seat || seat.status !== 'available') return;

  if (state.selectedIds.has(seatId)) {
    state.selectedIds.delete(seatId);
  } else {
    state.selectedIds.add(seatId);
  }

  updateSeatEl(seatId, null);
  updateSelectionUI();
}

function updateSelectionUI() {
  const count = state.selectedIds.size;
  if (count === 0) {
    selectionInfo.textContent = 'Click available seats to select them.';
    btnHold.disabled = true;
  } else {
    const ids = [...state.selectedIds].join(', ');
    selectionInfo.textContent = `Selected: ${ids} (${count} seat${count > 1 ? 's' : ''})`;
    btnHold.disabled = false;
  }
}

// ===== Panel Management =====
function showPanel(name) {
  panelSelect.classList.add('hidden');
  panelHold.classList.add('hidden');
  panelBooked.classList.add('hidden');
  panelError.classList.add('hidden');

  if (name === 'select') panelSelect.classList.remove('hidden');
  else if (name === 'hold') panelHold.classList.remove('hidden');
  else if (name === 'booked') panelBooked.classList.remove('hidden');
  else if (name === 'error') panelError.classList.remove('hidden');
}

// ===== Hold Flow =====
btnHold.addEventListener('click', async () => {
  if (state.selectedIds.size === 0) return;

  btnHold.disabled = true;
  btnHold.textContent = 'Placing hold…';

  const seatIds = [...state.selectedIds];

  try {
    const data = await apiFetch('/holds', {
      method: 'POST',
      body: JSON.stringify({ seatIds, sessionId: SESSION_ID }),
    });

    state.currentHold = {
      holdId: data.holdId,
      seatIds: data.seatIds,
      expiresAt: new Date(data.expiresAt),
      ttlSeconds: data.ttlSeconds,
    };
    state.selectedIds.clear();

    // Update seat states locally (SSE will also update, but be proactive)
    for (const id of data.seatIds) {
      if (state.seats[id]) {
        state.seats[id].status = 'held';
        state.seats[id].hold_id = data.holdId;
        state.seats[id].hold_expires_at = data.expiresAt;
      }
      updateSeatEl(id, 'just-held');
    }

    holdSeatList.textContent = data.seatIds.join(', ');
    showPanel('hold');
    startCountdown();
    updateInventory();
  } catch (err) {
    if (err.status === 409) {
      const conflicting = err.conflictingSeatIds || [];
      showError(
        `Seats ${conflicting.join(', ')} are no longer available. Please select different seats.`,
        true
      );
      // Refresh seat map to show current state
      await loadSeats();
    } else {
      showError(`Failed to place hold: ${err.error || 'Unknown error'}`);
    }
  } finally {
    btnHold.textContent = 'Hold Selected Seats';
    btnHold.disabled = state.selectedIds.size === 0;
  }
});

// ===== Countdown =====
function startCountdown() {
  stopCountdown();
  updateCountdownDisplay();
  state.countdownTimer = setInterval(updateCountdownDisplay, 500);
}

function stopCountdown() {
  if (state.countdownTimer) {
    clearInterval(state.countdownTimer);
    state.countdownTimer = null;
  }
}

function updateCountdownDisplay() {
  if (!state.currentHold) {
    stopCountdown();
    return;
  }

  const remaining = Math.max(0, state.currentHold.expiresAt - Date.now());
  const seconds = Math.ceil(remaining / 1000);
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  holdCountdown.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;

  if (seconds <= 10) {
    holdCountdown.classList.add('urgent');
  } else {
    holdCountdown.classList.remove('urgent');
  }

  if (remaining === 0) {
    stopCountdown();
    onHoldExpired();
  }
}

function onHoldExpired() {
  if (!state.currentHold) return;
  const expiredSeatIds = state.currentHold.seatIds;
  state.currentHold = null;

  for (const id of expiredSeatIds) {
    if (state.seats[id] && state.seats[id].status === 'held') {
      state.seats[id].status = 'available';
      state.seats[id].hold_id = null;
      state.seats[id].hold_expires_at = null;
    }
    updateSeatEl(id, null);
  }

  updateInventory();
  showPanel('select');
  updateSelectionUI();
  showError('Your hold has expired. The seats are now available again.');
}

// ===== Confirm Flow =====
btnConfirm.addEventListener('click', async () => {
  if (!state.currentHold) return;

  btnConfirm.disabled = true;
  btnConfirm.textContent = 'Confirming…';

  try {
    const data = await apiFetch(`/holds/${state.currentHold.holdId}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });

    stopCountdown();
    const confirmedSeatIds = data.seatIds;
    state.bookedHoldId = data.holdId;
    state.bookedSeatIds = confirmedSeatIds;
    state.currentHold = null;

    // Update local state
    for (const id of confirmedSeatIds) {
      if (state.seats[id]) {
        state.seats[id].status = 'booked';
        state.seats[id].booked_by = SESSION_ID;
      }
      updateSeatEl(id, 'just-booked');
    }

    bookedSeatList.textContent = confirmedSeatIds.join(', ');
    bookingHoldId.textContent = data.holdId.slice(0, 8) + '…';
    showPanel('booked');
    updateInventory();
  } catch (err) {
    if (err.status === 410 || err.status === 404) {
      // Hold expired or not found
      stopCountdown();
      state.currentHold = null;
      showError(`Booking failed: ${err.error}. Your hold may have expired.`);
      await loadSeats();
    } else {
      showError(`Failed to confirm booking: ${err.error || 'Unknown error'}`);
    }
  } finally {
    btnConfirm.disabled = false;
    btnConfirm.textContent = '✓ Confirm Booking';
  }
});

// ===== Release Flow =====
btnRelease.addEventListener('click', async () => {
  if (!state.currentHold) return;

  btnRelease.disabled = true;
  btnRelease.textContent = 'Releasing…';

  const holdId = state.currentHold.holdId;
  const seatIds = state.currentHold.seatIds;

  try {
    await apiFetch(`/holds/${holdId}`, {
      method: 'DELETE',
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });

    stopCountdown();
    state.currentHold = null;

    for (const id of seatIds) {
      if (state.seats[id]) {
        state.seats[id].status = 'available';
        state.seats[id].hold_id = null;
        state.seats[id].hold_expires_at = null;
      }
      updateSeatEl(id, null);
    }

    updateInventory();
    showPanel('select');
    updateSelectionUI();
  } catch (err) {
    showError(`Failed to release hold: ${err.error || 'Unknown error'}`);
  } finally {
    btnRelease.disabled = false;
    btnRelease.textContent = '✗ Release Hold';
  }
});

// ===== New Booking =====
btnNewBooking.addEventListener('click', () => {
  state.bookedHoldId = null;
  state.bookedSeatIds = [];
  state.selectedIds.clear();
  showPanel('select');
  updateSelectionUI();
  // Re-render to clear booked-own styling
  renderSeatMap();
});

// ===== Error Panel =====
function showError(msg, keepSelectPanel = false) {
  errorMessage.textContent = msg;
  if (!keepSelectPanel) {
    showPanel('error');
  } else {
    // Show error inline without hiding select panel
    panelError.classList.remove('hidden');
    panelSelect.classList.remove('hidden');
  }
}

btnErrorDismiss.addEventListener('click', () => {
  panelError.classList.add('hidden');
  if (state.currentHold) {
    showPanel('hold');
  } else if (state.bookedHoldId) {
    showPanel('booked');
  } else {
    showPanel('select');
  }
});

// ===== Load Seats =====
async function loadSeats() {
  try {
    const data = await apiFetch('/seats');
    state.seats = {};
    for (const seat of data.seats) {
      state.seats[seat.id] = seat;
    }
    renderSeatMap();
  } catch (err) {
    seatMapEl.innerHTML = '<div class="loading">Failed to load seats. Please refresh.</div>';
    console.error('Failed to load seats:', err);
  }
}

// ===== SSE =====
function connectSSE() {
  const es = new EventSource(`${API_BASE}/stream`);

  es.addEventListener('connected', () => {
    sseStatusEl.textContent = '● Connected';
    sseStatusEl.className = 'sse-status connected';
  });

  es.addEventListener('seat-update', (event) => {
    try {
      const payload = JSON.parse(event.data);
      handleSeatUpdate(payload);
    } catch (err) {
      console.error('SSE parse error:', err);
    }
  });

  es.onerror = () => {
    sseStatusEl.textContent = '● Disconnected';
    sseStatusEl.className = 'sse-status disconnected';
    // EventSource auto-reconnects
  };

  es.onopen = () => {
    sseStatusEl.textContent = '● Connected';
    sseStatusEl.className = 'sse-status connected';
  };

  return es;
}

function handleSeatUpdate(payload) {
  const { type, seats } = payload;

  for (const update of seats) {
    const seat = state.seats[update.id];
    if (!seat) continue;

    // Don't override our own hold/booking state from SSE
    // (we already updated locally; SSE is for other users' changes)
    const isOurHold = state.currentHold && state.currentHold.seatIds.includes(update.id);
    const isOurBooked = state.bookedSeatIds.includes(update.id);

    if (isOurHold || isOurBooked) continue;

    // Update seat state
    if (type === 'held') {
      seat.status = 'held';
      seat.hold_id = update.holdId || null;
      seat.hold_expires_at = update.expiresAt || null;
      // Remove from selection if it was selected
      state.selectedIds.delete(update.id);
      updateSeatEl(update.id, null);
    } else if (type === 'booked') {
      seat.status = 'booked';
      seat.hold_id = update.holdId || null;
      seat.booked_by = update.bookedBy || null;
      state.selectedIds.delete(update.id);
      updateSeatEl(update.id, 'just-booked');
    } else if (type === 'released') {
      seat.status = 'available';
      seat.hold_id = null;
      seat.hold_expires_at = null;
      updateSeatEl(update.id, null);
    }
  }

  updateSelectionUI();
  updateInventory();
}

// ===== Bootstrap =====
showPanel('select');
updateSelectionUI();
loadSeats().then(() => {
  connectSSE();
});
