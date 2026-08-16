const API_BASE = '/api';
let seats = [];
let selectedSeats = new Set();
let currentHold = null;
let eventSource = null;
let countdownInterval = null;

const seatMapEl = document.getElementById('seat-map');
const statusEl = document.getElementById('status');
const inventoryEl = document.getElementById('inventory');
const holdBtn = document.getElementById('hold-btn');
const confirmBtn = document.getElementById('confirm-btn');
const releaseBtn = document.getElementById('release-btn');
const holdInfoEl = document.getElementById('hold-info');
const messagesEl = document.getElementById('messages');

function showMessage(msg, type = 'success') {
  const div = document.createElement('div');
  div.className = `message ${type}`;
  div.textContent = msg;
  messagesEl.appendChild(div);
  setTimeout(() => div.remove(), 5000);
}

async function fetchSeats() {
  try {
    const res = await fetch(`${API_BASE}/seats`);
    if (!res.ok) throw new Error('Failed to fetch seats');
    seats = await res.json();
    renderSeatMap();
    updateInventory();
    statusEl.textContent = 'Seats loaded';
  } catch (err) {
    statusEl.textContent = 'Error loading seats';
    showMessage(err.message, 'error');
  }
}

function updateInventory() {
  const available = seats.filter(s => s.status === 'available').length;
  const held = seats.filter(s => s.status === 'held').length;
  const booked = seats.filter(s => s.status === 'booked').length;
  inventoryEl.innerHTML = `
    <span>Available: ${available}</span>
    <span>Held: ${held}</span>
    <span>Booked: ${booked}</span>
    <span>Total: ${seats.length}</span>
  `;
}

function renderSeatMap() {
  seatMapEl.innerHTML = '';
  const rows = {};
  seats.forEach(seat => {
    if (!rows[seat.row_label]) rows[seat.row_label] = [];
    rows[seat.row_label].push(seat);
  });

  Object.keys(rows).sort().forEach(rowLabel => {
    rows[rowLabel].sort((a, b) => a.seat_number - b.seat_number).forEach(seat => {
      const seatEl = document.createElement('div');
      seatEl.className = `seat ${seat.status}`;
      seatEl.textContent = `${seat.row_label}${seat.seat_number}`;
      seatEl.dataset.seatId = seat.id;

      if (seat.status === 'available') {
        seatEl.addEventListener('click', () => toggleSeatSelection(seat.id, seatEl));
      } else if (seat.status === 'held' && currentHold && currentHold.seatIds.includes(seat.id)) {
        seatEl.classList.add('selected');
      }

      seatMapEl.appendChild(seatEl);
    });
  });

  updateButtons();
}

function toggleSeatSelection(seatId, seatEl) {
  if (currentHold) {
    showMessage('Release current hold first', 'error');
    return;
  }
  if (selectedSeats.has(seatId)) {
    selectedSeats.delete(seatId);
    seatEl.classList.remove('selected');
  } else {
    selectedSeats.add(seatId);
    seatEl.classList.add('selected');
  }
  updateButtons();
}

function updateButtons() {
  holdBtn.disabled = selectedSeats.size === 0 || !!currentHold;
  confirmBtn.disabled = !currentHold;
  releaseBtn.disabled = !currentHold;
}

holdBtn.addEventListener('click', async () => {
  if (selectedSeats.size === 0) return;
  const seatIds = Array.from(selectedSeats);
  const sessionId = localStorage.getItem('sessionId') || `session-${Date.now()}`;
  localStorage.setItem('sessionId', sessionId);

  try {
    const res = await fetch(`${API_BASE}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId })
    });

    if (res.status === 409) {
      const data = await res.json();
      showMessage(`Some seats taken: ${data.conflictingSeats.join(', ')}`, 'error');
      selectedSeats.clear();
      await fetchSeats();
      return;
    }

    if (!res.ok) throw new Error('Hold failed');
    currentHold = await res.json();
    selectedSeats.clear();
    showMessage(`Hold created! Expires in ${Math.floor(currentHold.ttl / 1000)}s`);
    startCountdown();
    await fetchSeats();
    updateButtons();
  } catch (err) {
    showMessage(err.message, 'error');
  }
});

confirmBtn.addEventListener('click', async () => {
  if (!currentHold) return;
  try {
    const res = await fetch(`${API_BASE}/holds/${currentHold.holdId}/confirm`, {
      method: 'POST'
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Confirm failed');
    }
    const result = await res.json();
    showMessage('Booking confirmed!');
    stopCountdown();
    currentHold = null;
    await fetchSeats();
    updateButtons();
    holdInfoEl.textContent = '';
  } catch (err) {
    showMessage(err.message, 'error');
    await fetchSeats();
  }
});

releaseBtn.addEventListener('click', async () => {
  if (!currentHold) return;
  try {
    await fetch(`${API_BASE}/holds/${currentHold.holdId}`, { method: 'DELETE' });
    showMessage('Hold released');
    stopCountdown();
    currentHold = null;
    await fetchSeats();
    updateButtons();
    holdInfoEl.textContent = '';
  } catch (err) {
    showMessage(err.message, 'error');
  }
});

function startCountdown() {
  stopCountdown();
  if (!currentHold) return;
  const update = () => {
    const remaining = Math.max(0, Math.floor((currentHold.expiresAt - Date.now()) / 1000));
    holdInfoEl.textContent = `Hold active: ${remaining}s remaining. Seats: ${currentHold.seatIds.join(', ')}`;
    if (remaining <= 0) {
      stopCountdown();
      currentHold = null;
      holdInfoEl.textContent = 'Hold expired';
      fetchSeats();
    }
  };
  update();
  countdownInterval = setInterval(update, 1000);
}

function stopCountdown() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
}

function connectSSE() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`${API_BASE}/stream`);
  
  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'seat-update') {
      // Update local seats
      const updatedSeat = data.seat;
      const idx = seats.findIndex(s => s.id === updatedSeat.id);
      if (idx !== -1) {
        seats[idx] = { ...seats[idx], ...updatedSeat };
      }
      renderSeatMap();
      updateInventory();
    } else if (data.type === 'seats-refresh') {
      fetchSeats();
    }
  };

  eventSource.onerror = () => {
    showMessage('SSE connection error, retrying...', 'error');
    setTimeout(connectSSE, 3000);
  };
}

async function init() {
  await fetchSeats();
  connectSSE();
  statusEl.textContent = 'Ready - Select available seats to hold';
}

init();