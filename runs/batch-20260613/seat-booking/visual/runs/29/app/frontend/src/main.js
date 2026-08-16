const API_BASE = 'http://localhost:3000/api';
const SESSION_ID = 'session_' + Math.random().toString(36).substr(2, 9);

let selectedSeats = new Set();
let currentHold = null;
let countdownInterval = null;
let seatsData = [];

// Fetch and render seats
async function fetchSeats() {
  try {
    const res = await fetch(`${API_BASE}/seats`);
    seatsData = await res.json();
    renderSeatMap();
    updateInventory();
  } catch (e) {
    showMessage('Failed to fetch seats', 'error');
  }
}

// Render the seat map
function renderSeatMap() {
  const container = document.getElementById('seat-map');
  container.innerHTML = '';
  
  const rows = {};
  seatsData.forEach(seat => {
    if (!rows[seat.row_label]) rows[seat.row_label] = [];
    rows[seat.row_label].push(seat);
  });
  
  Object.keys(rows).sort().forEach(rowLabel => {
    const rowDiv = document.createElement('div');
    rowDiv.className = 'row';
    
    const label = document.createElement('div');
    label.className = 'row-label';
    label.textContent = rowLabel;
    rowDiv.appendChild(label);
    
    rows[rowLabel].sort((a, b) => a.seat_number - b.seat_number).forEach(seat => {
      const seatEl = document.createElement('div');
      seatEl.className = `seat ${seat.status}`;
      seatEl.textContent = seat.seat_number;
      seatEl.dataset.id = seat.id;
      seatEl.dataset.status = seat.status;
      
      // Selection logic
      if (seat.status === 'available') {
        seatEl.addEventListener('click', () => toggleSeatSelection(seat.id, seatEl));
      }
      
      // Highlight selected
      if (selectedSeats.has(seat.id)) {
        seatEl.classList.add('selected');
        seatEl.classList.remove(seat.status);
      }
      
      rowDiv.appendChild(seatEl);
    });
    
    container.appendChild(rowDiv);
  });
  
  updateButtons();
}

// Toggle seat selection
function toggleSeatSelection(seatId, seatEl) {
  if (currentHold) return; // Can't select while holding
  
  if (selectedSeats.has(seatId)) {
    selectedSeats.delete(seatId);
    seatEl.classList.remove('selected');
    seatEl.classList.add('available');
  } else {
    selectedSeats.add(seatId);
    seatEl.classList.add('selected');
    seatEl.classList.remove('available');
  }
  
  updateButtons();
}

// Update button states
function updateButtons() {
  const holdBtn = document.getElementById('hold-btn');
  const confirmBtn = document.getElementById('confirm-btn');
  const releaseBtn = document.getElementById('release-btn');
  
  holdBtn.disabled = selectedSeats.size === 0 || !!currentHold;
  confirmBtn.disabled = !currentHold;
  releaseBtn.disabled = !currentHold;
}

// Update inventory counts
function updateInventory() {
  const available = seatsData.filter(s => s.status === 'available').length;
  const held = seatsData.filter(s => s.status === 'held').length;
  const booked = seatsData.filter(s => s.status === 'booked').length;
  const total = seatsData.length;
  
  document.getElementById('inventory').innerHTML = `
    <strong>Inventory:</strong> 
    Available: ${available} | Held: ${held} | Booked: ${booked} | Total: ${total}
    ${available + held + booked === total ? '✅ Balanced' : '⚠️ Mismatch!'}
  `;
}

// Create hold
async function createHold() {
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
      showMessage(`Some seats taken: ${data.conflictingSeats.join(', ')}`, 'error');
      await fetchSeats();
      selectedSeats.clear();
      renderSeatMap();
      return;
    }
    
    if (!res.ok) {
      const err = await res.json();
      showMessage(err.error || 'Failed to hold seats', 'error');
      return;
    }
    
    const holdData = await res.json();
    currentHold = holdData;
    selectedSeats.clear();
    
    showHoldInfo(holdData);
    await fetchSeats();
    startCountdown(holdData.expiresAt);
    
    showMessage(`Hold created! Expires at ${new Date(holdData.expiresAt).toLocaleTimeString()}`, 'success');
    
  } catch (e) {
    showMessage('Network error creating hold', 'error');
  }
}

// Confirm booking
async function confirmBooking() {
  if (!currentHold) return;
  
  try {
    const res = await fetch(`${API_BASE}/holds/${currentHold.holdId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID })
    });
    
    if (!res.ok) {
      const err = await res.json();
      showMessage(err.error || 'Confirmation failed', 'error');
      if (res.status === 410) {
        // Expired
        clearCurrentHold();
        await fetchSeats();
      }
      return;
    }
    
    const data = await res.json();
    showMessage('Booking confirmed! Seats are yours.', 'success');
    clearCurrentHold();
    await fetchSeats();
    
  } catch (e) {
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
    
    if (res.ok) {
      showMessage('Hold released', 'success');
      clearCurrentHold();
      await fetchSeats();
    }
  } catch (e) {
    showMessage('Failed to release', 'error');
  }
}

// Show hold info with countdown
function showHoldInfo(holdData) {
  const infoDiv = document.getElementById('hold-info');
  infoDiv.style.display = 'block';
  document.getElementById('hold-id').textContent = holdData.holdId;
}

// Start countdown timer
function startCountdown(expiresAt) {
  if (countdownInterval) clearInterval(countdownInterval);
  
  countdownInterval = setInterval(() => {
    const remaining = new Date(expiresAt) - new Date();
    
    if (remaining <= 0) {
      clearInterval(countdownInterval);
      document.getElementById('countdown').textContent = 'EXPIRED';
      showMessage('Hold expired!', 'error');
      setTimeout(() => {
        clearCurrentHold();
        fetchSeats();
      }, 1000);
      return;
    }
    
    const minutes = Math.floor(remaining / 60000);
    const seconds = Math.floor((remaining % 60000) / 1000);
    document.getElementById('countdown').textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }, 1000);
}

// Clear current hold state
function clearCurrentHold() {
  currentHold = null;
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
  document.getElementById('hold-info').style.display = 'none';
  document.getElementById('countdown').textContent = '';
  updateButtons();
}

// Show message
function showMessage(msg, type = 'info') {
  const container = document.getElementById('messages');
  const div = document.createElement('div');
  div.style.cssText = `padding:8px;margin:5px 0;border-radius:4px;background:${type === 'error' ? '#ffebee' : '#e8f5e9'};color:${type === 'error' ? '#c62828' : '#2e7d32'}`;
  div.textContent = msg;
  container.appendChild(div);
  setTimeout(() => div.remove(), 4000);
}

// Connect to SSE
function connectSSE() {
  const eventSource = new EventSource(`${API_BASE}/stream`);
  
  eventSource.addEventListener('connected', () => {
    console.log('SSE connected');
  });
  
  eventSource.addEventListener('seats-updated', (event) => {
    const data = JSON.parse(event.data);
    console.log('Seat update:', data);
    
    // Refresh seat map on any update
    fetchSeats();
    
    if (data.action === 'booked' || data.action === 'released') {
      if (currentHold && data.holdId === currentHold.holdId) {
        // Our hold was affected externally? unlikely but handle
      }
    }
  });
  
  eventSource.onerror = () => {
    console.log('SSE error, will reconnect...');
    setTimeout(connectSSE, 3000);
  };
}

// Event listeners
function setupListeners() {
  document.getElementById('hold-btn').addEventListener('click', createHold);
  document.getElementById('confirm-btn').addEventListener('click', confirmBooking);
  document.getElementById('release-btn').addEventListener('click', releaseHold);
  document.getElementById('refresh-btn').addEventListener('click', fetchSeats);
  
  // Keyboard support
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && currentHold) {
      releaseHold();
    }
  });
}

// Initialize app
async function init() {
  setupListeners();
  await fetchSeats();
  connectSSE();
  
  // Periodic refresh as fallback
  setInterval(fetchSeats, 30000);
  
  showMessage('Connected to live seat booking system', 'success');
}

init();