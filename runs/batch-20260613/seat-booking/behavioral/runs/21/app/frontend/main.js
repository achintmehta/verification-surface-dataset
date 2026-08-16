const API_BASE = window.location.origin + '/api';

// Generate a unique session ID for this browser tab
const SESSION_ID = crypto.randomUUID ? crypto.randomUUID() : 'session-' + Math.random().toString(36).slice(2);

let seats = [];
let selectedSeatIds = new Set();
let currentHold = null; // { holdId, expiresAt, seatIds }
let countdownInterval = null;

// ─── DOM Elements ────────────────────────────────────────────
const seatMapEl = document.getElementById('seat-map');
const holdBtn = document.getElementById('hold-btn');
const confirmBtn = document.getElementById('confirm-btn');
const releaseBtn = document.getElementById('release-btn');
const holdInfoEl = document.getElementById('hold-info');
const holdTimerEl = document.getElementById('hold-timer');
const selectionInfoEl = document.getElementById('selection-info');
const inventoryInfoEl = document.getElementById('inventory-info');
const connectionStatusEl = document.getElementById('connection-status');
const errorMessageEl = document.getElementById('error-message');

// ─── Initialize ──────────────────────────────────────────────
async function init() {
  await loadSeats();
  renderSeatMap();
  connectSSE();
  setupEventListeners();
}

// ─── API Calls ───────────────────────────────────────────────
async function loadSeats() {
  try {
    const res = await fetch(`${API_BASE}/seats`);
    const data = await res.json();
    seats = data.seats;
    updateInventory();
  } catch (err) {
    showError('Failed to load seats: ' + err.message);
  }
}

async function requestHold(seatIds) {
  try {
    const res = await fetch(`${API_BASE}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds: Array.from(seatIds), sessionId: SESSION_ID }),
    });

    const data = await res.json();

    if (!res.ok) {
      if (res.status === 409) {
        showError(`Seats already taken: ${data.conflictingSeats?.map(s => `${s.row_label}${s.seat_number}`).join(', ')}`);
        await loadSeats();
        renderSeatMap();
        return null;
      }
      showError(data.error || 'Failed to hold seats');
      return null;
    }

    hideError();
    return data;
  } catch (err) {
    showError('Failed to hold seats: ' + err.message);
    return null;
  }
}

async function confirmHold(holdId) {
  try {
    const res = await fetch(`${API_BASE}/holds/${holdId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    const data = await res.json();

    if (!res.ok) {
      showError(data.error || 'Failed to confirm booking');
      currentHold = null;
      clearCountdown();
      holdInfoEl.style.display = 'none';
      await loadSeats();
      renderSeatMap();
      return false;
    }

    hideError();
    return true;
  } catch (err) {
    showError('Failed to confirm: ' + err.message);
    return false;
  }
}

async function releaseHold(holdId) {
  try {
    const res = await fetch(`${API_BASE}/holds/${holdId}`, {
      method: 'DELETE',
    });

    if (!res.ok) {
      const data = await res.json();
      showError(data.error || 'Failed to release hold');
    }
    hideError();
  } catch (err) {
    showError('Failed to release: ' + err.message);
  }
}

// ─── Rendering ───────────────────────────────────────────────
function renderSeatMap() {
  seatMapEl.innerHTML = '';

  // Add stage
  const stageEl = document.createElement('div');
  stageEl.className = 'stage';
  stageEl.textContent = '━━━ STAGE ━━━';
  seatMapEl.appendChild(stageEl);

  // Add legend
  const legendEl = document.createElement('div');
  legendEl.className = 'legend';
  legendEl.innerHTML = `
    <div class="legend-item"><div class="legend-swatch available"></div>Available</div>
    <div class="legend-item"><div class="legend-swatch held"></div>Held</div>
    <div class="legend-item"><div class="legend-swatch booked"></div>Booked</div>
    <div class="legend-item"><div class="legend-swatch mine"></div>Your booking</div>
  `;
  seatMapEl.appendChild(legendEl);

  // Group seats by row
  const rowMap = new Map();
  for (const seat of seats) {
    if (!rowMap.has(seat.row_label)) {
      rowMap.set(seat.row_label, []);
    }
    rowMap.get(seat.row_label).push(seat);
  }

  for (const [rowLabel, rowSeats] of rowMap) {
    rowSeats.sort((a, b) => a.seat_number - b.seat_number);

    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';

    const labelEl = document.createElement('div');
    labelEl.className = 'row-label';
    labelEl.textContent = rowLabel;
    rowEl.appendChild(labelEl);

    for (const seat of rowSeats) {
      const seatEl = document.createElement('div');
      seatEl.className = `seat ${seat.status}`;
      seatEl.dataset.seatId = seat.id;
      seatEl.textContent = seat.seat_number;

      // Mark our own seats
      if (seat.session_id === SESSION_ID) {
        seatEl.classList.add('mine');
      }

      if (selectedSeatIds.has(seat.id)) {
        seatEl.classList.add('selected');
      }

      seatEl.addEventListener('click', () => onSeatClick(seat));
      rowEl.appendChild(seatEl);
    }

    seatMapEl.appendChild(rowEl);
  }

  updateInventory();
}

function updateSeatInMap(updatedSeat) {
  const idx = seats.findIndex(s => s.id === updatedSeat.id);
  if (idx !== -1) {
    seats[idx] = { ...seats[idx], ...updatedSeat };
  }

  // Update the DOM element directly for performance
  const seatEl = seatMapEl.querySelector(`[data-seat-id="${updatedSeat.id}"]`);
  if (seatEl) {
    seatEl.className = `seat ${updatedSeat.status}`;
    if (updatedSeat.session_id === SESSION_ID) {
      seatEl.classList.add('mine');
    }
    if (selectedSeatIds.has(updatedSeat.id)) {
      seatEl.classList.add('selected');
    }
  }

  updateInventory();
}

function updateInventory() {
  const available = seats.filter(s => s.status === 'available').length;
  const held = seats.filter(s => s.status === 'held').length;
  const booked = seats.filter(s => s.status === 'booked').length;
  inventoryInfoEl.textContent = `Available: ${available} | Held: ${held} | Booked: ${booked} | Total: ${seats.length}`;
}

// ─── Event Handlers ──────────────────────────────────────────
function onSeatClick(seat) {
  if (currentHold) return; // Can't select while holding

  if (seat.status !== 'available') return;

  if (selectedSeatIds.has(seat.id)) {
    selectedSeatIds.delete(seat.id);
  } else {
    selectedSeatIds.add(seat.id);
  }

  renderSeatMap();
  updateSelectionInfo();
}

function updateSelectionInfo() {
  if (selectedSeatIds.size === 0) {
    selectionInfoEl.textContent = 'Select seats to hold them';
    holdBtn.disabled = true;
  } else {
    selectionInfoEl.textContent = `${selectedSeatIds.size} seat(s) selected`;
    holdBtn.disabled = false;
  }
}

function setupEventListeners() {
  holdBtn.addEventListener('click', async () => {
    if (selectedSeatIds.size === 0) return;

    holdBtn.disabled = true;
    const result = await requestHold(selectedSeatIds);

    if (result) {
      currentHold = {
        holdId: result.holdId,
        expiresAt: new Date(result.expiresAt),
        seatIds: result.seats.map(s => s.id),
      };
      selectedSeatIds.clear();
      holdBtn.style.display = 'none';
      holdInfoEl.style.display = 'flex';
      startCountdown();
      await loadSeats();
      renderSeatMap();
    } else {
      holdBtn.disabled = false;
    }
  });

  confirmBtn.addEventListener('click', async () => {
    if (!currentHold) return;

    confirmBtn.disabled = true;
    const success = await confirmHold(currentHold.holdId);

    if (success) {
      currentHold = null;
      clearCountdown();
      holdInfoEl.style.display = 'none';
      holdBtn.style.display = '';
      holdBtn.disabled = true;
      selectionInfoEl.textContent = '✅ Booking confirmed!';
      await loadSeats();
      renderSeatMap();
    }
    confirmBtn.disabled = false;
  });

  releaseBtn.addEventListener('click', async () => {
    if (!currentHold) return;

    releaseBtn.disabled = true;
    await releaseHold(currentHold.holdId);
    currentHold = null;
    clearCountdown();
    holdInfoEl.style.display = 'none';
    holdBtn.style.display = '';
    holdBtn.disabled = true;
    selectionInfoEl.textContent = 'Select seats to hold them';
    await loadSeats();
    renderSeatMap();
    releaseBtn.disabled = false;
  });
}

// ─── Countdown Timer ─────────────────────────────────────────
function startCountdown() {
  clearCountdown();
  updateCountdownDisplay();
  countdownInterval = setInterval(() => {
    updateCountdownDisplay();
  }, 250);
}

function updateCountdownDisplay() {
  if (!currentHold) {
    clearCountdown();
    return;
  }

  const remaining = Math.max(0, currentHold.expiresAt.getTime() - Date.now());
  const seconds = Math.ceil(remaining / 1000);

  if (remaining <= 0) {
    holdTimerEl.textContent = 'Hold expired!';
    holdTimerEl.style.color = '#ff5252';
    clearCountdown();
    // Auto-clear hold state
    currentHold = null;
    setTimeout(async () => {
      holdInfoEl.style.display = 'none';
      holdBtn.style.display = '';
      holdBtn.disabled = true;
      selectionInfoEl.textContent = 'Hold expired. Select seats again.';
      await loadSeats();
      renderSeatMap();
    }, 1500);
    return;
  }

  holdTimerEl.textContent = `⏱ ${seconds}s remaining`;
  holdTimerEl.style.color = seconds <= 5 ? '#ff5252' : '#ff9800';
}

function clearCountdown() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
}

// ─── SSE Connection ──────────────────────────────────────────
function connectSSE() {
  const eventSource = new EventSource(`${API_BASE}/stream`);

  eventSource.onopen = () => {
    connectionStatusEl.textContent = '● Connected';
    connectionStatusEl.className = 'connected';
  };

  eventSource.onerror = () => {
    connectionStatusEl.textContent = '● Disconnected';
    connectionStatusEl.className = 'disconnected';
  };

  eventSource.addEventListener('seat-update', (event) => {
    const seatData = JSON.parse(event.data);
    updateSeatInMap(seatData);

    // If our current hold's seats were released by the server (expired)
    if (currentHold && seatData.status === 'available' && currentHold.seatIds.includes(seatData.id)) {
      // Check if all our held seats are released
      const allReleased = currentHold.seatIds.every(id => {
        const s = seats.find(seat => seat.id === id);
        return s && s.status === 'available';
      });
      if (allReleased) {
        currentHold = null;
        clearCountdown();
        holdInfoEl.style.display = 'none';
        holdBtn.style.display = '';
        holdBtn.disabled = true;
        selectionInfoEl.textContent = 'Hold expired. Select seats again.';
      }
    }
  });
}

// ─── Error Display ───────────────────────────────────────────
function showError(message) {
  errorMessageEl.textContent = message;
  errorMessageEl.style.display = 'block';
  setTimeout(() => {
    hideError();
  }, 5000);
}

function hideError() {
  errorMessageEl.style.display = 'none';
}

// ─── Start ───────────────────────────────────────────────────
init();
