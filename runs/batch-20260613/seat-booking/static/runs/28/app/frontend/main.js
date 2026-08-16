const API_BASE = '/api';
const SSE_URL = '/api/stream';

let seats = [];
let selectedSeats = new Set();
let currentHold = null;
let holdTimer = null;
let eventSource = null;

const seatMapEl = document.getElementById('seat-map');
const statusEl = document.getElementById('status');
const inventoryEl = document.getElementById('inventory');
const holdBtn = document.getElementById('hold-btn');
const confirmBtn = document.getElementById('confirm-btn');
const releaseBtn = document.getElementById('release-btn');
const holdInfoEl = document.getElementById('hold-info');
const messagesEl = document.getElementById('messages');

function showMessage(text, type = 'success') {
  const msg = document.createElement('div');
  msg.className = `message ${type}`;
  msg.textContent = text;
  messagesEl.appendChild(msg);
  setTimeout(() => msg.remove(), 5000);
}

async function fetchSeats() {
  try {
    const res = await fetch(`${API_BASE}/seats`);
    if (!res.ok) throw new Error('Failed to fetch seats');
    seats = await res.json();
    renderSeatMap();
    updateInventory();
    statusEl.textContent = 'Seat map loaded';
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
    <div class="inventory-item inventory-available">Available: ${available}</div>
    <div class="inventory-item inventory-held">Held: ${held}</div>
    <div class="inventory-item inventory-booked">Booked: ${booked}</div>
    <div>Total: ${seats.length}</div>
  `;
}

function renderSeatMap() {
  seatMapEl.innerHTML = '';
  
  // Group by row
  const rows = {};
  seats.forEach(seat => {
    if (!rows[seat.row_label]) rows[seat.row_label] = [];
    rows[seat.row_label].push(seat);
  });
  
  // Sort rows and seats
  const sortedRows = Object.keys(rows).sort();
  
  sortedRows.forEach(rowLabel => {
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
    showMessage('Release current hold before selecting new seats', 'error');
    return;
  }
  
  if (selectedSeats.has(seatId)) {
    selectedSeats.delete(seatId);
    seatEl.classList.remove('selected');
  } else {
    selectedSeats.add(seatId);
    seatEl.classList.add('selected');
  }
  
  holdBtn.disabled = selectedSeats.size === 0;
}

function updateButtons() {
  holdBtn.disabled = selectedSeats.size === 0 || !!currentHold;
  confirmBtn.disabled = !currentHold;
  releaseBtn.disabled = !currentHold;
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
      showMessage(`Some seats unavailable: ${data.conflictingSeats.join(', ')}`, 'error');
      selectedSeats.clear();
      await fetchSeats();
      return;
    }
    
    if (!res.ok) throw new Error('Hold request failed');
    
    currentHold = await res.json();
    selectedSeats.clear();
    showMessage(`Hold acquired! Expires in ${Math.floor(currentHold.ttl / 1000)}s`, 'success');
    startHoldCountdown();
    await fetchSeats();
    updateButtons();
  } catch (err) {
    showMessage(err.message, 'error');
    await fetchSeats();
  }
}

function getSessionId() {
  let sessionId = localStorage.getItem('sessionId');
  if (!sessionId) {
    sessionId = 'sess_' + Math.random().toString(36).substr(2, 9);
    localStorage.setItem('sessionId', sessionId);
  }
  return sessionId;
}

function startHoldCountdown() {
  if (holdTimer) clearInterval(holdTimer);
  
  holdInfoEl.style.display = 'block';
  
  holdTimer = setInterval(() => {
    if (!currentHold) {
      clearInterval(holdTimer);
      holdInfoEl.style.display = 'none';
      return;
    }
    
    const remaining = Math.max(0, new Date(currentHold.expires_at).getTime() - Date.now());
    const seconds = Math.floor(remaining / 1000);
    
    holdInfoEl.innerHTML = `
      Hold ID: ${currentHold.id}<br>
      Seats: ${currentHold.seatIds.join(', ')}<br>
      Time left: ${seconds}s
    `;
    
    if (remaining <= 0) {
      clearInterval(holdTimer);
      showMessage('Hold expired', 'error');
      currentHold = null;
      holdInfoEl.style.display = 'none';
      fetchSeats();
      updateButtons();
    }
  }, 1000);
}

async function confirmHold() {
  if (!currentHold) return;
  
  try {
    const res = await fetch(`${API_BASE}/holds/${currentHold.id}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: getSessionId() })
    });
    
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Confirmation failed');
    }
    
    const result = await res.json();
    showMessage(`Booking confirmed! Seats: ${result.seatIds.join(', ')}`, 'success');
    
    currentHold = null;
    if (holdTimer) clearInterval(holdTimer);
    holdInfoEl.style.display = 'none';
    
    await fetchSeats();
    updateButtons();
  } catch (err) {
    showMessage(err.message, 'error');
    await fetchSeats();
  }
}

async function releaseHold() {
  if (!currentHold) return;
  
  try {
    const res = await fetch(`${API_BASE}/holds/${currentHold.id}`, {
      method: 'DELETE'
    });
    
    if (!res.ok) throw new Error('Release failed');
    
    showMessage('Hold released', 'success');
    currentHold = null;
    if (holdTimer) clearInterval(holdTimer);
    holdInfoEl.style.display = 'none';
    
    await fetchSeats();
    updateButtons();
  } catch (err) {
    showMessage(err.message, 'error');
  }
}

function connectSSE() {
  if (eventSource) eventSource.close();
  
  eventSource = new EventSource(SSE_URL);
  
  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'seat-update') {
        // Update local seats state
        const updatedSeat = data.seat;
        const idx = seats.findIndex(s => s.id === updatedSeat.id);
        if (idx !== -1) {
          seats[idx] = { ...seats[idx], ...updatedSeat };
        }
        renderSeatMap();
        updateInventory();
      } else if (data.type === 'seats-reset') {
        fetchSeats();
      }
    } catch (e) {
      console.error('SSE parse error', e);
    }
  };
  
  eventSource.onerror = () => {
    console.log('SSE connection error, will retry...');
    setTimeout(connectSSE, 3000);
  };
  
  eventSource.onopen = () => {
    console.log('SSE connected');
  };
}

function setupEventListeners() {
  holdBtn.addEventListener('click', requestHold);
  confirmBtn.addEventListener('click', confirmHold);
  releaseBtn.addEventListener('click', releaseHold);
  
  // Allow clicking booked/held to show info
  seatMapEl.addEventListener('click', (e) => {
    if (e.target.classList.contains('booked') || e.target.classList.contains('held')) {
      const seatId = e.target.dataset.seatId;
      const seat = seats.find(s => s.id === seatId);
      if (seat) {
        showMessage(`Seat ${seat.row_label}${seat.seat_number} is ${seat.status}`, 'success');
      }
    }
  });
}

async function init() {
  setupEventListeners();
  await fetchSeats();
  connectSSE();
  
  // Periodic refresh as fallback
  setInterval(fetchSeats, 30000);
  
  statusEl.textContent = 'Ready - Click available seats to select';
}

init();
