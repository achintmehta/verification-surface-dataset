const API_BASE = '/api';
let selectedSeats = new Set();
let currentHold = null;
let eventSource = null;
let seatsData = [];

async function fetchSeats() {
  try {
    const res = await fetch(`${API_BASE}/seats`);
    if (!res.ok) throw new Error('Failed to fetch seats');
    seatsData = await res.json();
    renderSeatMap();
    updateInventory();
  } catch (err) {
    showMessage('Error loading seats: ' + err.message, 'error');
  }
}

function updateInventory() {
  const available = seatsData.filter(s => s.status === 'available').length;
  const held = seatsData.filter(s => s.status === 'held').length;
  const booked = seatsData.filter(s => s.status === 'booked').length;
  const total = seatsData.length;
  
  document.getElementById('inventory').innerHTML = `
    <span>Available: ${available}</span>
    <span>Held: ${held}</span>
    <span>Booked: ${booked}</span>
    <span>Total: ${total}</span>
  `;
}

function renderSeatMap() {
  const map = document.getElementById('seat-map');
  map.innerHTML = '';
  
  seatsData.forEach(seat => {
    const div = document.createElement('div');
    div.className = `seat ${seat.status}`;
    div.textContent = `${seat.row_label}${seat.seat_number}`;
    div.dataset.id = seat.id;
    
    if (seat.status === 'available') {
      div.addEventListener('click', () => toggleSeatSelection(seat.id, div));
    }
    
    if (selectedSeats.has(seat.id)) {
      div.classList.add('selected');
    }
    
    map.appendChild(div);
  });
}

function toggleSeatSelection(seatId, element) {
  if (currentHold) {
    showMessage('Release or confirm current hold first', 'error');
    return;
  }
  
  if (selectedSeats.has(seatId)) {
    selectedSeats.delete(seatId);
    element.classList.remove('selected');
  } else {
    selectedSeats.add(seatId);
    element.classList.add('selected');
  }
  
  updateHoldButton();
}

function updateHoldButton() {
  const btn = document.getElementById('hold-btn');
  btn.disabled = selectedSeats.size === 0 || !!currentHold;
}

function updateConfirmReleaseButtons() {
  const confirmBtn = document.getElementById('confirm-btn');
  const releaseBtn = document.getElementById('release-btn');
  const holdInfo = document.getElementById('hold-info');
  
  if (currentHold) {
    confirmBtn.disabled = false;
    releaseBtn.disabled = false;
    const remaining = Math.max(0, Math.floor((currentHold.expires_at - Date.now()) / 1000));
    holdInfo.innerHTML = `Hold active: ${currentHold.seat_ids.length} seats. Expires in <span id="countdown">${remaining}</span>s`;
    startCountdown();
  } else {
    confirmBtn.disabled = true;
    releaseBtn.disabled = true;
    holdInfo.innerHTML = '';
  }
}

let countdownInterval = null;

function startCountdown() {
  if (countdownInterval) clearInterval(countdownInterval);
  
  countdownInterval = setInterval(() => {
    if (!currentHold) {
      clearInterval(countdownInterval);
      return;
    }
    const remainingEl = document.getElementById('countdown');
    if (!remainingEl) return;
    
    const remaining = Math.max(0, Math.floor((currentHold.expires_at - Date.now()) / 1000));
    remainingEl.textContent = remaining;
    
    if (remaining <= 0) {
      clearInterval(countdownInterval);
      currentHold = null;
      selectedSeats.clear();
      fetchSeats();
      updateConfirmReleaseButtons();
      showMessage('Hold expired', 'error');
    }
  }, 1000);
}

async function requestHold() {
  if (selectedSeats.size === 0) return;
  
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
      showMessage(`Some seats unavailable: ${data.conflictingSeats.join(', ')}`, 'error');
      selectedSeats.clear();
      await fetchSeats();
      return;
    }
    
    if (!res.ok) throw new Error('Hold request failed');
    
    const hold = await res.json();
    currentHold = {
      ...hold,
      expires_at: Date.now() + (hold.ttl_seconds * 1000)
    };
    selectedSeats.clear();
    showMessage(`Hold successful! Hold ID: ${hold.hold_id}`, 'success');
    await fetchSeats();
    updateConfirmReleaseButtons();
    updateHoldButton();
  } catch (err) {
    showMessage('Error requesting hold: ' + err.message, 'error');
  }
}

function getSessionId() {
  let sessionId = localStorage.getItem('sessionId');
  if (!sessionId) {
    sessionId = 'session_' + Math.random().toString(36).substr(2, 9);
    localStorage.setItem('sessionId', sessionId);
  }
  return sessionId;
}

async function confirmHold() {
  if (!currentHold) return;
  
  try {
    const res = await fetch(`${API_BASE}/holds/${currentHold.hold_id}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Confirmation failed');
    }
    
    const result = await res.json();
    showMessage('Booking confirmed! Seats booked.', 'success');
    currentHold = null;
    clearInterval(countdownInterval);
    await fetchSeats();
    updateConfirmReleaseButtons();
  } catch (err) {
    showMessage('Error confirming: ' + err.message, 'error');
    // Refresh in case of expiry
    await fetchSeats();
  }
}

async function releaseHold() {
  if (!currentHold) return;
  
  try {
    const res = await fetch(`${API_BASE}/holds/${currentHold.hold_id}`, {
      method: 'DELETE'
    });
    
    if (!res.ok) throw new Error('Release failed');
    
    showMessage('Hold released', 'success');
    currentHold = null;
    clearInterval(countdownInterval);
    await fetchSeats();
    updateConfirmReleaseButtons();
  } catch (err) {
    showMessage('Error releasing: ' + err.message, 'error');
  }
}

function showMessage(msg, type = 'success') {
  const container = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = `message ${type}`;
  div.textContent = msg;
  container.appendChild(div);
  setTimeout(() => div.remove(), 5000);
}

function connectSSE() {
  if (eventSource) eventSource.close();
  
  eventSource = new EventSource(`${API_BASE}/stream`);
  
  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'seat_update') {
      // Update local seatsData
      const updatedSeat = data.seat;
      const idx = seatsData.findIndex(s => s.id === updatedSeat.id);
      if (idx !== -1) {
        seatsData[idx] = { ...seatsData[idx], ...updatedSeat };
      }
      renderSeatMap();
      updateInventory();
    } else if (data.type === 'seats_refresh') {
      fetchSeats();
    }
  };
  
  eventSource.onerror = () => {
    console.log('SSE error, will reconnect...');
    setTimeout(connectSSE, 3000);
  };
}

function init() {
  document.getElementById('hold-btn').addEventListener('click', requestHold);
  document.getElementById('confirm-btn').addEventListener('click', confirmHold);
  document.getElementById('release-btn').addEventListener('click', releaseHold);
  
  fetchSeats();
  connectSSE();
  
  // Periodic refresh as fallback
  setInterval(fetchSeats, 30000);
}

init();