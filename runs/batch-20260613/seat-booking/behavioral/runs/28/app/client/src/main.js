let seats = [];
let selectedSeats = new Set();
let currentHold = null;
let countdownInterval = null;
let sessionId = localStorage.getItem('sessionId') || generateSessionId();

function generateSessionId() {
  const id = 'sess_' + Math.random().toString(36).substr(2, 9);
  localStorage.setItem('sessionId', id);
  return id;
}

function showMessage(msg, type = 'success') {
  const container = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = `message ${type}`;
  div.textContent = msg;
  container.appendChild(div);
  setTimeout(() => div.remove(), 5000);
}

async function fetchSeats() {
  try {
    const res = await fetch('/api/seats');
    const data = await res.json();
    seats = data.seats;
    renderSeatMap();
    updateInventory();
  } catch (err) {
    console.error(err);
    showMessage('Failed to load seats', 'error');
  }
}

function updateInventory() {
  const available = seats.filter(s => s.status === 'available').length;
  const held = seats.filter(s => s.status === 'held').length;
  const booked = seats.filter(s => s.status === 'booked').length;
  const total = seats.length;
  document.getElementById('inventory').innerHTML = 
    `Total: ${total} | Available: ${available} | Held: ${held} | Booked: ${booked}`;
}

function renderSeatMap() {
  const map = document.getElementById('seat-map');
  map.innerHTML = '';

  // Group by row
  const rows = {};
  seats.forEach(seat => {
    if (!rows[seat.row]) rows[seat.row] = [];
    rows[seat.row].push(seat);
  });

  Object.keys(rows).sort().forEach(rowLabel => {
    rows[rowLabel].sort((a, b) => a.number - b.number).forEach(seat => {
      const div = document.createElement('div');
      div.className = `seat ${seat.status}`;
      div.textContent = `${seat.row}${seat.number}`;
      div.dataset.id = seat.id;

      if (seat.status === 'available') {
        if (selectedSeats.has(seat.id)) {
          div.classList.add('selected');
        }
        div.addEventListener('click', () => toggleSelect(seat.id, div));
      } else if (seat.status === 'held' && seat.holdId && currentHold && seat.holdId === currentHold.holdId) {
        // Our hold
        div.style.background = '#FFD700';
        div.style.borderColor = '#DAA520';
      }

      map.appendChild(div);
    });
  });

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
    holdInfo.innerHTML = `Hold active: ${currentHold.seatIds.length} seats. Expires in <span id="countdown">${remaining}</span>s`;
    if (!countdownInterval) startCountdown();
  } else {
    holdInfo.innerHTML = '';
    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }
  }
}

function startCountdown() {
  if (countdownInterval) clearInterval(countdownInterval);
  countdownInterval = setInterval(() => {
    if (!currentHold) {
      clearInterval(countdownInterval);
      countdownInterval = null;
      return;
    }
    const remainingEl = document.getElementById('countdown');
    if (remainingEl) {
      const remaining = Math.max(0, Math.floor((new Date(currentHold.expiresAt) - Date.now()) / 1000));
      remainingEl.textContent = remaining;
      if (remaining <= 0) {
        clearInterval(countdownInterval);
        currentHold = null;
        selectedSeats.clear();
        fetchSeats();
        showMessage('Hold expired', 'error');
      }
    }
  }, 1000);
}

async function requestHold() {
  if (selectedSeats.size === 0) return;

  const seatIds = Array.from(selectedSeats);
  try {
    const res = await fetch('/api/holds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId })
    });

    if (res.status === 409) {
      const data = await res.json();
      showMessage(`Some seats taken: ${data.conflictingSeatIds.join(', ')}`, 'error');
      selectedSeats.clear();
      await fetchSeats();
      return;
    }

    if (!res.ok) {
      const data = await res.json();
      showMessage(data.error || 'Hold failed', 'error');
      return;
    }

    const data = await res.json();
    currentHold = { holdId: data.holdId, expiresAt: data.expiresAt, seatIds: data.seatIds };
    selectedSeats.clear();
    showMessage(`Hold successful! Hold ID: ${data.holdId}`);
    await fetchSeats();
  } catch (err) {
    console.error(err);
    showMessage('Network error', 'error');
  }
}

async function confirmHold() {
  if (!currentHold) return;

  try {
    const res = await fetch(`/api/holds/${currentHold.holdId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    });

    const data = await res.json();
    if (!res.ok) {
      showMessage(data.error || 'Confirm failed', 'error');
      if (data.error && (data.error.includes('expired') || data.error.includes('not found'))) {
        currentHold = null;
        await fetchSeats();
      }
      return;
    }

    showMessage(data.alreadyConfirmed ? 'Already confirmed!' : 'Booking confirmed!');
    currentHold = null;
    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }
    await fetchSeats();
  } catch (err) {
    console.error(err);
    showMessage('Network error', 'error');
  }
}

async function releaseHold() {
  if (!currentHold) return;

  try {
    const res = await fetch(`/api/holds/${currentHold.holdId}`, {
      method: 'DELETE'
    });
    const data = await res.json();
    if (res.ok) {
      showMessage('Hold released');
    }
    currentHold = null;
    if (countdownInterval) clearInterval(countdownInterval);
    countdownInterval = null;
    selectedSeats.clear();
    await fetchSeats();
  } catch (err) {
    console.error(err);
  }
}

function connectSSE() {
  const eventSource = new EventSource('/api/stream');

  eventSource.onmessage = (event) => {
    // generic
  };

  eventSource.addEventListener('connected', () => {
    console.log('SSE connected');
  });

  eventSource.addEventListener('seats-held', (event) => {
    const data = JSON.parse(event.data);
    // Update local state optimistically or refetch
    fetchSeats();
  });

  eventSource.addEventListener('seats-booked', (event) => {
    const data = JSON.parse(event.data);
    fetchSeats();
    if (currentHold && currentHold.holdId === data.holdId) {
      currentHold = null;
      if (countdownInterval) clearInterval(countdownInterval);
    }
  });

  eventSource.addEventListener('seats-released', (event) => {
    const data = JSON.parse(event.data);
    fetchSeats();
    if (currentHold && data.seatIds.some(id => currentHold.seatIds.includes(id))) {
      // Our hold was released externally? unlikely
    }
  });

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

  // Refresh seats periodically as fallback
  setInterval(fetchSeats, 30000);
}

init();