// ---------- State ----------
let seats = [];                // array of seat objects from server
let selectedSeatIds = new Set(); // seats the user has clicked to select
let currentHold = null;        // { id, sessionId, seatIds, expiresAt }
let countdownTimer = null;
const sessionId = generateSessionId();

// ---------- API base ----------
const API_BASE = '/api';

// ---------- DOM refs ----------
const seatMapEl = document.getElementById('seat-map');
const btnHold = document.getElementById('btn-hold');
const btnConfirm = document.getElementById('btn-confirm');
const btnRelease = document.getElementById('btn-release');
const selectionInfo = document.getElementById('selection-info');
const holdInfo = document.getElementById('hold-info');
const holdSeatCount = document.getElementById('hold-seat-count');
const holdCountdown = document.getElementById('hold-countdown');
const errorMessage = document.getElementById('error-message');
const connectionStatus = document.getElementById('connection-status');
const countAvailable = document.getElementById('count-available');
const countHeld = document.getElementById('count-held');
const countBooked = document.getElementById('count-booked');
const countTotal = document.getElementById('count-total');

// ---------- Initialization ----------
async function init() {
  await loadSeats();
  renderSeatMap();
  updateInventory();
  connectSSE();
  bindButtons();
}

// ---------- Load seats from API ----------
async function loadSeats() {
  try {
    const res = await fetch(`${API_BASE}/seats`);
    const data = await res.json();
    seats = data.seats;
  } catch (err) {
    console.error('Failed to load seats:', err);
    showError('Failed to load seat map. Please refresh.');
  }
}

// ---------- Render seat map ----------
function renderSeatMap() {
  seatMapEl.innerHTML = '';

  // Group seats by row
  const rows = {};
  for (const seat of seats) {
    if (!rows[seat.row_label]) rows[seat.row_label] = [];
    rows[seat.row_label].push(seat);
  }

  // Sort rows alphabetically
  const sortedRowLabels = Object.keys(rows).sort();

  for (const rowLabel of sortedRowLabels) {
    const rowSeats = rows[rowLabel].sort((a, b) => a.seat_number - b.seat_number);
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';

    const labelEl = document.createElement('span');
    labelEl.className = 'row-label';
    labelEl.textContent = rowLabel;
    rowEl.appendChild(labelEl);

    for (const seat of rowSeats) {
      const seatEl = document.createElement('div');
      seatEl.className = `seat ${getSeatClass(seat)}`;
      seatEl.textContent = seat.seat_number;
      seatEl.dataset.seatId = seat.id;
      seatEl.addEventListener('click', () => handleSeatClick(seat));
      rowEl.appendChild(seatEl);
    }

    // Right label
    const labelElRight = document.createElement('span');
    labelElRight.className = 'row-label';
    labelElRight.textContent = rowLabel;
    rowEl.appendChild(labelElRight);

    seatMapEl.appendChild(rowEl);
  }
}

function getSeatClass(seat) {
  if (selectedSeatIds.has(seat.id)) return 'selected';
  if (seat.status === 'booked') return 'booked';
  if (seat.status === 'held') {
    // Check if it's our hold
    if (currentHold && currentHold.seatIds.includes(seat.id)) {
      return 'held-mine';
    }
    return 'held';
  }
  return 'available';
}

function updateSeatElement(seat) {
  const el = seatMapEl.querySelector(`[data-seat-id="${seat.id}"]`);
  if (el) {
    el.className = `seat ${getSeatClass(seat)}`;
  }
}

// ---------- Seat click handling ----------
function handleSeatClick(seat) {
  // Can only select/deselect when not holding
  if (currentHold) return;

  const effective = seat.status;
  if (effective !== 'available') return;

  if (selectedSeatIds.has(seat.id)) {
    selectedSeatIds.delete(seat.id);
  } else {
    selectedSeatIds.add(seat.id);
  }

  updateSeatElement(seat);
  updateActionPanel();
}

// ---------- Action panel ----------
function updateActionPanel() {
  hideError();

  if (currentHold) {
    selectionInfo.style.display = 'none';
    holdInfo.style.display = 'block';
    holdSeatCount.textContent = currentHold.seatIds.length;
    btnHold.style.display = 'none';
    btnHold.disabled = true;
    btnConfirm.style.display = 'inline-block';
    btnConfirm.disabled = false;
    btnRelease.style.display = 'inline-block';
    btnRelease.disabled = false;
    startCountdown();
  } else {
    holdInfo.style.display = 'none';
    selectionInfo.style.display = 'block';
    btnConfirm.style.display = 'none';
    btnRelease.style.display = 'none';
    btnHold.style.display = 'inline-block';
    btnHold.disabled = selectedSeatIds.size === 0;
    stopCountdown();

    if (selectedSeatIds.size > 0) {
      selectionInfo.textContent = `${selectedSeatIds.size} seat(s) selected`;
    } else {
      selectionInfo.textContent = 'Select seats to hold them';
    }
  }
}

// ---------- Countdown timer ----------
function startCountdown() {
  stopCountdown();
  updateCountdownDisplay();
  countdownTimer = setInterval(updateCountdownDisplay, 250);
}

function stopCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  holdCountdown.textContent = '--';
}

function updateCountdownDisplay() {
  if (!currentHold) {
    stopCountdown();
    return;
  }

  const now = Date.now();
  const expires = new Date(currentHold.expiresAt).getTime();
  const remaining = Math.max(0, expires - now);

  if (remaining <= 0) {
    holdCountdown.textContent = 'EXPIRED';
    // Clear hold state since it expired
    handleHoldExpired();
    return;
  }

  const seconds = Math.ceil(remaining / 1000);
  holdCountdown.textContent = `${seconds}s`;
}

function handleHoldExpired() {
  currentHold = null;
  selectedSeatIds.clear();
  stopCountdown();
  loadSeats().then(() => {
    renderSeatMap();
    updateInventory();
    updateActionPanel();
  });
  showError('Your hold has expired. The seats are available again.');
}

// ---------- Button bindings ----------
function bindButtons() {
  btnHold.addEventListener('click', handleHoldClick);
  btnConfirm.addEventListener('click', handleConfirmClick);
  btnRelease.addEventListener('click', handleReleaseClick);
}

async function handleHoldClick() {
  if (selectedSeatIds.size === 0) return;
  hideError();
  btnHold.disabled = true;

  try {
    const seatIds = [...selectedSeatIds];
    const res = await fetch(`${API_BASE}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId })
    });

    const data = await res.json();

    if (res.status === 201) {
      currentHold = {
        id: data.hold.id,
        sessionId: data.hold.sessionId,
        seatIds: data.hold.seatIds,
        expiresAt: data.hold.expiresAt,
        status: data.hold.status
      };
      selectedSeatIds.clear();

      // Update seat data from response
      for (const updatedSeat of data.seats) {
        const idx = seats.findIndex(s => s.id === updatedSeat.id);
        if (idx !== -1) seats[idx] = updatedSeat;
      }

      renderSeatMap();
      updateInventory();
      updateActionPanel();
    } else if (res.status === 409) {
      // Conflict - some seats not available
      const conflicting = data.conflicting || [];
      const conflictLabels = conflicting.map(c => `${c.row_label}${c.seat_number}`).join(', ');
      showError(`Cannot hold: seats ${conflictLabels} are already ${conflicting[0]?.status || 'unavailable'}.`);

      // Deselect conflicting seats
      for (const c of conflicting) {
        selectedSeatIds.delete(c.id);
      }

      // Refresh seats
      await loadSeats();
      renderSeatMap();
      updateInventory();
      updateActionPanel();
    } else {
      showError(data.error || 'Failed to hold seats.');
      btnHold.disabled = selectedSeatIds.size === 0;
    }
  } catch (err) {
    console.error('Hold error:', err);
    showError('Network error. Please try again.');
    btnHold.disabled = selectedSeatIds.size === 0;
  }
}

async function handleConfirmClick() {
  if (!currentHold) return;
  hideError();
  btnConfirm.disabled = true;
  btnRelease.disabled = true;

  try {
    const res = await fetch(`${API_BASE}/holds/${currentHold.id}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    const data = await res.json();

    if (res.ok) {
      // Booking confirmed!
      // Update seat data
      if (data.seats) {
        for (const updatedSeat of data.seats) {
          const idx = seats.findIndex(s => s.id === updatedSeat.id);
          if (idx !== -1) seats[idx] = updatedSeat;
        }
      }

      currentHold = null;
      selectedSeatIds.clear();
      renderSeatMap();
      updateInventory();
      updateActionPanel();

      showSuccess('Booking confirmed! 🎉');
    } else {
      showError(data.error || 'Failed to confirm booking.');
      if (res.status === 410 || res.status === 404) {
        // Hold expired or not found
        currentHold = null;
        selectedSeatIds.clear();
        await loadSeats();
        renderSeatMap();
        updateInventory();
        updateActionPanel();
      } else {
        btnConfirm.disabled = false;
        btnRelease.disabled = false;
      }
    }
  } catch (err) {
    console.error('Confirm error:', err);
    showError('Network error. Please try again.');
    btnConfirm.disabled = false;
    btnRelease.disabled = false;
  }
}

async function handleReleaseClick() {
  if (!currentHold) return;
  hideError();
  btnRelease.disabled = true;
  btnConfirm.disabled = true;

  try {
    const res = await fetch(`${API_BASE}/holds/${currentHold.id}`, {
      method: 'DELETE'
    });

    const data = await res.json();

    if (res.ok) {
      // Update seat data
      if (data.seats) {
        for (const updatedSeat of data.seats) {
          const idx = seats.findIndex(s => s.id === updatedSeat.id);
          if (idx !== -1) seats[idx] = updatedSeat;
        }
      }

      currentHold = null;
      selectedSeatIds.clear();
      renderSeatMap();
      updateInventory();
      updateActionPanel();
    } else {
      showError(data.error || 'Failed to release hold.');
      currentHold = null;
      selectedSeatIds.clear();
      await loadSeats();
      renderSeatMap();
      updateInventory();
      updateActionPanel();
    }
  } catch (err) {
    console.error('Release error:', err);
    showError('Network error. Please try again.');
    btnRelease.disabled = false;
    btnConfirm.disabled = false;
  }
}

// ---------- SSE ----------
function connectSSE() {
  const evtSource = new EventSource(`${API_BASE}/stream`);

  evtSource.onopen = () => {
    connectionStatus.textContent = 'Connected';
    connectionStatus.className = 'connected';
  };

  evtSource.onerror = () => {
    connectionStatus.textContent = 'Disconnected';
    connectionStatus.className = 'disconnected';
  };

  evtSource.addEventListener('seat-update', (event) => {
    try {
      const updatedSeat = JSON.parse(event.data);
      const idx = seats.findIndex(s => s.id === updatedSeat.id);
      if (idx !== -1) {
        seats[idx] = updatedSeat;
      } else {
        seats.push(updatedSeat);
      }

      // If this seat was in our selected set and is no longer available, deselect it
      if (selectedSeatIds.has(updatedSeat.id) && updatedSeat.status !== 'available') {
        selectedSeatIds.delete(updatedSeat.id);
      }

      // If our hold's seats got released by expiry (server-side), clear hold
      if (currentHold && currentHold.seatIds.includes(updatedSeat.id)) {
        if (updatedSeat.status === 'available' && updatedSeat.hold_id === null) {
          // Our hold expired server-side
          currentHold = null;
          selectedSeatIds.clear();
          stopCountdown();
          updateActionPanel();
          showError('Your hold has expired.');
        }
      }

      updateSeatElement(updatedSeat);
      updateInventory();
      updateActionPanel();
    } catch (e) {
      console.error('SSE parse error:', e);
    }
  });
}

// ---------- Inventory ----------
function updateInventory() {
  let available = 0, held = 0, booked = 0;
  for (const seat of seats) {
    switch (seat.status) {
      case 'available': available++; break;
      case 'held': held++; break;
      case 'booked': booked++; break;
    }
  }
  countAvailable.textContent = available;
  countHeld.textContent = held;
  countBooked.textContent = booked;
  countTotal.textContent = seats.length;
}

// ---------- UI Helpers ----------
function showError(msg) {
  errorMessage.textContent = msg;
  errorMessage.style.display = 'block';
  errorMessage.style.background = '#e74c3c33';
  errorMessage.style.borderColor = '#e74c3c';
  errorMessage.style.color = '#e74c3c';
}

function showSuccess(msg) {
  errorMessage.textContent = msg;
  errorMessage.style.display = 'block';
  errorMessage.style.background = '#2ecc7133';
  errorMessage.style.borderColor = '#2ecc71';
  errorMessage.style.color = '#2ecc71';
  setTimeout(() => {
    if (errorMessage.textContent === msg) {
      errorMessage.style.display = 'none';
    }
  }, 5000);
}

function hideError() {
  errorMessage.style.display = 'none';
}

function generateSessionId() {
  // Generate a random session id
  return 'session-' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// ---------- Start ----------
init();
