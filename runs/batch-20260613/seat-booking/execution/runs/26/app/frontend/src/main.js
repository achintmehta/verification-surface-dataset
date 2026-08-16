const API_BASE = '/api';
const SSE_URL = '/api/stream';

let selectedSeats = new Set();
let currentHold = null;
let eventSource = null;
let seatsData = [];

async function fetchSeats() {
  const res = await fetch(`${API_BASE}/seats`);
  seatsData = await res.json();
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
  
  // Group by row
  const rows = {};
  seatsData.forEach(seat => {
    if (!rows[seat.row_label]) rows[seat.row_label] = [];
    rows[seat.row_label].push(seat);
  });
  
  Object.keys(rows).sort().forEach(rowLabel => {
    rows[rowLabel].sort((a, b) => a.seat_number - b.seat_number).forEach(seat => {
      const div = document.createElement('div');
      div.className = `seat ${seat.status}`;
      div.textContent = `${seat.row_label}${seat.seat_number}`;
      div.dataset.seatId = seat.id;
      
      if (seat.status === 'available') {
        div.addEventListener('click', () => toggleSeatSelection(seat.id, div));
      } else if (seat.status === 'held' && currentHold && currentHold.seatIds.includes(seat.id)) {
        div.classList.add('selected');
      }
      
      map.appendChild(div);
    });
  });
}

function toggleSeatSelection(seatId, element) {
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

function updateControls() {
  const holdBtn = document.getElementById('hold-btn');
  const confirmBtn = document.getElementById('confirm-btn');
  const releaseBtn = document.getElementById('release-btn');
  const holdInfo = document.getElementById('hold-info');
  
  if (currentHold) {
    holdBtn.disabled = true;
    confirmBtn.disabled = false;
    releaseBtn.disabled = false;
    holdInfo.innerHTML = `Hold active. Expires in <span id="countdown"></span>s. Seats: ${currentHold.seatIds.join(', ')}`;
    startCountdown();
  } else {
    holdBtn.disabled = selectedSeats.size === 0;
    confirmBtn.disabled = true;
    releaseBtn.disabled = true;
    holdInfo.innerHTML = '';
  }
}

let countdownInterval = null;

function startCountdown() {
  if (countdownInterval) clearInterval(countdownInterval);
  const expiresAt = currentHold.expiresAt;
  countdownInterval = setInterval(() => {
    const remaining = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
    const el = document.getElementById('countdown');
    if (el) el.textContent = remaining;
    if (remaining <= 0) {
      clearInterval(countdownInterval);
      currentHold = null;
      selectedSeats.clear();
      fetchSeats();
      updateControls();
    }
  }, 1000);
}

async function requestHold() {
  const sessionId = getSessionId();
  const seatIds = Array.from(selectedSeats);
  const res = await fetch(`${API_BASE}/holds`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seatIds, sessionId })
  });
  
  const msgEl = document.getElementById('message');
  if (res.ok) {
    currentHold = await res.json();
    selectedSeats.clear();
    msgEl.textContent = 'Hold successful!';
    msgEl.className = 'success';
    fetchSeats();
    updateControls();
  } else if (res.status === 409) {
    const data = await res.json();
    msgEl.textContent = `Some seats unavailable: ${data.conflictingSeats.join(', ')}`;
    msgEl.className = 'error';
    selectedSeats.clear();
    fetchSeats();
  } else {
    msgEl.textContent = 'Error requesting hold';
    msgEl.className = 'error';
  }
  setTimeout(() => { msgEl.textContent = ''; }, 3000);
}

async function confirmHold() {
  if (!currentHold) return;
  const res = await fetch(`${API_BASE}/holds/${currentHold.holdId}/confirm`, {
    method: 'POST'
  });
  
  const msgEl = document.getElementById('message');
  if (res.ok) {
    msgEl.textContent = 'Booking confirmed!';
    msgEl.className = 'success';
    currentHold = null;
    fetchSeats();
    updateControls();
  } else {
    const data = await res.json();
    msgEl.textContent = data.error || 'Confirm failed';
    msgEl.className = 'error';
    currentHold = null;
    fetchSeats();
    updateControls();
  }
}

async function releaseHold() {
  if (!currentHold) return;
  await fetch(`${API_BASE}/holds/${currentHold.holdId}`, {
    method: 'DELETE'
  });
  currentHold = null;
  selectedSeats.clear();
  fetchSeats();
  updateControls();
}

function getSessionId() {
  let id = localStorage.getItem('sessionId');
  if (!id) {
    id = 'sess_' + Math.random().toString(36).substr(2, 9);
    localStorage.setItem('sessionId', id);
  }
  return id;
}

function connectSSE() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(SSE_URL);
  
  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'seat-update') {
      // Update local seatsData
      const updatedSeat = data.seat;
      const idx = seatsData.findIndex(s => s.id === updatedSeat.id);
      if (idx !== -1) {
        seatsData[idx] = updatedSeat;
      }
      renderSeatMap();
      updateInventory();
    } else if (data.type === 'seats-reset') {
      fetchSeats();
    }
  };
  
  eventSource.onerror = () => {
    console.log('SSE error, reconnecting...');
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
  
  // Initial update
  updateControls();
}

init();