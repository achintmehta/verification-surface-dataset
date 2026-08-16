const API_BASE = '/api';
let selectedSeats = new Set();
let currentHold = null;
let eventSource = null;
let seatsData = [];

async function fetchSeats() {
  try {
    const res = await fetch(`${API_BASE}/seats`);
    const data = await res.json();
    seatsData = data.seats;
    renderSeatMap();
    updateStatus();
  } catch (err) {
    console.error('Failed to fetch seats:', err);
    document.getElementById('status').textContent = 'Error loading seats';
  }
}

function renderSeatMap() {
  const container = document.getElementById('seat-map');
  container.innerHTML = '';

  const rows = {};
  seatsData.forEach(seat => {
    if (!rows[seat.row]) rows[seat.row] = [];
    rows[seat.row].push(seat);
  });

  Object.keys(rows).sort().forEach(rowLabel => {
    const rowDiv = document.createElement('div');
    rowDiv.className = 'row';

    const label = document.createElement('div');
    label.className = 'row-label';
    label.textContent = rowLabel;
    rowDiv.appendChild(label);

    rows[rowLabel].sort((a, b) => a.number - b.number).forEach(seat => {
      const seatEl = document.createElement('div');
      seatEl.className = `seat ${seat.status}`;
      seatEl.textContent = seat.number;
      seatEl.dataset.id = seat.id;

      if (seat.status === 'available') {
        seatEl.addEventListener('click', () => toggleSeatSelection(seat.id, seatEl));
      } else if (seat.status === 'held' && currentHold && seat.holdId === currentHold.holdId) {
        seatEl.classList.add('selected');
      }

      rowDiv.appendChild(seatEl);
    });

    container.appendChild(rowDiv);
  });

  updateButtons();
}

function toggleSeatSelection(seatId, seatEl) {
  if (currentHold) return; // Can't select while holding

  if (selectedSeats.has(seatId)) {
    selectedSeats.delete(seatId);
    seatEl.classList.remove('selected');
  } else {
    selectedSeats.add(seatId);
    seatEl.classList.add('selected');
  }
  updateButtons();
}

function updateButtons() {
  const holdBtn = document.getElementById('hold-btn');
  const confirmBtn = document.getElementById('confirm-btn');
  const releaseBtn = document.getElementById('release-btn');

  holdBtn.disabled = selectedSeats.size === 0 || !!currentHold;
  confirmBtn.disabled = !currentHold;
  releaseBtn.disabled = !currentHold;
}

function updateStatus() {
  const statusEl = document.getElementById('status');
  const available = seatsData.filter(s => s.status === 'available').length;
  const held = seatsData.filter(s => s.status === 'held').length;
  const booked = seatsData.filter(s => s.status === 'booked').length;
  statusEl.textContent = `Available: ${available} | Held: ${held} | Booked: ${booked} | Total: ${seatsData.length}`;
}

function updateHoldInfo() {
  const infoEl = document.getElementById('hold-info');
  if (currentHold) {
    const expires = new Date(currentHold.expiresAt);
    const remaining = Math.max(0, Math.floor((expires - Date.now()) / 1000));
    infoEl.innerHTML = `
      Hold active: ${currentHold.seatIds.join(', ')}<br>
      Expires in: <span id="countdown">${remaining}</span>s<br>
      Hold ID: ${currentHold.holdId}
    `;
    infoEl.style.display = 'block';

    // Start countdown
    if (window.countdownInterval) clearInterval(window.countdownInterval);
    window.countdownInterval = setInterval(() => {
      const cd = document.getElementById('countdown');
      if (cd) {
        const rem = Math.max(0, Math.floor((new Date(currentHold.expiresAt) - Date.now()) / 1000));
        cd.textContent = rem;
        if (rem <= 0) {
          clearInterval(window.countdownInterval);
          releaseHold();
        }
      }
    }, 1000);
  } else {
    infoEl.style.display = 'none';
    if (window.countdownInterval) {
      clearInterval(window.countdownInterval);
      window.countdownInterval = null;
    }
  }
}

async function requestHold() {
  if (selectedSeats.size === 0) return;

  const sessionId = localStorage.getItem('sessionId') || `session_${Date.now()}`;
  localStorage.setItem('sessionId', sessionId);

  try {
    const res = await fetch(`${API_BASE}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        seatIds: Array.from(selectedSeats),
        sessionId
      })
    });

    if (res.status === 409) {
      const data = await res.json();
      alert(`Some seats are unavailable: ${data.conflictingSeats.join(', ')}`);
      selectedSeats.clear();
      await fetchSeats();
      return;
    }

    if (!res.ok) {
      const data = await res.json();
      alert(data.error || 'Failed to hold seats');
      return;
    }

    const holdData = await res.json();
    currentHold = { ...holdData, sessionId };
    selectedSeats.clear();
    await fetchSeats();
    updateHoldInfo();
    updateButtons();
  } catch (err) {
    console.error(err);
    alert('Error requesting hold');
  }
}

async function confirmHold() {
  if (!currentHold) return;

  const sessionId = currentHold.sessionId;

  try {
    const res = await fetch(`${API_BASE}/holds/${currentHold.holdId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    });

    if (!res.ok) {
      const data = await res.json();
      alert(data.error || 'Failed to confirm');
      if (res.status === 410 || res.status === 404) {
        currentHold = null;
        updateHoldInfo();
        await fetchSeats();
      }
      return;
    }

    const result = await res.json();
    alert(`Successfully booked seats: ${result.seatIds.join(', ')}`);
    currentHold = null;
    updateHoldInfo();
    await fetchSeats();
    updateButtons();
  } catch (err) {
    console.error(err);
    alert('Error confirming hold');
  }
}

async function releaseHold() {
  if (!currentHold) return;

  try {
    await fetch(`${API_BASE}/holds/${currentHold.holdId}`, {
      method: 'DELETE'
    });
    currentHold = null;
    updateHoldInfo();
    await fetchSeats();
    updateButtons();
  } catch (err) {
    console.error(err);
  }
}

function connectSSE() {
  if (eventSource) eventSource.close();

  eventSource = new EventSource(`${API_BASE}/stream`);

  eventSource.addEventListener('connected', () => {
    console.log('SSE connected');
  });

  eventSource.addEventListener('seats-held', (e) => {
    const data = JSON.parse(e.data);
    console.log('Seats held:', data);
    // Update local state optimistically or refetch
    fetchSeats();
  });

  eventSource.addEventListener('seats-booked', (e) => {
    const data = JSON.parse(e.data);
    console.log('Seats booked:', data);
    if (currentHold && currentHold.holdId === data.holdId) {
      currentHold = null;
      updateHoldInfo();
    }
    fetchSeats();
  });

  eventSource.addEventListener('seats-released', (e) => {
    const data = JSON.parse(e.data);
    console.log('Seats released:', data);
    fetchSeats();
  });

  eventSource.onerror = (err) => {
    console.error('SSE error', err);
    // Reconnect after delay
    setTimeout(() => {
      if (eventSource) connectSSE();
    }, 5000);
  };
}

function setupEventListeners() {
  document.getElementById('hold-btn').addEventListener('click', requestHold);
  document.getElementById('confirm-btn').addEventListener('click', confirmHold);
  document.getElementById('release-btn').addEventListener('click', releaseHold);
  document.getElementById('refresh-btn').addEventListener('click', fetchSeats);

  // Keyboard support
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && currentHold) {
      releaseHold();
    }
  });
}

async function init() {
  setupEventListeners();
  await fetchSeats();
  connectSSE();
  updateButtons();
}

init();