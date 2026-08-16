const API_BASE = '/api';
let selectedSeats = new Set();
let currentHold = null;
let eventSource = null;
let seatsData = [];

async function fetchSeats() {
  try {
    const res = await fetch(`${API_BASE}/seats`);
    seatsData = await res.json();
    renderSeatMap();
    updateInventory();
  } catch (err) {
    showMessage('Failed to fetch seats', 'error');
  }
}

function renderSeatMap() {
  const map = document.getElementById('seat-map');
  map.innerHTML = '';
  
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
      
      map.appendChild(div);
    });
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
  
  document.getElementById('hold-btn').disabled = selectedSeats.size === 0;
}

function updateInventory() {
  let available = 0, held = 0, booked = 0;
  seatsData.forEach(s => {
    if (s.status === 'available') available++;
    else if (s.status === 'held') held++;
    else if (s.status === 'booked') booked++;
  });
  
  document.getElementById('available-count').textContent = available;
  document.getElementById('held-count').textContent = held;
  document.getElementById('booked-count').textContent = booked;
}

function showMessage(msg, type = 'success') {
  const el = document.getElementById('message');
  el.textContent = msg;
  el.className = type;
  setTimeout(() => {
    if (el.textContent === msg) el.textContent = '';
    el.className = '';
  }, 3000);
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
      showMessage(`Seats already taken: ${data.conflictingSeats.join(', ')}`, 'error');
      selectedSeats.clear();
      await fetchSeats();
      return;
    }
    
    if (!res.ok) {
      const err = await res.json();
      showMessage(err.error || 'Hold failed', 'error');
      return;
    }
    
    currentHold = await res.json();
    selectedSeats.clear();
    showMessage(`Hold acquired! Expires in ${Math.floor(currentHold.ttl / 1000)}s`, 'success');
    document.getElementById('hold-btn').disabled = true;
    document.getElementById('confirm-btn').disabled = false;
    document.getElementById('release-btn').disabled = false;
    
    startHoldCountdown();
    await fetchSeats();
  } catch (err) {
    showMessage('Network error', 'error');
  }
}

function getSessionId() {
  let id = localStorage.getItem('sessionId');
  if (!id) {
    id = 'sess_' + Math.random().toString(36).substr(2, 9);
    localStorage.setItem('sessionId', id);
  }
  return id;
}

let countdownInterval = null;

function startHoldCountdown() {
  if (countdownInterval) clearInterval(countdownInterval);
  
  const info = document.getElementById('hold-info');
  
  countdownInterval = setInterval(() => {
    if (!currentHold) {
      clearInterval(countdownInterval);
      info.textContent = '';
      return;
    }
    
    const remaining = currentHold.expires_at - Date.now();
    if (remaining <= 0) {
      clearInterval(countdownInterval);
      info.textContent = 'Hold expired';
      currentHold = null;
      resetControls();
      fetchSeats();
    } else {
      info.textContent = `Hold expires in ${Math.ceil(remaining / 1000)}s`;
    }
  }, 1000);
}

function resetControls() {
  document.getElementById('confirm-btn').disabled = true;
  document.getElementById('release-btn').disabled = true;
  document.getElementById('hold-info').textContent = '';
  currentHold = null;
}

async function confirmHold() {
  if (!currentHold) return;
  
  try {
    const res = await fetch(`${API_BASE}/holds/${currentHold.id}/confirm`, {
      method: 'POST'
    });
    
    if (!res.ok) {
      const err = await res.json();
      showMessage(err.error || 'Confirm failed', 'error');
      if (err.expired) {
        currentHold = null;
        resetControls();
      }
      await fetchSeats();
      return;
    }
    
    const booking = await res.json();
    showMessage(`Booking confirmed! Booking ID: ${booking.id}`, 'success');
    currentHold = null;
    resetControls();
    if (countdownInterval) clearInterval(countdownInterval);
    await fetchSeats();
  } catch (err) {
    showMessage('Network error', 'error');
  }
}

async function releaseHold() {
  if (!currentHold) return;
  
  try {
    const res = await fetch(`${API_BASE}/holds/${currentHold.id}`, {
      method: 'DELETE'
    });
    
    if (res.ok) {
      showMessage('Hold released', 'success');
      currentHold = null;
      resetControls();
      if (countdownInterval) clearInterval(countdownInterval);
      await fetchSeats();
    }
  } catch (err) {
    showMessage('Release failed', 'error');
  }
}

function connectSSE() {
  if (eventSource) eventSource.close();
  
  eventSource = new EventSource(`${API_BASE}/stream`);
  
  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'seat-update') {
      // Update local seatsData
      const idx = seatsData.findIndex(s => s.id === data.seat.id);
      if (idx !== -1) {
        seatsData[idx] = data.seat;
      } else {
        seatsData.push(data.seat);
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
    console.log('SSE disconnected, retrying...');
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