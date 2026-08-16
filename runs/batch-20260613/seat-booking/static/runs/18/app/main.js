import { v4 as uuidv4 } from 'uuid';

const API_BASE = 'http://localhost:3000/api';

let sessionId = localStorage.getItem('sessionId');
if (!sessionId) {
  sessionId = uuidv4();
  localStorage.setItem('sessionId', sessionId);
}

let seats = [];
let selectedSeatIds = new Set();
let currentHoldId = null;
let holdExpiresAt = null;
let countdownInterval = null;

const seatMapEl = document.getElementById('seat-map');
const holdBtn = document.getElementById('hold-btn');
const confirmBtn = document.getElementById('confirm-btn');
const releaseBtn = document.getElementById('release-btn');
const statusMessageEl = document.getElementById('status-message');

async function fetchSeats() {
  const res = await fetch(`${API_BASE}/seats`);
  seats = await res.json();
  renderSeats();
}

function renderSeats() {
  seatMapEl.innerHTML = '';
  
  let myHeldSeats = 0;

  seats.forEach(seat => {
    const seatEl = document.createElement('div');
    seatEl.className = 'seat';
    seatEl.textContent = seat.id;

    if (seat.status === 'available') {
      seatEl.classList.add('available');
      if (selectedSeatIds.has(seat.id)) {
        seatEl.classList.add('selected');
      }
      seatEl.addEventListener('click', () => toggleSeatSelection(seat.id));
    } else if (seat.status === 'held') {
      if (seat.hold_id === currentHoldId) {
        seatEl.classList.add('held-by-me');
        myHeldSeats++;
      } else {
        seatEl.classList.add('held');
      }
    } else if (seat.status === 'booked') {
      seatEl.classList.add('booked');
    }

    seatMapEl.appendChild(seatEl);
  });

  if (myHeldSeats === 0 && currentHoldId) {
    // Hold expired or was released
    clearHoldState();
  }

  updateControls();
}

function toggleSeatSelection(seatId) {
  if (currentHoldId) return; // Cannot select new seats while holding

  if (selectedSeatIds.has(seatId)) {
    selectedSeatIds.delete(seatId);
  } else {
    selectedSeatIds.add(seatId);
  }
  renderSeats();
}

function updateControls() {
  holdBtn.disabled = selectedSeatIds.size === 0 || currentHoldId !== null;
  confirmBtn.disabled = currentHoldId === null;
  releaseBtn.disabled = currentHoldId === null;
}

function updateStatusMessage(msg) {
  statusMessageEl.textContent = msg;
}

function startCountdown() {
  if (countdownInterval) clearInterval(countdownInterval);
  
  countdownInterval = setInterval(() => {
    if (!holdExpiresAt) {
      clearInterval(countdownInterval);
      return;
    }
    
    const now = new Date();
    const expires = new Date(holdExpiresAt);
    const diff = Math.max(0, Math.floor((expires - now) / 1000));
    
    if (diff > 0) {
      updateStatusMessage(`Hold active. Expires in ${diff}s`);
    } else {
      updateStatusMessage('Hold expired.');
      clearHoldState();
      fetchSeats(); // Refresh to see available seats
    }
  }, 1000);
}

function clearHoldState() {
  currentHoldId = null;
  holdExpiresAt = null;
  selectedSeatIds.clear();
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
  updateControls();
}

holdBtn.addEventListener('click', async () => {
  if (selectedSeatIds.size === 0) return;

  try {
    const res = await fetch(`${API_BASE}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        seatIds: Array.from(selectedSeatIds),
        sessionId
      })
    });

    const data = await res.json();

    if (res.ok) {
      currentHoldId = data.holdId;
      // Find the expiry from the returned seats
      holdExpiresAt = data.seats[0].hold_expires_at;
      selectedSeatIds.clear();
      startCountdown();
      // Update local seats with the returned data
      updateLocalSeats(data.seats);
    } else if (res.status === 409) {
      updateStatusMessage(`Conflict! Seats already taken: ${data.conflictingSeats.join(', ')}`);
      selectedSeatIds.clear();
      await fetchSeats();
    } else {
      updateStatusMessage(`Error: ${data.error}`);
    }
  } catch (err) {
    updateStatusMessage('Network error.');
  }
});

confirmBtn.addEventListener('click', async () => {
  if (!currentHoldId) return;

  try {
    const res = await fetch(`${API_BASE}/holds/${currentHoldId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    });

    const data = await res.json();

    if (res.ok) {
      updateStatusMessage('Booking confirmed!');
      clearHoldState();
      updateLocalSeats(data.seats);
    } else {
      updateStatusMessage(`Error: ${data.error}`);
      clearHoldState();
      await fetchSeats();
    }
  } catch (err) {
    updateStatusMessage('Network error.');
  }
});

releaseBtn.addEventListener('click', async () => {
  if (!currentHoldId) return;

  try {
    await fetch(`${API_BASE}/holds/${currentHoldId}`, {
      method: 'DELETE'
    });
    updateStatusMessage('Hold released.');
    clearHoldState();
    // SSE will update the seats
  } catch (err) {
    updateStatusMessage('Network error.');
  }
});

function updateLocalSeats(updatedSeats) {
  const updatedMap = new Map(updatedSeats.map(s => [s.id, s]));
  seats = seats.map(s => {
    if (updatedMap.has(s.id)) {
      const updated = updatedMap.get(s.id);
      // If the seat is held but expired, treat as available
      if (updated.status === 'held' && new Date(updated.hold_expires_at) < new Date()) {
        return { ...updated, status: 'available', hold_id: null, hold_expires_at: null };
      }
      return updated;
    }
    return s;
  });
  renderSeats();
}

function setupSSE() {
  const evtSource = new EventSource(`${API_BASE}/stream`);
  evtSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'seat_update') {
      updateLocalSeats(data.seats);
    }
  };
}

// Init
fetchSeats().then(() => {
  setupSSE();
});
