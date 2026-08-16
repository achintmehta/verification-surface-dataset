// Generate or retrieve session ID
function getSessionId() {
  let id = sessionStorage.getItem('seatBookingSessionId');
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : 
      'sess-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    sessionStorage.setItem('seatBookingSessionId', id);
  }
  return id;
}

const SESSION_ID = getSessionId();
const API_BASE = '/api';

// State
let seats = new Map(); // seatId -> seat object
let selectedSeatIds = new Set();
let currentHold = null; // { holdId, expiresAt, seatIds }
let countdownInterval = null;

// DOM Elements
const seatMapEl = document.getElementById('seat-map');
const selectedCountEl = document.getElementById('selected-count');
const btnHold = document.getElementById('btn-hold');
const btnConfirm = document.getElementById('btn-confirm');
const btnRelease = document.getElementById('btn-release');
const holdInfoEl = document.getElementById('hold-info');
const holdCountdownEl = document.getElementById('hold-countdown');
const bookingSuccessEl = document.getElementById('booking-success');
const errorMessageEl = document.getElementById('error-message');
const sessionIdDisplay = document.getElementById('session-id-display');
const connectionStatus = document.getElementById('connection-status');
const invAvailable = document.getElementById('inv-available');
const invHeld = document.getElementById('inv-held');
const invBooked = document.getElementById('inv-booked');
const invTotal = document.getElementById('inv-total');

// Display session ID
sessionIdDisplay.textContent = SESSION_ID.slice(0, 8) + '…';

// ─── API Functions ───────────────────────────────────────────

async function fetchSeats() {
  const res = await fetch(`${API_BASE}/seats`);
  const data = await res.json();
  return data.seats;
}

async function createHold(seatIds) {
  const res = await fetch(`${API_BASE}/holds`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seatIds, sessionId: SESSION_ID }),
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error || 'Hold request failed');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function confirmHold(holdId) {
  const res = await fetch(`${API_BASE}/holds/${holdId}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error || 'Confirm failed');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function releaseHold(holdId) {
  const res = await fetch(`${API_BASE}/holds/${holdId}`, {
    method: 'DELETE',
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error || 'Release failed');
    err.status = res.status;
    throw err;
  }
  return data;
}

// ─── Rendering ───────────────────────────────────────────────

function getSeatClass(seat) {
  if (seat.status === 'booked') {
    return seat.bookedBy === SESSION_ID || seat.sessionId === SESSION_ID ? 'booked-mine' : 'booked';
  }
  if (seat.status === 'held') {
    if (seat.sessionId === SESSION_ID) return 'held-mine';
    return 'held';
  }
  if (selectedSeatIds.has(seat.id)) {
    return 'selected';
  }
  return 'available';
}

function renderSeatMap() {
  // Group seats by row
  const rows = new Map();
  for (const seat of seats.values()) {
    if (!rows.has(seat.rowLabel)) {
      rows.set(seat.rowLabel, []);
    }
    rows.get(seat.rowLabel).push(seat);
  }

  // Sort rows alphabetically
  const sortedRowLabels = [...rows.keys()].sort();

  seatMapEl.innerHTML = '';

  for (const rowLabel of sortedRowLabels) {
    const rowSeats = rows.get(rowLabel).sort((a, b) => a.seatNumber - b.seatNumber);
    const rowDiv = document.createElement('div');
    rowDiv.className = 'seat-row';

    const label = document.createElement('span');
    label.className = 'row-label';
    label.textContent = rowLabel;
    rowDiv.appendChild(label);

    for (const seat of rowSeats) {
      const seatEl = document.createElement('div');
      seatEl.className = `seat ${getSeatClass(seat)}`;
      seatEl.dataset.seatId = seat.id;
      seatEl.textContent = seat.seatNumber;
      seatEl.title = `${seat.rowLabel}${seat.seatNumber} — ${seat.status}`;
      seatEl.addEventListener('click', () => handleSeatClick(seat));
      rowDiv.appendChild(seatEl);
    }

    seatMapEl.appendChild(rowDiv);
  }

  updateInventory();
}

function updateInventory() {
  let available = 0, held = 0, booked = 0;
  for (const seat of seats.values()) {
    if (seat.status === 'available') available++;
    else if (seat.status === 'held') held++;
    else if (seat.status === 'booked') booked++;
  }
  invAvailable.textContent = available;
  invHeld.textContent = held;
  invBooked.textContent = booked;
  invTotal.textContent = seats.size;
}

function updateSelectedCount() {
  selectedCountEl.textContent = selectedSeatIds.size;
  btnHold.disabled = selectedSeatIds.size === 0 || currentHold !== null;
}

function showError(msg) {
  errorMessageEl.textContent = msg;
  errorMessageEl.classList.remove('hidden');
  setTimeout(() => {
    errorMessageEl.classList.add('hidden');
  }, 5000);
}

function clearError() {
  errorMessageEl.classList.add('hidden');
}

// ─── Event Handlers ──────────────────────────────────────────

function handleSeatClick(seat) {
  // Can't click if we have an active hold or if seat is not available
  if (currentHold) return;
  if (bookingSuccessEl && !bookingSuccessEl.classList.contains('hidden')) return;

  if (seat.status !== 'available') return;

  if (selectedSeatIds.has(seat.id)) {
    selectedSeatIds.delete(seat.id);
  } else {
    selectedSeatIds.add(seat.id);
  }

  renderSeatMap();
  updateSelectedCount();
}

async function handleHold() {
  if (selectedSeatIds.size === 0) return;
  clearError();

  const seatIds = [...selectedSeatIds];
  btnHold.disabled = true;

  try {
    const result = await createHold(seatIds);
    currentHold = {
      holdId: result.holdId,
      expiresAt: new Date(result.expiresAt),
      seatIds: result.seatIds,
    };
    selectedSeatIds.clear();

    // Update local seat states
    for (const seatId of result.seatIds) {
      const seat = seats.get(seatId);
      if (seat) {
        seat.status = 'held';
        seat.holdId = result.holdId;
        seat.sessionId = SESSION_ID;
        seat.holdExpiresAt = result.expiresAt;
      }
    }

    showHoldUI();
    renderSeatMap();
    updateSelectedCount();
  } catch (err) {
    if (err.status === 409 && err.data && err.data.conflicting) {
      const conflictLabels = err.data.conflicting
        .map(c => `${c.rowLabel}${c.seatNumber}`)
        .join(', ');
      showError(`Seats unavailable: ${conflictLabels}. Please choose different seats.`);

      // Remove conflicting seats from selection
      if (err.data.conflicting) {
        for (const c of err.data.conflicting) {
          selectedSeatIds.delete(c.seatId);
        }
      }

      // Refresh seat map
      await loadSeats();
    } else {
      showError(err.message);
    }
    btnHold.disabled = selectedSeatIds.size === 0;
  }
}

async function handleConfirm() {
  if (!currentHold) return;
  clearError();
  btnConfirm.disabled = true;

  try {
    const result = await confirmHold(currentHold.holdId);

    // Update local seat states
    for (const seatId of result.seatIds) {
      const seat = seats.get(seatId);
      if (seat) {
        seat.status = 'booked';
        seat.bookedBy = SESSION_ID;
        seat.holdId = null;
        seat.holdExpiresAt = null;
      }
    }

    hideHoldUI();
    bookingSuccessEl.classList.remove('hidden');
    currentHold = null;
    renderSeatMap();

    // Hide success message after a bit and allow new selections
    setTimeout(() => {
      bookingSuccessEl.classList.add('hidden');
      updateSelectedCount();
    }, 3000);
  } catch (err) {
    showError(`Confirm failed: ${err.message}`);
    btnConfirm.disabled = false;
    // If hold expired, reset UI
    if (err.status === 410) {
      hideHoldUI();
      currentHold = null;
      await loadSeats();
      updateSelectedCount();
    }
  }
}

async function handleRelease() {
  if (!currentHold) return;
  clearError();

  try {
    await releaseHold(currentHold.holdId);

    // Update local seat states
    for (const seatId of currentHold.seatIds) {
      const seat = seats.get(seatId);
      if (seat) {
        seat.status = 'available';
        seat.holdId = null;
        seat.sessionId = null;
        seat.holdExpiresAt = null;
      }
    }

    hideHoldUI();
    currentHold = null;
    renderSeatMap();
    updateSelectedCount();
  } catch (err) {
    showError(`Release failed: ${err.message}`);
    // If it's already released/expired, reset UI
    hideHoldUI();
    currentHold = null;
    await loadSeats();
    updateSelectedCount();
  }
}

// ─── Hold Timer UI ───────────────────────────────────────────

function showHoldUI() {
  holdInfoEl.classList.remove('hidden');
  btnHold.classList.add('hidden');
  btnConfirm.disabled = false;
  startCountdown();
}

function hideHoldUI() {
  holdInfoEl.classList.add('hidden');
  btnHold.classList.remove('hidden');
  stopCountdown();
}

function startCountdown() {
  stopCountdown();
  updateCountdown();
  countdownInterval = setInterval(updateCountdown, 500);
}

function stopCountdown() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
}

function updateCountdown() {
  if (!currentHold) {
    stopCountdown();
    return;
  }

  const remaining = Math.max(0, Math.floor((currentHold.expiresAt.getTime() - Date.now()) / 1000));
  holdCountdownEl.textContent = remaining;

  if (remaining <= 0) {
    // Hold expired on client side
    stopCountdown();
    hideHoldUI();

    // Update local states
    for (const seatId of currentHold.seatIds) {
      const seat = seats.get(seatId);
      if (seat && seat.status === 'held' && seat.sessionId === SESSION_ID) {
        seat.status = 'available';
        seat.holdId = null;
        seat.sessionId = null;
        seat.holdExpiresAt = null;
      }
    }

    currentHold = null;
    showError('Your hold has expired. Please select seats again.');
    renderSeatMap();
    updateSelectedCount();
  }
}

// ─── SSE ─────────────────────────────────────────────────────

function connectSSE() {
  const evtSource = new EventSource(`${API_BASE}/stream`);

  evtSource.onopen = () => {
    connectionStatus.className = 'status-dot connected';
    connectionStatus.title = 'SSE connected';
  };

  evtSource.onerror = () => {
    connectionStatus.className = 'status-dot disconnected';
    connectionStatus.title = 'SSE disconnected';
  };

  evtSource.addEventListener('seat-update', (event) => {
    try {
      const data = JSON.parse(event.data);
      const seat = seats.get(data.seatId);
      if (seat) {
        seat.status = data.status;
        seat.holdId = data.holdId || null;
        seat.sessionId = data.sessionId || null;
        seat.holdExpiresAt = data.holdExpiresAt || null;
        seat.bookedBy = data.bookedBy || seat.bookedBy;

        // If this seat was in our selection and is no longer available, remove it
        if (data.status !== 'available' && selectedSeatIds.has(data.seatId)) {
          // Only remove if it's not our own hold
          if (data.sessionId !== SESSION_ID) {
            selectedSeatIds.delete(data.seatId);
          }
        }

        // If our hold's seats got released (e.g., by expiry), update UI
        if (currentHold && currentHold.seatIds.includes(data.seatId)) {
          if (data.status === 'available' && data.sessionId !== SESSION_ID) {
            // Our hold on this seat was released (expired server-side)
            // Check if all hold seats are now released
            const allReleased = currentHold.seatIds.every(sid => {
              const s = seats.get(sid);
              return s && s.status === 'available';
            });
            if (allReleased) {
              hideHoldUI();
              currentHold = null;
              showError('Your hold has expired. Please select seats again.');
            }
          }
        }

        renderSeatMap();
        updateSelectedCount();
      }
    } catch (e) {
      console.error('SSE parse error:', e);
    }
  });

  return evtSource;
}

// ─── Initialize ──────────────────────────────────────────────

async function loadSeats() {
  try {
    const seatList = await fetchSeats();
    seats.clear();
    for (const seat of seatList) {
      seats.set(seat.id, seat);
    }
    renderSeatMap();
    updateSelectedCount();
  } catch (err) {
    showError('Failed to load seats: ' + err.message);
  }
}

async function init() {
  // Load initial seat data
  await loadSeats();

  // Connect SSE
  connectSSE();

  // Wire up buttons
  btnHold.addEventListener('click', handleHold);
  btnConfirm.addEventListener('click', handleConfirm);
  btnRelease.addEventListener('click', handleRelease);
}

init();
