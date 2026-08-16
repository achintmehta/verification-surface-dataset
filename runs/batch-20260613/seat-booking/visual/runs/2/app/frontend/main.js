// ===== Configuration =====
const API_BASE = '/api';
const HOLD_TTL_SECONDS = 60;

// ===== State =====
const state = {
  sessionId: getOrCreateSessionId(),
  seats: {},           // id -> seat object
  selectedSeatIds: new Set(),
  currentHold: null,   // { id, seatIds, expiresAt }
  currentBooking: null, // { holdId, seatIds }
  countdownInterval: null,
};

// ===== Session ID =====
function getOrCreateSessionId() {
  let id = sessionStorage.getItem('seat_session_id');
  if (!id) {
    id = 'sess_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now();
    sessionStorage.setItem('seat_session_id', id);
  }
  return id;
}

// ===== DOM References =====
const dom = {
  seatMap: document.getElementById('seat-map'),
  loadingOverlay: document.getElementById('loading-overlay'),
  sessionIdDisplay: document.getElementById('session-id-display'),
  connectionStatus: document.getElementById('connection-status'),
  invAvailable: document.getElementById('inv-available'),
  invHeld: document.getElementById('inv-held'),
  invBooked: document.getElementById('inv-booked'),
  invTotal: document.getElementById('inv-total'),
  notifications: document.getElementById('notifications'),

  // Phases
  phaseSelect: document.getElementById('phase-select'),
  phaseHold: document.getElementById('phase-hold'),
  phaseBooked: document.getElementById('phase-booked'),

  // Select phase
  selectionHint: document.getElementById('selection-hint'),
  selectedSeatsDisplay: document.getElementById('selected-seats-display'),
  btnHold: document.getElementById('btn-hold'),

  // Hold phase
  heldSeatsList: document.getElementById('held-seats-list'),
  holdCountdown: document.getElementById('hold-countdown'),
  btnConfirm: document.getElementById('btn-confirm'),
  btnRelease: document.getElementById('btn-release'),

  // Booked phase
  bookedSeatsList: document.getElementById('booked-seats-list'),
  btnNewBooking: document.getElementById('btn-new-booking'),
};

// ===== Initialization =====
async function init() {
  dom.sessionIdDisplay.textContent = state.sessionId.slice(0, 12) + '…';
  await loadSeats();
  connectSSE();
  bindActions();
}

// ===== Load Seats =====
async function loadSeats() {
  showLoading(true);
  try {
    const res = await fetch(`${API_BASE}/seats`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { seats } = await res.json();
    seats.forEach(seat => { state.seats[seat.id] = seat; });
    renderSeatMap();
    updateInventory();
  } catch (err) {
    showNotification('error', 'Failed to load seats', err.message);
  } finally {
    showLoading(false);
  }
}

// ===== Render Seat Map =====
function renderSeatMap() {
  dom.seatMap.innerHTML = '';

  // Group by row
  const rows = {};
  Object.values(state.seats).forEach(seat => {
    if (!rows[seat.row_label]) rows[seat.row_label] = [];
    rows[seat.row_label].push(seat);
  });

  const sortedRows = Object.keys(rows).sort();

  sortedRows.forEach(rowLabel => {
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';

    const labelEl = document.createElement('div');
    labelEl.className = 'row-label';
    labelEl.textContent = rowLabel;
    rowEl.appendChild(labelEl);

    const seatsEl = document.createElement('div');
    seatsEl.className = 'seats-in-row';

    const sortedSeats = rows[rowLabel].sort((a, b) => a.seat_number - b.seat_number);
    sortedSeats.forEach(seat => {
      seatsEl.appendChild(createSeatElement(seat));
    });

    rowEl.appendChild(seatsEl);
    dom.seatMap.appendChild(rowEl);
  });
}

function createSeatElement(seat) {
  const el = document.createElement('button');
  el.id = `seat-${seat.id}`;
  el.className = `seat ${getSeatClass(seat)}`;
  el.textContent = seat.seat_number;
  el.setAttribute('aria-label', `Row ${seat.row_label} Seat ${seat.seat_number} - ${getSeatClass(seat)}`);
  el.dataset.seatId = seat.id;

  const cls = getSeatClass(seat);
  if (cls === 'available') {
    el.addEventListener('click', () => toggleSeatSelection(seat.id));
  } else if (cls === 'held-mine') {
    // Clicking a held-mine seat does nothing (already in hold phase)
  }

  return el;
}

function getSeatClass(seat) {
  if (seat.status === 'booked') return 'booked';
  if (seat.status === 'held') {
    if (seat.hold_id && state.currentHold && seat.hold_id === state.currentHold.id) {
      return 'held-mine';
    }
    return 'held-other';
  }
  if (state.selectedSeatIds.has(seat.id)) return 'selected';
  return 'available';
}

function updateSeatElement(seatId) {
  const seat = state.seats[seatId];
  if (!seat) return;

  const el = document.getElementById(`seat-${seatId}`);
  if (!el) return;

  const cls = getSeatClass(seat);
  el.className = `seat ${cls}`;
  el.setAttribute('aria-label', `Row ${seat.row_label} Seat ${seat.seat_number} - ${cls}`);

  // Re-bind click handler
  const newEl = el.cloneNode(true);
  if (cls === 'available') {
    newEl.addEventListener('click', () => toggleSeatSelection(seatId));
  }
  el.parentNode.replaceChild(newEl, el);
}

// ===== Seat Selection =====
function toggleSeatSelection(seatId) {
  // Only allow selection in select phase
  if (!dom.phaseSelect.classList.contains('active')) return;

  const seat = state.seats[seatId];
  if (!seat || seat.status !== 'available') return;

  if (state.selectedSeatIds.has(seatId)) {
    state.selectedSeatIds.delete(seatId);
  } else {
    state.selectedSeatIds.add(seatId);
  }

  updateSeatElement(seatId);
  updateSelectionDisplay();
}

function updateSelectionDisplay() {
  const count = state.selectedSeatIds.size;
  dom.btnHold.disabled = count === 0;
  dom.btnHold.textContent = count > 0
    ? `Hold ${count} Seat${count > 1 ? 's' : ''}`
    : 'Hold Selected Seats';

  dom.selectedSeatsDisplay.innerHTML = '';
  state.selectedSeatIds.forEach(id => {
    const tag = document.createElement('span');
    tag.className = 'seat-tag';
    tag.textContent = id;
    dom.selectedSeatsDisplay.appendChild(tag);
  });
}

// ===== Inventory =====
function updateInventory() {
  const seats = Object.values(state.seats);
  const total = seats.length;
  const booked = seats.filter(s => s.status === 'booked').length;
  const held = seats.filter(s => s.status === 'held').length;
  const available = seats.filter(s => s.status === 'available').length;

  dom.invAvailable.textContent = available;
  dom.invHeld.textContent = held;
  dom.invBooked.textContent = booked;
  dom.invTotal.textContent = total;
}

// ===== Phase Management =====
function showPhase(phase) {
  dom.phaseSelect.classList.remove('active');
  dom.phaseHold.classList.remove('active');
  dom.phaseBooked.classList.remove('active');
  document.getElementById(`phase-${phase}`).classList.add('active');
}

// ===== Hold Actions =====
async function requestHold() {
  const seatIds = [...state.selectedSeatIds];
  if (seatIds.length === 0) return;

  dom.btnHold.disabled = true;
  dom.btnHold.textContent = 'Placing hold…';

  try {
    const res = await fetch(`${API_BASE}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId: state.sessionId }),
    });

    const data = await res.json();

    if (res.status === 409) {
      // Conflict — some seats taken
      const conflicting = data.conflictingSeatIds || [];
      showNotification('error', 'Seats Unavailable',
        `Seats ${conflicting.join(', ')} are no longer available.`);

      // Refresh seat map to show current state
      await loadSeats();

      // Deselect conflicting seats
      conflicting.forEach(id => state.selectedSeatIds.delete(id));
      updateSelectionDisplay();
      return;
    }

    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    // Success
    const { hold } = data;
    state.currentHold = {
      id: hold.id,
      seatIds: hold.seatIds,
      expiresAt: new Date(hold.expiresAt),
    };

    // Update local seat state
    hold.seatIds.forEach(id => {
      if (state.seats[id]) {
        state.seats[id].status = 'held';
        state.seats[id].hold_id = hold.id;
        state.seats[id].hold_expires_at = hold.expiresAt;
      }
    });

    state.selectedSeatIds.clear();
    renderSeatMap();
    updateInventory();

    // Show hold phase
    dom.heldSeatsList.textContent = hold.seatIds.join(', ');
    showPhase('hold');
    startCountdown();

    showNotification('success', 'Hold Placed',
      `${hold.seatIds.length} seat(s) held for ${HOLD_TTL_SECONDS}s.`);

  } catch (err) {
    showNotification('error', 'Hold Failed', err.message);
    dom.btnHold.disabled = false;
    dom.btnHold.textContent = `Hold ${state.selectedSeatIds.size} Seat(s)`;
  }
}

async function confirmHold() {
  if (!state.currentHold) return;

  dom.btnConfirm.disabled = true;
  dom.btnConfirm.textContent = 'Confirming…';

  try {
    const res = await fetch(`${API_BASE}/holds/${state.currentHold.id}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: state.sessionId }),
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    // Success
    const { booking } = data;
    state.currentBooking = {
      holdId: booking.holdId,
      seatIds: booking.seats.map(s => s.id),
    };

    // Update local state
    booking.seats.forEach(s => {
      if (state.seats[s.id]) {
        state.seats[s.id].status = 'booked';
        state.seats[s.id].hold_id = null;
        state.seats[s.id].hold_expires_at = null;
        state.seats[s.id].booked_by = state.sessionId;
      }
    });

    stopCountdown();
    state.currentHold = null;

    renderSeatMap();
    updateInventory();

    dom.bookedSeatsList.textContent = booking.seats.map(s => s.id).join(', ');
    showPhase('booked');

    showNotification('success', 'Booking Confirmed!',
      `Seats ${booking.seats.map(s => s.id).join(', ')} are now booked.`);

  } catch (err) {
    showNotification('error', 'Confirmation Failed', err.message);
    dom.btnConfirm.disabled = false;
    dom.btnConfirm.textContent = '✅ Confirm Booking';

    // If hold expired, go back to select phase
    if (err.message.includes('expired') || err.message.includes('not found')) {
      handleHoldExpired();
    }
  }
}

async function releaseHold() {
  if (!state.currentHold) return;

  dom.btnRelease.disabled = true;
  dom.btnRelease.textContent = 'Releasing…';

  try {
    const res = await fetch(`${API_BASE}/holds/${state.currentHold.id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: state.sessionId }),
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    // Update local state
    const releasedIds = data.released || [];
    releasedIds.forEach(id => {
      if (state.seats[id]) {
        state.seats[id].status = 'available';
        state.seats[id].hold_id = null;
        state.seats[id].hold_expires_at = null;
      }
    });

    stopCountdown();
    state.currentHold = null;

    renderSeatMap();
    updateInventory();
    showPhase('select');
    updateSelectionDisplay();

    showNotification('info', 'Hold Released', `${releasedIds.length} seat(s) released.`);

  } catch (err) {
    showNotification('error', 'Release Failed', err.message);
    dom.btnRelease.disabled = false;
    dom.btnRelease.textContent = '❌ Release Hold';
  }
}

// ===== Countdown =====
function startCountdown() {
  stopCountdown();
  updateCountdownDisplay();
  state.countdownInterval = setInterval(() => {
    updateCountdownDisplay();
  }, 1000);
}

function stopCountdown() {
  if (state.countdownInterval) {
    clearInterval(state.countdownInterval);
    state.countdownInterval = null;
  }
}

function updateCountdownDisplay() {
  if (!state.currentHold) return;

  const remaining = Math.max(0, Math.floor((state.currentHold.expiresAt - Date.now()) / 1000));

  if (remaining <= 0) {
    dom.holdCountdown.textContent = 'Expired!';
    dom.holdCountdown.classList.add('urgent');
    handleHoldExpired();
    return;
  }

  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  dom.holdCountdown.textContent = mins > 0
    ? `${mins}m ${secs.toString().padStart(2, '0')}s`
    : `${secs}s`;

  if (remaining <= 10) {
    dom.holdCountdown.classList.add('urgent');
  } else {
    dom.holdCountdown.classList.remove('urgent');
  }
}

function handleHoldExpired() {
  stopCountdown();

  if (state.currentHold) {
    // Update local state for held seats
    state.currentHold.seatIds.forEach(id => {
      if (state.seats[id] && state.seats[id].status === 'held') {
        state.seats[id].status = 'available';
        state.seats[id].hold_id = null;
        state.seats[id].hold_expires_at = null;
      }
    });
    state.currentHold = null;
  }

  renderSeatMap();
  updateInventory();
  showPhase('select');
  updateSelectionDisplay();

  showNotification('warning', 'Hold Expired', 'Your hold has expired. Please select seats again.');
}

// ===== SSE =====
function connectSSE() {
  setConnectionStatus('connecting');

  const es = new EventSource(`/api/stream`);

  es.addEventListener('connected', () => {
    setConnectionStatus('connected');
    console.log('[SSE] Connected');
  });

  es.addEventListener('seat_held', (e) => {
    const { seats } = JSON.parse(e.data);
    handleSeatUpdates(seats, 'held');
  });

  es.addEventListener('seat_booked', (e) => {
    const { seats } = JSON.parse(e.data);
    handleSeatUpdates(seats, 'booked');
  });

  es.addEventListener('seat_released', (e) => {
    const { seats } = JSON.parse(e.data);
    handleSeatUpdates(seats, 'available');
  });

  es.onerror = () => {
    setConnectionStatus('disconnected');
    console.warn('[SSE] Connection error, will retry…');
  };

  es.onopen = () => {
    setConnectionStatus('connected');
  };
}

function handleSeatUpdates(seats, defaultStatus) {
  let changed = false;

  seats.forEach(update => {
    const seat = state.seats[update.id];
    if (!seat) return;

    const newStatus = update.status || defaultStatus;

    // Don't overwrite our own hold with SSE (we already updated locally)
    if (newStatus === 'held' && state.currentHold && update.holdId === state.currentHold.id) {
      return;
    }

    // Don't overwrite our own booking
    if (newStatus === 'booked' && state.currentBooking &&
        state.currentBooking.seatIds.includes(update.id)) {
      return;
    }

    seat.status = newStatus;
    seat.hold_id = update.holdId || null;
    seat.hold_expires_at = update.expiresAt || null;
    seat.booked_by = update.bookedBy || null;

    // If a seat we selected got taken, deselect it
    if (newStatus !== 'available' && state.selectedSeatIds.has(update.id)) {
      state.selectedSeatIds.delete(update.id);
      changed = true;
    }

    updateSeatElement(update.id);
    changed = true;
  });

  if (changed) {
    updateInventory();
    updateSelectionDisplay();
  }
}

function setConnectionStatus(status) {
  dom.connectionStatus.className = `status-dot ${status}`;
  dom.connectionStatus.title = `SSE: ${status}`;
}

// ===== Bind Actions =====
function bindActions() {
  dom.btnHold.addEventListener('click', requestHold);
  dom.btnConfirm.addEventListener('click', confirmHold);
  dom.btnRelease.addEventListener('click', releaseHold);
  dom.btnNewBooking.addEventListener('click', () => {
    state.currentBooking = null;
    state.selectedSeatIds.clear();
    showPhase('select');
    updateSelectionDisplay();
    loadSeats(); // Refresh to get latest state
  });
}

// ===== Notifications =====
function showNotification(type, title, message, durationMs = 5000) {
  const icons = { error: '❌', success: '✅', warning: '⚠️', info: 'ℹ️' };

  const el = document.createElement('div');
  el.className = `notification ${type}`;
  el.innerHTML = `
    <span class="notification-icon">${icons[type] || 'ℹ️'}</span>
    <div class="notification-body">
      <div class="notification-title">${title}</div>
      ${message ? `<div class="notification-msg">${message}</div>` : ''}
    </div>
  `;

  dom.notifications.appendChild(el);

  setTimeout(() => {
    el.classList.add('removing');
    setTimeout(() => el.remove(), 300);
  }, durationMs);
}

// ===== Loading =====
function showLoading(show) {
  dom.loadingOverlay.classList.toggle('hidden', !show);
}

// ===== Start =====
init();
