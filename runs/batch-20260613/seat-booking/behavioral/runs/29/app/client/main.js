const API_BASE = '/api';
const SESSION_ID = 'user_' + Math.random().toString(36).substr(2, 9);

let seats = [];
let selectedSeats = new Set();
let currentHold = null;
let countdownInterval = null;
let eventSource = null;

async function fetchSeats() {
  try {
    const res = await fetch(`${API_BASE}/seats`);
    seats = await res.json();
    renderSeatMap();
    updateInventory();
  } catch (err) {
    showMessage('Failed to load seats', 'error');
  }
}

function renderSeatMap() {
  const container = document.getElementById('seat-map');
  container.innerHTML = '';

  // Group by row
  const rows = {};
  seats.forEach(seat => {
    if (!rows[seat.row]) rows[seat.row] = [];
    rows[seat.row].push(seat);
  });

  Object.keys(rows).sort().forEach(rowLabel => {
    rows[rowLabel].sort((a, b) => a.number - b.number).forEach(seat => {
      const div = document.createElement('div');
      div.className = `seat ${seat.status}`;
      div.textContent = `${seat.row}${seat.number}`;
      div.dataset.id = seat.id;

      if (seat.status === 'available') {
        div.addEventListener('click', () => toggleSeatSelection(seat.id, div));
      } else if (seat.status === 'held' && currentHold && seat.holdId === currentHold.holdId) {
        // Our hold
        div.classList.add('selected');
        div.addEventListener('click', () => toggleSeatSelection(seat.id, div));
      }

      container.appendChild(div);
    });
  });
}

function toggleSeatSelection(seatId, element) {
  if (currentHold) {
    // Can only select our held seats or available? But for simplicity allow reselect
    showMessage('Release current hold first or confirm it', 'error');
    return;
  }

  if (selectedSeats.has(seatId)) {
    selectedSeats.delete(seatId);
    element.classList.remove('selected');
  } else {
    // Only allow selecting available
    const seat = seats.find(s => s.id === seatId);
    if (seat && seat.status === 'available') {
      selectedSeats.add(seatId);
      element.classList.add('selected');
    }
  }

  updateControls();
}

function updateInventory() {
  let available = 0, held = 0, booked = 0;
  seats.forEach(seat => {
    if (seat.status === 'available') available++;
    else if (seat.status === 'held') held++;
    else if (seat.status === 'booked') booked++;
  });

  document.getElementById('available-count').textContent = available;
  document.getElementById('held-count').textContent = held;
  document.getElementById('booked-count').textContent = booked;
}

function updateControls() {
  const holdBtn = document.getElementById('hold-btn');
  const confirmBtn = document.getElementById('confirm-btn');
  const releaseBtn = document.getElementById('release-btn');
  const holdInfo = document.getElementById('hold-info');

  holdBtn.disabled = selectedSeats.size === 0 || !!currentHold;
  confirmBtn.disabled = !currentHold;
  releaseBtn.disabled = !currentHold;

  if (currentHold) {
    holdInfo.innerHTML = `Hold active: ${currentHold.seatIds.join(', ')} <br> Expires in: <span id="countdown"></span>`;
    startCountdown();
  } else {
    holdInfo.innerHTML = '';
    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }
  }
}

function startCountdown() {
  if (countdownInterval) clearInterval(countdownInterval);
  
  const update = () => {
    if (!currentHold) return;
    const remaining = Math.max(0, Math.floor((new Date(currentHold.expiresAt) - new Date()) / 1000));
    const el = document.getElementById('countdown');
    if (el) {
      el.textContent = `${remaining}s`;
    }
    if (remaining <= 0) {
      clearInterval(countdownInterval);
      currentHold = null;
      selectedSeats.clear();
      fetchSeats();
      updateControls();
      showMessage('Hold expired', 'error');
    }
  };
  
  update();
  countdownInterval = setInterval(update, 1000);
}

async function requestHold() {
  if (selectedSeats.size === 0) return;

  const seatIds = Array.from(selectedSeats);
  try {
    const res = await fetch(`${API_BASE}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId: SESSION_ID })
    });

    if (res.status === 409) {
      const data = await res.json();
      showMessage(`Seats already taken: ${data.conflictingSeatIds.join(', ')}`, 'error');
      selectedSeats.clear();
      await fetchSeats();
      return;
    }

    if (!res.ok) {
      throw new Error('Hold failed');
    }

    const holdData = await res.json();
    currentHold = { ...holdData, seatIds };
    selectedSeats.clear();
    showMessage('Hold successful! You have 2 minutes to confirm.', 'success');
    await fetchSeats();
    updateControls();
  } catch (err) {
    showMessage('Failed to hold seats', 'error');
    await fetchSeats();
  }
}

async function confirmHold() {
  if (!currentHold) return;

  try {
    const res = await fetch(`${API_BASE}/holds/${currentHold.holdId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID })
    });

    if (!res.ok) {
      const data = await res.json();
      showMessage(data.error || 'Confirm failed', 'error');
      currentHold = null;
      await fetchSeats();
      updateControls();
      return;
    }

    const data = await res.json();
    showMessage(`Successfully booked seats: ${data.bookedSeatIds.join(', ')}`, 'success');
    currentHold = null;
    selectedSeats.clear();
    await fetchSeats();
    updateControls();
  } catch (err) {
    showMessage('Confirm failed', 'error');
  }
}

async function releaseHold() {
  if (!currentHold) return;

  try {
    await fetch(`${API_BASE}/holds/${currentHold.holdId}`, {
      method: 'DELETE'
    });
    showMessage('Hold released', 'success');
    currentHold = null;
    selectedSeats.clear();
    await fetchSeats();
    updateControls();
  } catch (err) {
    showMessage('Release failed', 'error');
  }
}

function showMessage(msg, type) {
  const el = document.getElementById('message');
  el.textContent = msg;
  el.className = type === 'error' ? 'message-error' : 'message-success';
  setTimeout(() => {
    el.textContent = '';
    el.className = '';
  }, 4000);
}

function connectSSE() {
  eventSource = new EventSource(`${API_BASE}/stream`);

  eventSource.addEventListener('seats-held', (e) => {
    const data = JSON.parse(e.data);
    // Update local state
    seats.forEach(seat => {
      if (data.seatIds.includes(seat.id)) {
        seat.status = 'held';
        seat.holdId = data.holdId;
      }
    });
    renderSeatMap();
    updateInventory();
  });

  eventSource.addEventListener('seats-booked', (e) => {
    const data = JSON.parse(e.data);
    seats.forEach(seat => {
      if (data.seatIds.includes(seat.id)) {
        seat.status = 'booked';
        seat.bookedBy = data.bookedBy;
      }
    });
    if (currentHold && data.seatIds.some(id => currentHold.seatIds.includes(id))) {
      currentHold = null;
      updateControls();
    }
    renderSeatMap();
    updateInventory();
  });

  eventSource.addEventListener('seats-released', (e) => {
    const data = JSON.parse(e.data);
    seats.forEach(seat => {
      if (data.seatIds.includes(seat.id)) {
        seat.status = 'available';
        seat.holdId = null;
      }
    });
    if (currentHold && data.seatIds.some(id => currentHold.seatIds.includes(id))) {
      currentHold = null;
      updateControls();
    }
    renderSeatMap();
    updateInventory();
  });

  eventSource.onerror = () => {
    console.log('SSE disconnected, retrying...');
    setTimeout(connectSSE, 3000);
  };
}

function init() {
  document.getElementById('hold-btn').addEventListener('click', requestHold);
  document.getElementById('confirm-btn').addEventListener('click', confirmHold);
  document.getElementById('release-btn').addEventListener('click', releaseHold);

  fetchSeats();
  connectSSE();

  // Refresh seats periodically as fallback
  setInterval(fetchSeats, 30000);
}

init();