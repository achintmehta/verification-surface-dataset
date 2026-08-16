const API_BASE = '/api';

let currentHold = null;
let selectedSeats = new Set();
let seatMap = new Map(); // id -> seat element
let sessionId = 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

// Fetch and render seats
async function fetchAndRenderSeats() {
  try {
    const response = await fetch(`${API_BASE}/seats`);
    const data = await response.json();
    
    renderSeatMap(data.seats);
    updateInventory(data.inventory);
  } catch (error) {
    console.error('Failed to fetch seats:', error);
    showMessage('Failed to load seat map', true);
  }
}

// Render the seat grid
function renderSeatMap(seats) {
  const container = document.getElementById('seat-map');
  container.innerHTML = '';
  seatMap.clear();
  selectedSeats.clear();
  updateControls();
  
  // Group by row
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
      seatEl.dataset.id = seat.id;
      seatEl.dataset.status = seat.status;
      
      seatEl.addEventListener('click', () => handleSeatClick(seatEl, seat));
      
      container.appendChild(seatEl);
      seatMap.set(seat.id, seatEl);
    });
  });
}

// Update inventory counts
function updateInventory(inventory) {
  document.getElementById('available-count').textContent = inventory.available;
  document.getElementById('held-count').textContent = inventory.held;
  document.getElementById('booked-count').textContent = inventory.booked;
}

// Handle seat click
function handleSeatClick(seatEl, seatData) {
  const status = seatEl.dataset.status;
  
  if (status === 'booked') {
    showMessage('This seat is already booked', true);
    return;
  }
  
  if (status === 'held' && !currentHold) {
    showMessage('This seat is held by someone else', true);
    return;
  }
  
  if (currentHold) {
    // If we have a hold, only allow selecting our held seats? But for simplicity, prevent new selections
    showMessage('Please confirm or release current hold first', true);
    return;
  }
  
  if (status === 'available') {
    if (selectedSeats.has(seatData.id)) {
      selectedSeats.delete(seatData.id);
      seatEl.classList.remove('selected');
    } else {
      selectedSeats.add(seatData.id);
      seatEl.classList.add('selected');
    }
    updateControls();
  }
}

// Update button states
function updateControls() {
  const holdBtn = document.getElementById('hold-btn');
  const confirmBtn = document.getElementById('confirm-btn');
  const releaseBtn = document.getElementById('release-btn');
  
  holdBtn.disabled = selectedSeats.size === 0 || !!currentHold;
  confirmBtn.disabled = !currentHold;
  releaseBtn.disabled = !currentHold;
}

// Request hold
async function requestHold() {
  if (selectedSeats.size === 0) return;
  
  const seatIds = Array.from(selectedSeats);
  const messageEl = document.getElementById('message');
  
  try {
    const response = await fetch(`${API_BASE}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId })
    });
    
    if (response.status === 409) {
      const data = await response.json();
      showMessage(`Some seats taken: ${data.conflictingSeats.join(', ')}`, true);
      selectedSeats.clear();
      await fetchAndRenderSeats();
      return;
    }
    
    if (!response.ok) {
      throw new Error('Hold request failed');
    }
    
    const holdData = await response.json();
    currentHold = holdData;
    
    // Update UI for held seats
    seatIds.forEach(id => {
      const el = seatMap.get(id);
      if (el) {
        el.classList.remove('selected', 'available');
        el.classList.add('held');
        el.dataset.status = 'held';
      }
    });
    
    selectedSeats.clear();
    updateControls();
    
    // Show countdown
    startHoldCountdown(holdData);
    showMessage(`Hold acquired for ${seatIds.length} seat(s). Expires in 2 minutes.`, false);
    
  } catch (error) {
    console.error('Hold error:', error);
    showMessage('Failed to acquire hold', true);
  }
}

// Start countdown timer for hold
function startHoldCountdown(holdData) {
  const infoEl = document.getElementById('hold-info');
  const expiresAt = new Date(holdData.expiresAt);
  
  const interval = setInterval(() => {
    const now = new Date();
    const remaining = Math.max(0, Math.floor((expiresAt - now) / 1000));
    
    if (remaining <= 0 || !currentHold) {
      clearInterval(interval);
      infoEl.textContent = '';
      if (currentHold) {
        // Hold expired on client side
        currentHold = null;
        updateControls();
        fetchAndRenderSeats();
      }
      return;
    }
    
    infoEl.textContent = `Hold expires in: ${Math.floor(remaining / 60)}:${(remaining % 60).toString().padStart(2, '0')}`;
  }, 1000);
}

// Confirm hold
async function confirmHold() {
  if (!currentHold) return;
  
  try {
    const response = await fetch(`${API_BASE}/holds/${currentHold.holdId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    });
    
    if (!response.ok) {
      const data = await response.json();
      showMessage(data.error || 'Confirmation failed', true);
      currentHold = null;
      await fetchAndRenderSeats();
      return;
    }
    
    const result = await response.json();
    showMessage(`Successfully booked seats: ${result.seatIds.join(', ')}`, false);
    
    // Update UI
    result.seatIds.forEach(id => {
      const el = seatMap.get(id);
      if (el) {
        el.classList.remove('held');
        el.classList.add('booked');
        el.dataset.status = 'booked';
      }
    });
    
    currentHold = null;
    document.getElementById('hold-info').textContent = '';
    updateControls();
    
    // Refresh inventory
    await fetchAndRenderSeats();
    
  } catch (error) {
    console.error('Confirm error:', error);
    showMessage('Confirmation failed', true);
  }
}

// Release hold early
async function releaseHold() {
  if (!currentHold) return;
  
  try {
    const response = await fetch(`${API_BASE}/holds/${currentHold.holdId}`, {
      method: 'DELETE'
    });
    
    if (response.ok) {
      showMessage('Hold released', false);
      currentHold = null;
      document.getElementById('hold-info').textContent = '';
      
      // Refresh to get accurate state
      await fetchAndRenderSeats();
    }
  } catch (error) {
    console.error('Release error:', error);
  }
}

// Show message
function showMessage(msg, isError = false) {
  const el = document.getElementById('message');
  el.textContent = msg;
  el.style.color = isError ? 'red' : 'green';
  
  setTimeout(() => {
    if (el.textContent === msg) el.textContent = '';
  }, 5000);
}

// Connect to SSE for real-time updates
function connectSSE() {
  const eventSource = new EventSource(`${API_BASE}/stream`);
  
  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      
      if (data.type === 'connected') return;
      
      if (data.seatIds && data.status) {
        data.seatIds.forEach(id => {
          const el = seatMap.get(id);
          if (el) {
            // Update class
            el.classList.remove('available', 'held', 'booked', 'selected');
            el.classList.add(data.status);
            el.dataset.status = data.status;
            
            // If this was our hold and someone else booked/released, clear it
            if (currentHold && currentHold.seatIds && currentHold.seatIds.includes(id) && data.status !== 'held') {
              currentHold = null;
              document.getElementById('hold-info').textContent = '';
              updateControls();
            }
          }
        });
        
        // Refresh inventory counts
        fetchAndRenderSeats();
      }
    } catch (e) {
      console.error('SSE parse error:', e);
    }
  };
  
  eventSource.onerror = () => {
    console.log('SSE connection error, will retry...');
    setTimeout(connectSSE, 5000);
  };
  
  return eventSource;
}

// Initialize
function init() {
  // Wire up buttons
  document.getElementById('hold-btn').addEventListener('click', requestHold);
  document.getElementById('confirm-btn').addEventListener('click', confirmHold);
  document.getElementById('release-btn').addEventListener('click', releaseHold);
  
  // Initial load
  fetchAndRenderSeats();
  
  // Connect SSE
  connectSSE();
  
  // Periodic refresh as fallback (every 30s)
  setInterval(fetchAndRenderSeats, 30000);
  
  console.log('Seat booking app initialized. Session:', sessionId);
}

init();