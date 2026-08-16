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

function renderSeatMap() {
  const map = document.getElementById('seat-map');
  map.innerHTML = '';
  
  seatsData.forEach(seat => {
    const div = document.createElement('div');
    div.className = `seat ${seat.status}`;
    div.textContent = `${seat.row_label}${seat.seat_number}`;
    div.dataset.id = seat.id;
    
    if (seat.status === 'available') {
      div.addEventListener('click', () => toggleSelect(seat.id, div));
    } else if (seat.status === 'held' && currentHold && currentHold.seatIds.includes(seat.id)) {
      div.classList.add('selected');
    }
    
    map.appendChild(div);
  });
}

function toggleSelect(seatId, element) {
  if (selectedSeats.has(seatId)) {
    selectedSeats.delete(seatId);
    element.classList.remove('selected');
  } else {
    selectedSeats.add(seatId);
    element.classList.add('selected');
  }
  updateControls();
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

function updateControls() {
  const holdBtn = document.getElementById('hold-btn');
  const confirmBtn = document.getElementById('confirm-btn');
  const releaseBtn = document.getElementById('release-btn');
  const holdInfo = document.getElementById('hold-info');
  
  holdBtn.disabled = selectedSeats.size === 0 || currentHold !== null;
  
  if (currentHold) {
    confirmBtn.disabled = false;
    releaseBtn.disabled = false;
    holdInfo.innerHTML = `Hold active: ${currentHold.seatIds.length} seats. Expires in <span id="countdown"></span>s`;
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
  const countdownEl = document.getElementById('countdown');
  if (!countdownEl || !currentHold) return;
  
  const update = () => {
    const remaining = Math.max(0, Math.floor((currentHold.expiresAt - Date.now()) / 1000));
    countdownEl.textContent = remaining;
    if (remaining <= 0) {
      clearInterval(countdownInterval);
      currentHold = null;
      updateControls();
      fetchSeats();
    }
  };
  update();
  countdownInterval = setInterval(update, 1000);
}

async function requestHold() {
  const messageEl = document.getElementById('message');
  messageEl.textContent = '';
  
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
      messageEl.textContent = `Some seats taken: ${data.conflictingSeats.join(', ')}`;
      selectedSeats.clear();
      await fetchSeats();
      return;
    }
    
    if (!res.ok) throw new Error('Hold failed');
    
    const hold = await res.json();
    currentHold = {
      holdId: hold.holdId,
      seatIds: hold.seatIds,
      expiresAt: Date.now() + (hold.ttlSeconds * 1000)
    };
    selectedSeats.clear();
    await fetchSeats();
    updateControls();
  } catch (e) {
    messageEl.textContent = e.message;
  }
}

async function confirmHold() {
  if (!currentHold) return;
  const messageEl = document.getElementById('message');
  messageEl.textContent = '';
  
  try {
    const res = await fetch(`${API_BASE}/holds/${currentHold.holdId}/confirm`, {
      method: 'POST'
    });
    
    if (!res.ok) {
      const data = await res.json();
      messageEl.textContent = data.error || 'Confirm failed';
      currentHold = null;
      await fetchSeats();
      updateControls();
      return;
    }
    
    const result = await res.json();
    messageEl.textContent = 'Booking confirmed!';
    currentHold = null;
    await fetchSeats();
    updateControls();
  } catch (e) {
    messageEl.textContent = e.message;
  }
}

async function releaseHold() {
  if (!currentHold) return;
  const messageEl = document.getElementById('message');
  
  try {
    await fetch(`${API_BASE}/holds/${currentHold.holdId}`, {
      method: 'DELETE'
    });
    currentHold = null;
    await fetchSeats();
    updateControls();
  } catch (e) {
    messageEl.textContent = e.message;
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

function connectSSE() {
  eventSource = new EventSource(`${API_BASE}/stream`);
  
  eventSource.onmessage = (event) => {
    const update = JSON.parse(event.data);
    // Update local seatsData
    const seat = seatsData.find(s => s.id === update.seatId);
    if (seat) {
      seat.status = update.status;
      if (update.status !== 'held') {
        seat.holdId = null;
      }
    }
    renderSeatMap();
    updateInventory();
  };
  
  eventSource.onerror = () => {
    console.log('SSE error, reconnecting...');
    setTimeout(connectSSE, 3000);
  };
}

function init() {
  document.getElementById('hold-btn').addEventListener('click', requestHold);
  document.getElementById('confirm-btn').addEventListener('click', confirmHold);
  document.getElementById('release-btn').addEventListener('click', releaseHold);
  
  fetchSeats().then(() => {
    connectSSE();
  });
  
  // Periodic refresh as fallback
  setInterval(fetchSeats, 30000);
}

init();