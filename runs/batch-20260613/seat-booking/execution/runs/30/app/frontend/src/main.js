const API_BASE = '/api';
let selectedSeats = new Set();
let currentHold = null;
let countdownInterval = null;
let eventSource = null;

async function fetchSeats() {
  const res = await fetch(`${API_BASE}/seats`);
  return res.json();
}

function renderSeats(seats) {
  const map = document.getElementById('seat-map');
  map.innerHTML = '';
  
  // Group by row
  const rows = {};
  seats.forEach(seat => {
    if (!rows[seat.row_label]) rows[seat.row_label] = [];
    rows[seat.row_label].push(seat);
  });
  
  Object.keys(rows).sort().forEach(rowLabel => {
    rows[rowLabel].sort((a, b) => a.seat_number - b.seat_number).forEach(seat => {
      const div = document.createElement('div');
      div.className = `seat ${seat.status}`;
      div.textContent = `${seat.row_label}${seat.seat_number}`;
      div.dataset.id = seat.id;
      div.dataset.status = seat.status;
      
      if (seat.status === 'available') {
        div.addEventListener('click', () => toggleSelect(seat.id, div));
      } else if (seat.status === 'held' && currentHold && currentHold.seatIds.includes(seat.id)) {
        div.classList.add('selected');
      }
      
      map.appendChild(div);
    });
  });
  
  updateInventory(seats);
}

function toggleSelect(seatId, element) {
  if (selectedSeats.has(seatId)) {
    selectedSeats.delete(seatId);
    element.classList.remove('selected');
  } else {
    selectedSeats.add(seatId);
    element.classList.add('selected');
  }
  updateControls();
}

function updateControls() {
  const holdBtn = document.getElementById('hold-btn');
  const confirmBtn = document.getElementById('confirm-btn');
  const releaseBtn = document.getElementById('release-btn');
  
  holdBtn.disabled = selectedSeats.size === 0 || currentHold !== null;
  confirmBtn.disabled = !currentHold;
  releaseBtn.disabled = !currentHold;
}

function updateInventory(seats) {
  let avail = 0, held = 0, booked = 0;
  seats.forEach(s => {
    if (s.status === 'available') avail++;
    else if (s.status === 'held') held++;
    else if (s.status === 'booked') booked++;
  });
  document.getElementById('avail-count').textContent = avail;
  document.getElementById('held-count').textContent = held;
  document.getElementById('booked-count').textContent = booked;
}

async function requestHold() {
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
      alert(`Some seats are unavailable: ${data.conflictingSeats.join(', ')}`);
      await refreshSeats();
      selectedSeats.clear();
      return;
    }
    
    if (!res.ok) {
      alert('Failed to hold seats');
      return;
    }
    
    currentHold = await res.json();
    selectedSeats.clear();
    document.getElementById('hold-info').textContent = `Hold ID: ${currentHold.id} (expires in ${currentHold.ttlSeconds}s)`;
    startCountdown(currentHold.expiresAt);
    await refreshSeats();
    updateControls();
  } catch (e) {
    alert('Error: ' + e.message);
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

function startCountdown(expiresAt) {
  if (countdownInterval) clearInterval(countdownInterval);
  const countdownEl = document.getElementById('countdown');
  
  countdownInterval = setInterval(() => {
    const remaining = Math.max(0, Math.floor((new Date(expiresAt) - new Date()) / 1000));
    countdownEl.textContent = `Time left: ${remaining}s`;
    if (remaining <= 0) {
      clearInterval(countdownInterval);
      countdownEl.textContent = 'Hold expired';
      currentHold = null;
      updateControls();
      refreshSeats();
    }
  }, 1000);
}

async function confirmHold() {
  if (!currentHold) return;
  
  try {
    const res = await fetch(`${API_BASE}/holds/${currentHold.id}/confirm`, {
      method: 'POST'
    });
    
    if (!res.ok) {
      const data = await res.json();
      alert('Confirm failed: ' + (data.error || 'Unknown'));
      return;
    }
    
    const result = await res.json();
    alert('Booking confirmed! Seats booked.');
    currentHold = null;
    if (countdownInterval) clearInterval(countdownInterval);
    document.getElementById('hold-info').textContent = '';
    document.getElementById('countdown').textContent = '';
    await refreshSeats();
    updateControls();
  } catch (e) {
    alert(e.message);
  }
}

async function releaseHold() {
  if (!currentHold) return;
  
  try {
    await fetch(`${API_BASE}/holds/${currentHold.id}`, { method: 'DELETE' });
    currentHold = null;
    if (countdownInterval) clearInterval(countdownInterval);
    document.getElementById('hold-info').textContent = '';
    document.getElementById('countdown').textContent = '';
    await refreshSeats();
    updateControls();
  } catch (e) {
    alert(e.message);
  }
}

async function refreshSeats() {
  const seats = await fetchSeats();
  renderSeats(seats);
}

function connectSSE() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`${API_BASE}/stream`);
  
  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'seat-update') {
      refreshSeats();
    }
  };
  
  eventSource.onerror = () => {
    console.log('SSE error, reconnecting...');
    setTimeout(connectSSE, 3000);
  };
}

function setupEventListeners() {
  document.getElementById('hold-btn').addEventListener('click', requestHold);
  document.getElementById('confirm-btn').addEventListener('click', confirmHold);
  document.getElementById('release-btn').addEventListener('click', releaseHold);
}

async function init() {
  setupEventListeners();
  await refreshSeats();
  connectSSE();
  updateControls();
}

init();
