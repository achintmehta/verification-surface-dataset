const API_BASE = '/api';
let sessionId = localStorage.getItem('sessionId') || '';
let currentHold = null;
let selectedSeats = new Set();
let eventSource = null;
let countdownInterval = null;

const seatMapEl = document.getElementById('seatMap');
const sessionInput = document.getElementById('sessionId');
const holdBtn = document.getElementById('holdBtn');
const confirmBtn = document.getElementById('confirmBtn');
const releaseBtn = document.getElementById('releaseBtn');
const refreshBtn = document.getElementById('refreshBtn');
const holdInfoEl = document.getElementById('holdInfo');
const holdIdEl = document.getElementById('holdId');
const countdownEl = document.getElementById('countdown');
const statusEl = document.getElementById('status');
const inventoryEl = document.getElementById('inventory');

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.className = isError ? 'status error' : 'status success';
  setTimeout(() => {
    if (statusEl.textContent === message) statusEl.textContent = '';
  }, 4000);
}

function updateSession() {
  sessionId = sessionInput.value.trim();
  if (sessionId) {
    localStorage.setItem('sessionId', sessionId);
    setStatus('Session ID set');
  }
}

function updateButtons() {
  const hasSelection = selectedSeats.size > 0;
  const hasHold = !!currentHold;
  
  holdBtn.disabled = !hasSelection || hasHold || !sessionId;
  confirmBtn.disabled = !hasHold;
  releaseBtn.disabled = !hasHold;
}

function updateInventory(seats) {
  const total = seats.length;
  let available = 0, held = 0, booked = 0;
  
  seats.forEach(seat => {
    if (seat.status === 'available') available++;
    else if (seat.status === 'held') held++;
    else if (seat.status === 'booked') booked++;
  });
  
  inventoryEl.innerHTML = `
    Total: ${total} | Available: ${available} | Held: ${held} | Booked: ${booked}
    <br>Inventory check: ${available + held + booked === total ? '✓ Balanced' : '✗ Mismatch'}
  `;
}

async function fetchSeats() {
  try {
    const res = await fetch(`${API_BASE}/seats`);
    if (!res.ok) throw new Error('Failed to fetch seats');
    const seats = await res.json();
    renderSeatMap(seats);
    updateInventory(seats);
    return seats;
  } catch (err) {
    setStatus('Error fetching seats: ' + err.message, true);
    return [];
  }
}

function renderSeatMap(seats) {
  seatMapEl.innerHTML = '';
  
  // Group by row
  const rows = {};
  seats.forEach(seat => {
    if (!rows[seat.row_label]) rows[seat.row_label] = [];
    rows[seat.row_label].push(seat);
  });
  
  const sortedRows = Object.keys(rows).sort();
  
  sortedRows.forEach(rowLabel => {
    const rowEl = document.createElement('div');
    rowEl.className = 'row';
    
    const label = document.createElement('div');
    label.className = 'row-label';
    label.textContent = rowLabel;
    rowEl.appendChild(label);
    
    rows[rowLabel]
      .sort((a, b) => a.seat_number - b.seat_number)
      .forEach(seat => {
        const seatEl = document.createElement('div');
        seatEl.className = `seat ${seat.status}`;
        seatEl.textContent = seat.seat_number;
        seatEl.dataset.seatId = seat.id;
        
        // Visual override for own holds
        if (seat.status === 'held' && seat.hold_id && currentHold && seat.hold_id === currentHold.id) {
          seatEl.classList.add('selected');
          seatEl.classList.remove('held');
        }
        
        if (seat.status === 'available') {
          seatEl.addEventListener('click', () => toggleSeatSelection(seat.id, seatEl));
        } else if (seat.status === 'held' && currentHold && seat.hold_id === currentHold.id) {
          seatEl.addEventListener('click', () => toggleSeatSelection(seat.id, seatEl));
        }
        
        rowEl.appendChild(seatEl);
      });
    
    seatMapEl.appendChild(rowEl);
  });
}

function toggleSeatSelection(seatId, seatEl) {
  if (currentHold) {
    // Can only deselect from own hold? But for simplicity allow reselect
    return;
  }
  
  if (selectedSeats.has(seatId)) {
    selectedSeats.delete(seatId);
    seatEl.classList.remove('selected');
    seatEl.classList.add('available');
  } else {
    selectedSeats.add(seatId);
    seatEl.classList.remove('available');
    seatEl.classList.add('selected');
  }
  
  updateButtons();
}

async function requestHold() {
  if (!sessionId || selectedSeats.size === 0) return;
  
  const seatIds = Array.from(selectedSeats);
  
  try {
    const res = await fetch(`${API_BASE}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId })
    });
    
    if (res.status === 409) {
      const data = await res.json();
      setStatus(`Some seats unavailable: ${data.conflictingSeats?.join(', ')}`, true);
      selectedSeats.clear();
      await fetchSeats();
      return;
    }
    
    if (!res.ok) throw new Error(await res.text());
    
    const hold = await res.json();
    currentHold = hold;
    selectedSeats.clear();
    
    holdIdEl.textContent = hold.id;
    holdInfoEl.style.display = 'block';
    startCountdown(hold.expires_at);
    
    setStatus('Hold acquired successfully');
    updateButtons();
    await fetchSeats();
  } catch (err) {
    setStatus('Hold failed: ' + err.message, true);
    await fetchSeats();
  }
}

async function confirmHold() {
  if (!currentHold) return;
  
  try {
    const res = await fetch(`${API_BASE}/holds/${currentHold.id}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    });
    
    if (!res.ok) {
      const err = await res.text();
      throw new Error(err);
    }
    
    const result = await res.json();
    setStatus('Booking confirmed! Seats booked.');
    
    stopCountdown();
    currentHold = null;
    holdInfoEl.style.display = 'none';
    updateButtons();
    await fetchSeats();
  } catch (err) {
    setStatus('Confirm failed: ' + err.message, true);
    // Refresh to see current state
    await fetchSeats();
  }
}

async function releaseHold() {
  if (!currentHold) return;
  
  try {
    const res = await fetch(`${API_BASE}/holds/${currentHold.id}`, {
      method: 'DELETE'
    });
    
    if (!res.ok) throw new Error(await res.text());
    
    setStatus('Hold released');
    stopCountdown();
    currentHold = null;
    holdInfoEl.style.display = 'none';
    updateButtons();
    await fetchSeats();
  } catch (err) {
    setStatus('Release failed: ' + err.message, true);
  }
}

function startCountdown(expiresAt) {
  stopCountdown();
  
  countdownInterval = setInterval(() => {
    const now = Date.now();
    const expires = new Date(expiresAt).getTime();
    const remaining = Math.max(0, Math.floor((expires - now) / 1000));
    
    const min = Math.floor(remaining / 60);
    const sec = remaining % 60;
    countdownEl.textContent = `${min}:${sec.toString().padStart(2, '0')}`;
    
    if (remaining <= 0) {
      stopCountdown();
      setStatus('Hold expired', true);
      currentHold = null;
      holdInfoEl.style.display = 'none';
      updateButtons();
      fetchSeats();
    }
  }, 1000);
}

function stopCountdown() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
}

function connectSSE() {
  if (eventSource) eventSource.close();
  
  eventSource = new EventSource(`${API_BASE}/stream`);
  
  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'seat-update') {
        // Refresh seat map on any update
        fetchSeats();
      }
    } catch (e) {}
  };
  
  eventSource.onerror = () => {
    // Reconnect logic could be added
    setTimeout(connectSSE, 3000);
  };
}

function init() {
  if (sessionId) {
    sessionInput.value = sessionId;
  }
  
  document.getElementById('setSession').addEventListener('click', updateSession);
  sessionInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') updateSession();
  });
  
  holdBtn.addEventListener('click', requestHold);
  confirmBtn.addEventListener('click', confirmHold);
  releaseBtn.addEventListener('click', releaseHold);
  refreshBtn.addEventListener('click', fetchSeats);
  
  // Initial load
  fetchSeats().then(() => {
    connectSSE();
  });
  
  updateButtons();
  
  // Auto refresh inventory periodically
  setInterval(() => {
    if (!currentHold) fetchSeats();
  }, 30000);
}

init();