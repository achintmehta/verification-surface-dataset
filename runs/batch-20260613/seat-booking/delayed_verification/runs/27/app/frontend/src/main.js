const API_BASE = '/api';
let selectedSeats = new Set();
let currentHold = null;
let countdownInterval = null;
let sessionId = 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

// Render seat map
function renderSeats(seats) {
  const container = document.getElementById('seat-map');
  container.innerHTML = '';

  // Group by row
  const rows = {};
  seats.forEach(seat => {
    if (!rows[seat.row_label]) rows[seat.row_label] = [];
    rows[seat.row_label].push(seat);
  });

  Object.keys(rows).sort().forEach(rowLabel => {
    rows[rowLabel].sort((a, b) => a.seat_number - b.seat_number).forEach(seat => {
      const el = document.createElement('div');
      el.className = `seat ${seat.status}`;
      el.textContent = `${seat.row_label}${seat.seat_number}`;
      el.dataset.id = seat.id;
      el.dataset.status = seat.status;

      if (seat.status === 'available') {
        el.addEventListener('click', () => toggleSelect(seat.id, el));
      } else if (seat.status === 'held' && currentHold && seat.hold_id === currentHold.holdId) {
        // Our hold - allow interaction?
        el.classList.add('selected');
      }

      container.appendChild(el);
    });
  });
}

function toggleSelect(seatId, el) {
  if (currentHold) return; // Can't select while holding

  if (selectedSeats.has(seatId)) {
    selectedSeats.delete(seatId);
    el.classList.remove('selected');
    el.classList.add('available');
  } else {
    selectedSeats.add(seatId);
    el.classList.remove('available');
    el.classList.add('selected');
  }

  updateControls();
}

function updateControls() {
  const holdBtn = document.getElementById('hold-btn');
  const confirmBtn = document.getElementById('confirm-btn');
  const releaseBtn = document.getElementById('release-btn');

  holdBtn.disabled = selectedSeats.size === 0 || !!currentHold;
  confirmBtn.disabled = !currentHold;
  releaseBtn.disabled = !currentHold;
}

function showStatus(msg, isError = false) {
  const statusEl = document.getElementById('status');
  statusEl.textContent = msg;
  statusEl.style.color = isError ? 'red' : 'green';
  setTimeout(() => { statusEl.textContent = ''; }, 3000);
}

async function fetchSeats() {
  try {
    const res = await fetch(`${API_BASE}/seats`);
    const seats = await res.json();
    renderSeats(seats);
    return seats;
  } catch (e) {
    console.error(e);
    showStatus('Failed to load seats', true);
  }
}

async function requestHold() {
  if (selectedSeats.size === 0) return;

  const seatIds = Array.from(selectedSeats);
  
  try {
    const res = await fetch(`${API_BASE}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId })
    });

    if (res.status === 409) {
      const data = await res.json();
      showStatus(`Seats already taken: ${data.conflicts.join(', ')}`, true);
      selectedSeats.clear();
      await fetchSeats();
      return;
    }

    if (!res.ok) throw new Error('Hold failed');

    const hold = await res.json();
    currentHold = hold;
    selectedSeats.clear();

    // Show hold info
    document.getElementById('hold-info').style.display = 'block';
    document.getElementById('hold-id').textContent = hold.holdId;
    startCountdown(hold.expiresAt);

    showStatus(`Hold successful for ${hold.seatIds.length} seats`);
    await fetchSeats();
    updateControls();
  } catch (e) {
    console.error(e);
    showStatus('Hold request failed', true);
  }
}

function startCountdown(expiresAt) {
  if (countdownInterval) clearInterval(countdownInterval);

  const countdownEl = document.getElementById('countdown');

  countdownInterval = setInterval(() => {
    const remaining = Math.max(0, Math.floor((new Date(expiresAt) - new Date()) / 1000));
    const min = Math.floor(remaining / 60);
    const sec = remaining % 60;
    countdownEl.textContent = `${min}:${sec.toString().padStart(2, '0')}`;

    if (remaining <= 0) {
      clearInterval(countdownInterval);
      handleHoldExpired();
    }
  }, 1000);
}

async function handleHoldExpired() {
  showStatus('Hold expired', true);
  currentHold = null;
  document.getElementById('hold-info').style.display = 'none';
  await fetchSeats();
  updateControls();
}

async function confirmHold() {
  if (!currentHold) return;

  try {
    const res = await fetch(`${API_BASE}/holds/${currentHold.holdId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    });

    if (!res.ok) {
      const err = await res.json();
      showStatus(err.error || 'Confirm failed', true);
      if (err.error === 'Hold expired') {
        await handleHoldExpired();
      }
      return;
    }

    const data = await res.json();
    showStatus('Booking confirmed! Seats are yours.');
    
    // Clear hold
    currentHold = null;
    if (countdownInterval) clearInterval(countdownInterval);
    document.getElementById('hold-info').style.display = 'none';

    await fetchSeats();
    updateControls();
  } catch (e) {
    console.error(e);
    showStatus('Confirm failed', true);
  }
}

async function releaseHold() {
  if (!currentHold) return;

  try {
    await fetch(`${API_BASE}/holds/${currentHold.holdId}`, { method: 'DELETE' });
    showStatus('Hold released');
    currentHold = null;
    if (countdownInterval) clearInterval(countdownInterval);
    document.getElementById('hold-info').style.display = 'none';
    await fetchSeats();
    updateControls();
  } catch (e) {
    console.error(e);
  }
}

function connectSSE() {
  const eventSource = new EventSource(`${API_BASE}/stream`);

  eventSource.addEventListener('seats-held', (e) => {
    const data = JSON.parse(e.data);
    // Refresh to show held seats (could be optimized to update specific)
    fetchSeats();
  });

  eventSource.addEventListener('seats-booked', (e) => {
    fetchSeats();
  });

  eventSource.addEventListener('seats-released', (e) => {
    fetchSeats();
  });

  eventSource.onopen = () => console.log('SSE connected');
  eventSource.onerror = (e) => console.log('SSE error', e);
}

// Event listeners
document.getElementById('hold-btn').addEventListener('click', requestHold);
document.getElementById('confirm-btn').addEventListener('click', confirmHold);
document.getElementById('release-btn').addEventListener('click', releaseHold);
document.getElementById('refresh-btn').addEventListener('click', fetchSeats);

// Init
async function init() {
  await fetchSeats();
  connectSSE();
  updateControls();
  console.log('Session ID:', sessionId);
}

init();