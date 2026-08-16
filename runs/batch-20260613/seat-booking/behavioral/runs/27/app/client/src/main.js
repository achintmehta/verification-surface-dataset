const API_BASE = '/api';
let selectedSeats = new Set();
let currentHold = null;
let eventSource = null;
let seatsData = [];

async function fetchSeats() {
  const res = await fetch(`${API_BASE}/seats`);
  const data = await res.json();
  seatsData = data.seats;
  renderSeatMap();
  updateInventory();
}

function updateInventory() {
  const available = seatsData.filter(s => s.status === 'available').length;
  const held = seatsData.filter(s => s.status === 'held').length;
  const booked = seatsData.filter(s => s.status === 'booked').length;
  document.getElementById('inventory').innerHTML = `
    Available: ${available} | Held: ${held} | Booked: ${booked} | Total: ${seatsData.length}
  `;
}

function renderSeatMap() {
  const container = document.getElementById('seat-map');
  container.innerHTML = '';
  
  // Group by row
  const rows = {};
  seatsData.forEach(seat => {
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
}

function toggleSeatSelection(seatId, element) {
  if (selectedSeats.has(seatId)) {
    selectedSeats.delete(seatId);
    element.classList.remove('selected');
  } else {
    selectedSeats.add(seatId);
    element.classList.add('selected');
  }
}

async function requestHold() {
  if (selectedSeats.size === 0) {
    showMessage('Please select some seats first.');
    return;
  }
  
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
      showMessage(`Some seats are unavailable: ${data.conflictingSeats.join(', ')}`);
      selectedSeats.clear();
      await fetchSeats();
      return;
    }
    
    if (!res.ok) {
      const data = await res.json();
      showMessage(data.error || 'Failed to hold seats');
      return;
    }
    
    const hold = await res.json();
    currentHold = hold;
    selectedSeats.clear();
    showHoldInfo(hold);
    await fetchSeats();
    enableHoldButtons(true);
  } catch (err) {
    showMessage('Error requesting hold: ' + err.message);
  }
}

function getSessionId() {
  let sessionId = localStorage.getItem('sessionId');
  if (!sessionId) {
    sessionId = 'session-' + Math.random().toString(36).substr(2, 9);
    localStorage.setItem('sessionId', sessionId);
  }
  return sessionId;
}

function showHoldInfo(hold) {
  const infoDiv = document.getElementById('hold-info');
  const expiresAt = new Date(hold.expiresAt);
  const remaining = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  
  infoDiv.innerHTML = `
    <strong>Hold Active</strong><br>
    Seats: ${hold.seatIds.join(', ')}<br>
    Expires in: <span id="countdown">${remaining}</span>s<br>
    Hold ID: ${hold.holdId}
  `;
  infoDiv.style.display = 'block';
  
  // Start countdown
  startCountdown(expiresAt);
}

let countdownInterval = null;

function startCountdown(expiresAt) {
  if (countdownInterval) clearInterval(countdownInterval);
  
  countdownInterval = setInterval(() => {
    const remainingEl = document.getElementById('countdown');
    if (!remainingEl) {
      clearInterval(countdownInterval);
      return;
    }
    const remaining = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
    remainingEl.textContent = remaining;
    
    if (remaining <= 0) {
      clearInterval(countdownInterval);
      document.getElementById('hold-info').innerHTML = 'Hold expired!';
      currentHold = null;
      enableHoldButtons(false);
      fetchSeats();
    }
  }, 1000);
}

function enableHoldButtons(enabled) {
  document.getElementById('confirm-btn').disabled = !enabled;
  document.getElementById('release-btn').disabled = !enabled;
}

async function confirmHold() {
  if (!currentHold) return;
  
  try {
    const res = await fetch(`${API_BASE}/holds/${currentHold.holdId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: getSessionId() })
    });
    
    if (!res.ok) {
      const data = await res.json();
      showMessage(data.error || 'Confirmation failed');
      if (data.expired) {
        currentHold = null;
        enableHoldButtons(false);
        document.getElementById('hold-info').style.display = 'none';
      }
      await fetchSeats();
      return;
    }
    
    const result = await res.json();
    showMessage('Booking confirmed! Seats booked successfully.');
    currentHold = null;
    enableHoldButtons(false);
    document.getElementById('hold-info').style.display = 'none';
    if (countdownInterval) clearInterval(countdownInterval);
    await fetchSeats();
  } catch (err) {
    showMessage('Error confirming: ' + err.message);
  }
}

async function releaseHold() {
  if (!currentHold) return;
  
  try {
    const res = await fetch(`${API_BASE}/holds/${currentHold.holdId}`, {
      method: 'DELETE'
    });
    
    if (res.ok) {
      showMessage('Hold released.');
      currentHold = null;
      enableHoldButtons(false);
      document.getElementById('hold-info').style.display = 'none';
      if (countdownInterval) clearInterval(countdownInterval);
      await fetchSeats();
    }
  } catch (err) {
    showMessage('Error releasing: ' + err.message);
  }
}

function showMessage(msg) {
  const messages = document.getElementById('messages');
  messages.innerHTML = `<div style="color: red; margin: 10px 0;">${msg}</div>`;
  setTimeout(() => {
    messages.innerHTML = '';
  }, 5000);
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
    } else if (data.type === 'seats-update') {
      seatsData = data.seats;
      renderSeatMap();
      updateInventory();
    }
  };
  
  eventSource.onerror = () => {
    console.log('SSE connection error, will retry...');
    setTimeout(connectSSE, 3000);
  };
}

function init() {
  document.getElementById('hold-btn').addEventListener('click', requestHold);
  document.getElementById('confirm-btn').addEventListener('click', confirmHold);
  document.getElementById('release-btn').addEventListener('click', releaseHold);
  
  fetchSeats();
  connectSSE();
  
  // Refresh seats periodically as fallback
  setInterval(fetchSeats, 30000);
}

init();