const API_BASE = '/api';
let selectedSeats = new Set();
let currentHold = null;
let countdownInterval = null;
let sessionId = 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

const seatMapEl = document.getElementById('seat-map');
const holdBtn = document.getElementById('hold-btn');
const confirmBtn = document.getElementById('confirm-btn');
const releaseBtn = document.getElementById('release-btn');
const refreshBtn = document.getElementById('refresh-btn');
const statusEl = document.getElementById('status');
const holdInfoEl = document.getElementById('hold-info');
const holdIdEl = document.getElementById('hold-id');
const countdownEl = document.getElementById('countdown');

function showStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.style.color = isError ? '#d32f2f' : '#2e7d32';
  setTimeout(() => { statusEl.textContent = ''; }, 4000);
}

async function fetchSeats() {
  try {
    const res = await fetch(`${API_BASE}/seats`);
    const data = await res.json();
    return data.seats;
  } catch (e) {
    console.error(e);
    showStatus('Failed to load seats', true);
    return [];
  }
}

function renderSeats(seats) {
  seatMapEl.innerHTML = '';
  
  // Group by row
  const rows = {};
  seats.forEach(seat => {
    if (!rows[seat.row]) rows[seat.row] = [];
    rows[seat.row].push(seat);
  });

  Object.keys(rows).sort().forEach(rowLabel => {
    rows[rowLabel].sort((a, b) => a.number - b.number).forEach(seat => {
      const seatEl = document.createElement('div');
      seatEl.className = `seat ${seat.status}`;
      seatEl.textContent = `${seat.row}${seat.number}`;
      seatEl.dataset.id = seat.id;
      seatEl.dataset.status = seat.status;

      if (seat.status === 'available') {
        seatEl.addEventListener('click', () => toggleSeatSelection(seat.id, seatEl));
      } else if (seat.status === 'held' && currentHold && seat.holdId === currentHold.holdId) {
        // Allow interaction with own hold? but for now visual
        seatEl.style.borderColor = '#ff9800';
      }

      seatMapEl.appendChild(seatEl);
    });
  });

  updateControls();
}

function toggleSeatSelection(seatId, seatEl) {
  if (currentHold) {
    showStatus('Release or confirm current hold first', true);
    return;
  }

  if (selectedSeats.has(seatId)) {
    selectedSeats.delete(seatId);
    seatEl.classList.remove('selected');
  } else {
    selectedSeats.add(seatId);
    seatEl.classList.add('selected');
  }
  updateControls();
}

function updateControls() {
  holdBtn.disabled = selectedSeats.size === 0 || !!currentHold;
  confirmBtn.disabled = !currentHold;
  releaseBtn.disabled = !currentHold;
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
      showStatus(`Seats taken: ${data.conflictingSeatIds.join(', ')}`, true);
      selectedSeats.clear();
      await refreshSeatMap();
      return;
    }

    if (!res.ok) {
      const data = await res.json();
      showStatus(data.error || 'Hold failed', true);
      return;
    }

    const hold = await res.json();
    currentHold = hold;
    selectedSeats.clear();
    
    holdIdEl.textContent = hold.holdId;
    holdInfoEl.style.display = 'block';
    startCountdown(hold.expiresAt);
    
    showStatus(`Hold acquired for ${hold.seatIds.length} seats`);
    await refreshSeatMap();
    updateControls();
  } catch (e) {
    showStatus('Hold request failed', true);
  }
}

function startCountdown(expiresAt) {
  if (countdownInterval) clearInterval(countdownInterval);
  
  countdownInterval = setInterval(() => {
    const remaining = new Date(expiresAt) - new Date();
    if (remaining <= 0) {
      clearInterval(countdownInterval);
      countdownEl.textContent = 'Expired';
      handleHoldExpired();
    } else {
      const mins = Math.floor(remaining / 60000);
      const secs = Math.floor((remaining % 60000) / 1000);
      countdownEl.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
    }
  }, 1000);
}

async function handleHoldExpired() {
  currentHold = null;
  holdInfoEl.style.display = 'none';
  updateControls();
  await refreshSeatMap();
  showStatus('Hold expired', true);
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
      const data = await res.json();
      showStatus(data.error || 'Confirm failed', true);
      if (data.error && data.error.includes('expired')) {
        await handleHoldExpired();
      }
      return;
    }

    const result = await res.json();
    showStatus(`Booked seats: ${result.seatIds.join(', ')}`);
    
    // Clear hold
    if (countdownInterval) clearInterval(countdownInterval);
    currentHold = null;
    holdInfoEl.style.display = 'none';
    updateControls();
    await refreshSeatMap();
  } catch (e) {
    showStatus('Confirm failed', true);
  }
}

async function releaseHold() {
  if (!currentHold) return;

  try {
    await fetch(`${API_BASE}/holds/${currentHold.holdId}`, { method: 'DELETE' });
    
    if (countdownInterval) clearInterval(countdownInterval);
    currentHold = null;
    holdInfoEl.style.display = 'none';
    showStatus('Hold released');
    updateControls();
    await refreshSeatMap();
  } catch (e) {
    showStatus('Release failed', true);
  }
}

async function refreshSeatMap() {
  const seats = await fetchSeats();
  renderSeats(seats);
}

function connectSSE() {
  const eventSource = new EventSource(`${API_BASE}/stream`);
  
  eventSource.addEventListener('connected', () => {
    console.log('SSE connected');
  });

  eventSource.addEventListener('seats-held', (e) => {
    const data = JSON.parse(e.data);
    // If not our hold, refresh map
    if (!currentHold || data.holdId !== currentHold.holdId) {
      refreshSeatMap();
    }
  });

  eventSource.addEventListener('seats-booked', () => {
    refreshSeatMap();
  });

  eventSource.addEventListener('seats-released', () => {
    refreshSeatMap();
  });

  eventSource.onerror = () => {
    console.log('SSE error, will reconnect on next action');
  };
}

function init() {
  holdBtn.addEventListener('click', requestHold);
  confirmBtn.addEventListener('click', confirmHold);
  releaseBtn.addEventListener('click', releaseHold);
  refreshBtn.addEventListener('click', refreshSeatMap);

  // Initial load
  refreshSeatMap();
  connectSSE();

  // Auto refresh every 10s as fallback
  setInterval(refreshSeatMap, 10000);
}

init();