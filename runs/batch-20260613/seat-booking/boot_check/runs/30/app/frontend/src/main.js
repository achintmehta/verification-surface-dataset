const API_BASE = 'http://localhost:3001';
const SESSION_ID = 'session_' + Math.random().toString(36).substr(2, 9);

let seats = [];
let selectedSeats = new Set();
let currentHold = null;
let countdownInterval = null;
let eventSource = null;

// Render inventory counts
function updateInventory() {
  const available = seats.filter(s => s.status === 'available').length;
  const held = seats.filter(s => s.status === 'held').length;
  const booked = seats.filter(s => s.status === 'booked').length;
  
  const inv = document.getElementById('inventory');
  inv.innerHTML = `
    <span class="count">Available: ${available}</span>
    <span class="count">Held: ${held}</span>
    <span class="count">Booked: ${booked}</span>
    <span class="count">Total: ${seats.length}</span>
  `;
}

// Render seat map
function renderSeatMap() {
  const map = document.getElementById('seat-map');
  map.innerHTML = '';
  
  // Group by row
  const rows = {};
  seats.forEach(seat => {
    if (!rows[seat.row_label]) rows[seat.row_label] = [];
    rows[seat.row_label].push(seat);
  });
  
  Object.keys(rows).sort().forEach(rowLabel => {
    // Row label
    const label = document.createElement('div');
    label.className = 'seat row-label';
    label.textContent = rowLabel;
    map.appendChild(label);
    
    rows[rowLabel].sort((a, b) => a.seat_number - b.seat_number).forEach(seat => {
      const el = document.createElement('div');
      el.className = `seat ${seat.status}`;
      el.textContent = seat.seat_number;
      el.dataset.id = seat.id;
      
      if (seat.status === 'available') {
        el.addEventListener('click', () => toggleSelect(seat.id, el));
      }
      
      if (currentHold && currentHold.seats.some(s => s.id === seat.id)) {
        el.classList.add('selected');
      }
      
      map.appendChild(el);
    });
  });
  
  updateInventory();
}

// Toggle seat selection
function toggleSelect(seatId, el) {
  if (currentHold) return; // Can't select while holding
  
  if (selectedSeats.has(seatId)) {
    selectedSeats.delete(seatId);
    el.classList.remove('selected');
  } else {
    selectedSeats.add(seatId);
    el.classList.add('selected');
  }
  
  document.getElementById('hold-btn').disabled = selectedSeats.size === 0;
}

// Show message
function showMessage(msg, isError = false) {
  const container = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = 'message';
  div.style.color = isError ? '#dc2626' : '#166534';
  div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  container.prepend(div);
  
  // Keep only last 5
  while (container.children.length > 5) {
    container.removeChild(container.lastChild);
  }
}

// Fetch seats
async function fetchSeats() {
  try {
    const res = await fetch(`${API_BASE}/api/seats`);
    const data = await res.json();
    seats = data.seats;
    renderSeatMap();
    document.getElementById('status').textContent = 'Connected';
  } catch (e) {
    document.getElementById('status').textContent = 'Connection error';
    showMessage('Failed to fetch seats', true);
  }
}

// Request hold
async function requestHold() {
  if (selectedSeats.size === 0) return;
  
  const seatIds = Array.from(selectedSeats);
  
  try {
    const res = await fetch(`${API_BASE}/api/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId: SESSION_ID })
    });
    
    if (res.status === 409) {
      const data = await res.json();
      showMessage(`Hold failed. Seats already taken: ${data.conflicts.join(', ')}`, true);
      selectedSeats.clear();
      await fetchSeats();
      return;
    }
    
    if (!res.ok) throw new Error('Hold request failed');
    
    const data = await res.json();
    currentHold = { holdId: data.holdId, expiresAt: data.expiresAt, seats: data.seats };
    
    // Clear selection
    selectedSeats.clear();
    document.getElementById('hold-btn').disabled = true;
    document.getElementById('confirm-btn').disabled = false;
    document.getElementById('release-btn').disabled = false;
    
    startCountdown();
    await fetchSeats();
    showMessage(`Hold created for ${seatIds.length} seats. Expires in 2 minutes.`);
  } catch (e) {
    showMessage('Failed to create hold: ' + e.message, true);
  }
}

// Confirm hold
async function confirmCurrentHold() {
  if (!currentHold) return;
  
  try {
    const res = await fetch(`${API_BASE}/api/holds/${currentHold.holdId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID })
    });
    
    if (!res.ok) {
      const data = await res.json();
      showMessage(`Confirm failed: ${data.error}`, true);
      await releaseCurrentHold();
      return;
    }
    
    const data = await res.json();
    showMessage(data.alreadyConfirmed ? 'Already confirmed (idempotent)' : 'Booking confirmed!');
    
    stopCountdown();
    currentHold = null;
    document.getElementById('confirm-btn').disabled = true;
    document.getElementById('release-btn').disabled = true;
    
    await fetchSeats();
  } catch (e) {
    showMessage('Confirm error: ' + e.message, true);
  }
}

// Release hold
async function releaseCurrentHold() {
  if (!currentHold) return;
  
  try {
    await fetch(`${API_BASE}/api/holds/${currentHold.holdId}`, { method: 'DELETE' });
    showMessage('Hold released');
  } catch (e) {}
  
  stopCountdown();
  currentHold = null;
  document.getElementById('confirm-btn').disabled = true;
  document.getElementById('release-btn').disabled = true;
  await fetchSeats();
}

// Countdown timer
function startCountdown() {
  const info = document.getElementById('hold-info');
  stopCountdown();
  
  countdownInterval = setInterval(() => {
    if (!currentHold) {
      stopCountdown();
      return;
    }
    
    const remaining = new Date(currentHold.expiresAt) - new Date();
    if (remaining <= 0) {
      info.textContent = 'Hold expired!';
      stopCountdown();
      currentHold = null;
      document.getElementById('confirm-btn').disabled = true;
      document.getElementById('release-btn').disabled = true;
      fetchSeats();
    } else {
      const secs = Math.floor(remaining / 1000);
      info.textContent = `Hold active: ${Math.floor(secs / 60)}:${(secs % 60).toString().padStart(2, '0')} remaining`;
    }
  }, 1000);
}

function stopCountdown() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
  document.getElementById('hold-info').textContent = '';
}

// Connect to SSE
function connectSSE() {
  if (eventSource) eventSource.close();
  
  eventSource = new EventSource(`${API_BASE}/api/stream`);
  
  eventSource.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'seat_update' && msg.seat) {
        // Update local seat
        const idx = seats.findIndex(s => s.id === msg.seat.id);
        if (idx !== -1) {
          seats[idx] = msg.seat;
          renderSeatMap();
        } else {
          fetchSeats();
        }
      }
    } catch (e) {}
  };
  
  eventSource.onerror = () => {
    // Reconnect logic simple
    setTimeout(connectSSE, 3000);
  };
}

// Setup event listeners
function setupListeners() {
  document.getElementById('hold-btn').addEventListener('click', requestHold);
  document.getElementById('confirm-btn').addEventListener('click', confirmCurrentHold);
  document.getElementById('release-btn').addEventListener('click', releaseCurrentHold);
  
  // Keyboard support
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && currentHold) {
      releaseCurrentHold();
    }
  });
}

// Initialize
async function init() {
  document.getElementById('status').textContent = 'Connecting...';
  
  setupListeners();
  await fetchSeats();
  connectSSE();
  
  // Refresh seats periodically as fallback
  setInterval(fetchSeats, 30000);
  
  showMessage('Welcome! Select available seats to hold.');
}

init();