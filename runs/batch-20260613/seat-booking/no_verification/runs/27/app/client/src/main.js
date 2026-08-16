const API_BASE = '/api';
let currentHold = null;
let selectedSeats = new Set();
let eventSource = null;
let seatsData = [];

async function fetchSeats() {
  const res = await fetch(`${API_BASE}/seats`);
  const data = await res.json();
  seatsData = data.seats;
  renderSeatMap();
  updateInventory();
  return data;
}

function updateInventory() {
  const available = seatsData.filter(s => s.status === 'available').length;
  const held = seatsData.filter(s => s.status === 'held').length;
  const booked = seatsData.filter(s => s.status === 'booked').length;
  document.getElementById('inventory').innerHTML = 
    `Available: ${available} | Held: ${held} | Booked: ${booked} | Total: ${seatsData.length}`;
}

function renderSeatMap() {
  const mapEl = document.getElementById('seat-map');
  mapEl.innerHTML = '';
  
  // Group by row
  const rows = {};
  seatsData.forEach(seat => {
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
      
      mapEl.appendChild(seatEl);
    });
  });
}

function toggleSeatSelection(seatId, seatEl) {
  if (currentHold) {
    showMessage('Please release or confirm your current hold first.', 'error');
    return;
  }
  
  if (selectedSeats.has(seatId)) {
    selectedSeats.delete(seatId);
    seatEl.classList.remove('selected');
  } else {
    selectedSeats.add(seatId);
    seatEl.classList.add('selected');
  }
  
  if (selectedSeats.size > 0) {
    document.getElementById('hold-panel').style.display = 'block';
    document.getElementById('hold-info').innerHTML = `Selected ${selectedSeats.size} seat(s). Click "Request Hold" to proceed.`;
    // Add a request hold button if not present
    if (!document.getElementById('request-hold-btn')) {
      const btn = document.createElement('button');
      btn.id = 'request-hold-btn';
      btn.textContent = 'Request Hold';
      btn.onclick = requestHold;
      document.getElementById('hold-panel').appendChild(btn);
    }
  } else {
    document.getElementById('hold-panel').style.display = 'none';
  }
}

async function requestHold() {
  if (selectedSeats.size === 0) return;
  
  const sessionId = getOrCreateSessionId();
  const seatIds = Array.from(selectedSeats);
  
  try {
    const res = await fetch(`${API_BASE}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId })
    });
    
    if (res.status === 409) {
      const err = await res.json();
      showMessage(`Some seats are unavailable: ${err.conflictingSeats.join(', ')}`, 'error');
      selectedSeats.clear();
      await fetchSeats();
      return;
    }
    
    if (!res.ok) {
      const err = await res.json();
      showMessage(err.error || 'Failed to acquire hold', 'error');
      return;
    }
    
    const hold = await res.json();
    currentHold = hold;
    selectedSeats.clear();
    
    document.getElementById('hold-panel').style.display = 'block';
    document.getElementById('hold-info').innerHTML = `Hold acquired! Hold ID: ${hold.holdId}. Expires in ${hold.ttlSeconds}s.`;
    
    // Remove request button
    const reqBtn = document.getElementById('request-hold-btn');
    if (reqBtn) reqBtn.remove();
    
    startCountdown(hold.expiresAt);
    await fetchSeats();
    
  } catch (e) {
    showMessage('Network error: ' + e.message, 'error');
  }
}

function getOrCreateSessionId() {
  let sid = localStorage.getItem('sessionId');
  if (!sid) {
    sid = 'sess_' + Math.random().toString(36).substr(2, 9);
    localStorage.setItem('sessionId', sid);
  }
  return sid;
}

let countdownInterval = null;

function startCountdown(expiresAt) {
  const countdownEl = document.getElementById('countdown');
  if (countdownInterval) clearInterval(countdownInterval);
  
  countdownInterval = setInterval(() => {
    const now = Date.now();
    const exp = new Date(expiresAt).getTime();
    const remaining = Math.max(0, Math.floor((exp - now) / 1000));
    
    countdownEl.innerHTML = `Time remaining: ${remaining}s`;
    
    if (remaining <= 0) {
      clearInterval(countdownInterval);
      showMessage('Hold expired!', 'error');
      releaseCurrentHoldUI();
    }
  }, 1000);
}

function releaseCurrentHoldUI() {
  currentHold = null;
  document.getElementById('hold-panel').style.display = 'none';
  document.getElementById('countdown').innerHTML = '';
  if (countdownInterval) clearInterval(countdownInterval);
  fetchSeats();
}

async function confirmHold() {
  if (!currentHold) return;
  
  try {
    const res = await fetch(`${API_BASE}/holds/${currentHold.holdId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    
    if (!res.ok) {
      const err = await res.json();
      showMessage(err.error || 'Confirmation failed', 'error');
      if (err.expired) {
        releaseCurrentHoldUI();
      }
      return;
    }
    
    const result = await res.json();
    showMessage(`Booking confirmed! Seats: ${result.seatIds.join(', ')}`, 'success');
    currentHold = null;
    document.getElementById('hold-panel').style.display = 'none';
    if (countdownInterval) clearInterval(countdownInterval);
    await fetchSeats();
    
  } catch (e) {
    showMessage('Error confirming: ' + e.message, 'error');
  }
}

async function releaseHold() {
  if (!currentHold) return;
  
  try {
    await fetch(`${API_BASE}/holds/${currentHold.holdId}`, {
      method: 'DELETE'
    });
    showMessage('Hold released.', 'success');
    releaseCurrentHoldUI();
  } catch (e) {
    showMessage('Release error: ' + e.message, 'error');
  }
}

function showMessage(msg, type = 'info') {
  const msgEl = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = type;
  div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  msgEl.appendChild(div);
  setTimeout(() => div.remove(), 5000);
}

function connectSSE() {
  if (eventSource) eventSource.close();
  
  eventSource = new EventSource(`${API_BASE}/stream`);
  
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
    } else if (data.type === 'seats-refresh') {
      fetchSeats();
    }
  };
  
  eventSource.onerror = () => {
    console.log('SSE error, will reconnect...');
    setTimeout(connectSSE, 3000);
  };
}

function setupHoldPanelButtons() {
  const confirmBtn = document.getElementById('confirm-btn');
  const releaseBtn = document.getElementById('release-btn');
  
  confirmBtn.onclick = confirmHold;
  releaseBtn.onclick = releaseHold;
}

async function init() {
  setupHoldPanelButtons();
  await fetchSeats();
  connectSSE();
  document.getElementById('status').innerHTML = 'Connected. Select available seats to hold.';
  
  // Periodic refresh as fallback
  setInterval(() => {
    if (!currentHold) fetchSeats();
  }, 30000);
}

init();