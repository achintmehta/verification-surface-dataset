const API_BASE = '/api';
let selectedSeats = new Set();
let currentHold = null;
let eventSource = null;
let seatsData = [];

async function fetchSeats() {
  const res = await fetch(`${API_BASE}/seats`);
  const data = await res.json();
  seatsData = data.seats;
  renderSeatMap();
  updateInventory();
}

function updateInventory() {
  let available = 0, held = 0, booked = 0;
  seatsData.forEach(seat => {
    if (seat.status === 'available') available++;
    else if (seat.status === 'held') held++;
    else if (seat.status === 'booked') booked++;
  });
  document.getElementById('available-count').textContent = available;
  document.getElementById('held-count').textContent = held;
  document.getElementById('booked-count').textContent = booked;
}

function renderSeatMap() {
  const map = document.getElementById('seat-map');
  map.innerHTML = '';
  const seatsByRow = {};
  seatsData.forEach(seat => {
    if (!seatsByRow[seat.row_label]) seatsByRow[seat.row_label] = [];
    seatsByRow[seat.row_label].push(seat);
  });

  Object.keys(seatsByRow).sort().forEach(row => {
    seatsByRow[row].sort((a, b) => a.seat_number - b.seat_number).forEach(seat => {
      const div = document.createElement('div');
      div.className = `seat ${seat.status}`;
      div.textContent = `${seat.row_label}${seat.seat_number}`;
      div.dataset.seatId = seat.id;

      if (seat.status === 'available') {
        div.addEventListener('click', () => toggleSelect(seat.id, div));
      } else if (seat.status === 'held' && currentHold && currentHold.seatIds.includes(seat.id)) {
        div.classList.add('selected');
      }

      map.appendChild(div);
    });
  });
}

function toggleSelect(seatId, element) {
  if (selectedSeats.has(seatId)) {
    selectedSeats.delete(seatId);
    element.classList.remove('selected');
  } else {
    selectedSeats.add(seatId);
    element.classList.add('selected');
  }
  updateHoldButton();
}

function updateHoldButton() {
  const btn = document.getElementById('hold-btn');
  btn.disabled = selectedSeats.size === 0 || currentHold !== null;
}

function showMessage(msg, isError = false) {
  const el = document.getElementById('message');
  el.textContent = msg;
  el.className = isError ? 'error' : 'success';
  setTimeout(() => {
    el.textContent = '';
    el.className = '';
  }, 3000);
}

async function requestHold() {
  if (selectedSeats.size === 0) return;
  const sessionId = getSessionId();
  const seatIds = Array.from(selectedSeats);

  try {
    const res = await fetch(`${API_BASE}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId })
    });

    if (res.status === 409) {
      const data = await res.json();
      showMessage(`Some seats taken: ${data.conflictingSeats.join(', ')}`, true);
      selectedSeats.clear();
      await fetchSeats();
      return;
    }

    if (!res.ok) {
      const data = await res.json();
      showMessage(data.error || 'Hold failed', true);
      return;
    }

    const hold = await res.json();
    currentHold = hold;
    selectedSeats.clear();
    showMessage(`Hold successful! Expires in ${hold.ttlSeconds} seconds.`);
    document.getElementById('hold-btn').disabled = true;
    document.getElementById('confirm-btn').disabled = false;
    document.getElementById('release-btn').disabled = false;
    startHoldCountdown(hold.expiresAt);
    await fetchSeats();
  } catch (e) {
    showMessage('Network error', true);
  }
}

function getSessionId() {
  let id = localStorage.getItem('sessionId');
  if (!id) {
    id = 'sess_' + Math.random().toString(36).substr(2, 9);
    localStorage.setItem('sessionId', id);
  }
  return id;
}

let countdownInterval = null;

function startHoldCountdown(expiresAt) {
  const info = document.getElementById('hold-info');
  if (countdownInterval) clearInterval(countdownInterval);

  countdownInterval = setInterval(() => {
    const remaining = Math.max(0, Math.floor((new Date(expiresAt) - Date.now()) / 1000));
    info.textContent = `Hold expires in: ${remaining}s`;
    if (remaining <= 0) {
      clearInterval(countdownInterval);
      info.textContent = 'Hold expired';
      releaseCurrentHoldUI();
    }
  }, 1000);
}

function releaseCurrentHoldUI() {
  currentHold = null;
  document.getElementById('confirm-btn').disabled = true;
  document.getElementById('release-btn').disabled = true;
  document.getElementById('hold-info').textContent = '';
  document.getElementById('hold-btn').disabled = false;
  fetchSeats();
}

async function confirmHold() {
  if (!currentHold) return;
  try {
    const res = await fetch(`${API_BASE}/holds/${currentHold.holdId}/confirm`, {
      method: 'POST'
    });
    const data = await res.json();
    if (!res.ok) {
      showMessage(data.error || 'Confirm failed', true);
      if (data.expired) {
        releaseCurrentHoldUI();
      }
      return;
    }
    showMessage('Booking confirmed!');
    currentHold = null;
    document.getElementById('confirm-btn').disabled = true;
    document.getElementById('release-btn').disabled = true;
    document.getElementById('hold-info').textContent = '';
    if (countdownInterval) clearInterval(countdownInterval);
    await fetchSeats();
  } catch (e) {
    showMessage('Error confirming', true);
  }
}

async function releaseHold() {
  if (!currentHold) return;
  try {
    await fetch(`${API_BASE}/holds/${currentHold.holdId}`, {
      method: 'DELETE'
    });
    showMessage('Hold released');
    releaseCurrentHoldUI();
  } catch (e) {
    showMessage('Release error', true);
  }
}

function connectSSE() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`http://localhost:3000/api/stream`);

  eventSource.onmessage = (event) => {
    const update = JSON.parse(event.data);
    // Update local seatsData
    if (update.type === 'seat_update') {
      const idx = seatsData.findIndex(s => s.id === update.seatId);
      if (idx !== -1) {
        seatsData[idx].status = update.status;
        if (update.status !== 'held') {
          seatsData[idx].holdId = null;
          seatsData[idx].holdExpiresAt = null;
        }
      }
      renderSeatMap();
      updateInventory();
    } else if (update.type === 'full_refresh') {
      fetchSeats();
    }
  };

  eventSource.onerror = () => {
    console.log('SSE error, will reconnect...');
    setTimeout(connectSSE, 3000);
  };
}

function init() {
  document.getElementById('hold-btn').addEventListener('click', requestHold);
  document.getElementById('confirm-btn').addEventListener('click', confirmHold);
  document.getElementById('release-btn').addEventListener('click', releaseHold);

  fetchSeats().then(() => {
    connectSSE();
  });

  // Refresh seats periodically as fallback
  setInterval(fetchSeats, 30000);
}

init();