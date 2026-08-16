const API_BASE = '/api';

let selectedSeats = new Set();
let currentHold = null;
let countdownInterval = null;
let seatsData = new Map(); // id -> seat info

const seatMapEl = document.getElementById('seat-map');
const holdBtn = document.getElementById('hold-btn');
const confirmBtn = document.getElementById('confirm-btn');
const releaseBtn = document.getElementById('release-btn');
const holdInfoEl = document.getElementById('hold-info');
const messagesEl = document.getElementById('messages');

function showMessage(msg, isError = false) {
  const div = document.createElement('div');
  div.className = 'message';
  div.style.color = isError ? 'red' : 'green';
  div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  messagesEl.prepend(div);
  setTimeout(() => div.remove(), 5000);
}

async function fetchSeats() {
  try {
    const res = await fetch(`${API_BASE}/seats`);
    const seats = await res.json();
    
    seatsData.clear();
    seats.forEach(seat => {
      seatsData.set(seat.id, seat);
    });
    
    renderSeatMap();
    updateCounts();
  } catch (err) {
    showMessage('Failed to fetch seats', true);
  }
}

function updateCounts() {
  let available = 0, held = 0, booked = 0;
  
  for (const seat of seatsData.values()) {
    if (seat.status === 'available') available++;
    else if (seat.status === 'held') held++;
    else if (seat.status === 'booked') booked++;
  }
  
  document.getElementById('count-available').textContent = available;
  document.getElementById('count-held').textContent = held;
  document.getElementById('count-booked').textContent = booked;
}

function renderSeatMap() {
  seatMapEl.innerHTML = '';
  
  const sortedSeats = Array.from(seatsData.values()).sort((a, b) => {
    if (a.row_label !== b.row_label) return a.row_label.localeCompare(b.row_label);
    return a.seat_number - b.seat_number;
  });
  
  for (const seat of sortedSeats) {
    const el = document.createElement('div');
    el.className = `seat ${seat.status}`;
    el.textContent = seat.id;
    el.dataset.id = seat.id;
    
    if (seat.status === 'available') {
      el.addEventListener('click', () => toggleSeatSelection(seat.id, el));
    } else if (seat.status === 'held' && currentHold && seat.hold_id === currentHold.holdId) {
      el.classList.add('selected');
    }
    
    seatMapEl.appendChild(el);
  }
  
  updateSelectionUI();
}

function toggleSeatSelection(seatId, el) {
  if (currentHold) {
    showMessage('Release or confirm current hold first', true);
    return;
  }
  
  if (selectedSeats.has(seatId)) {
    selectedSeats.delete(seatId);
    el.classList.remove('selected');
  } else {
    selectedSeats.add(seatId);
    el.classList.add('selected');
  }
  
  updateSelectionUI();
}

function updateSelectionUI() {
  holdBtn.disabled = selectedSeats.size === 0 || !!currentHold;
  confirmBtn.disabled = !currentHold;
  releaseBtn.disabled = !currentHold;
}

async function requestHold() {
  if (selectedSeats.size === 0) return;
  
  const sessionId = localStorage.getItem('sessionId') || `session_${Date.now()}`;
  localStorage.setItem('sessionId', sessionId);
  
  try {
    const res = await fetch(`${API_BASE}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        seatIds: Array.from(selectedSeats),
        sessionId
      })
    });
    
    if (res.status === 409) {
      const data = await res.json();
      showMessage(`Seats already taken: ${data.conflictingSeats.join(', ')}`, true);
      selectedSeats.clear();
      await fetchSeats();
      return;
    }
    
    if (!res.ok) {
      throw new Error('Hold request failed');
    }
    
    const hold = await res.json();
    currentHold = { ...hold, sessionId };
    selectedSeats.clear();
    
    showMessage(`Hold acquired! Expires at ${new Date(hold.expiresAt).toLocaleTimeString()}`);
    startCountdown(hold.expiresAt);
    
    await fetchSeats();
    updateSelectionUI();
  } catch (err) {
    showMessage(err.message, true);
  }
}

function startCountdown(expiresAt) {
  if (countdownInterval) clearInterval(countdownInterval);
  
  countdownInterval = setInterval(() => {
    const remaining = new Date(expiresAt) - new Date();
    if (remaining <= 0) {
      clearInterval(countdownInterval);
      holdInfoEl.textContent = 'Hold expired!';
      currentHold = null;
      fetchSeats();
      updateSelectionUI();
    } else {
      const mins = Math.floor(remaining / 60000);
      const secs = Math.floor((remaining % 60000) / 1000);
      holdInfoEl.textContent = `Hold active: ${mins}:${secs.toString().padStart(2, '0')} remaining`;
    }
  }, 1000);
}

async function confirmHold() {
  if (!currentHold) return;
  
  try {
    const res = await fetch(`${API_BASE}/holds/${currentHold.holdId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: currentHold.sessionId })
    });
    
    if (!res.ok) {
      const data = await res.json();
      showMessage(data.error || 'Confirm failed', true);
      return;
    }
    
    const data = await res.json();
    showMessage('Booking confirmed successfully!');
    
    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }
    holdInfoEl.textContent = '';
    currentHold = null;
    
    await fetchSeats();
    updateSelectionUI();
  } catch (err) {
    showMessage(err.message, true);
  }
}

async function releaseHold() {
  if (!currentHold) return;
  
  try {
    await fetch(`${API_BASE}/holds/${currentHold.holdId}`, {
      method: 'DELETE'
    });
    
    showMessage('Hold released');
    
    if (countdownInterval) clearInterval(countdownInterval);
    holdInfoEl.textContent = '';
    currentHold = null;
    
    await fetchSeats();
    updateSelectionUI();
  } catch (err) {
    showMessage(err.message, true);
  }
}

function connectSSE() {
  const eventSource = new EventSource(`${API_BASE}/stream`);
  
  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'connected') return;
      
      if (data.seatIds && data.status) {
        // Update local state
        data.seatIds.forEach(id => {
          const seat = seatsData.get(id);
          if (seat) {
            seat.status = data.status;
            if (data.status === 'available') {
              seat.hold_id = null;
              seat.hold_expires_at = null;
              seat.booked_by = null;
            } else if (data.status === 'held') {
              seat.hold_id = data.holdId;
              seat.hold_expires_at = data.expiresAt;
            } else if (data.status === 'booked') {
              seat.booked_by = data.holdId;
            }
          }
        });
        
        renderSeatMap();
        updateCounts();
      }
    } catch (e) {
      // ignore parse errors for pings
    }
  };
  
  eventSource.onerror = () => {
    showMessage('SSE connection lost, retrying...', true);
    setTimeout(() => {
      eventSource.close();
      connectSSE();
    }, 3000);
  };
}

function init() {
  holdBtn.addEventListener('click', requestHold);
  confirmBtn.addEventListener('click', confirmHold);
  releaseBtn.addEventListener('click', releaseHold);
  
  fetchSeats();
  connectSSE();
  
  // Refresh seats periodically as fallback
  setInterval(fetchSeats, 30000);
}

init();
