const API_BASE = 'http://localhost:3000/api';
let selectedSeats = new Set();
let currentHold = null;
let countdownInterval = null;
let seatsData = [];

async function fetchSeats() {
  const res = await fetch(`${API_BASE}/seats`);
  return await res.json();
}

function renderSeats(seats) {
  seatsData = seats;
  const mapEl = document.getElementById('seat-map');
  mapEl.innerHTML = '';

  // Header row
  const header = document.createElement('div');
  header.className = 'row-label';
  header.textContent = '';
  mapEl.appendChild(header);

  for (let s = 1; s <= 10; s++) {
    const label = document.createElement('div');
    label.className = 'row-label';
    label.textContent = s;
    mapEl.appendChild(label);
  }

  const rows = ['A', 'B', 'C', 'D', 'E'];
  for (const row of rows) {
    const rowLabel = document.createElement('div');
    rowLabel.className = 'row-label';
    rowLabel.textContent = row;
    mapEl.appendChild(rowLabel);

    for (let num = 1; num <= 10; num++) {
      const seatId = `${row}${num}`;
      const seat = seats.find(s => s.id === seatId) || { status: 'available' };

      const seatEl = document.createElement('div');
      seatEl.className = `seat ${seat.status}`;
      seatEl.textContent = seatId;
      seatEl.dataset.id = seatId;

      if (seat.status === 'held' && currentHold && currentHold.seatIds.includes(seatId)) {
        seatEl.classList.add('mine');
      }

      seatEl.addEventListener('click', () => handleSeatClick(seatId, seat.status));
      mapEl.appendChild(seatEl);
    }
  }

  updateInventory(seats);
  updateControls();
}

function updateInventory(seats) {
  const invEl = document.getElementById('inventory');
  const available = seats.filter(s => s.status === 'available').length;
  const held = seats.filter(s => s.status === 'held').length;
  const booked = seats.filter(s => s.status === 'booked').length;
  invEl.innerHTML = `Available: ${available} | Held: ${held} | Booked: ${booked} | Total: 50`;
}

function handleSeatClick(seatId, status) {
  const msgEl = document.getElementById('messages');
  msgEl.textContent = '';

  if (status === 'booked') {
    msgEl.textContent = 'This seat is already booked.';
    return;
  }

  if (status === 'held') {
    if (currentHold && currentHold.seatIds.includes(seatId)) {
      // deselect from my hold? but better not, since held
    } else {
      msgEl.textContent = 'This seat is held by someone else.';
    }
    return;
  }

  // available
  if (currentHold) {
    msgEl.textContent = 'Release current hold before selecting new seats.';
    return;
  }

  if (selectedSeats.has(seatId)) {
    selectedSeats.delete(seatId);
  } else {
    selectedSeats.add(seatId);
  }

  // re-render to update selection visuals? For simplicity, add class
  const seatEls = document.querySelectorAll('.seat');
  seatEls.forEach(el => {
    if (selectedSeats.has(el.dataset.id)) {
      el.style.border = '3px solid #3b82f6';
    } else {
      el.style.border = '';
    }
  });

  document.getElementById('hold-btn').disabled = selectedSeats.size === 0;
}

async function requestHold() {
  if (selectedSeats.size === 0) return;

  const sessionId = localStorage.getItem('sessionId') || `session_${Date.now()}`;
  localStorage.setItem('sessionId', sessionId);

  const seatIds = Array.from(selectedSeats);

  const res = await fetch(`${API_BASE}/holds`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seatIds, sessionId })
  });

  const msgEl = document.getElementById('messages');
  if (!res.ok) {
    if (res.status === 409) {
      const data = await res.json();
      msgEl.textContent = `Some seats taken: ${data.conflictingSeatIds?.join(', ')}. Refreshing...`;
      selectedSeats.clear();
      await refreshSeats();
    } else {
      msgEl.textContent = 'Failed to hold seats.';
    }
    return;
  }

  const hold = await res.json();
  currentHold = { ...hold, sessionId };
  selectedSeats.clear();

  document.getElementById('hold-btn').disabled = true;
  startHoldCountdown(hold.expiresAt);
  await refreshSeats();
  updateControls();
}

function startHoldCountdown(expiresAt) {
  const infoEl = document.getElementById('hold-info');
  infoEl.style.display = 'block';

  if (countdownInterval) clearInterval(countdownInterval);

  countdownInterval = setInterval(() => {
    const remaining = Math.max(0, Math.floor((new Date(expiresAt) - new Date()) / 1000));
    infoEl.innerHTML = `
      <strong>Hold active</strong> for seats: ${currentHold.seatIds.join(', ')}<br>
      Time remaining: ${Math.floor(remaining / 60)}:${(remaining % 60).toString().padStart(2, '0')}<br>
      <small>Session: ${currentHold.sessionId}</small>
    `;

    if (remaining <= 0) {
      clearInterval(countdownInterval);
      infoEl.innerHTML = 'Hold expired. Seats released.';
      currentHold = null;
      updateControls();
      refreshSeats();
    }
  }, 1000);
}

async function confirmHold() {
  if (!currentHold) return;

  const res = await fetch(`${API_BASE}/holds/${currentHold.holdId}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: currentHold.sessionId })
  });

  const msgEl = document.getElementById('messages');
  if (!res.ok) {
    const data = await res.json();
    msgEl.textContent = data.error || 'Confirmation failed.';
    return;
  }

  msgEl.textContent = 'Booking confirmed! Seats are yours.';
  clearInterval(countdownInterval);
  document.getElementById('hold-info').style.display = 'none';
  currentHold = null;
  updateControls();
  await refreshSeats();
}

async function releaseHold() {
  if (!currentHold) return;

  await fetch(`${API_BASE}/holds/${currentHold.holdId}`, { method: 'DELETE' });

  clearInterval(countdownInterval);
  document.getElementById('hold-info').style.display = 'none';
  currentHold = null;
  document.getElementById('messages').textContent = 'Hold released.';
  updateControls();
  await refreshSeats();
}

function updateControls() {
  const holdBtn = document.getElementById('hold-btn');
  const confirmBtn = document.getElementById('confirm-btn');
  const releaseBtn = document.getElementById('release-btn');

  holdBtn.disabled = selectedSeats.size === 0 || !!currentHold;
  confirmBtn.disabled = !currentHold;
  releaseBtn.disabled = !currentHold;
}

async function refreshSeats() {
  const seats = await fetchSeats();
  renderSeats(seats);
}

function connectSSE() {
  const eventSource = new EventSource(`${API_BASE}/stream`);

  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    console.log('SSE event:', data);

    if (data.type === 'seats-held' || data.type === 'seats-booked' || data.type === 'seats-released') {
      refreshSeats();
    }
  };

  eventSource.onerror = () => {
    console.log('SSE disconnected, retrying...');
    setTimeout(connectSSE, 3000);
  };
}

async function init() {
  document.getElementById('hold-btn').addEventListener('click', requestHold);
  document.getElementById('confirm-btn').addEventListener('click', confirmHold);
  document.getElementById('release-btn').addEventListener('click', releaseHold);

  await refreshSeats();
  connectSSE();

  // Initial status
  document.getElementById('status').textContent = 'Select available seats to hold them.';
}

init();