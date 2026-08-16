const API_BASE = '/api';
let selectedSeats = new Set();
let currentHold = null;
let countdownInterval = null;
let seatsData = [];

async function fetchSeats() {
  const res = await fetch(`${API_BASE}/seats`);
  if (!res.ok) throw new Error('Failed to fetch seats');
  return res.json();
}

function renderSeatMap(seats) {
  seatsData = seats;
  const container = document.getElementById('seat-map');
  container.innerHTML = '';

  const rows = {};
  seats.forEach(seat => {
    if (!rows[seat.row_label]) rows[seat.row_label] = [];
    rows[seat.row_label].push(seat);
  });

  Object.keys(rows).sort().forEach(rowLabel => {
    const rowDiv = document.createElement('div');
    rowDiv.className = 'row';

    const label = document.createElement('div');
    label.className = 'row-label';
    label.textContent = rowLabel;
    rowDiv.appendChild(label);

    rows[rowLabel].sort((a, b) => a.seat_number - b.seat_number).forEach(seat => {
      const seatEl = document.createElement('div');
      seatEl.className = `seat ${seat.effective_status}`;
      seatEl.textContent = seat.seat_number;
      seatEl.dataset.id = seat.id;
      seatEl.dataset.status = seat.effective_status;

      if (seat.effective_status === 'available') {
        seatEl.addEventListener('click', () => toggleSeatSelection(seat.id, seatEl));
      } else {
        seatEl.style.cursor = 'not-allowed';
      }

      // Highlight if selected
      if (selectedSeats.has(seat.id)) {
        seatEl.classList.add('selected');
        seatEl.classList.remove(seat.effective_status);
      }

      rowDiv.appendChild(seatEl);
    });

    container.appendChild(rowDiv);
  });

  updateControls();
}

function toggleSeatSelection(seatId, seatEl) {
  if (currentHold) return; // Can't select while holding

  if (selectedSeats.has(seatId)) {
    selectedSeats.delete(seatId);
    seatEl.classList.remove('selected');
    seatEl.classList.add('available');
  } else {
    selectedSeats.add(seatId);
    seatEl.classList.add('selected');
    seatEl.classList.remove('available');
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

function updateStatus(msg, isError = false) {
  const statusEl = document.getElementById('status');
  statusEl.textContent = msg;
  statusEl.style.color = isError ? '#d32f2f' : '#333';
}

function showHoldInfo(hold) {
  const infoEl = document.getElementById('hold-info');
  infoEl.style.display = 'block';
  infoEl.innerHTML = `
    <strong>Hold Active</strong> (Hold ID: ${hold.holdId})<br>
    Seats: ${hold.seats.map(s => s.row_label + s.seat_number).join(', ')}<br>
    <span class="countdown">Expires in: <span id="countdown">2:00</span></span>
  `;
  startCountdown(hold.expiresAt);
}

function hideHoldInfo() {
  const infoEl = document.getElementById('hold-info');
  infoEl.style.display = 'none';
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
}

function startCountdown(expiresAt) {
  if (countdownInterval) clearInterval(countdownInterval);

  countdownInterval = setInterval(() => {
    const now = Date.now();
    const exp = new Date(expiresAt).getTime();
    const diff = Math.max(0, Math.floor((exp - now) / 1000));
    const min = Math.floor(diff / 60);
    const sec = diff % 60;
    const cdEl = document.getElementById('countdown');
    if (cdEl) {
      cdEl.textContent = `${min}:${sec.toString().padStart(2, '0')}`;
    }
    if (diff <= 0) {
      clearInterval(countdownInterval);
      updateStatus('Hold expired. Seats released.', true);
      currentHold = null;
      hideHoldInfo();
      selectedSeats.clear();
      refreshSeatMap();
    }
  }, 1000);
}

async function requestHold() {
  if (selectedSeats.size === 0) return;

  const sessionId = localStorage.getItem('sessionId') || `session_${Date.now()}`;
  localStorage.setItem('sessionId', sessionId);

  const seatIds = Array.from(selectedSeats);

  try {
    const res = await fetch(`${API_BASE}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId })
    });

    if (res.status === 409) {
      const data = await res.json();
      updateStatus(`Hold failed. Seats already taken: ${data.conflictingSeatIds.join(', ')}`, true);
      selectedSeats.clear();
      await refreshSeatMap();
      return;
    }

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Hold request failed');
    }

    const hold = await res.json();
    currentHold = hold;
    selectedSeats.clear();
    updateStatus(`Hold successful! Expires at ${new Date(hold.expiresAt).toLocaleTimeString()}`);
    showHoldInfo(hold);
    await refreshSeatMap();
  } catch (err) {
    updateStatus(err.message, true);
  }
}

async function confirmHold() {
  if (!currentHold) return;

  const sessionId = localStorage.getItem('sessionId');
  try {
    const res = await fetch(`${API_BASE}/holds/${currentHold.holdId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Confirmation failed');
    }

    const result = await res.json();
    updateStatus('Booking confirmed! Seats are now yours.');
    currentHold = null;
    hideHoldInfo();
    await refreshSeatMap();
  } catch (err) {
    updateStatus(err.message, true);
    // Refresh in case of expiry etc.
    await refreshSeatMap();
  }
}

async function releaseHold() {
  if (!currentHold) return;

  try {
    await fetch(`${API_BASE}/holds/${currentHold.holdId}`, { method: 'DELETE' });
    updateStatus('Hold released.');
    currentHold = null;
    hideHoldInfo();
    selectedSeats.clear();
    await refreshSeatMap();
  } catch (err) {
    updateStatus('Failed to release hold', true);
  }
}

async function refreshSeatMap() {
  try {
    const seats = await fetchSeats();
    renderSeatMap(seats);
  } catch (err) {
    updateStatus('Failed to refresh seats', true);
  }
}

function connectSSE() {
  const eventSource = new EventSource(`${API_BASE}/stream`);

  eventSource.addEventListener('connected', () => {
    console.log('SSE connected');
  });

  eventSource.addEventListener('seats-held', (e) => {
    const data = JSON.parse(e.data);
    console.log('Seats held by someone:', data);
    refreshSeatMap();
  });

  eventSource.addEventListener('seats-booked', (e) => {
    const data = JSON.parse(e.data);
    console.log('Seats booked:', data);
    if (currentHold && currentHold.holdId === data.holdId) {
      // Our own booking
    }
    refreshSeatMap();
  });

  eventSource.addEventListener('seats-released', (e) => {
    const data = JSON.parse(e.data);
    console.log('Seats released:', data);
    refreshSeatMap();
  });

  eventSource.onerror = () => {
    console.log('SSE error, will reconnect...');
    setTimeout(() => {
      if (!eventSource.closed) eventSource.close();
      connectSSE();
    }, 3000);
  };
}

function init() {
  // Buttons
  document.getElementById('hold-btn').addEventListener('click', requestHold);
  document.getElementById('confirm-btn').addEventListener('click', confirmHold);
  document.getElementById('release-btn').addEventListener('click', releaseHold);
  document.getElementById('refresh-btn').addEventListener('click', refreshSeatMap);

  // Initial load
  refreshSeatMap();
  connectSSE();

  updateStatus('Welcome! Select available seats to hold.');
}

init();