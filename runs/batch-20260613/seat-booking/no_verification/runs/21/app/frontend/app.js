// ─── Session ID ──────────────────────────────────────────────────
const SESSION_KEY = 'seat-booking-session-id';
function getSessionId() {
  let sid = localStorage.getItem(SESSION_KEY);
  if (!sid) {
    sid = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem(SESSION_KEY, sid);
  }
  return sid;
}
const sessionId = getSessionId();

// ─── State ───────────────────────────────────────────────────────
let seats = [];           // all seats from server
let selectedSeatIds = new Set();
let currentHold = null;   // { id, sessionId, seatIds, expiresAt, status }
let countdownTimer = null;

// ─── API ─────────────────────────────────────────────────────────
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
    body: JSON.stringify({ seatIds, sessionId })
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error || 'Failed to hold seats');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data.hold;
}

async function confirmHold(holdId) {
  const res = await fetch(`${API_BASE}/holds/${holdId}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error || 'Failed to confirm');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data.booking;
}

async function releaseHold(holdId) {
  const res = await fetch(`${API_BASE}/holds/${holdId}`, {
    method: 'DELETE'
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error || 'Failed to release');
    err.status = res.status;
    throw err;
  }
  return data;
}

// ─── Rendering ───────────────────────────────────────────────────
const seatMapEl = document.getElementById('seat-map');
const selectedCountEl = document.getElementById('selected-count');
const btnHold = document.getElementById('btn-hold');
const btnConfirm = document.getElementById('btn-confirm');
const btnRelease = document.getElementById('btn-release');
const holdInfoEl = document.getElementById('hold-info');
const holdIdDisplay = document.getElementById('hold-id-display');
const holdSeatsDisplay = document.getElementById('hold-seats-display');
const holdCountdown = document.getElementById('hold-countdown');
const statusMsgEl = document.getElementById('status-msg');
const invAvailable = document.getElementById('inv-available');
const invHeld = document.getElementById('inv-held');
const invBooked = document.getElementById('inv-booked');
const invTotal = document.getElementById('inv-total');
const sseStatus = document.getElementById('sse-status');
const sseLabel = document.getElementById('sse-label');

function seatClass(seat) {
  if (seat.status === 'booked') return 'seat booked';
  if (seat.status === 'held') {
    if (seat.session_id === sessionId) return 'seat held-mine';
    return 'seat held';
  }
  if (selectedSeatIds.has(seat.id)) return 'seat selected';
  return 'seat available';
}

function renderSeatMap() {
  // Group by rows
  const rowMap = new Map();
  for (const seat of seats) {
    if (!rowMap.has(seat.row_label)) rowMap.set(seat.row_label, []);
    rowMap.get(seat.row_label).push(seat);
  }

  seatMapEl.innerHTML = '';
  for (const [rowLabel, rowSeats] of rowMap) {
    rowSeats.sort((a, b) => a.seat_number - b.seat_number);
    const rowDiv = document.createElement('div');
    rowDiv.className = 'seat-row';

    const label = document.createElement('span');
    label.className = 'row-label';
    label.textContent = rowLabel;
    rowDiv.appendChild(label);

    for (const seat of rowSeats) {
      const seatEl = document.createElement('div');
      seatEl.className = seatClass(seat);
      seatEl.textContent = seat.seat_number;
      seatEl.dataset.seatId = seat.id;
      seatEl.addEventListener('click', () => onSeatClick(seat));
      rowDiv.appendChild(seatEl);
    }

    seatMapEl.appendChild(rowDiv);
  }

  updateInventory();
  updateButtons();
}

function updateInventory() {
  let available = 0, held = 0, booked = 0;
  for (const s of seats) {
    if (s.status === 'available') available++;
    else if (s.status === 'held') held++;
    else if (s.status === 'booked') booked++;
  }
  invAvailable.textContent = available;
  invHeld.textContent = held;
  invBooked.textContent = booked;
  invTotal.textContent = available + held + booked;
}

function updateButtons() {
  btnHold.disabled = selectedSeatIds.size === 0 || currentHold !== null;
  btnConfirm.disabled = !currentHold || currentHold.status !== 'active';
  btnRelease.disabled = !currentHold || currentHold.status !== 'active';

  if (selectedSeatIds.size === 0) {
    selectedCountEl.textContent = 'No seats selected';
  } else {
    selectedCountEl.textContent = `${selectedSeatIds.size} seat(s) selected`;
  }
}

function showHoldInfo() {
  if (!currentHold) {
    holdInfoEl.style.display = 'none';
    stopCountdown();
    return;
  }
  holdInfoEl.style.display = 'block';
  holdIdDisplay.textContent = currentHold.id;

  // Show seat labels
  const seatLabels = currentHold.seatIds.map(id => {
    const seat = seats.find(s => s.id === id);
    return seat ? `${seat.row_label}${seat.seat_number}` : id;
  });
  holdSeatsDisplay.textContent = seatLabels.join(', ');

  startCountdown();
}

function startCountdown() {
  stopCountdown();
  if (!currentHold) return;

  const tick = () => {
    if (!currentHold) { stopCountdown(); return; }
    const remaining = Math.max(0, new Date(currentHold.expiresAt).getTime() - Date.now());
    const seconds = Math.ceil(remaining / 1000);
    holdCountdown.textContent = `${seconds}s`;
    if (remaining <= 0) {
      showStatus('Hold expired — seats released', 'error');
      currentHold = null;
      selectedSeatIds.clear();
      showHoldInfo();
      refreshSeats();
    }
  };
  tick();
  countdownTimer = setInterval(tick, 500);
}

function stopCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

function showStatus(msg, type = 'info') {
  statusMsgEl.textContent = msg;
  statusMsgEl.className = `status-msg ${type}`;
  if (type === 'success' || type === 'info') {
    setTimeout(() => {
      if (statusMsgEl.textContent === msg) {
        statusMsgEl.textContent = '';
        statusMsgEl.className = 'status-msg';
      }
    }, 5000);
  }
}

// ─── Interactions ────────────────────────────────────────────────
function onSeatClick(seat) {
  // Can't select if we already have a hold
  if (currentHold) return;
  // Can only select available seats
  if (seat.status !== 'available') return;

  if (selectedSeatIds.has(seat.id)) {
    selectedSeatIds.delete(seat.id);
  } else {
    selectedSeatIds.add(seat.id);
  }
  renderSeatMap();
}

btnHold.addEventListener('click', async () => {
  if (selectedSeatIds.size === 0) return;
  btnHold.disabled = true;

  try {
    const seatIds = Array.from(selectedSeatIds);
    const hold = await requestHold(seatIds);
    currentHold = {
      id: hold.id,
      sessionId: hold.sessionId,
      seatIds: hold.seatIds,
      expiresAt: hold.expiresAt,
      status: 'active'
    };
    showStatus(`Hold created for ${seatIds.length} seat(s)`, 'success');
    selectedSeatIds.clear();
    await refreshSeats();
    showHoldInfo();
  } catch (err) {
    if (err.status === 409) {
      const conflicting = err.data?.conflicting || [];
      const labels = conflicting.map(c => `${c.row_label}${c.seat_number}`);
      showStatus(`Seats already taken: ${labels.join(', ')}`, 'error');
      selectedSeatIds.clear();
      await refreshSeats();
    } else {
      showStatus(err.message, 'error');
    }
  }
  updateButtons();
});

btnConfirm.addEventListener('click', async () => {
  if (!currentHold) return;
  btnConfirm.disabled = true;

  try {
    const booking = await confirmHold(currentHold.id);
    showStatus(`Booking confirmed! Seats are yours.`, 'success');
    currentHold = null;
    stopCountdown();
    holdInfoEl.style.display = 'none';
    await refreshSeats();
  } catch (err) {
    showStatus(err.message, 'error');
    currentHold = null;
    stopCountdown();
    holdInfoEl.style.display = 'none';
    await refreshSeats();
  }
  updateButtons();
});

btnRelease.addEventListener('click', async () => {
  if (!currentHold) return;
  btnRelease.disabled = true;

  try {
    await releaseHold(currentHold.id);
    showStatus('Hold released', 'info');
    currentHold = null;
    stopCountdown();
    holdInfoEl.style.display = 'none';
    await refreshSeats();
  } catch (err) {
    showStatus(err.message, 'error');
  }
  updateButtons();
});

// ─── Data Refresh ────────────────────────────────────────────────
async function refreshSeats() {
  try {
    seats = await fetchSeats();
    renderSeatMap();
  } catch (err) {
    console.error('Failed to refresh seats:', err);
  }
}

// ─── SSE ─────────────────────────────────────────────────────────
function connectSSE() {
  const evtSource = new EventSource(`${API_BASE}/stream`);

  evtSource.onopen = () => {
    sseStatus.className = 'sse-indicator connected';
    sseLabel.textContent = 'Connected';
  };

  evtSource.addEventListener('seat-update', (e) => {
    try {
      const updatedSeat = JSON.parse(e.data);
      // Update local seat state
      const idx = seats.findIndex(s => s.id === updatedSeat.id);
      if (idx !== -1) {
        seats[idx] = { ...seats[idx], ...updatedSeat };
      }

      // If a seat we had selected is no longer available, deselect it
      if (updatedSeat.status !== 'available' && selectedSeatIds.has(updatedSeat.id)) {
        selectedSeatIds.delete(updatedSeat.id);
      }

      // If our hold's seats got released by expiry (from server), clear hold
      if (currentHold && currentHold.seatIds.includes(updatedSeat.id)) {
        if (updatedSeat.status === 'available' && updatedSeat.session_id !== sessionId) {
          // Our hold expired server-side
          currentHold = null;
          stopCountdown();
          holdInfoEl.style.display = 'none';
          showStatus('Your hold expired', 'error');
        }
      }

      renderSeatMap();
    } catch (err) {
      console.error('SSE parse error:', err);
    }
  });

  evtSource.onerror = () => {
    sseStatus.className = 'sse-indicator disconnected';
    sseLabel.textContent = 'Reconnecting...';
  };

  return evtSource;
}

// ─── Init ────────────────────────────────────────────────────────
async function init() {
  await refreshSeats();
  connectSSE();
}

init();
