const API_BASE = 'http://localhost:3000/api';
let currentHold = null;
let selectedSeats = new Set();
let eventSource = null;

async function fetchSeats() {
  const res = await fetch(`${API_BASE}/seats`);
  return res.json();
}

async function createHold(seatIds, sessionId) {
  const res = await fetch(`${API_BASE}/holds`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seatIds, sessionId })
  });
  if (res.status === 409) {
    const data = await res.json();
    throw new Error(`Seats unavailable: ${data.conflictingSeats.join(', ')}`);
  }
  if (!res.ok) throw new Error('Failed to create hold');
  return res.json();
}

async function confirmHold(holdId) {
  const res = await fetch(`${API_BASE}/holds/${holdId}/confirm`, {
    method: 'POST'
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to confirm');
  }
  return res.json();
}

async function releaseHold(holdId) {
  const res = await fetch(`${API_BASE}/holds/${holdId}`, {
    method: 'DELETE'
  });
  if (!res.ok) throw new Error('Failed to release');
  return res.json();
}

function renderSeats(seats) {
  const container = document.getElementById('seat-map');
  container.innerHTML = '';
  
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
      div.dataset.seatId = seat.id;
      
      if (seat.status === 'available') {
        div.addEventListener('click', () => toggleSeatSelection(seat.id, div));
      } else if (seat.status === 'held' && currentHold && currentHold.seatIds.includes(seat.id)) {
        div.classList.add('selected');
      }
      
      container.appendChild(div);
    });
  });
  
  updateCounts(seats);
}

function toggleSeatSelection(seatId, element) {
  if (currentHold) return; // Can't select while holding
  
  if (selectedSeats.has(seatId)) {
    selectedSeats.delete(seatId);
    element.classList.remove('selected');
  } else {
    selectedSeats.add(seatId);
    element.classList.add('selected');
  }
}

function updateCounts(seats) {
  const available = seats.filter(s => s.status === 'available').length;
  const held = seats.filter(s => s.status === 'held').length;
  const booked = seats.filter(s => s.status === 'booked').length;
  
  document.getElementById('available-count').textContent = available;
  document.getElementById('held-count').textContent = held;
  document.getElementById('booked-count').textContent = booked;
}

function showMessage(msg, isError = false) {
  const el = document.getElementById('message');
  el.textContent = msg;
  el.style.color = isError ? 'red' : 'green';
  setTimeout(() => { el.textContent = ''; }, 5000);
}

async function handleHold() {
  if (selectedSeats.size === 0) {
    showMessage('Select some seats first', true);
    return;
  }
  
  const sessionId = localStorage.getItem('sessionId') || `session-${Date.now()}`;
  localStorage.setItem('sessionId', sessionId);
  
  try {
    const seatIds = Array.from(selectedSeats);
    const hold = await createHold(seatIds, sessionId);
    currentHold = { ...hold, seatIds };
    selectedSeats.clear();
    showMessage(`Hold created! Expires in ${hold.ttlSeconds} seconds`);
    document.getElementById('confirm-btn').disabled = false;
    document.getElementById('release-btn').disabled = false;
    document.getElementById('hold-btn').disabled = true;
    
    // Start countdown
    startCountdown(hold.expiresAt);
    
    // Refresh seats
    const seats = await fetchSeats();
    renderSeats(seats);
  } catch (err) {
    showMessage(err.message, true);
    // Refresh to show current state
    const seats = await fetchSeats();
    renderSeats(seats);
  }
}

let countdownInterval = null;

function startCountdown(expiresAt) {
  if (countdownInterval) clearInterval(countdownInterval);
  
  const infoEl = document.getElementById('hold-info');
  
  countdownInterval = setInterval(() => {
    const remaining = Math.max(0, Math.floor((new Date(expiresAt) - Date.now()) / 1000));
    infoEl.innerHTML = `Hold active. Time remaining: <strong>${remaining}s</strong>`;
    
    if (remaining <= 0) {
      clearInterval(countdownInterval);
      infoEl.textContent = 'Hold expired';
      currentHold = null;
      document.getElementById('confirm-btn').disabled = true;
      document.getElementById('release-btn').disabled = true;
      document.getElementById('hold-btn').disabled = false;
      refreshSeats();
    }
  }, 1000);
}

async function handleConfirm() {
  if (!currentHold) return;
  
  try {
    await confirmHold(currentHold.holdId);
    showMessage('Booking confirmed!');
    currentHold = null;
    document.getElementById('confirm-btn').disabled = true;
    document.getElementById('release-btn').disabled = true;
    document.getElementById('hold-btn').disabled = false;
    document.getElementById('hold-info').textContent = '';
    if (countdownInterval) clearInterval(countdownInterval);
    
    const seats = await fetchSeats();
    renderSeats(seats);
  } catch (err) {
    showMessage(err.message, true);
    currentHold = null;
    document.getElementById('confirm-btn').disabled = true;
    document.getElementById('release-btn').disabled = true;
    document.getElementById('hold-btn').disabled = false;
    refreshSeats();
  }
}

async function handleRelease() {
  if (!currentHold) return;
  
  try {
    await releaseHold(currentHold.holdId);
    showMessage('Hold released');
    currentHold = null;
    document.getElementById('confirm-btn').disabled = true;
    document.getElementById('release-btn').disabled = true;
    document.getElementById('hold-btn').disabled = false;
    document.getElementById('hold-info').textContent = '';
    if (countdownInterval) clearInterval(countdownInterval);
    
    const seats = await fetchSeats();
    renderSeats(seats);
  } catch (err) {
    showMessage(err.message, true);
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
      // Refresh seats on any update
      refreshSeats();
    }
  };
  
  eventSource.onerror = () => {
    console.log('SSE error, will reconnect...');
    setTimeout(connectSSE, 3000);
  };
}

function init() {
  document.getElementById('hold-btn').addEventListener('click', handleHold);
  document.getElementById('confirm-btn').addEventListener('click', handleConfirm);
  document.getElementById('release-btn').addEventListener('click', handleRelease);
  document.getElementById('refresh-btn').addEventListener('click', refreshSeats);
  
  // Initial load
  refreshSeats();
  
  // Connect to SSE
  connectSSE();
  
  // Periodic refresh as fallback
  setInterval(refreshSeats, 30000);
}

init();