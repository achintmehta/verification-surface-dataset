const API_BASE = '/api';
let selectedSeats = new Set();
let currentHold = null;
let eventSource = null;
let seatsData = [];
let totalSeats = 50; // 5x10

async function fetchSeats() {
  const res = await fetch(`${API_BASE}/seats`);
  const data = await res.json();
  seatsData = data.seats;
  totalSeats = data.total || 50;
  renderSeatMap();
  updateInventory();
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
  document.getElementById('total-count').textContent = totalSeats;
}

function renderSeatMap() {
  const map = document.getElementById('seat-map');
  map.innerHTML = '';
  const byRow = {};
  seatsData.forEach(seat => {
    if (!byRow[seat.row_label]) byRow[seat.row_label] = [];
    byRow[seat.row_label].push(seat);
  });

  Object.keys(byRow).sort().forEach(row => {
    byRow[row].sort((a, b) => a.seat_number - b.seat_number).forEach(seat => {
      const div = document.createElement('div');
      div.className = `seat ${seat.status}`;
      div.textContent = `${seat.row_label}${seat.seat_number}`;
      div.dataset.id = seat.id;

      if (seat.status === 'available') {
        div.addEventListener('click', () => toggleSelect(seat.id, div));
      } else if (seat.status === 'held' && currentHold && currentHold.seatIds.includes(seat.id)) {
        div.classList.add('selected');
      }

      map.appendChild(div);
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
  updateControls();
}

function updateControls() {
  const holdBtn = document.getElementById('hold-btn');
  const confirmBtn = document.getElementById('confirm-btn');
  const releaseBtn = document.getElementById('release-btn');
  const holdInfo = document.getElementById('hold-info');

  holdBtn.disabled = selectedSeats.size === 0 || currentHold !== null;
  confirmBtn.disabled = !currentHold;
  releaseBtn.disabled = !currentHold;

  if (currentHold) {
    const remaining = Math.max(0, Math.floor((currentHold.expiresAt - Date.now()) / 1000));
    holdInfo.innerHTML = `Hold active: ${currentHold.seatIds.length} seats. Expires in <span id="countdown">${remaining}</span>s`;
    startCountdown();
  } else {
    holdInfo.innerHTML = '';
  }
}

let countdownInterval = null;
function startCountdown() {
  if (countdownInterval) clearInterval(countdownInterval);
  countdownInterval = setInterval(() => {
    if (!currentHold) {
      clearInterval(countdownInterval);
      return;
    }
    const remaining = Math.max(0, Math.floor((currentHold.expiresAt - Date.now()) / 1000));
    const cd = document.getElementById('countdown');
    if (cd) cd.textContent = remaining;
    if (remaining <= 0) {
      clearInterval(countdownInterval);
      currentHold = null;
      selectedSeats.clear();
      fetchSeats();
      updateControls();
    }
  }, 1000);
}

async function requestHold() {
  const messageEl = document.getElementById('message');
  messageEl.textContent = '';
  messageEl.className = '';

  const seatIds = Array.from(selectedSeats);
  const sessionId = getSessionId();

  try {
    const res = await fetch(`${API_BASE}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId })
    });

    if (res.status === 409) {
      const err = await res.json();
      messageEl.textContent = `Some seats unavailable: ${err.conflictingSeats.join(', ')}`;
      messageEl.className = 'error';
      await fetchSeats();
      selectedSeats.clear();
      return;
    }

    if (!res.ok) throw new Error('Hold failed');

    const hold = await res.json();
    currentHold = {
      holdId: hold.holdId,
      seatIds: hold.seatIds,
      expiresAt: Date.now() + (hold.ttlSeconds * 1000)
    };
    selectedSeats.clear();
    messageEl.textContent = 'Hold successful!';
    messageEl.className = 'success';
    await fetchSeats();
    updateControls();
  } catch (e) {
    messageEl.textContent = e.message;
    messageEl.className = 'error';
  }
}

async function confirmHold() {
  if (!currentHold) return;
  const messageEl = document.getElementById('message');
  messageEl.textContent = '';
  messageEl.className = '';

  try {
    const res = await fetch(`${API_BASE}/holds/${currentHold.holdId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: getSessionId() })
    });

    if (!res.ok) {
      const err = await res.json();
      messageEl.textContent = err.error || 'Confirm failed';
      messageEl.className = 'error';
      currentHold = null;
      await fetchSeats();
      updateControls();
      return;
    }

    const result = await res.json();
    messageEl.textContent = 'Booking confirmed!';
    messageEl.className = 'success';
    currentHold = null;
    await fetchSeats();
    updateControls();
  } catch (e) {
    messageEl.textContent = e.message;
    messageEl.className = 'error';
  }
}

async function releaseHold() {
  if (!currentHold) return;
  const messageEl = document.getElementById('message');

  try {
    await fetch(`${API_BASE}/holds/${currentHold.holdId}`, {
      method: 'DELETE'
    });
    currentHold = null;
    selectedSeats.clear();
    messageEl.textContent = 'Hold released';
    messageEl.className = 'success';
    await fetchSeats();
    updateControls();
  } catch (e) {
    messageEl.textContent = e.message;
    messageEl.className = 'error';
  }
}

function getSessionId() {
  let sid = localStorage.getItem('sessionId');
  if (!sid) {
    sid = 'sess_' + Math.random().toString(36).substr(2, 9);
    localStorage.setItem('sessionId', sid);
  }
  return sid;
}

function connectSSE() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`${API_BASE}/stream`);

  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'seat-update') {
      // Update local seatsData
      const updated = data.seats;
      seatsData = seatsData.map(s => {
        const u = updated.find(x => x.id === s.id);
        return u ? { ...s, ...u } : s;
      });
      renderSeatMap();
      updateInventory();
    } else if (data.type === 'hold-expired') {
      if (currentHold && currentHold.holdId === data.holdId) {
        currentHold = null;
        updateControls();
      }
      fetchSeats();
    }
  };

  eventSource.onerror = () => {
    console.log('SSE error, reconnecting...');
    setTimeout(connectSSE, 3000);
  };
}

function init() {
  document.getElementById('hold-btn').addEventListener('click', requestHold);
  document.getElementById('confirm-btn').addEventListener('click', confirmHold);
  document.getElementById('release-btn').addEventListener('click', releaseHold);

  fetchSeats().then(() => {
    updateControls();
    connectSSE();
  });

  // Periodic refresh as fallback
  setInterval(fetchSeats, 30000);
}

init();