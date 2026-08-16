const API_BASE = '/api';
let selectedSeats = new Set();
let currentHold = null;
let eventSource = null;
let seatsData = [];

async function fetchSeats() {
  try {
    const res = await fetch(`${API_BASE}/seats`);
    if (!res.ok) throw new Error('Failed to fetch seats');
    seatsData = await res.json();
    renderSeatMap();
    updateInventory();
  } catch (err) {
    showMessage(err.message, true);
  }
}

function updateInventory() {
  let available = 0, held = 0, booked = 0;
  seatsData.forEach(seat => {
    if (seat.status === 'available') available++;
    else if (seat.status === 'held') held++;
    else if (seat.status === 'booked') booked++;
  });
  document.getElementById('available-count').textContent = available;
  document.getElementById('held-count').textContent = held;
  document.getElementById('booked-count').textContent = booked;
}

function renderSeatMap() {
  const container = document.getElementById('seat-map');
  container.innerHTML = '';
  const seatMap = {};
  seatsData.forEach(seat => {
    const key = `${seat.row_label}-${seat.seat_number}`;
    seatMap[key] = seat;
  });

  // Assume 5 rows A-E, 10 seats each
  const rows = ['A', 'B', 'C', 'D', 'E'];
  rows.forEach(row => {
    for (let num = 1; num <= 10; num++) {
      const seatEl = document.createElement('div');
      seatEl.className = 'seat';
      const seatKey = `${row}-${num}`;
      const seat = seatMap[seatKey] || { status: 'available', id: null };
      
      seatEl.textContent = `${row}${num}`;
      seatEl.dataset.seatId = seat.id || `${row}${num}`; // fallback
      seatEl.dataset.row = row;
      seatEl.dataset.number = num;

      if (seat.status === 'booked') {
        seatEl.classList.add('booked');
      } else if (seat.status === 'held') {
        seatEl.classList.add('held');
      } else {
        seatEl.classList.add('available');
        seatEl.addEventListener('click', () => toggleSeatSelection(seatEl, seat));
      }

      if (selectedSeats.has(seat.id)) {
        seatEl.classList.add('selected');
      }

      container.appendChild(seatEl);
    }
  });
}

function toggleSeatSelection(seatEl, seat) {
  const seatId = seat.id;
  if (!seatId) return;
  
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

  holdBtn.disabled = selectedSeats.size === 0 || currentHold !== null;
  confirmBtn.disabled = !currentHold;
  releaseBtn.disabled = !currentHold;
}

async function requestHold() {
  const messageEl = document.getElementById('message');
  messageEl.textContent = '';
  if (selectedSeats.size === 0) return;

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
      showMessage(`Some seats unavailable: ${data.conflictingSeats?.join(', ')}`, true);
      selectedSeats.clear();
      await fetchSeats();
      return;
    }

    if (!res.ok) throw new Error('Hold request failed');

    const hold = await res.json();
    currentHold = hold;
    showHoldInfo(hold);
    selectedSeats.clear();
    await fetchSeats();
    updateButtons();
  } catch (err) {
    showMessage(err.message, true);
  }
}

function getSessionId() {
  let sessionId = localStorage.getItem('sessionId');
  if (!sessionId) {
    sessionId = 'sess_' + Math.random().toString(36).substr(2, 9);
    localStorage.setItem('sessionId', sessionId);
  }
  return sessionId;
}

function showHoldInfo(hold) {
  const infoEl = document.getElementById('hold-info');
  const expiresAt = new Date(hold.expires_at);
  const updateCountdown = () => {
    const now = new Date();
    const remaining = Math.max(0, Math.floor((expiresAt - now) / 1000));
    infoEl.innerHTML = `Hold active (ID: ${hold.id}). Expires in <strong>${remaining}s</strong>. Seats: ${hold.seatIds?.join(', ')}`;
    if (remaining > 0 && currentHold) {
      setTimeout(updateCountdown, 1000);
    } else if (currentHold) {
      infoEl.innerHTML = 'Hold expired.';
      currentHold = null;
      updateButtons();
      fetchSeats();
    }
  };
  updateCountdown();
}

async function confirmHold() {
  if (!currentHold) return;
  const messageEl = document.getElementById('message');
  try {
    const res = await fetch(`${API_BASE}/holds/${currentHold.id}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: getSessionId() })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Confirm failed');
    }
    const result = await res.json();
    showMessage('Booking confirmed! Seats booked.', false);
    currentHold = null;
    document.getElementById('hold-info').innerHTML = '';
    await fetchSeats();
    updateButtons();
  } catch (err) {
    showMessage(err.message, true);
    await fetchSeats();
  }
}

async function releaseHold() {
  if (!currentHold) return;
  try {
    await fetch(`${API_BASE}/holds/${currentHold.id}`, {
      method: 'DELETE'
    });
    currentHold = null;
    document.getElementById('hold-info').innerHTML = '';
    selectedSeats.clear();
    await fetchSeats();
    updateButtons();
  } catch (err) {
    showMessage(err.message, true);
  }
}

function showMessage(msg, isError) {
  const el = document.getElementById('message');
  el.textContent = msg;
  el.style.color = isError ? 'red' : 'green';
  setTimeout(() => { el.textContent = ''; }, 5000);
}

function connectSSE() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`${API_BASE}/stream`);
  
  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'seat-update') {
        // Update local seatsData
        const updatedSeat = data.seat;
        const idx = seatsData.findIndex(s => s.id === updatedSeat.id);
        if (idx !== -1) {
          seatsData[idx] = updatedSeat;
        } else {
          seatsData.push(updatedSeat);
        }
        renderSeatMap();
        updateInventory();
      } else if (data.type === 'seats-refresh') {
        fetchSeats();
      }
    } catch (e) {}
  };

  eventSource.onerror = () => {
    // Reconnect logic could be added
    setTimeout(connectSSE, 3000);
  };
}

function init() {
  document.getElementById('hold-btn').addEventListener('click', requestHold);
  document.getElementById('confirm-btn').addEventListener('click', confirmHold);
  document.getElementById('release-btn').addEventListener('click', releaseHold);
  document.getElementById('refresh-btn').addEventListener('click', fetchSeats);

  fetchSeats();
  connectSSE();
  updateButtons();
}

init();