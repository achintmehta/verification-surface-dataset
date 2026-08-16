const API_BASE = 'http://localhost:3000/api';
let selectedSeats = new Set();
let currentHold = null;
let eventSource = null;
let seatsData = [];

async function fetchSeats() {
  try {
    const res = await fetch(`${API_BASE}/seats`);
    seatsData = await res.json();
    renderSeatMap();
    updateStatus();
  } catch (err) {
    console.error('Failed to fetch seats:', err);
  }
}

function renderSeatMap() {
  const container = document.getElementById('seatMap');
  container.innerHTML = '';

  const rows = {};
  seatsData.forEach(seat => {
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
      seatEl.className = `seat ${seat.status}`;
      seatEl.textContent = seat.seat_number;
      seatEl.dataset.id = seat.id;
      seatEl.dataset.status = seat.status;

      if (seat.status === 'available') {
        seatEl.addEventListener('click', () => toggleSeatSelection(seat, seatEl));
      } else if (seat.status === 'held' && currentHold && seat.hold_id === currentHold.holdId) {
        seatEl.classList.add('selected');
      }

      rowDiv.appendChild(seatEl);
    });

    container.appendChild(rowDiv);
  });
}

function toggleSeatSelection(seat, seatEl) {
  const id = seat.id;
  if (selectedSeats.has(id)) {
    selectedSeats.delete(id);
    seatEl.classList.remove('selected');
  } else {
    selectedSeats.add(id);
    seatEl.classList.add('selected');
  }
  updateControls();
}

function updateControls() {
  const holdBtn = document.getElementById('holdBtn');
  const confirmBtn = document.getElementById('confirmBtn');
  const releaseBtn = document.getElementById('releaseBtn');

  holdBtn.disabled = selectedSeats.size === 0 || !!currentHold;
  confirmBtn.disabled = !currentHold;
  releaseBtn.disabled = !currentHold;
}

function updateStatus() {
  const statusEl = document.getElementById('status');
  const available = seatsData.filter(s => s.status === 'available').length;
  const held = seatsData.filter(s => s.status === 'held').length;
  const booked = seatsData.filter(s => s.status === 'booked').length;
  statusEl.innerHTML = `Available: ${available} | Held: ${held} | Booked: ${booked} | Total: ${seatsData.length}`;
}

function updateHoldInfo() {
  const infoEl = document.getElementById('holdInfo');
  if (!currentHold) {
    infoEl.innerHTML = '';
    return;
  }

  const expiresAt = new Date(currentHold.expiresAt);
  const remaining = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  infoEl.innerHTML = `
    Hold active: ${currentHold.seatIds.length} seats. 
    Expires in: <span id="countdown">${remaining}</span>s
    <br>Hold ID: ${currentHold.holdId}
  `;

  // Start countdown
  if (window.countdownInterval) clearInterval(window.countdownInterval);
  window.countdownInterval = setInterval(() => {
    const cd = document.getElementById('countdown');
    if (!cd || !currentHold) {
      clearInterval(window.countdownInterval);
      return;
    }
    const rem = Math.max(0, Math.floor((new Date(currentHold.expiresAt) - Date.now()) / 1000));
    cd.textContent = rem;
    if (rem <= 0) {
      clearInterval(window.countdownInterval);
      currentHold = null;
      updateHoldInfo();
      updateControls();
      fetchSeats();
    }
  }, 1000);
}

async function requestHold() {
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
      alert(`Some seats are taken: ${data.conflictingSeats.join(', ')}`);
      selectedSeats.clear();
      await fetchSeats();
      return;
    }

    if (!res.ok) {
      const err = await res.json();
      alert(err.error || 'Failed to hold seats');
      return;
    }

    currentHold = await res.json();
    selectedSeats.clear();
    updateControls();
    updateHoldInfo();
    await fetchSeats();
  } catch (err) {
    console.error(err);
    alert('Error requesting hold');
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
      alert(err.error || 'Failed to confirm');
      if (res.status === 410 || res.status === 404) {
        currentHold = null;
        updateHoldInfo();
        updateControls();
      }
      await fetchSeats();
      return;
    }

    const data = await res.json();
    alert('Booking confirmed! Seats are now yours.');
    currentHold = null;
    updateHoldInfo();
    updateControls();
    await fetchSeats();
  } catch (err) {
    console.error(err);
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
    updateControls();
    await fetchSeats();
  } catch (err) {
    console.error(err);
  }
}

function connectSSE() {
  if (eventSource) eventSource.close();
  
  eventSource = new EventSource(`${API_BASE}/stream`);
  
  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'seat-update' && data.seats) {
        // Update local seatsData
        data.seats.forEach(updated => {
          const idx = seatsData.findIndex(s => s.id === updated.id);
          if (idx !== -1) {
            seatsData[idx] = { ...seatsData[idx], ...updated };
          }
        });
        renderSeatMap();
        updateStatus();
      }
    } catch (e) {
      // ignore parse errors for connected msg
    }
  };

  eventSource.onerror = () => {
    console.log('SSE disconnected, reconnecting...');
    setTimeout(connectSSE, 3000);
  };
}

function setupEventListeners() {
  document.getElementById('holdBtn').addEventListener('click', requestHold);
  document.getElementById('confirmBtn').addEventListener('click', confirmHold);
  document.getElementById('releaseBtn').addEventListener('click', releaseHold);
  document.getElementById('refreshBtn').addEventListener('click', fetchSeats);

  // Initial selection clear on refresh etc.
}

async function init() {
  setupEventListeners();
  await fetchSeats();
  connectSSE();
  updateControls();
}

init();