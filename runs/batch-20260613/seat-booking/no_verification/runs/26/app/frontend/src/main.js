const API_BASE = 'http://localhost:3000/api';
let selectedSeats = new Set();
let currentHold = null;
let seatData = new Map(); // id -> seat
let eventSource = null;

async function fetchSeats() {
  const res = await fetch(`${API_BASE}/seats`);
  const seats = await res.json();
  seatData.clear();
  seats.forEach(seat => {
    seatData.set(seat.id, seat);
  });
  renderSeatMap();
  updateInventory();
}

function updateInventory() {
  let avail = 0, held = 0, booked = 0;
  seatData.forEach(seat => {
    if (seat.status === 'available') avail++;
    else if (seat.status === 'held') held++;
    else if (seat.status === 'booked') booked++;
  });
  document.getElementById('avail').textContent = avail;
  document.getElementById('held').textContent = held;
  document.getElementById('booked').textContent = booked;
}

function renderSeatMap() {
  const container = document.getElementById('seatMap');
  container.innerHTML = '';
  
  // Group by row
  const rows = {};
  seatData.forEach(seat => {
    if (!rows[seat.row_label]) rows[seat.row_label] = [];
    rows[seat.row_label].push(seat);
  });

  Object.keys(rows).sort().forEach(rowLabel => {
    // Row label
    const label = document.createElement('div');
    label.className = 'row-label';
    label.textContent = rowLabel;
    container.appendChild(label);

    rows[rowLabel].sort((a,b) => a.seat_number - b.seat_number).forEach(seat => {
      const div = document.createElement('div');
      div.className = `seat ${seat.status}`;
      div.textContent = seat.seat_number;
      div.dataset.id = seat.id;

      if (seat.status === 'available') {
        div.addEventListener('click', () => toggleSelect(seat.id, div));
      } else if (seat.status === 'held' && currentHold && currentHold.seatIds.includes(seat.id)) {
        div.classList.add('selected');
      }

      container.appendChild(div);
    });
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
  document.getElementById('holdBtn').disabled = selectedSeats.size === 0;
}

async function requestHold() {
  if (selectedSeats.size === 0) return;
  const sessionId = localStorage.getItem('sessionId') || `sess_${Date.now()}`;
  localStorage.setItem('sessionId', sessionId);

  const res = await fetch(`${API_BASE}/holds`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seatIds: Array.from(selectedSeats), sessionId })
  });

  if (res.status === 409) {
    const data = await res.json();
    document.getElementById('status').textContent = `Some seats taken: ${data.conflictingSeats.join(', ')}. Refreshing...`;
    selectedSeats.clear();
    await fetchSeats();
    return;
  }

  if (!res.ok) {
    const err = await res.json();
    document.getElementById('status').textContent = `Error: ${err.error}`;
    return;
  }

  const hold = await res.json();
  currentHold = { holdId: hold.holdId, expiresAt: hold.expiresAt, seatIds: hold.seatIds };
  selectedSeats.clear();
  document.getElementById('holdBtn').disabled = true;
  document.getElementById('confirmBtn').disabled = false;
  document.getElementById('releaseBtn').disabled = false;
  
  startCountdown();
  await fetchSeats();
  document.getElementById('status').textContent = `Hold acquired! Expires at ${new Date(hold.expiresAt).toLocaleTimeString()}`;
}

function startCountdown() {
  const infoEl = document.getElementById('holdInfo');
  if (!currentHold) return;

  const interval = setInterval(() => {
    if (!currentHold) {
      clearInterval(interval);
      return;
    }
    const remaining = Math.max(0, new Date(currentHold.expiresAt) - Date.now());
    if (remaining <= 0) {
      infoEl.textContent = 'Hold expired';
      clearInterval(interval);
      currentHold = null;
      document.getElementById('confirmBtn').disabled = true;
      document.getElementById('releaseBtn').disabled = true;
      fetchSeats();
    } else {
      infoEl.textContent = `Hold expires in ${Math.floor(remaining / 1000)}s`;
    }
  }, 1000);
}

async function confirmHold() {
  if (!currentHold) return;
  const sessionId = localStorage.getItem('sessionId');
  const res = await fetch(`${API_BASE}/holds/${currentHold.holdId}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId })
  });

  if (!res.ok) {
    const err = await res.json();
    document.getElementById('status').textContent = `Confirm failed: ${err.error}`;
    return;
  }

  document.getElementById('status').textContent = 'Booking confirmed!';
  currentHold = null;
  document.getElementById('confirmBtn').disabled = true;
  document.getElementById('releaseBtn').disabled = true;
  document.getElementById('holdInfo').textContent = '';
  await fetchSeats();
}

async function releaseHold() {
  if (!currentHold) return;
  await fetch(`${API_BASE}/holds/${currentHold.holdId}`, { method: 'DELETE' });
  currentHold = null;
  document.getElementById('confirmBtn').disabled = true;
  document.getElementById('releaseBtn').disabled = true;
  document.getElementById('holdInfo').textContent = '';
  await fetchSeats();
}

function connectSSE() {
  eventSource = new EventSource(`${API_BASE}/stream`);
  
  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'seat_update' && data.seat) {
      seatData.set(data.seat.id, data.seat);
      renderSeatMap();
      updateInventory();
    }
  };

  eventSource.onerror = () => {
    console.log('SSE error, reconnecting...');
    setTimeout(connectSSE, 3000);
  };
}

function init() {
  document.getElementById('holdBtn').addEventListener('click', requestHold);
  document.getElementById('confirmBtn').addEventListener('click', confirmHold);
  document.getElementById('releaseBtn').addEventListener('click', releaseHold);

  fetchSeats().then(() => {
    connectSSE();
  });

  // Refresh periodically as fallback
  setInterval(fetchSeats, 30000);
}

init();