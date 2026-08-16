/**
 * Seat Booking Frontend
 * Vanilla JS SPA with SSE for real-time updates
 */

// When served via Vite dev proxy, /api proxies to backend.
// When served directly from backend (production build), /api is on same origin.
const API_BASE = '/api';
const HOLD_TTL_SECONDS = 60; // Should match backend

// ===== State =====
const state = {
  sessionId: getOrCreateSessionId(),
  seats: new Map(),          // seatId -> seat object
  selectedSeatIds: new Set(), // seats user has clicked to select
  currentHold: null,          // { id, seatIds, expiresAt, ttlSeconds }
  currentBooking: null,       // { holdId, seatIds }
  countdownInterval: null,
  sseSource: null,
};

// ===== Session ID =====
function getOrCreateSessionId() {
  let id = sessionStorage.getItem('seatBookingSessionId');
  if (!id) {
    id = 'sess-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36);
    sessionStorage.setItem('seatBookingSessionId', id);
  }
  return id;
}

// ===== DOM References =====
const dom = {
  sessionIdEl: document.getElementById('session-id'),
  connectionStatus: document.getElementById('connection-status'),
  seatMap: document.getElementById('seat-map'),
  invAvailable: document.getElementById('inv-available'),
  invHeld: document.getElementById('inv-held'),
  invBooked: document.getElementById('inv-booked'),
  invTotal: document.getElementById('inv-total'),
  panelSelect: document.getElementById('panel-select'),
  panelHold: document.getElementById('panel-hold'),
  panelBooked: document.getElementById('panel-booked'),
  panelError: document.getElementById('panel-error'),
  selectionInfo: document.getElementById('selection-info'),
  btnHold: document.getElementById('btn-hold'),
  holdSeatList: document.getElementById('hold-seat-list'),
  holdCountdown: document.getElementById('hold-countdown'),
  btnConfirm: document.getElementById('btn-confirm'),
  btnRelease: document.getElementById('btn-release'),
  bookedSeatList: document.getElementById('booked-seat-list'),
  btnNewBooking: document.getElementById('btn-new-booking'),
  errorMessage: document.getElementById('error-message'),
  btnErrorDismiss: document.getElementById('btn-error-dismiss'),
  notifications: document.getElementById('notifications'),
};

// ===== Initialization =====
async function init() {
  dom.sessionIdEl.textContent = state.sessionId.slice(0, 16) + '…';
  dom.sessionIdEl.title = state.sessionId;

  setupEventListeners();
  await loadSeats();
  connectSSE();
}

// ===== Event Listeners =====
function setupEventListeners() {
  dom.btnHold.addEventListener('click', requestHold);
  dom.btnConfirm.addEventListener('click', confirmHold);
  dom.btnRelease.addEventListener('click', releaseHold);
  dom.btnNewBooking.addEventListener('click', resetToSelection);
  dom.btnErrorDismiss.addEventListener('click', () => {
    showPanel('select');
  });
}

// ===== API Calls =====
async function loadSeats() {
  try {
    const res = await fetch(`${API_BASE}/seats`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // Update state
    state.seats.clear();
    for (const seat of data.seats) {
      state.seats.set(seat.id, seat);
    }

    renderSeatMap();
    updateInventory();
  } catch (err) {
    console.error('[loadSeats]', err);
    dom.seatMap.innerHTML = '<div class="loading" style="color:#ff8888">Failed to load seats. Retrying…</div>';
    setTimeout(loadSeats, 3000);
  }
}

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

    if (res.ok) {
      state.currentHold = data.hold;
      state.selectedSeatIds.clear();

      // Update local seat state
      for (const seatId of data.hold.seatIds) {
        const seat = state.seats.get(seatId);
        if (seat) {
          seat.status = 'held';
          seat.hold_id = data.hold.id;
          seat.hold_expires_at = data.hold.expiresAt;
        }
      }

      renderSeatMap();
      updateInventory();
      showPanel('hold');
      startCountdown(data.hold.expiresAt);
      showNotification(`Hold placed for ${data.hold.seatIds.length} seat(s)!`, 'success');
    } else if (res.status === 409) {
      // Conflict: some seats taken
      const conflicting = data.conflictingSeatIds || [];
      showError(
        `⚠️ Seats unavailable: ${conflicting.join(', ')}.\n` +
        `These seats were taken by another user. Please select different seats.`
      );

      // Refresh seat map to show current state
      state.selectedSeatIds.clear();
      await loadSeats();
    } else {
      showError(`Failed to place hold: ${data.error || 'Unknown error'}`);
    }
  } catch (err) {
    console.error('[requestHold]', err);
    showError('Network error while placing hold. Please try again.');
  } finally {
    dom.btnHold.disabled = false;
    dom.btnHold.textContent = 'Hold Selected Seats';
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

    if (res.ok) {
      stopCountdown();
      state.currentBooking = data.booking;

      // Update local seat state
      for (const seatId of data.booking.seatIds) {
        const seat = state.seats.get(seatId);
        if (seat) {
          seat.status = 'booked';
          seat.booked_by = state.sessionId;
          seat.hold_expires_at = null;
        }
      }

      state.currentHold = null;
      renderSeatMap();
      updateInventory();
      showPanel('booked');

      dom.bookedSeatList.textContent = data.booking.seatIds.join(', ');
      showNotification('🎉 Booking confirmed!', 'success');
    } else if (res.status === 410) {
      // Hold expired
      stopCountdown();
      state.currentHold = null;
      showError(`Hold expired: ${data.error}. Please select seats again.`);
      await loadSeats();
    } else {
      showError(`Failed to confirm: ${data.error || 'Unknown error'}`);
    }
  } catch (err) {
    console.error('[confirmHold]', err);
    showError('Network error while confirming. Please try again.');
  } finally {
    dom.btnConfirm.disabled = false;
    dom.btnConfirm.textContent = '✓ Confirm Booking';
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

    if (res.ok) {
      stopCountdown();

      // Update local seat state
      for (const seatId of (data.seatIds || state.currentHold.seatIds)) {
        const seat = state.seats.get(seatId);
        if (seat) {
          seat.status = 'available';
          seat.hold_id = null;
          seat.hold_expires_at = null;
        }
      }

      state.currentHold = null;
      renderSeatMap();
      updateInventory();
      showPanel('select');
      showNotification('Hold released. Seats are available again.', 'info');
    } else {
      showError(`Failed to release hold: ${data.error || 'Unknown error'}`);
    }
  } catch (err) {
    console.error('[releaseHold]', err);
    showError('Network error while releasing hold.');
  } finally {
    dom.btnRelease.disabled = false;
    dom.btnRelease.textContent = '✗ Release Hold';
  }
}

// ===== Seat Map Rendering =====
function renderSeatMap() {
  // Group seats by row
  const rows = new Map();
  for (const seat of state.seats.values()) {
    if (!rows.has(seat.row_label)) rows.set(seat.row_label, []);
    rows.get(seat.row_label).push(seat);
  }

  // Sort rows alphabetically
  const sortedRows = [...rows.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  dom.seatMap.innerHTML = '';

  for (const [rowLabel, seats] of sortedRows) {
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';

    const labelEl = document.createElement('div');
    labelEl.className = 'row-label';
    labelEl.textContent = rowLabel;
    rowEl.appendChild(labelEl);

    const seatsContainer = document.createElement('div');
    seatsContainer.className = 'seats-container';

    // Sort seats by seat_number
    seats.sort((a, b) => a.seat_number - b.seat_number);

    for (const seat of seats) {
      // Add aisle gap after seat 5
      if (seat.seat_number === 6) {
        const aisle = document.createElement('div');
        aisle.className = 'seat-aisle';
        seatsContainer.appendChild(aisle);
      }

      const seatEl = createSeatElement(seat);
      seatsContainer.appendChild(seatEl);
    }

    rowEl.appendChild(seatsContainer);
    dom.seatMap.appendChild(rowEl);
  }
}

function createSeatElement(seat) {
  const el = document.createElement('div');
  el.className = 'seat';
  el.dataset.seatId = seat.id;
  el.textContent = seat.seat_number;

  const seatClass = getSeatClass(seat);
  el.classList.add(seatClass);

  const isClickable = canSelectSeat(seat);
  if (!isClickable) {
    el.classList.add('seat--disabled');
  }

  // Tooltip
  el.title = getSeatTooltip(seat);

  el.addEventListener('click', () => handleSeatClick(seat.id));

  return el;
}

function getSeatClass(seat) {
  const isSelected = state.selectedSeatIds.has(seat.id);
  if (isSelected) return 'seat--selected';

  const isMyHold = state.currentHold && state.currentHold.seatIds.includes(seat.id);
  const isMyBooking = state.currentBooking && state.currentBooking.seatIds.includes(seat.id);

  switch (seat.status) {
    case 'available':
      return 'seat--available';
    case 'held':
      if (isMyHold || seat.booked_by === state.sessionId) return 'seat--held-mine';
      // Check if this hold belongs to our session via hold_id matching
      if (state.currentHold && seat.hold_id === state.currentHold.id) return 'seat--held-mine';
      return 'seat--held-other';
    case 'booked':
      if (seat.booked_by === state.sessionId || isMyBooking) return 'seat--booked-mine';
      return 'seat--booked-other';
    default:
      return 'seat--available';
  }
}

function getSeatTooltip(seat) {
  switch (seat.status) {
    case 'available': return `Seat ${seat.id} — Available`;
    case 'held': {
      const isMyHold = state.currentHold && seat.hold_id === state.currentHold.id;
      if (isMyHold) return `Seat ${seat.id} — Your hold`;
      return `Seat ${seat.id} — Held by another user`;
    }
    case 'booked': {
      if (seat.booked_by === state.sessionId) return `Seat ${seat.id} — Booked by you`;
      return `Seat ${seat.id} — Booked`;
    }
    default: return `Seat ${seat.id}`;
  }
}

function canSelectSeat(seat) {
  // Can only select available seats when not in hold/booked state
  if (state.currentHold || state.currentBooking) return false;
  return seat.status === 'available';
}

function handleSeatClick(seatId) {
  const seat = state.seats.get(seatId);
  if (!seat) return;
  if (!canSelectSeat(seat)) return;

  if (state.selectedSeatIds.has(seatId)) {
    state.selectedSeatIds.delete(seatId);
  } else {
    state.selectedSeatIds.add(seatId);
  }

  updateSelectionUI();
  // Re-render just the affected seat
  updateSeatElement(seatId);
}

function updateSeatElement(seatId) {
  const seat = state.seats.get(seatId);
  if (!seat) return;

  const existing = dom.seatMap.querySelector(`[data-seat-id="${seatId}"]`);
  if (!existing) return;

  const newEl = createSeatElement(seat);
  existing.replaceWith(newEl);
}

function updateSelectionUI() {
  const count = state.selectedSeatIds.size;
  if (count === 0) {
    dom.selectionInfo.textContent = 'Click available seats to select them.';
    dom.btnHold.disabled = true;
  } else {
    const ids = [...state.selectedSeatIds].sort().join(', ');
    dom.selectionInfo.textContent = `Selected: ${ids}`;
    dom.btnHold.disabled = false;
  }
}

// ===== Inventory =====
function updateInventory() {
  let available = 0, held = 0, booked = 0;
  for (const seat of state.seats.values()) {
    switch (seat.status) {
      case 'available': available++; break;
      case 'held': held++; break;
      case 'booked': booked++; break;
    }
  }
  const total = available + held + booked;
  dom.invAvailable.textContent = available;
  dom.invHeld.textContent = held;
  dom.invBooked.textContent = booked;
  dom.invTotal.textContent = total;
}

// ===== Panel Management =====
function showPanel(name) {
  const panels = {
    select: dom.panelSelect,
    hold: dom.panelHold,
    booked: dom.panelBooked,
    error: dom.panelError,
  };

  for (const [key, el] of Object.entries(panels)) {
    el.classList.toggle('active', key === name);
  }
}

function showError(message) {
  dom.errorMessage.textContent = message;
  showPanel('error');
}

function resetToSelection() {
  state.currentBooking = null;
  state.selectedSeatIds.clear();
  updateSelectionUI();
  showPanel('select');
}

// ===== Countdown Timer =====
function startCountdown(expiresAt) {
  stopCountdown();

  const expiresMs = new Date(expiresAt).getTime();

  // Update hold seat list
  if (state.currentHold) {
    dom.holdSeatList.textContent = state.currentHold.seatIds.join(', ');
  }

  function tick() {
    const remaining = Math.max(0, Math.floor((expiresMs - Date.now()) / 1000));
    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    dom.holdCountdown.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;

    if (remaining <= 10) {
      dom.holdCountdown.classList.add('urgent');
    } else {
      dom.holdCountdown.classList.remove('urgent');
    }

    if (remaining === 0) {
      stopCountdown();
      handleHoldExpired();
    }
  }

  tick();
  state.countdownInterval = setInterval(tick, 1000);
}

function stopCountdown() {
  if (state.countdownInterval) {
    clearInterval(state.countdownInterval);
    state.countdownInterval = null;
  }
  dom.holdCountdown.classList.remove('urgent');
}

function handleHoldExpired() {
  showNotification('⏰ Your hold has expired. Seats are available again.', 'warning');

  // Update local state
  if (state.currentHold) {
    for (const seatId of state.currentHold.seatIds) {
      const seat = state.seats.get(seatId);
      if (seat && seat.status === 'held') {
        seat.status = 'available';
        seat.hold_id = null;
        seat.hold_expires_at = null;
      }
    }
    state.currentHold = null;
  }

  renderSeatMap();
  updateInventory();
  showPanel('select');
}

// ===== SSE Connection =====
function connectSSE() {
  if (state.sseSource) {
    state.sseSource.close();
  }

  setConnectionStatus('connecting');

  const source = new EventSource(`${API_BASE}/stream`);
  state.sseSource = source;

  source.addEventListener('connected', () => {
    setConnectionStatus('connected');
    console.log('[SSE] Connected');
  });

  source.addEventListener('seatUpdate', (event) => {
    try {
      const data = JSON.parse(event.data);
      handleSeatUpdate(data);
    } catch (err) {
      console.error('[SSE] Failed to parse event:', err);
    }
  });

  source.addEventListener('error', () => {
    setConnectionStatus('disconnected');
    console.warn('[SSE] Connection error, will retry…');
    source.close();
    state.sseSource = null;
    // Reconnect after 3 seconds
    setTimeout(connectSSE, 3000);
  });

  source.onopen = () => {
    setConnectionStatus('connected');
  };
}

function setConnectionStatus(status) {
  dom.connectionStatus.className = `connection-status ${status}`;
  dom.connectionStatus.title = status.charAt(0).toUpperCase() + status.slice(1);
}

function handleSeatUpdate(data) {
  const { type, seats: updatedSeats } = data;
  if (!Array.isArray(updatedSeats)) return;

  let changed = false;

  for (const update of updatedSeats) {
    const seat = state.seats.get(update.id);
    if (!seat) continue;

    const oldStatus = seat.status;

    switch (type) {
      case 'held':
        // Don't overwrite our own hold (we already updated locally)
        if (update.holdId === state.currentHold?.id) break;
        seat.status = 'held';
        seat.hold_id = update.holdId || null;
        seat.hold_expires_at = update.expiresAt || null;
        seat.booked_by = null;
        break;

      case 'booked':
        // Don't overwrite our own booking
        if (state.currentBooking?.seatIds.includes(update.id)) break;
        seat.status = 'booked';
        seat.booked_by = update.bookedBy || null;
        seat.hold_expires_at = null;
        break;

      case 'released':
        // Don't overwrite our own hold
        if (state.currentHold?.seatIds.includes(update.id)) break;
        seat.status = 'available';
        seat.hold_id = null;
        seat.hold_expires_at = null;
        break;
    }

    if (seat.status !== oldStatus) {
      changed = true;
      // Remove from selection if it's no longer available
      if (seat.status !== 'available') {
        state.selectedSeatIds.delete(update.id);
      }
      // Animate the seat
      updateSeatElementWithPulse(update.id);
    }
  }

  if (changed) {
    updateInventory();
    updateSelectionUI();

    // Show notification for significant updates
    if (type === 'released' && updatedSeats.length > 0) {
      const ids = updatedSeats.map(s => s.id).join(', ');
      showNotification(`Seats released: ${ids}`, 'info', 2000);
    }
  }
}

function updateSeatElementWithPulse(seatId) {
  const seat = state.seats.get(seatId);
  if (!seat) return;

  const existing = dom.seatMap.querySelector(`[data-seat-id="${seatId}"]`);
  if (!existing) return;

  const newEl = createSeatElement(seat);
  newEl.classList.add('seat--pulse');
  existing.replaceWith(newEl);

  // Remove pulse class after animation
  setTimeout(() => newEl.classList.remove('seat--pulse'), 700);
}

// ===== Notifications =====
function showNotification(message, type = 'info', duration = 4000) {
  const el = document.createElement('div');
  el.className = `notification ${type}`;
  el.textContent = message;
  dom.notifications.appendChild(el);

  setTimeout(() => {
    el.classList.add('removing');
    setTimeout(() => el.remove(), 300);
  }, duration);
}

// ===== Start =====
init();
