const API_BASE = '/api';

let selectedSeats = [];
let currentHold = null;
let countdownInterval = null;
let seatsData = [];

// Fetch and render seats
async function fetchAndRenderSeats() {
  try {
    const res = await fetch(`${API_BASE}/seats`);
    const data = await res.json();
    seatsData = data.seats;
    renderSeatMap(seatsData);
    updateInventory(data.inventory);
  } catch (err) {
    showMessage('Failed to load seats', 'error');
  }
}

function updateInventory(inventory) {
  document.getElementById('available-count').textContent = inventory.available;
  document.getElementById('held-count').textContent = inventory.held;
  document.getElementById('booked-count').textContent = inventory.booked;
}

function renderSeatMap(seats) {
  const mapEl = document.getElementById('seat-map');
  mapEl.innerHTML = '';

  // Group by row
  const rows = {};
  seats.forEach(seat => {
    if (!rows[seat.row_label]) rows[seat.row_label] = [];
    rows[seat.row_label].push(seat);
  });

  Object.keys(rows).sort().forEach(rowLabel => {
    rows[rowLabel].sort((a, b) => a.seat_number - b.seat_number).forEach(seat => {
      const seatEl = document.createElement('div');
      seatEl.className = `seat ${seat.status}`;
      seatEl.textContent = seat.id;
      seatEl.dataset.id = seat.id;
      seatEl.dataset.status = seat.status;

      if (seat.status === 'available') {
        seatEl.addEventListener('click', () => toggleSeatSelection(seat.id, seatEl));
      } else if (seat.status === 'held' && currentHold && currentHold.seatIds.includes(seat.id)) {
        seatEl.classList.add('selected');
      }

      mapEl.appendChild(seatEl);
    });
  });

  updateControls();
}

function toggleSeatSelection(seatId, seatEl) {
  if (currentHold) {
    showMessage('Release or confirm current hold first', 'error');
    return;
  }

  const index = selectedSeats.indexOf(seatId);
  if (index > -1) {
    selectedSeats.splice(index, 1);
    seatEl.classList.remove('selected');
  } else {
    selectedSeats.push(seatId);
    seatEl.classList.add('selected');
  }

  updateControls();
}

function updateControls() {
  const holdBtn = document.getElementById('hold-btn');
  const confirmBtn = document.getElementById('confirm-btn');
  const releaseBtn = document.getElementById('release-btn');

  holdBtn.disabled = selectedSeats.length === 0 || !!currentHold;
  confirmBtn.disabled = !currentHold;
  releaseBtn.disabled = !currentHold;
}

function showMessage(msg, type = 'success') {
  const msgEl = document.getElementById('message');
  msgEl.textContent = msg;
  msgEl.className = type;
  setTimeout(() => {
    msgEl.textContent = '';
    msgEl.className = '';
  }, 4000);
}

// Request hold
async function requestHold() {
  if (selectedSeats.length === 0) return;

  // Generate a session ID (simple, could be from localStorage)
  const sessionId = localStorage.getItem('sessionId') || `session_${Date.now()}`;
  localStorage.setItem('sessionId', sessionId);

  try {
    const res = await fetch(`${API_BASE}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds: selectedSeats, sessionId })
    });

    if (res.status === 409) {
      const err = await res.json();
      showMessage(`Seats already taken: ${err.conflictingSeats.join(', ')}`, 'error');
      selectedSeats = [];
      await fetchAndRenderSeats();
      return;
    }

    if (!res.ok) {
      const err = await res.json();
      showMessage(err.error || 'Failed to hold seats', 'error');
      return;
    }

    const hold = await res.json();
    currentHold = hold;
    selectedSeats = [];
    showMessage(`Hold created! Expires at ${new Date(hold.expiresAt).toLocaleTimeString()}`, 'success');
    startCountdown(hold.expiresAt);
    await fetchAndRenderSeats();
    updateControls();
  } catch (err) {
    showMessage('Network error creating hold', 'error');
  }
}

function startCountdown(expiresAt) {
  const infoEl = document.getElementById('hold-info');
  clearInterval(countdownInterval);

  countdownInterval = setInterval(() => {
    const remaining = new Date(expiresAt) - new Date();
    if (remaining <= 0) {
      clearInterval(countdownInterval);
      infoEl.textContent = 'Hold expired!';
      currentHold = null;
      fetchAndRenderSeats();
      updateControls();
    } else {
      const seconds = Math.floor(remaining / 1000);
      infoEl.textContent = `Hold active: ${Math.floor(seconds / 60)}m ${seconds % 60}s remaining`;
    }
  }, 1000);
}

// Confirm hold
async function confirmHold() {
  if (!currentHold) return;

  const sessionId = localStorage.getItem('sessionId');

  try {
    const res = await fetch(`${API_BASE}/holds/${currentHold.holdId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    });

    if (!res.ok) {
      const err = await res.json();
      showMessage(err.error || 'Confirmation failed', 'error');
      currentHold = null;
      clearInterval(countdownInterval);
      document.getElementById('hold-info').textContent = '';
      await fetchAndRenderSeats();
      return;
    }

    const result = await res.json();
    showMessage('Booking confirmed!', 'success');
    currentHold = null;
    clearInterval(countdownInterval);
    document.getElementById('hold-info').textContent = '';
    await fetchAndRenderSeats();
    updateControls();
  } catch (err) {
    showMessage('Network error confirming', 'error');
  }
}

// Release hold
async function releaseHold() {
  if (!currentHold) return;

  try {
    const res = await fetch(`${API_BASE}/holds/${currentHold.holdId}`, {
      method: 'DELETE'
    });

    if (!res.ok) {
      showMessage('Failed to release', 'error');
      return;
    }

    showMessage('Hold released', 'success');
    currentHold = null;
    clearInterval(countdownInterval);
    document.getElementById('hold-info').textContent = '';
    await fetchAndRenderSeats();
    updateControls();
  } catch (err) {
    showMessage('Error releasing hold', 'error');
  }
}

// Setup SSE
function setupSSE() {
  const eventSource = new EventSource(`${API_BASE}/stream`);

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'connected') return;

      // Update local state and re-render on updates
      if (data.seatIds && data.status) {
        // Optimistic update or refetch
        fetchAndRenderSeats();
      }
    } catch (e) {
      // ignore
    }
  };

  eventSource.onerror = () => {
    console.log('SSE disconnected, will retry on next action');
    // Could implement reconnect but for simplicity refetch on actions
  };
}

// Event listeners
function setupEventListeners() {
  document.getElementById('hold-btn').addEventListener('click', requestHold);
  document.getElementById('confirm-btn').addEventListener('click', confirmHold);
  document.getElementById('release-btn').addEventListener('click', releaseHold);

  // Allow clicking booked/held to show info maybe, but basic is fine
}

// Initialize
async function init() {
  await fetchAndRenderSeats();
  setupEventListeners();
  setupSSE();

  // Periodic refresh as fallback
  setInterval(fetchAndRenderSeats, 30000);
}

init();