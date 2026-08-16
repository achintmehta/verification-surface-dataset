import './style.css';

const API_BASE = 'http://localhost:3000/api';
let currentHold = null;
let selectedSeats = new Set();
let eventSource = null;
let seatsData = [];

const sessionInput = () => document.getElementById('session-id');
const seatMapEl = () => document.getElementById('seat-map');
const holdInfoEl = () => document.getElementById('hold-info');
const messagesEl = () => document.getElementById('messages');
const holdBtn = () => document.getElementById('hold-btn');
const confirmBtn = () => document.getElementById('confirm-btn');
const releaseBtn = () => document.getElementById('release-btn');
const inventoryEl = () => document.getElementById('inventory');

function showMessage(msg, isError = false) {
  const div = document.createElement('div');
  div.textContent = msg;
  div.className = isError ? 'error' : 'success';
  messagesEl().appendChild(div);
  setTimeout(() => div.remove(), 5000);
}

async function fetchSeats() {
  try {
    const res = await fetch(`${API_BASE}/seats`);
    seatsData = await res.json();
    renderSeatMap();
    updateInventory();
  } catch (e) {
    showMessage('Failed to load seats', true);
  }
}

function updateInventory() {
  let available = 0, held = 0, booked = 0;
  seatsData.forEach(s => {
    if (s.status === 'available') available++;
    else if (s.status === 'held') held++;
    else if (s.status === 'booked') booked++;
  });
  inventoryEl().textContent = `Available: ${available} | Held: ${held} | Booked: ${booked}`;
}

function renderSeatMap() {
  const container = seatMapEl();
  container.innerHTML = '';

  const rows = {};
  seatsData.forEach(seat => {
    if (!rows[seat.row_label]) rows[seat.row_label] = [];
    rows[seat.row_label].push(seat);
  });

  Object.keys(rows).sort().forEach(rowLabel => {
    const rowDiv = document.createElement('div');
    rowDiv.className = 'seat-row';
    rowDiv.innerHTML = `<span class="row-label">${rowLabel}</span>`;

    rows[rowLabel].sort((a, b) => a.seat_number - b.seat_number).forEach(seat => {
      const seatEl = document.createElement('div');
      seatEl.className = `seat ${seat.status}`;
      seatEl.textContent = seat.seat_number;
      seatEl.dataset.id = seat.id;

      if (seat.status === 'available') {
        seatEl.addEventListener('click', () => toggleSeatSelection(seat.id, seatEl));
      } else if (seat.status === 'held' && currentHold && currentHold.seatIds.includes(seat.id)) {
        seatEl.classList.add('my-hold');
      }

      rowDiv.appendChild(seatEl);
    });

    container.appendChild(rowDiv);
  });
}

function toggleSeatSelection(seatId, seatEl) {
  if (selectedSeats.has(seatId)) {
    selectedSeats.delete(seatId);
    seatEl.classList.remove('selected');
  } else {
    selectedSeats.add(seatId);
    seatEl.classList.add('selected');
  }
  holdBtn().disabled = selectedSeats.size === 0;
}

async function requestHold() {
  const seatIds = Array.from(selectedSeats);
  const sessionId = sessionInput().value.trim() || 'anonymous';

  try {
    const res = await fetch(`${API_BASE}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId })
    });

    if (res.status === 409) {
      const data = await res.json();
      showMessage(`Seats already taken: ${data.conflictingSeats.join(', ')}`, true);
      await fetchSeats();
      selectedSeats.clear();
      holdBtn().disabled = true;
      return;
    }

    if (!res.ok) throw new Error(await res.text());

    const hold = await res.json();
    currentHold = { ...hold, sessionId };
    selectedSeats.clear();

    holdInfoEl().innerHTML = `
      Hold active: ${hold.seatIds.join(', ')}<br>
      Expires at: ${new Date(hold.expiresAt).toLocaleTimeString()}<br>
      <span id="countdown"></span>
    `;
    startCountdown(hold.expiresAt);

    confirmBtn().disabled = false;
    releaseBtn().disabled = false;
    holdBtn().disabled = true;

    showMessage('Hold acquired successfully');
    await fetchSeats();
  } catch (e) {
    showMessage('Failed to acquire hold: ' + e.message, true);
    await fetchSeats();
  }
}

let countdownInterval = null;
function startCountdown(expiresAt) {
  if (countdownInterval) clearInterval(countdownInterval);
  countdownInterval = setInterval(() => {
    const remaining = Math.max(0, Math.floor((new Date(expiresAt) - Date.now()) / 1000));
    const cd = document.getElementById('countdown');
    if (cd) cd.textContent = `Time left: ${remaining}s`;
    if (remaining <= 0) {
      clearInterval(countdownInterval);
      handleHoldExpired();
    }
  }, 1000);
}

function handleHoldExpired() {
  showMessage('Hold expired', true);
  currentHold = null;
  confirmBtn().disabled = true;
  releaseBtn().disabled = true;
  holdInfoEl().innerHTML = '';
  fetchSeats();
}

async function confirmHold() {
  if (!currentHold) return;
  const sessionId = sessionInput().value.trim() || 'anonymous';

  try {
    const res = await fetch(`${API_BASE}/holds/${currentHold.holdId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    });

    if (!res.ok) {
      const err = await res.json();
      showMessage(err.error || 'Confirm failed', true);
      await fetchSeats();
      return;
    }

    const data = await res.json();
    showMessage('Booking confirmed! Seats: ' + data.seatIds.join(', '));
    currentHold = null;
    confirmBtn().disabled = true;
    releaseBtn().disabled = true;
    holdInfoEl().innerHTML = '';
    if (countdownInterval) clearInterval(countdownInterval);
    await fetchSeats();
  } catch (e) {
    showMessage('Confirm error', true);
  }
}

async function releaseHold() {
  if (!currentHold) return;

  try {
    const res = await fetch(`${API_BASE}/holds/${currentHold.holdId}`, {
      method: 'DELETE'
    });

    if (!res.ok) throw new Error();

    showMessage('Hold released');
    currentHold = null;
    confirmBtn().disabled = true;
    releaseBtn().disabled = true;
    holdInfoEl().innerHTML = '';
    if (countdownInterval) clearInterval(countdownInterval);
    await fetchSeats();
  } catch (e) {
    showMessage('Release failed', true);
  }
}

function connectSSE() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`${API_BASE}/stream`);

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'connected') return;

      // Update local seatsData and re-render
      if (data.seatIds && data.status) {
        data.seatIds.forEach(id => {
          const seat = seatsData.find(s => s.id === id);
          if (seat) {
            seat.status = data.status;
            if (data.status === 'available') {
              seat.hold_id = null;
              seat.hold_expires_at = null;
            } else if (data.status === 'held') {
              seat.hold_id = data.holdId;
              seat.hold_expires_at = data.expiresAt;
            } else if (data.status === 'booked') {
              seat.booked_by = data.sessionId;
            }
          }
        });
        renderSeatMap();
        updateInventory();
      }
    } catch (e) {}
  };

  eventSource.onerror = () => {
    console.log('SSE error, reconnecting...');
    setTimeout(connectSSE, 3000);
  };
}

function init() {
  holdBtn().addEventListener('click', requestHold);
  confirmBtn().addEventListener('click', confirmHold);
  releaseBtn().addEventListener('click', releaseHold);

  sessionInput().addEventListener('change', () => {
    // optional: could validate
  });

  fetchSeats().then(() => {
    connectSSE();
  });

  // Refresh seats periodically as fallback
  setInterval(fetchSeats, 30000);
}

init();