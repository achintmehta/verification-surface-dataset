import { v4 as uuidv4 } from 'uuid';

let sessionId = localStorage.getItem('sessionId');
if (!sessionId) {
  sessionId = uuidv4();
  localStorage.setItem('sessionId', sessionId);
}

let seats = [];
let selectedSeatIds = new Set();
let currentHold = JSON.parse(localStorage.getItem('currentHold')) || null; // { holdId, expiresAt, seatIds }
let timerInterval = null;

const seatMapEl = document.getElementById('seat-map');
const holdBtn = document.getElementById('hold-btn');
const confirmBtn = document.getElementById('confirm-btn');
const releaseBtn = document.getElementById('release-btn');
const timerEl = document.getElementById('timer');
const messagesEl = document.getElementById('messages');

async function fetchSeats() {
  const res = await fetch('/api/seats');
  seats = await res.json();
  renderSeats();
}

function renderSeats() {
  seatMapEl.innerHTML = '';
  seats.forEach(seat => {
    const seatEl = document.createElement('div');
    seatEl.className = `seat ${seat.status}`;
    seatEl.textContent = seat.id;
    
    if (seat.status === 'available' && selectedSeatIds.has(seat.id)) {
      seatEl.classList.add('selected');
    }

    if (currentHold && currentHold.seatIds.includes(seat.id)) {
      if (seat.status === 'held') {
        seatEl.classList.add('held-by-me');
      } else if (seat.status === 'booked') {
        seatEl.classList.add('booked-by-me');
      }
    }

    seatEl.addEventListener('click', () => toggleSeatSelection(seat));
    seatMapEl.appendChild(seatEl);
  });
  updateControls();
}

function toggleSeatSelection(seat) {
  if (seat.status !== 'available') return;
  if (currentHold) return; // Cannot select new seats while holding

  if (selectedSeatIds.has(seat.id)) {
    selectedSeatIds.delete(seat.id);
  } else {
    selectedSeatIds.add(seat.id);
  }
  renderSeats();
}

function updateControls() {
  holdBtn.disabled = selectedSeatIds.size === 0 || currentHold !== null;
  confirmBtn.disabled = currentHold === null;
  releaseBtn.disabled = currentHold === null;
}

function showMessage(msg) {
  messagesEl.textContent = msg;
  setTimeout(() => { messagesEl.textContent = ''; }, 5000);
}

holdBtn.addEventListener('click', async () => {
  const seatIds = Array.from(selectedSeatIds);
  try {
    const res = await fetch('/api/holds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId })
    });
    
    if (res.status === 409) {
      const data = await res.json();
      showMessage(`Conflict! Seats already taken: ${data.conflictingSeats.join(', ')}`);
      selectedSeatIds.clear();
      await fetchSeats();
      return;
    }
    
    if (!res.ok) throw new Error('Failed to hold seats');
    
    const data = await res.json();
    currentHold = data;
    localStorage.setItem('currentHold', JSON.stringify(currentHold));
    selectedSeatIds.clear();
    startTimer();
    renderSeats();
  } catch (err) {
    showMessage(err.message);
  }
});

confirmBtn.addEventListener('click', async () => {
  if (!currentHold) return;
  try {
    const res = await fetch(`/api/holds/${currentHold.holdId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    });
    
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to confirm');
    }
    
    stopTimer();
    currentHold = null;
    localStorage.removeItem('currentHold');
    await fetchSeats();
  } catch (err) {
    showMessage(err.message);
    stopTimer();
    currentHold = null;
    localStorage.removeItem('currentHold');
    await fetchSeats();
  }
});

releaseBtn.addEventListener('click', async () => {
  if (!currentHold) return;
  try {
    await fetch(`/api/holds/${currentHold.holdId}`, {
      method: 'DELETE'
    });
    stopTimer();
    currentHold = null;
    localStorage.removeItem('currentHold');
    await fetchSeats();
  } catch (err) {
    showMessage(err.message);
  }
});

function startTimer() {
  stopTimer();
  updateTimerDisplay();
  timerInterval = setInterval(() => {
    if (!currentHold) {
      stopTimer();
      return;
    }
    const remaining = Math.max(0, Math.floor((currentHold.expiresAt - Date.now()) / 1000));
    if (remaining <= 0) {
      stopTimer();
      currentHold = null;
      localStorage.removeItem('currentHold');
      showMessage('Hold expired');
      fetchSeats();
    } else {
      updateTimerDisplay();
    }
  }, 1000);
}

function stopTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
  timerEl.textContent = '';
}

function updateTimerDisplay() {
  if (!currentHold) return;
  const remaining = Math.max(0, Math.floor((currentHold.expiresAt - Date.now()) / 1000));
  timerEl.textContent = `Time left: ${remaining}s`;
}

// SSE
const evtSource = new EventSource('/api/stream');
evtSource.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.type === 'seats_updated') {
    let changed = false;
    data.seats.forEach(updatedSeat => {
      const seat = seats.find(s => s.id === updatedSeat.id);
      if (seat && seat.status !== updatedSeat.status) {
        seat.status = updatedSeat.status;
        changed = true;
      }
    });
    if (changed) renderSeats();
  }
};

fetchSeats();
if (currentHold) {
  startTimer();
}
