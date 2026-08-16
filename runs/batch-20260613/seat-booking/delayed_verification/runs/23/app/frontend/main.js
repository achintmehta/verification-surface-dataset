// ─── State ───────────────────────────────────────
const state = {
  seats: [],          // Array of seat objects from server
  selectedIds: new Set(), // Seat IDs selected by user (before hold)
  currentHold: null,  // { holdId, expiresAt, seatIds }
  sessionId: getOrCreateSessionId(),
  timerInterval: null
};

function getOrCreateSessionId() {
  let sid = localStorage.getItem('seatBookingSessionId');
  if (!sid) {
    sid = 'session-' + Math.random().toString(36).substr(2, 9) + '-' + Date.now();
    localStorage.setItem('seatBookingSessionId', sid);
  }
  return sid;
}

// ─── API ─────────────────────────────────────────
const API_BASE = '/api';

async function fetchSeats() {
  const res = await fetch(`${API_BASE}/seats`);
  const data = await res.json();
  return data.seats;
}

async function requestHold(seatIds) {
  const res = await fetch(`${API_BASE}/holds`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seatIds, sessionId: state.sessionId })
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error || 'Hold failed');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function confirmHold(holdId) {
  const res = await fetch(`${API_BASE}/holds/${holdId}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error || 'Confirm failed');
    err.status = res.status;
    throw err;
  }
  return data;
}

async function releaseHold(holdId) {
  const res = await fetch(`${API_BASE}/holds/${holdId}`, {
    method: 'DELETE'
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error || 'Release failed');
    err.status = res.status;
    throw err;
  }
  return data;
}

// ─── SSE ─────────────────────────────────────────
function connectSSE() {
  const evtSource = new EventSource(`${API_BASE}/stream`);

  evtSource.addEventListener('connected', () => {
    document.getElementById('connection-status').textContent = 'Connected';
    document.getElementById('connection-status').className = 'status-badge connected';
  });

  evtSource.addEventListener('seatUpdate', (event) => {
    const updates = JSON.parse(event.data);
    applySeatUpdates(updates);
  });

  evtSource.onerror = () => {
    document.getElementById('connection-status').textContent = 'Disconnected';
    document.getElementById('connection-status').className = 'status-badge disconnected';
  };

  evtSource.onopen = () => {
    document.getElementById('connection-status').textContent = 'Connected';
    document.getElementById('connection-status').className = 'status-badge connected';
  };
}

function applySeatUpdates(updates) {
  for (const update of updates) {
    const idx = state.seats.findIndex(s => s.id === update.id);
    if (idx !== -1) {
      state.seats[idx] = { ...state.seats[idx], ...update };
    }
  }

  // Check if our hold's seats got released (e.g., expired server-side)
  if (state.currentHold) {
    const holdSeatIds = new Set(state.currentHold.seatIds);
    for (const update of updates) {
      if (holdSeatIds.has(update.id) && update.status === 'available') {
        // Our hold expired or was released
        clearCurrentHold();
        showNotification('Your hold has expired', 'error');
        break;
      }
    }
  }

  // If an update marks a selected seat as unavailable, deselect it
  for (const update of updates) {
    if (state.selectedIds.has(update.id) && update.status !== 'available') {
      state.selectedIds.delete(update.id);
    }
  }

  renderSeatMap();
  updateInventory();
  updateActionButtons();
}

// ─── Rendering ───────────────────────────────────
function renderSeatMap() {
  const container = document.getElementById('seat-map');
  container.innerHTML = '';

  // Group seats by row
  const rowMap = new Map();
  for (const seat of state.seats) {
    if (!rowMap.has(seat.row_label)) {
      rowMap.set(seat.row_label, []);
    }
    rowMap.get(seat.row_label).push(seat);
  }

  // Sort rows
  const sortedRows = [...rowMap.keys()].sort();

  for (const rowLabel of sortedRows) {
    const rowDiv = document.createElement('div');
    rowDiv.className = 'seat-row';

    const label = document.createElement('span');
    label.className = 'row-label';
    label.textContent = rowLabel;
    rowDiv.appendChild(label);

    const seats = rowMap.get(rowLabel).sort((a, b) => a.seat_number - b.seat_number);

    for (const seat of seats) {
      const seatEl = document.createElement('div');
      seatEl.className = 'seat ' + getSeatClass(seat);
      seatEl.textContent = seat.seat_number;
      seatEl.dataset.seatId = seat.id;
      seatEl.title = `${seat.row_label}${seat.seat_number} - ${getEffectiveStatus(seat)}`;

      seatEl.addEventListener('click', () => onSeatClick(seat));
      rowDiv.appendChild(seatEl);
    }

    // Right label
    const labelRight = document.createElement('span');
    labelRight.className = 'row-label';
    labelRight.textContent = rowLabel;
    rowDiv.appendChild(labelRight);

    container.appendChild(rowDiv);
  }
}

function getEffectiveStatus(seat) {
  if (seat.status === 'held' && seat.hold_expires_at && new Date(seat.hold_expires_at) <= new Date()) {
    return 'available';
  }
  return seat.status;
}

function getSeatClass(seat) {
  const effective = getEffectiveStatus(seat);

  if (state.selectedIds.has(seat.id) && effective === 'available') {
    return 'selected';
  }

  if (effective === 'held') {
    // Check if it's our hold
    if (state.currentHold && state.currentHold.seatIds.includes(seat.id)) {
      return 'held-mine';
    }
    if (seat.session_id === state.sessionId) {
      return 'held-mine';
    }
    return 'held';
  }

  if (effective === 'booked') return 'booked';
  return 'available';
}

function updateInventory() {
  let available = 0, held = 0, booked = 0;
  for (const seat of state.seats) {
    const eff = getEffectiveStatus(seat);
    if (eff === 'available') available++;
    else if (eff === 'held') held++;
    else if (eff === 'booked') booked++;
  }
  document.getElementById('inv-available').textContent = `Available: ${available}`;
  document.getElementById('inv-held').textContent = `Held: ${held}`;
  document.getElementById('inv-booked').textContent = `Booked: ${booked}`;
  document.getElementById('inv-total').textContent = `Total: ${state.seats.length}`;
}

function updateActionButtons() {
  const btnHold = document.getElementById('btn-hold');
  const btnConfirm = document.getElementById('btn-confirm');
  const btnRelease = document.getElementById('btn-release');
  const selectionInfo = document.getElementById('selection-info');
  const holdInfo = document.getElementById('hold-info');

  if (state.currentHold) {
    // In hold state
    btnHold.classList.add('hidden');
    btnConfirm.classList.remove('hidden');
    btnConfirm.disabled = false;
    btnRelease.classList.remove('hidden');
    selectionInfo.textContent = `Hold active: ${state.currentHold.seatIds.length} seat(s)`;
    holdInfo.classList.remove('hidden');
    const holdSeatLabels = state.currentHold.seatIds.map(id => {
      const seat = state.seats.find(s => s.id === id);
      return seat ? `${seat.row_label}${seat.seat_number}` : id;
    });
    document.getElementById('hold-seats').textContent = `Seats: ${holdSeatLabels.join(', ')}`;
  } else {
    // Selection state
    btnHold.classList.remove('hidden');
    btnConfirm.classList.add('hidden');
    btnRelease.classList.add('hidden');
    holdInfo.classList.add('hidden');

    if (state.selectedIds.size > 0) {
      btnHold.disabled = false;
      const selectedLabels = [...state.selectedIds].map(id => {
        const seat = state.seats.find(s => s.id === id);
        return seat ? `${seat.row_label}${seat.seat_number}` : id;
      });
      selectionInfo.textContent = `Selected: ${selectedLabels.join(', ')}`;
    } else {
      btnHold.disabled = true;
      selectionInfo.textContent = 'Select seats to begin';
    }
  }
}

// ─── Hold Timer ──────────────────────────────────
function startHoldTimer() {
  stopHoldTimer();
  updateTimerDisplay();
  state.timerInterval = setInterval(() => {
    updateTimerDisplay();
  }, 200);
}

function stopHoldTimer() {
  if (state.timerInterval) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }
  document.getElementById('hold-timer').textContent = '';
}

function updateTimerDisplay() {
  if (!state.currentHold) {
    stopHoldTimer();
    return;
  }
  const remaining = Math.max(0, new Date(state.currentHold.expiresAt) - Date.now());
  const seconds = Math.ceil(remaining / 1000);

  const timerEl = document.getElementById('hold-timer');
  if (seconds <= 0) {
    timerEl.textContent = 'Hold expired!';
    timerEl.style.color = '#e74c3c';
    clearCurrentHold();
    // Refresh seats from server
    loadSeats();
    showNotification('Your hold has expired', 'error');
  } else {
    timerEl.textContent = `⏱ ${seconds}s remaining`;
    timerEl.style.color = seconds <= 5 ? '#e74c3c' : '#e67e22';
  }
}

function clearCurrentHold() {
  state.currentHold = null;
  state.selectedIds.clear();
  stopHoldTimer();
  updateActionButtons();
  renderSeatMap();
}

// ─── Event Handlers ──────────────────────────────
function onSeatClick(seat) {
  // If we have an active hold, don't allow seat selection
  if (state.currentHold) return;

  const effective = getEffectiveStatus(seat);
  if (effective !== 'available') return;

  if (state.selectedIds.has(seat.id)) {
    state.selectedIds.delete(seat.id);
  } else {
    state.selectedIds.add(seat.id);
  }

  renderSeatMap();
  updateActionButtons();
}

async function onHoldClick() {
  if (state.selectedIds.size === 0) return;

  const seatIds = [...state.selectedIds];
  const btnHold = document.getElementById('btn-hold');
  btnHold.disabled = true;
  btnHold.textContent = 'Holding...';

  try {
    const result = await requestHold(seatIds);
    state.currentHold = {
      holdId: result.holdId,
      expiresAt: result.expiresAt,
      seatIds: seatIds
    };
    state.selectedIds.clear();

    // Update local seat state
    for (const seat of result.seats) {
      const idx = state.seats.findIndex(s => s.id === seat.id);
      if (idx !== -1) {
        state.seats[idx] = { ...state.seats[idx], ...seat };
      }
    }

    renderSeatMap();
    updateInventory();
    updateActionButtons();
    startHoldTimer();
    showNotification(`Held ${seatIds.length} seat(s)!`, 'success');
  } catch (err) {
    if (err.status === 409 && err.data && err.data.conflicting) {
      const conflictLabels = err.data.conflicting.map(c => `${c.row_label}${c.seat_number}`);
      showNotification(`Seats already taken: ${conflictLabels.join(', ')}`, 'error');

      // Remove conflicting seats from selection
      for (const c of err.data.conflicting) {
        state.selectedIds.delete(c.id);
      }

      // Refresh seat map
      await loadSeats();
    } else {
      showNotification(err.message || 'Failed to hold seats', 'error');
    }
  } finally {
    btnHold.textContent = 'Hold Selected Seats';
    updateActionButtons();
  }
}

async function onConfirmClick() {
  if (!state.currentHold) return;

  const btnConfirm = document.getElementById('btn-confirm');
  btnConfirm.disabled = true;
  btnConfirm.textContent = 'Confirming...';

  try {
    const result = await confirmHold(state.currentHold.holdId);

    // Update local seat state
    for (const seat of result.seats) {
      const idx = state.seats.findIndex(s => s.id === seat.id);
      if (idx !== -1) {
        state.seats[idx] = { ...state.seats[idx], ...seat };
      }
    }

    clearCurrentHold();
    renderSeatMap();
    updateInventory();
    showNotification('Booking confirmed! 🎉', 'success');
  } catch (err) {
    showNotification(err.message || 'Confirmation failed', 'error');
    if (err.status === 410 || err.status === 409) {
      clearCurrentHold();
      await loadSeats();
    }
  } finally {
    btnConfirm.textContent = 'Confirm Booking';
    updateActionButtons();
  }
}

async function onReleaseClick() {
  if (!state.currentHold) return;

  try {
    await releaseHold(state.currentHold.holdId);
    clearCurrentHold();
    await loadSeats();
    showNotification('Hold released', 'info');
  } catch (err) {
    showNotification(err.message || 'Release failed', 'error');
    clearCurrentHold();
    await loadSeats();
  }
}

// ─── Notifications ───────────────────────────────
let notifTimeout = null;

function showNotification(message, type = 'info') {
  const el = document.getElementById('notification');
  el.textContent = message;
  el.className = `notification ${type}`;
  el.classList.remove('hidden');

  if (notifTimeout) clearTimeout(notifTimeout);
  notifTimeout = setTimeout(() => {
    el.classList.add('hidden');
  }, 4000);
}

// ─── Init ────────────────────────────────────────
async function loadSeats() {
  try {
    state.seats = await fetchSeats();
    renderSeatMap();
    updateInventory();
    updateActionButtons();
  } catch (err) {
    showNotification('Failed to load seats', 'error');
  }
}

async function init() {
  // Bind button events
  document.getElementById('btn-hold').addEventListener('click', onHoldClick);
  document.getElementById('btn-confirm').addEventListener('click', onConfirmClick);
  document.getElementById('btn-release').addEventListener('click', onReleaseClick);

  // Load seats
  await loadSeats();

  // Connect SSE
  connectSSE();
}

init();
