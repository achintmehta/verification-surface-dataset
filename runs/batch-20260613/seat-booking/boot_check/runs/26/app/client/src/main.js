const API_BASE = '/api';
let selectedSeats = new Set();
let currentHold = null;
let countdownInterval = null;
let eventSource = null;

const seatMapEl = document.getElementById('seat-map');
const statusEl = document.getElementById('status');
const holdBtn = document.getElementById('hold-btn');
const confirmBtn = document.getElementById('confirm-btn');
const releaseBtn = document.getElementById('release-btn');
const refreshBtn = document.getElementById('refresh-btn');
const holdInfoEl = document.getElementById('hold-info');
const holdIdEl = document.getElementById('hold-id');
const countdownEl = document.getElementById('countdown');
const messageEl = document.getElementById('message');

function showMessage(msg, isError = false) {
  messageEl.textContent = msg;
  messageEl.style.color = isError ? 'red' : 'green';
  setTimeout(() => { messageEl.textContent = ''; }, 3000);
}

async function fetchSeats() {
  try {
    const res = await fetch(`${API_BASE}/seats`);
    if (!res.ok) throw new Error('Failed to fetch seats');
    const seats = await res.json();
    renderSeatMap(seats);
    updateInventory(seats);
  } catch (err) {
    statusEl.textContent = 'Error loading seats: ' + err.message;
  }
}

function updateInventory(seats) {
  const available = seats.filter(s => s.status === 'available').length;
  const held = seats.filter(s => s.status === 'held').length;
  const booked = seats.filter(s => s.status === 'booked').length;
  statusEl.textContent = `Available: ${available} | Held: ${held} | Booked: ${booked} | Total: ${seats.length}`;
}

function renderSeatMap(seats) {
  seatMapEl.innerHTML = '';
  const seatsByRow = {};
  seats.forEach(seat => {
    if (!seatsByRow[seat.row_label]) seatsByRow[seat.row_label] = [];
    seatsByRow[seat.row_label].push(seat);
  });

  Object.keys(seatsByRow).sort().forEach(row => {
    seatsByRow[row].sort((a, b) => a.seat_number - b.seat_number).forEach(seat => {
      const seatEl = document.createElement('div');
      seatEl.className = `seat ${seat.status}`;
      seatEl.textContent = `${seat.row_label}${seat.seat_number}`;
      seatEl.dataset.id = seat.id;
      seatEl.dataset.status = seat.status;

      if (seat.status === 'available') {
        seatEl.addEventListener('click', () => toggleSeatSelection(seat.id, seatEl));
      } else if (seat.status === 'held' && currentHold && seat.hold_id === currentHold.id) {
        seatEl.classList.add('selected');
      }

      seatMapEl.appendChild(seatEl);
    });
  });
}

function toggleSeatSelection(seatId, seatEl) {
  if (selectedSeats.has(seatId)) {
    selectedSeats.delete(seatId);
    seatEl.classList.remove('selected');
  } else {
    selectedSeats.add(seatId);
    seatEl.classList.add('selected');
  }
  holdBtn.disabled = selectedSeats.size === 0;
}

async function requestHold() {
  if (selectedSeats.size === 0) return;

  const seatIds = Array.from(selectedSeats);
  const sessionId = getSessionId();

  try {
    const res = await fetch(`${API_BASE}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId })
    });

    if (res.status === 409) {
      const data = await res.json();
      showMessage(`Some seats unavailable: ${data.conflictingSeats.join(', ')}`, true);
      selectedSeats.clear();
      await fetchSeats();
      return;
    }

    if (!res.ok) throw new Error('Hold request failed');

    const hold = await res.json();
    currentHold = hold;
    selectedSeats.clear();
    showMessage('Hold acquired successfully!');
    updateHoldUI();
    await fetchSeats();
  } catch (err) {
    showMessage(err.message, true);
  }
}

function getSessionId() {
  let sessionId = localStorage.getItem('sessionId');
  if (!sessionId) {
    sessionId = 'session-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    localStorage.setItem('sessionId', sessionId);
  }
  return sessionId;
}

function updateHoldUI() {
  if (currentHold) {
    holdInfoEl.style.display = 'block';
    holdIdEl.textContent = currentHold.id;
    confirmBtn.disabled = false;
    releaseBtn.disabled = false;
    holdBtn.disabled = true;

    if (countdownInterval) clearInterval(countdownInterval);
    countdownInterval = setInterval(() => {
      const expiresAt = new Date(currentHold.expires_at);
      const now = new Date();
      const remaining = Math.max(0, Math.floor((expiresAt - now) / 1000));
      countdownEl.textContent = `${remaining}s`;

      if (remaining <= 0) {
        clearInterval(countdownInterval);
        showMessage('Hold expired!', true);
        releaseCurrentHold();
      }
    }, 1000);
  } else {
    holdInfoEl.style.display = 'none';
    confirmBtn.disabled = true;
    releaseBtn.disabled = true;
    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }
  }
}

async function confirmHold() {
  if (!currentHold) return;

  try {
    const res = await fetch(`${API_BASE}/holds/${currentHold.id}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Confirm failed');
    }

    const result = await res.json();
    showMessage('Booking confirmed!');
    currentHold = null;
    updateHoldUI();
    await fetchSeats();
  } catch (err) {
    showMessage(err.message, true);
    if (err.message.includes('expired') || err.message.includes('not found')) {
      currentHold = null;
      updateHoldUI();
    }
    await fetchSeats();
  }
}

async function releaseHold() {
  if (!currentHold) return;
  await releaseCurrentHold();
}

async function releaseCurrentHold() {
  if (!currentHold) return;

  try {
    await fetch(`${API_BASE}/holds/${currentHold.id}`, {
      method: 'DELETE'
    });
  } catch (e) {}

  currentHold = null;
  updateHoldUI();
  await fetchSeats();
}

function connectSSE() {
  if (eventSource) eventSource.close();

  eventSource = new EventSource(`${API_BASE}/stream`);

  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'seat-update') {
      // Refresh seat map on any update
      fetchSeats();
    }
  };

  eventSource.onerror = () => {
    console.log('SSE connection error, will retry...');
    setTimeout(connectSSE, 5000);
  };
}

function init() {
  holdBtn.addEventListener('click', requestHold);
  confirmBtn.addEventListener('click', confirmHold);
  releaseBtn.addEventListener('click', releaseHold);
  refreshBtn.addEventListener('click', fetchSeats);

  fetchSeats();
  connectSSE();

  // Periodic refresh as fallback
  setInterval(fetchSeats, 30000);
}

init();