// ─── State ──────────────────────────────────────────────────

const API_BASE = '/api';

const state = {
  seats: new Map(), // id -> seat object
  selectedSeatIds: new Set(),
  sessionId: getOrCreateSessionId(),
  currentHold: null, // { holdId, seatIds, expiresAt }
  timerInterval: null
};

function getOrCreateSessionId() {
  let sid = sessionStorage.getItem('seatBookingSessionId');
  if (!sid) {
    sid = crypto.randomUUID();
    sessionStorage.setItem('seatBookingSessionId', sid);
  }
  return sid;
}

// ─── DOM Refs ───────────────────────────────────────────────

const seatMapEl = document.getElementById('seat-map');
const selectionInfoEl = document.getElementById('selection-info');
const btnHold = document.getElementById('btn-hold');
const btnConfirm = document.getElementById('btn-confirm');
const btnRelease = document.getElementById('btn-release');
const holdTimerEl = document.getElementById('hold-timer');
const timerValueEl = document.getElementById('timer-value');
const notificationEl = document.getElementById('notification');
const sseStatusEl = document.getElementById('sse-status');
const invAvailable = document.getElementById('inv-available');
const invHeld = document.getElementById('inv-held');
const invBooked = document.getElementById('inv-booked');
const invTotal = document.getElementById('inv-total');

// ─── API ────────────────────────────────────────────────────

async function fetchSeats() {
  const res = await fetch(`${API_BASE}/seats`);
  const data = await res.json();
  return data.seats;
}

async function requestHold(seatIds, sessionId) {
  const res = await fetch(`${API_BASE}/holds`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seatIds, sessionId })
  });
  const data = await res.json();
  if (!res.ok) {
    const error = new Error(data.error);
    error.status = res.status;
    error.data = data;
    throw error;
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
    const error = new Error(data.error);
    error.status = res.status;
    error.data = data;
    throw error;
  }
  return data;
}

async function releaseHold(holdId) {
  const res = await fetch(`${API_BASE}/holds/${holdId}`, {
    method: 'DELETE'
  });
  const data = await res.json();
  if (!res.ok) {
    const error = new Error(data.error);
    error.status = res.status;
    error.data = data;
    throw error;
  }
  return data;
}

// ─── Rendering ──────────────────────────────────────────────

function renderSeatMap() {
  seatMapEl.innerHTML = '';

  // Group seats by row
  const rows = new Map();
  for (const seat of state.seats.values()) {
    if (!rows.has(seat.rowLabel)) {
      rows.set(seat.rowLabel, []);
    }
    rows.get(seat.rowLabel).push(seat);
  }

  // Sort rows alphabetically, seats by number
  const sortedRowLabels = [...rows.keys()].sort();

  for (const rowLabel of sortedRowLabels) {
    const seats = rows.get(rowLabel).sort((a, b) => a.seatNumber - b.seatNumber);
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';

    const labelEl = document.createElement('div');
    labelEl.className = 'row-label';
    labelEl.textContent = rowLabel;
    rowEl.appendChild(labelEl);

    for (const seat of seats) {
      const seatEl = document.createElement('button');
      seatEl.dataset.seatId = seat.id;

      const effectiveStatus = getEffectiveStatus(seat);
      const isMine = seat.sessionId === state.sessionId;
      const isSelected = state.selectedSeatIds.has(seat.id);

      let cssClass = 'seat';
      if (isSelected) {
        cssClass += ' selected';
      } else if (effectiveStatus === 'held' && isMine) {
        cssClass += ' held-mine';
      } else {
        cssClass += ` ${effectiveStatus}`;
      }

      seatEl.className = cssClass;
      seatEl.textContent = seat.seatNumber;
      seatEl.title = `${rowLabel}${seat.seatNumber} — ${effectiveStatus}${isMine && effectiveStatus === 'held' ? ' (yours)' : ''}`;

      seatEl.addEventListener('click', () => handleSeatClick(seat));
      rowEl.appendChild(seatEl);
    }

    // Right label
    const labelElR = document.createElement('div');
    labelElR.className = 'row-label';
    labelElR.textContent = rowLabel;
    rowEl.appendChild(labelElR);

    seatMapEl.appendChild(rowEl);
  }

  updateInventory();
  updateActionButtons();
}

function getEffectiveStatus(seat) {
  if (seat.status === 'held' && seat.holdExpiresAt) {
    const expires = new Date(seat.holdExpiresAt);
    if (expires <= new Date()) {
      return 'available';
    }
  }
  return seat.status;
}

function updateInventory() {
  let available = 0, held = 0, booked = 0;
  for (const seat of state.seats.values()) {
    const eff = getEffectiveStatus(seat);
    if (eff === 'available') available++;
    else if (eff === 'held') held++;
    else if (eff === 'booked') booked++;
  }
  const total = state.seats.size;

  invAvailable.textContent = `Available: ${available}`;
  invHeld.textContent = `Held: ${held}`;
  invBooked.textContent = `Booked: ${booked}`;
  invTotal.textContent = `Total: ${total}`;
}

function updateActionButtons() {
  const hasSelection = state.selectedSeatIds.size > 0;
  const hasHold = state.currentHold !== null;

  btnHold.disabled = !hasSelection || hasHold;
  btnConfirm.disabled = !hasHold;
  btnRelease.disabled = !hasHold;

  if (hasHold) {
    selectionInfoEl.textContent = `Holding ${state.currentHold.seatIds.length} seat(s) — confirm or release`;
  } else if (hasSelection) {
    selectionInfoEl.textContent = `${state.selectedSeatIds.size} seat(s) selected`;
  } else {
    selectionInfoEl.textContent = 'Select seats to begin';
  }
}

function updateSingleSeat(seatData) {
  // Update the seat in state
  state.seats.set(seatData.id, seatData);

  // Update the DOM element directly
  const seatEl = seatMapEl.querySelector(`[data-seat-id="${seatData.id}"]`);
  if (seatEl) {
    const effectiveStatus = getEffectiveStatus(seatData);
    const isMine = seatData.sessionId === state.sessionId;
    const isSelected = state.selectedSeatIds.has(seatData.id);

    let cssClass = 'seat';
    if (isSelected) {
      cssClass += ' selected';
    } else if (effectiveStatus === 'held' && isMine) {
      cssClass += ' held-mine';
    } else {
      cssClass += ` ${effectiveStatus}`;
    }
    seatEl.className = cssClass;
    seatEl.title = `${seatData.rowLabel}${seatData.seatNumber} — ${effectiveStatus}${isMine && effectiveStatus === 'held' ? ' (yours)' : ''}`;
  }

  // If a seat we selected is no longer available, deselect it
  if (state.selectedSeatIds.has(seatData.id) && getEffectiveStatus(seatData) !== 'available') {
    state.selectedSeatIds.delete(seatData.id);
  }

  // If our hold's seats were released/booked by someone else, clear our hold state
  if (state.currentHold && state.currentHold.seatIds.includes(seatData.id)) {
    if (seatData.sessionId !== state.sessionId && seatData.status !== 'held') {
      // Our hold was expired/stolen
      clearHoldState();
      showNotification('Your hold has expired', 'error');
    }
    if (seatData.status === 'available' && seatData.sessionId === null) {
      // Hold was expired by server
      clearHoldState();
      showNotification('Your hold has expired', 'error');
    }
  }

  updateInventory();
  updateActionButtons();
}

// ─── Interaction ────────────────────────────────────────────

function handleSeatClick(seat) {
  const effectiveStatus = getEffectiveStatus(seat);

  // Can only select/deselect available seats, and only when no active hold
  if (state.currentHold) return;
  if (effectiveStatus !== 'available') return;

  if (state.selectedSeatIds.has(seat.id)) {
    state.selectedSeatIds.delete(seat.id);
  } else {
    state.selectedSeatIds.add(seat.id);
  }

  renderSeatMap();
}

async function handleHold() {
  if (state.selectedSeatIds.size === 0 || state.currentHold) return;

  const seatIds = [...state.selectedSeatIds];
  btnHold.disabled = true;
  btnHold.textContent = 'Placing hold...';

  try {
    const hold = await requestHold(seatIds, state.sessionId);
    state.currentHold = {
      holdId: hold.holdId,
      seatIds: hold.seatIds,
      expiresAt: new Date(hold.expiresAt)
    };
    state.selectedSeatIds.clear();

    // Refresh seats to show the hold
    await loadSeats();
    startTimer();
    showNotification(`Hold placed on ${hold.seatIds.length} seat(s)`, 'success');
  } catch (err) {
    if (err.status === 409 && err.data && err.data.conflictingSeatIds) {
      showNotification(`Seats already taken!`, 'error');
      highlightConflicts(err.data.conflictingSeatIds);
      for (const id of err.data.conflictingSeatIds) {
        state.selectedSeatIds.delete(id);
      }
      await loadSeats();
    } else {
      showNotification(err.message || 'Failed to place hold', 'error');
    }
  } finally {
    btnHold.textContent = 'Hold Selected Seats';
    updateActionButtons();
  }
}

async function handleConfirm() {
  if (!state.currentHold) return;

  btnConfirm.disabled = true;
  btnConfirm.textContent = 'Confirming...';

  try {
    await confirmHold(state.currentHold.holdId);
    clearHoldState();
    await loadSeats();
    showNotification('Booking confirmed! 🎉', 'success');
  } catch (err) {
    showNotification(err.message || 'Failed to confirm', 'error');
    if (err.status === 410) {
      clearHoldState();
      await loadSeats();
    }
  } finally {
    btnConfirm.textContent = 'Confirm Booking';
    updateActionButtons();
  }
}

async function handleRelease() {
  if (!state.currentHold) return;

  btnRelease.disabled = true;
  btnRelease.textContent = 'Releasing...';

  try {
    await releaseHold(state.currentHold.holdId);
    clearHoldState();
    await loadSeats();
    showNotification('Hold released', 'info');
  } catch (err) {
    showNotification(err.message || 'Failed to release', 'error');
  } finally {
    btnRelease.textContent = 'Release Hold';
    updateActionButtons();
  }
}

function clearHoldState() {
  state.currentHold = null;
  if (state.timerInterval) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }
  holdTimerEl.style.display = 'none';
}

function startTimer() {
  holdTimerEl.style.display = 'block';
  updateTimer();
  state.timerInterval = setInterval(() => {
    const remaining = updateTimer();
    if (remaining <= 0) {
      clearHoldState();
      showNotification('Hold expired', 'error');
      loadSeats();
    }
  }, 1000);
}

function updateTimer() {
  if (!state.currentHold) return 0;
  const remaining = Math.max(0, Math.ceil((state.currentHold.expiresAt - Date.now()) / 1000));
  timerValueEl.textContent = remaining;

  if (remaining <= 10) {
    timerValueEl.style.color = '#e74c3c';
  } else {
    timerValueEl.style.color = '';
  }

  return remaining;
}

function highlightConflicts(seatIds) {
  for (const id of seatIds) {
    const el = seatMapEl.querySelector(`[data-seat-id="${id}"]`);
    if (el) {
      el.classList.add('conflict');
      setTimeout(() => el.classList.remove('conflict'), 2000);
    }
  }
}

function showNotification(message, type = 'info') {
  notificationEl.textContent = message;
  notificationEl.className = `notification ${type}`;
  notificationEl.style.display = 'block';

  setTimeout(() => {
    notificationEl.style.display = 'none';
  }, 4000);
}

// ─── SSE ────────────────────────────────────────────────────

function connectSSE() {
  const evtSource = new EventSource(`${API_BASE}/stream`);

  evtSource.onopen = () => {
    sseStatusEl.textContent = 'SSE: connected';
    sseStatusEl.className = 'sse-status connected';
  };

  evtSource.addEventListener('seat-update', (event) => {
    try {
      const seats = JSON.parse(event.data);
      for (const seatData of seats) {
        updateSingleSeat(seatData);
      }
    } catch (e) {
      console.error('Error processing SSE event:', e);
    }
  });

  evtSource.onerror = () => {
    sseStatusEl.textContent = 'SSE: reconnecting...';
    sseStatusEl.className = 'sse-status disconnected';
  };

  return evtSource;
}

// ─── Load seats ─────────────────────────────────────────────

async function loadSeats() {
  try {
    const seats = await fetchSeats();
    state.seats.clear();
    for (const seat of seats) {
      state.seats.set(seat.id, seat);
    }
    renderSeatMap();
  } catch (err) {
    console.error('Failed to load seats:', err);
    showNotification('Failed to load seats', 'error');
  }
}

// ─── Init ───────────────────────────────────────────────────

btnHold.addEventListener('click', handleHold);
btnConfirm.addEventListener('click', handleConfirm);
btnRelease.addEventListener('click', handleRelease);

async function init() {
  await loadSeats();
  connectSSE();
}

init();
