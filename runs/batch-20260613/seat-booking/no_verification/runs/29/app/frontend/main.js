const API_BASE = '/api';
let selectedSeats = new Set();
let currentHold = null;
let countdownInterval = null;
let seatsData = new Map(); // id -> seat info
let sessionId = localStorage.getItem('sessionId') || 'user_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
localStorage.setItem('sessionId', sessionId);

const seatMapEl = document.getElementById('seat-map');
const holdBtn = document.getElementById('hold-btn');
const holdInfoEl = document.getElementById('hold-info');
const selectionInfoEl = document.getElementById('selection-info');
const messageEl = document.getElementById('message');
const confirmBtn = document.getElementById('confirm-btn');
const releaseBtn = document.getElementById('release-btn');
const countdownEl = document.getElementById('countdown');
const holdSeatsEl = document.getElementById('hold-seats');

function showMessage(text, isError = false) {
  messageEl.textContent = text;
  messageEl.className = 'message ' + (isError ? 'error' : 'success');
  setTimeout(() => {
    messageEl.textContent = '';
    messageEl.className = 'message';
  }, 4000);
}

async function fetchSeats() {
  try {
    const res = await fetch(`${API_BASE}/seats`);
    const data = await res.json();
    seatsData.clear();
    data.seats.forEach(seat => {
      seatsData.set(seat.id, seat);
    });
    renderSeatMap();
  } catch (err) {
    console.error('Failed to fetch seats:', err);
  }
}

function renderSeatMap() {
  seatMapEl.innerHTML = '';

  const rows = ['A', 'B', 'C', 'D', 'E'];
  
  rows.forEach(row => {
    // Row label
    const label = document.createElement('div');
    label.className = 'row-label';
    label.textContent = row;
    seatMapEl.appendChild(label);

    for (let num = 1; num <= 10; num++) {
      const id = `${row}${num}`;
      const seat = seatsData.get(id) || { id, status: 'available' };
      
      const seatEl = document.createElement('div');
      seatEl.className = 'seat';
      seatEl.dataset.id = id;
      seatEl.textContent = num;

      let stateClass = seat.status;
      const isMyHold = currentHold && currentHold.seatIds.includes(id) && seat.holdId === currentHold.holdId;

      if (seat.status === 'held') {
        if (isMyHold || (currentHold && seat.holdId === currentHold.holdId)) {
          stateClass = 'held';
        } else {
          stateClass = 'held-other';
        }
      } else if (seat.status === 'booked') {
        stateClass = 'booked';
      } else if (selectedSeats.has(id)) {
        seatEl.style.border = '3px solid #007bff';
        seatEl.style.background = '#cce5ff';
      }

      seatEl.classList.add(stateClass);

      if (seat.status === 'available' && !selectedSeats.has(id)) {
        seatEl.addEventListener('click', () => toggleSeatSelection(id, seatEl));
      } else if (seat.status === 'held' && isMyHold) {
        // Already held by us
      }

      seatMapEl.appendChild(seatEl);
    }
  });

  updateControls();
}

function toggleSeatSelection(id, seatEl) {
  if (currentHold) return; // Can't select while holding

  if (selectedSeats.has(id)) {
    selectedSeats.delete(id);
    seatEl.style.border = '';
    seatEl.style.background = '';
  } else {
    selectedSeats.add(id);
    seatEl.style.border = '3px solid #007bff';
    seatEl.style.background = '#cce5ff';
  }
  updateControls();
}

function updateControls() {
  if (currentHold) {
    selectionInfoEl.style.display = 'none';
    holdBtn.style.display = 'none';
    holdInfoEl.style.display = 'block';
    holdSeatsEl.textContent = currentHold.seatIds.join(', ');
  } else {
    selectionInfoEl.style.display = 'block';
    holdBtn.style.display = 'inline-block';
    holdInfoEl.style.display = 'none';
    
    holdBtn.disabled = selectedSeats.size === 0;
    selectionInfoEl.textContent = selectedSeats.size > 0 
      ? `Selected ${selectedSeats.size} seat(s): ${Array.from(selectedSeats).join(', ')}`
      : 'Select available seats to hold';
  }
}

async function createHold() {
  if (selectedSeats.size === 0) return;

  const seatIds = Array.from(selectedSeats);
  
  try {
    const res = await fetch(`${API_BASE}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId })
    });

    if (res.status === 409) {
      const err = await res.json();
      showMessage(`Some seats taken: ${err.conflictingSeats?.join(', ')}`, true);
      selectedSeats.clear();
      await fetchSeats();
      return;
    }

    if (!res.ok) {
      const err = await res.json();
      showMessage(err.error || 'Failed to hold seats', true);
      return;
    }

    const holdData = await res.json();
    currentHold = {
      holdId: holdData.holdId,
      seatIds: holdData.seatIds,
      expiresAt: holdData.expiresAt
    };

    selectedSeats.clear();
    startCountdown();
    await fetchSeats();
    showMessage('Seats held successfully! Confirm within 2 minutes.', false);
  } catch (err) {
    showMessage('Network error creating hold', true);
  }
}

function startCountdown() {
  if (countdownInterval) clearInterval(countdownInterval);

  countdownInterval = setInterval(() => {
    if (!currentHold) {
      clearInterval(countdownInterval);
      return;
    }

    const expires = new Date(currentHold.expiresAt);
    const now = new Date();
    const remaining = Math.max(0, Math.floor((expires - now) / 1000));

    if (remaining <= 0) {
      clearInterval(countdownInterval);
      showMessage('Hold expired!', true);
      releaseCurrentHoldLocally();
    } else {
      const min = Math.floor(remaining / 60);
      const sec = remaining % 60;
      countdownEl.textContent = `${min}:${sec.toString().padStart(2, '0')}`;
    }
  }, 1000);
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
      showMessage(err.error || 'Confirmation failed', true);
      if (res.status === 410 || res.status === 404) {
        releaseCurrentHoldLocally();
      }
      return;
    }

    const result = await res.json();
    showMessage('Booking confirmed! Seats are now yours.', false);
    
    clearInterval(countdownInterval);
    currentHold = null;
    await fetchSeats();
    updateControls();
  } catch (err) {
    showMessage('Network error confirming', true);
  }
}

async function releaseHold() {
  if (!currentHold) return;

  try {
    await fetch(`${API_BASE}/holds/${currentHold.holdId}`, {
      method: 'DELETE'
    });
  } catch (e) {}

  releaseCurrentHoldLocally();
  showMessage('Hold released', false);
}

function releaseCurrentHoldLocally() {
  clearInterval(countdownInterval);
  currentHold = null;
  updateControls();
  fetchSeats();
}

function connectSSE() {
  const eventSource = new EventSource(`${API_BASE}/stream`);

  eventSource.addEventListener('connected', () => {
    console.log('SSE connected');
  });

  eventSource.addEventListener('seats-updated', (event) => {
    const data = JSON.parse(event.data);
    console.log('Seat update:', data);

    // Refresh seat data
    fetchSeats();
    
    // If our hold was affected
    if (currentHold && data.seatIds) {
      const ourSeatsAffected = data.seatIds.some(id => currentHold.seatIds.includes(id));
      if (ourSeatsAffected && data.status === 'booked') {
        // We booked or someone else? But since we own it
        if (data.sessionId !== sessionId) {
          // shouldn't happen
        }
      }
      if (data.status === 'available' && ourSeatsAffected) {
        // Released externally or expired
        releaseCurrentHoldLocally();
      }
    }
  });

  eventSource.onerror = () => {
    console.log('SSE error, will reconnect on next fetch');
  };
}

function init() {
  holdBtn.addEventListener('click', createHold);
  confirmBtn.addEventListener('click', confirmHold);
  releaseBtn.addEventListener('click', releaseHold);

  // Initial load
  fetchSeats();
  connectSSE();

  // Periodic refresh as fallback
  setInterval(fetchSeats, 30000);
}

init();