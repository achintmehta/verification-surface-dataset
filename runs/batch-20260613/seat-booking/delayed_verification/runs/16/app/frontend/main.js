import { v4 as uuidv4 } from 'uuid';

const API_BASE = 'http://localhost:3000/api';
let sessionId = localStorage.getItem('sessionId');
if (!sessionId) {
  sessionId = uuidv4();
  localStorage.setItem('sessionId', sessionId);
}

let seats = [];
let selectedSeatIds = new Set();
let currentHold = null; // { holdId, expiresAt, seatIds }
let timerInterval = null;

const seatMapEl = document.getElementById('seat-map');
const holdBtn = document.getElementById('hold-btn');
const confirmBtn = document.getElementById('confirm-btn');
const releaseBtn = document.getElementById('release-btn');
const timerEl = document.getElementById('timer');
const messageEl = document.getElementById('message');

function showMessage(msg) {
  messageEl.textContent = msg;
  setTimeout(() => { messageEl.textContent = ''; }, 5000);
}

async function fetchSeats() {
  const res = await fetch(`${API_BASE}/seats`);
  seats = await res.json();
  let changedSelection = false;
  seats.forEach(seat => {
    if (seat.status !== 'available' && selectedSeatIds.has(seat.id)) {
      selectedSeatIds.delete(seat.id);
      changedSelection = true;
    }
  });
  renderSeats();
}

function renderSeats() {
  seatMapEl.innerHTML = '';
  seats.forEach(seat => {
    const seatEl = document.createElement('div');
    seatEl.className = 'seat';
    seatEl.textContent = seat.id;
    
    if (seat.status === 'available') {
      if (selectedSeatIds.has(seat.id)) {
        seatEl.classList.add('selected');
      } else {
        seatEl.classList.add('available');
      }
      seatEl.onclick = () => toggleSeatSelection(seat.id);
    } else if (seat.status === 'held') {
      if (currentHold && currentHold.seatIds.includes(seat.id)) {
        seatEl.classList.add('held-by-me');
      } else {
        seatEl.classList.add('held');
      }
    } else if (seat.status === 'booked') {
      seatEl.classList.add('booked');
    }
    
    seatMapEl.appendChild(seatEl);
  });
  updateButtons();
}

function toggleSeatSelection(seatId) {
  if (currentHold) return; // Cannot select new seats while holding
  if (selectedSeatIds.has(seatId)) {
    selectedSeatIds.delete(seatId);
  } else {
    selectedSeatIds.add(seatId);
  }
  renderSeats();
}

function updateButtons() {
  holdBtn.disabled = selectedSeatIds.size === 0 || currentHold !== null;
  confirmBtn.disabled = currentHold === null;
  releaseBtn.disabled = currentHold === null;
}

function startTimer() {
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    if (!currentHold) {
      clearInterval(timerInterval);
      timerEl.textContent = '';
      return;
    }
    const remaining = Math.max(0, currentHold.expiresAt - Date.now());
    timerEl.textContent = `Hold expires in ${Math.ceil(remaining / 1000)}s`;
    if (remaining === 0) {
      currentHold = null;
      selectedSeatIds.clear();
      renderSeats();
      clearInterval(timerInterval);
      timerEl.textContent = 'Hold expired';
    }
  }, 1000);
}

holdBtn.onclick = async () => {
  if (selectedSeatIds.size === 0) return;
  const seatIds = Array.from(selectedSeatIds);
  try {
    const res = await fetch(`${API_BASE}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId })
    });
    const data = await res.json();
    if (res.ok) {
      currentHold = data;
      selectedSeatIds.clear();
      startTimer();
      // Update local state immediately for snappiness
      seats.forEach(s => {
        if (seatIds.includes(s.id)) s.status = 'held';
      });
      renderSeats();
    } else if (res.status === 409) {
      showMessage(`Conflict! Seats already taken: ${data.conflictingSeats.join(', ')}`);
      selectedSeatIds.clear();
      await fetchSeats();
    } else {
      showMessage(data.error || 'Failed to hold seats');
    }
  } catch (err) {
    showMessage('Network error');
  }
};

confirmBtn.onclick = async () => {
  if (!currentHold) return;
  try {
    const res = await fetch(`${API_BASE}/holds/${currentHold.holdId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    });
    const data = await res.json();
    if (res.ok) {
      showMessage('Booking confirmed!');
      currentHold = null;
      clearInterval(timerInterval);
      timerEl.textContent = '';
      await fetchSeats();
    } else {
      showMessage(data.error || 'Failed to confirm booking');
      currentHold = null;
      clearInterval(timerInterval);
      timerEl.textContent = '';
      await fetchSeats();
    }
  } catch (err) {
    showMessage('Network error');
  }
};

releaseBtn.onclick = async () => {
  if (!currentHold) return;
  try {
    await fetch(`${API_BASE}/holds/${currentHold.holdId}`, { method: 'DELETE' });
    currentHold = null;
    clearInterval(timerInterval);
    timerEl.textContent = '';
    await fetchSeats();
  } catch (err) {
    showMessage('Network error');
  }
};

function setupSSE() {
  const evtSource = new EventSource(`${API_BASE}/stream`);
  evtSource.onopen = () => {
    fetchSeats();
  };
  evtSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'seats_updated') {
      let changed = false;
      data.seats.forEach(update => {
        const seat = seats.find(s => s.id === update.id);
        if (seat && seat.status !== update.status) {
          seat.status = update.status;
          changed = true;
          if (update.status !== 'available' && selectedSeatIds.has(seat.id)) {
            selectedSeatIds.delete(seat.id);
          }
          // If a seat we were holding was released (e.g. expired), clear our hold if it matches
          if (currentHold && currentHold.seatIds.includes(seat.id) && update.status === 'available') {
            currentHold = null;
            clearInterval(timerInterval);
            timerEl.textContent = 'Hold expired';
          }
        }
      });
      if (changed) renderSeats();
    }
  };
}

fetchSeats().then(setupSSE);