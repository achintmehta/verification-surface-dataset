const API_BASE = '/api';
let selectedSeats = new Set();
let currentHold = null;
let sessionId = 'session_' + Math.random().toString(36).substr(2, 9);
let eventSource = null;

async function fetchSeats() {
  const res = await fetch(`${API_BASE}/seats`);
  return res.json();
}

function renderSeats(seats) {
  const map = document.getElementById('seat-map');
  map.innerHTML = '';
  
  let avail = 0, held = 0, booked = 0;

  seats.forEach(seat => {
    const div = document.createElement('div');
    div.className = `seat ${seat.effective_status}`;
    div.textContent = seat.id;
    div.dataset.id = seat.id;

    if (seat.effective_status === 'available') {
      avail++;
      div.addEventListener('click', () => toggleSelect(seat.id, div));
    } else if (seat.effective_status === 'held') {
      held++;
      if (seat.hold_id === currentHold?.holdId) {
        div.classList.add('selected');
      }
    } else {
      booked++;
    }

    map.appendChild(div);
  });

  document.getElementById('avail-count').textContent = avail;
  document.getElementById('held-count').textContent = held;
  document.getElementById('booked-count').textContent = booked;

  updateControls();
}

function toggleSelect(seatId, element) {
  if (currentHold) return; // Can't select while holding

  if (selectedSeats.has(seatId)) {
    selectedSeats.delete(seatId);
    element.classList.remove('selected');
  } else {
    selectedSeats.add(seatId);
    element.classList.add('selected');
  }
  updateControls();
}

function updateControls() {
  const holdBtn = document.getElementById('hold-btn');
  const confirmBtn = document.getElementById('confirm-btn');
  const releaseBtn = document.getElementById('release-btn');
  const holdInfo = document.getElementById('hold-info');

  holdBtn.disabled = selectedSeats.size === 0 || !!currentHold;
  confirmBtn.disabled = !currentHold;
  releaseBtn.disabled = !currentHold;

  if (currentHold) {
    const remaining = Math.max(0, Math.floor((new Date(currentHold.expiresAt) - Date.now()) / 1000));
    holdInfo.innerHTML = `Hold active: ${currentHold.seatIds.join(', ')}<br>Expires in: ${remaining}s`;
  } else {
    holdInfo.innerHTML = '';
  }
}

async function requestHold() {
  if (selectedSeats.size === 0) return;

  const seatIds = Array.from(selectedSeats);
  const res = await fetch(`${API_BASE}/holds`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seatIds, sessionId })
  });

  if (res.status === 409) {
    const data = await res.json();
    alert(`Some seats taken: ${data.conflictingSeats.join(', ')}`);
    selectedSeats.clear();
    await refreshSeats();
    return;
  }

  if (!res.ok) {
    alert('Failed to hold seats');
    return;
  }

  const holdData = await res.json();
  currentHold = { ...holdData, seatIds };
  selectedSeats.clear();
  await refreshSeats();
  startCountdown();
}

async function confirmHold() {
  if (!currentHold) return;

  const res = await fetch(`${API_BASE}/holds/${currentHold.holdId}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId })
  });

  if (!res.ok) {
    const data = await res.json();
    alert(data.error || 'Confirm failed');
    currentHold = null;
    await refreshSeats();
    return;
  }

  const data = await res.json();
  alert(`Booked seats: ${data.seatIds.join(', ')}`);
  currentHold = null;
  await refreshSeats();
}

async function releaseHold() {
  if (!currentHold) return;

  await fetch(`${API_BASE}/holds/${currentHold.holdId}`, { method: 'DELETE' });
  currentHold = null;
  await refreshSeats();
}

function startCountdown() {
  const interval = setInterval(() => {
    if (!currentHold) {
      clearInterval(interval);
      return;
    }
    const remaining = Math.max(0, Math.floor((new Date(currentHold.expiresAt) - Date.now()) / 1000));
    const holdInfo = document.getElementById('hold-info');
    if (holdInfo) {
      holdInfo.innerHTML = `Hold active: ${currentHold.seatIds.join(', ')}<br>Expires in: ${remaining}s`;
    }
    if (remaining <= 0) {
      currentHold = null;
      clearInterval(interval);
      refreshSeats();
    }
  }, 1000);
}

function connectSSE() {
  eventSource = new EventSource(`${API_BASE}/stream`);
  
  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    // Update UI live
    refreshSeats();
  };

  eventSource.onerror = () => {
    console.log('SSE error, reconnecting...');
    setTimeout(connectSSE, 3000);
  };
}

async function refreshSeats() {
  const seats = await fetchSeats();
  renderSeats(seats);
}

async function init() {
  document.getElementById('hold-btn').addEventListener('click', requestHold);
  document.getElementById('confirm-btn').addEventListener('click', confirmHold);
  document.getElementById('release-btn').addEventListener('click', releaseHold);

  await refreshSeats();
  connectSSE();

  // Periodic refresh as fallback
  setInterval(refreshSeats, 10000);
}

init();