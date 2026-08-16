import { v4 as uuidv4 } from 'uuid';

const sessionId = uuidv4();
let seats = [];
let selectedSeatIds = new Set();
let currentHold = null; // { holdId, expiresAt, seatIds }
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
    seatEl.className = 'seat';
    seatEl.textContent = seat.id;
    
    if (seat.status === 'available') {
      if (selectedSeatIds.has(seat.id)) {
        seatEl.classList.add('selected');
      } else {
        seatEl.classList.add('available');
      }
      seatEl.addEventListener('click', () => toggleSelection(seat.id));
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
  updateControls();
}

function toggleSelection(seatId) {
  if (currentHold) return; // Cannot select new seats while holding
  if (selectedSeatIds.has(seatId)) {
    selectedSeatIds.delete(seatId);
  } else {
    selectedSeatIds.add(seatId);
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
  if (selectedSeatIds.size === 0) return;
  const seatIds = Array.from(selectedSeatIds);
  
  try {
    const res = await fetch('/api/holds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId })
    });
    
    if (res.ok) {
      const data = await res.json();
      currentHold = data;
      selectedSeatIds.clear();
      startTimer();
      renderSeats();
    } else if (res.status === 409) {
      const data = await res.json();
      showMessage(`Seats unavailable: ${data.conflictingSeatIds.join(', ')}`);
      selectedSeatIds.clear();
      await fetchSeats();
    } else {
      showMessage('Error holding seats');
    }
  } catch (err) {
    showMessage('Network error');
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
    
    if (res.ok) {
      stopTimer();
      currentHold = null;
      await fetchSeats();
      showMessage('Booking confirmed!');
    } else {
      const data = await res.json();
      showMessage(data.error || 'Error confirming hold');
      stopTimer();
      currentHold = null;
      await fetchSeats();
    }
  } catch (err) {
    showMessage('Network error');
  }
});

releaseBtn.addEventListener('click', async () => {
  if (!currentHold) return;
  
  try {
    await fetch(`/api/holds/${currentHold.holdId}`, { method: 'DELETE' });
    stopTimer();
    currentHold = null;
    await fetchSeats();
  } catch (err) {
    showMessage('Network error');
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
    const remaining = currentHold.expiresAt - Date.now();
    if (remaining <= 0) {
      stopTimer();
      currentHold = null;
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
  const remaining = Math.max(0, Math.ceil((currentHold.expiresAt - Date.now()) / 1000));
  timerEl.textContent = `Hold expires in ${remaining}s`;
}

function setupSSE() {
  const evtSource = new EventSource('/api/stream');
  evtSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    
    if (data.type === 'held') {
      data.seatIds.forEach(id => {
        const seat = seats.find(s => s.id === id);
        if (seat) {
          seat.status = 'held';
          seat.hold_id = data.holdId;
          seat.hold_expires_at = data.expiresAt;
        }
      });
    } else if (data.type === 'booked') {
      data.seatIds.forEach(id => {
        const seat = seats.find(s => s.id === id);
        if (seat) {
          seat.status = 'booked';
          seat.hold_id = data.holdId;
        }
      });
    } else if (data.type === 'released') {
      data.seatIds.forEach(id => {
        const seat = seats.find(s => s.id === id);
        if (seat) {
          seat.status = 'available';
          seat.hold_id = null;
          seat.hold_expires_at = null;
        }
      });
      // If our hold was released (e.g. expired)
      if (currentHold && data.seatIds.some(id => currentHold.seatIds.includes(id))) {
        stopTimer();
        currentHold = null;
        showMessage('Hold expired');
      }
    }
    renderSeats();
  };
}

fetchSeats().then(setupSSE);
