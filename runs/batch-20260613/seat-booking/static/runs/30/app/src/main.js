const API_BASE = '/api';
let selectedSeats = new Set();
let currentHold = null;
let eventSource = null;
let seatsData = [];

async function fetchSeats() {
  try {
    const res = await fetch(`${API_BASE}/seats`);
    const data = await res.json();
    seatsData = data.seats;
    renderSeatMap();
    updateStatus();
  } catch (err) {
    showError('Failed to fetch seats: ' + err.message);
  }
}

function renderSeatMap() {
  const container = document.getElementById('seat-map');
  container.innerHTML = '';
  
  // Group by row
  const rows = {};
  seatsData.forEach(seat => {
    if (!rows[seat.row]) rows[seat.row] = [];
    rows[seat.row].push(seat);
  });
  
  Object.keys(rows).sort().forEach(rowLabel => {
    const rowDiv = document.createElement('div');
    rowDiv.className = 'row';
    
    const label = document.createElement('div');
    label.className = 'row-label';
    label.textContent = rowLabel;
    rowDiv.appendChild(label);
    
    rows[rowLabel].sort((a, b) => a.number - b.number).forEach(seat => {
      const seatEl = document.createElement('div');
      seatEl.className = `seat ${seat.status}`;
      seatEl.textContent = seat.number;
      seatEl.dataset.id = seat.id;
      
      if (seat.status === 'available') {
        seatEl.addEventListener('click', () => toggleSeatSelection(seat.id, seatEl));
      }
      
      // Highlight if selected
      if (selectedSeats.has(seat.id)) {
        seatEl.classList.add('selected');
        seatEl.classList.remove(seat.status);
      }
      
      rowDiv.appendChild(seatEl);
    });
    
    container.appendChild(rowDiv);
  });
}

function toggleSeatSelection(seatId, seatEl) {
  if (currentHold) {
    showError('Release or confirm current hold first');
    return;
  }
  
  if (selectedSeats.has(seatId)) {
    selectedSeats.delete(seatId);
    seatEl.classList.remove('selected');
    seatEl.classList.add('available');
  } else {
    selectedSeats.add(seatId);
    seatEl.classList.add('selected');
    seatEl.classList.remove('available');
  }
  
  updateControls();
}

function updateControls() {
  const holdBtn = document.getElementById('hold-btn');
  const confirmBtn = document.getElementById('confirm-btn');
  const releaseBtn = document.getElementById('release-btn');
  
  holdBtn.disabled = selectedSeats.size === 0 || !!currentHold;
  confirmBtn.disabled = !currentHold;
  releaseBtn.disabled = !currentHold;
}

function updateStatus() {
  const statusEl = document.getElementById('status');
  const available = seatsData.filter(s => s.status === 'available').length;
  const held = seatsData.filter(s => s.status === 'held').length;
  const booked = seatsData.filter(s => s.status === 'booked').length;
  const total = seatsData.length;
  
  statusEl.innerHTML = `
    <strong>Inventory:</strong> 
    Available: ${available} | 
    Held: ${held} | 
    Booked: ${booked} | 
    Total: ${total} 
    ${available + held + booked === total ? '✓ Balanced' : '⚠ Mismatch!'}
  `;
}

function showError(msg) {
  const errorEl = document.getElementById('error');
  errorEl.textContent = msg;
  errorEl.style.display = 'block';
  setTimeout(() => {
    errorEl.style.display = 'none';
  }, 5000);
}

function showHoldInfo(hold) {
  const infoEl = document.getElementById('hold-info');
  const expiresAt = new Date(hold.expiresAt);
  
  infoEl.innerHTML = `
    <strong>Hold Active</strong> (Session: ${hold.sessionId || 'local'})<br>
    Seats: ${hold.seatIds.join(', ')}<br>
    <span class="countdown">Expires in: <span id="countdown">...</span></span>
  `;
  infoEl.style.display = 'block';
  
  // Countdown
  const countdownEl = document.getElementById('countdown');
  const interval = setInterval(() => {
    const remaining = Math.max(0, Math.floor((expiresAt - new Date()) / 1000));
    countdownEl.textContent = `${remaining}s`;
    if (remaining <= 0) {
      clearInterval(interval);
      infoEl.style.display = 'none';
      currentHold = null;
      selectedSeats.clear();
      fetchSeats();
    }
  }, 1000);
}

async function createHold() {
  if (selectedSeats.size === 0) return;
  
  const sessionId = localStorage.getItem('sessionId') || `session_${Date.now()}`;
  localStorage.setItem('sessionId', sessionId);
  
  const seatIds = Array.from(selectedSeats);
  
  try {
    const res = await fetch(`${API_BASE}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId })
    });
    
    if (res.status === 409) {
      const data = await res.json();
      showError(`Seats already taken: ${data.conflictingSeatIds.join(', ')}`);
      selectedSeats.clear();
      await fetchSeats();
      return;
    }
    
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to create hold');
    }
    
    const data = await res.json();
    currentHold = { ...data.hold, sessionId };
    selectedSeats.clear();
    
    document.getElementById('hold-info').style.display = 'block';
    showHoldInfo(currentHold);
    updateControls();
    await fetchSeats();
  } catch (err) {
    showError(err.message);
  }
}

async function confirmHold() {
  if (!currentHold) return;
  
  const sessionId = localStorage.getItem('sessionId');
  
  try {
    const res = await fetch(`${API_BASE}/holds/${currentHold.id}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    });
    
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Confirmation failed');
    }
    
    const data = await res.json();
    alert(`Booking confirmed! Seats: ${data.seatIds.join(', ')}`);
    
    currentHold = null;
    document.getElementById('hold-info').style.display = 'none';
    selectedSeats.clear();
    updateControls();
    await fetchSeats();
  } catch (err) {
    showError(err.message);
  }
}

async function releaseHold() {
  if (!currentHold) return;
  
  try {
    await fetch(`${API_BASE}/holds/${currentHold.id}`, { method: 'DELETE' });
    currentHold = null;
    document.getElementById('hold-info').style.display = 'none';
    selectedSeats.clear();
    updateControls();
    await fetchSeats();
  } catch (err) {
    showError(err.message);
  }
}

function connectSSE() {
  if (eventSource) eventSource.close();
  
  eventSource = new EventSource(`${API_BASE}/stream`);
  
  eventSource.addEventListener('seats-update', (e) => {
    const data = JSON.parse(e.data);
    seatsData = data.seats;
    renderSeatMap();
    updateStatus();
  });
  
  eventSource.addEventListener('seats-held', (e) => {
    const data = JSON.parse(e.data);
    // Update local state optimistically
    seatsData.forEach(seat => {
      if (data.seatIds.includes(seat.id)) {
        seat.status = 'held';
        seat.holdId = data.holdId;
        seat.expiresAt = data.expiresAt;
      }
    });
    renderSeatMap();
    updateStatus();
  });
  
  eventSource.addEventListener('seats-booked', (e) => {
    const data = JSON.parse(e.data);
    seatsData.forEach(seat => {
      if (data.seatIds.includes(seat.id)) {
        seat.status = 'booked';
        seat.bookedBy = data.bookedBy;
      }
    });
    renderSeatMap();
    updateStatus();
  });
  
  eventSource.addEventListener('seats-released', (e) => {
    const data = JSON.parse(e.data);
    seatsData.forEach(seat => {
      if (data.seatIds.includes(seat.id)) {
        seat.status = 'available';
        seat.holdId = null;
        seat.expiresAt = null;
      }
    });
    renderSeatMap();
    updateStatus();
  });
  
  eventSource.onerror = () => {
    console.log('SSE disconnected, will retry...');
  };
}

function init() {
  // Buttons
  document.getElementById('hold-btn').addEventListener('click', createHold);
  document.getElementById('confirm-btn').addEventListener('click', confirmHold);
  document.getElementById('release-btn').addEventListener('click', releaseHold);
  document.getElementById('refresh-btn').addEventListener('click', fetchSeats);
  
  // Initial load
  fetchSeats();
  connectSSE();
  
  // Periodic refresh as fallback
  setInterval(fetchSeats, 30000);
}

init();