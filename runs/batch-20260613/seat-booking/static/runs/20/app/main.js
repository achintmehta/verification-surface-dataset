import { v4 as uuidv4 } from 'uuid';

let sessionId = localStorage.getItem('sessionId');
if (!sessionId) {
  sessionId = uuidv4();
  localStorage.setItem('sessionId', sessionId);
}

let seats = [];
let selectedSeats = new Set();
let currentHold = null;
let countdownInterval = null;

const seatMapEl = document.getElementById('seat-map');
const holdBtn = document.getElementById('hold-btn');
const confirmBtn = document.getElementById('confirm-btn');
const releaseBtn = document.getElementById('release-btn');
const messageEl = document.getElementById('message');
const countdownEl = document.getElementById('countdown');

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
      if (selectedSeats.has(seat.id)) {
        seatEl.classList.add('selected');
      } else {
        seatEl.classList.add('available');
      }
      seatEl.addEventListener('click', () => toggleSeatSelection(seat.id));
    } else if (seat.status === 'held') {
      seatEl.classList.add('held');
      if (currentHold && currentHold.seatIds.includes(seat.id)) {
        seatEl.classList.add('my-hold');
      }
    } else if (seat.status === 'booked') {
      seatEl.classList.add('booked');
      if (seat.booked_by === sessionId) {
        seatEl.classList.add('my-booking');
      }
    }
    
    seatMapEl.appendChild(seatEl);
  });
  updateControls();
}

function toggleSeatSelection(seatId) {
  if (currentHold) return; // Cannot select new seats while holding
  if (selectedSeats.has(seatId)) {
    selectedSeats.delete(seatId);
  } else {
    selectedSeats.add(seatId);
  }
  renderSeats();
}

function updateControls() {
  if (currentHold) {
    holdBtn.style.display = 'none';
    confirmBtn.style.display = 'inline-block';
    releaseBtn.style.display = 'inline-block';
  } else {
    holdBtn.style.display = 'inline-block';
    confirmBtn.style.display = 'none';
    releaseBtn.style.display = 'none';
    holdBtn.disabled = selectedSeats.size === 0;
  }
}

holdBtn.addEventListener('click', async () => {
  if (selectedSeats.size === 0) return;
  
  const seatIds = Array.from(selectedSeats);
  try {
    const res = await fetch('/api/holds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId })
    });
    
    if (res.status === 409) {
      const data = await res.json();
      messageEl.textContent = `Conflict! Seats already taken: ${data.conflicts.join(', ')}`;
      selectedSeats.clear();
      await fetchSeats();
    } else if (res.ok) {
      const data = await res.json();
      currentHold = data;
      selectedSeats.clear();
      startCountdown();
      messageEl.textContent = 'Seats held!';
      renderSeats();
    } else {
      messageEl.textContent = 'Error holding seats.';
    }
  } catch (err) {
    console.error(err);
    messageEl.textContent = 'Network error.';
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
      messageEl.textContent = 'Booking confirmed!';
      clearHoldState();
      await fetchSeats();
    } else {
      const data = await res.json();
      messageEl.textContent = `Error: ${data.error}`;
      clearHoldState();
      await fetchSeats();
    }
  } catch (err) {
    console.error(err);
    messageEl.textContent = 'Network error.';
  }
});

releaseBtn.addEventListener('click', async () => {
  if (!currentHold) return;
  
  try {
    await fetch(`/api/holds/${currentHold.holdId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    });
    messageEl.textContent = 'Hold released.';
    clearHoldState();
    await fetchSeats();
  } catch (err) {
    console.error(err);
  }
});

function startCountdown() {
  if (countdownInterval) clearInterval(countdownInterval);
  
  countdownInterval = setInterval(() => {
    if (!currentHold) {
      clearInterval(countdownInterval);
      countdownEl.textContent = '';
      return;
    }
    
    const remaining = Math.max(0, currentHold.expiresAt - Date.now());
    if (remaining === 0) {
      clearInterval(countdownInterval);
      countdownEl.textContent = 'Hold expired';
      clearHoldState();
      fetchSeats();
    } else {
      countdownEl.textContent = `Time left: ${Math.ceil(remaining / 1000)}s`;
    }
  }, 1000);
}

function clearHoldState() {
  currentHold = null;
  if (countdownInterval) clearInterval(countdownInterval);
  countdownEl.textContent = '';
  updateControls();
}

function setupSSE() {
  const evtSource = new EventSource('/api/stream');
  evtSource.addEventListener('seats_updated', (e) => {
    const data = JSON.parse(e.data);
    let changed = false;
    data.seats.forEach(seatId => {
      const seat = seats.find(s => s.id === seatId);
      if (seat) {
        seat.status = data.status;
        if (data.status === 'available') {
          seat.booked_by = null;
        }
        changed = true;
      }
    });
    if (changed) {
      if (currentHold && data.status === 'available') {
        const ourSeatsReleased = data.seats.some(id => currentHold.seatIds.includes(id));
        if (ourSeatsReleased) {
          clearHoldState();
          messageEl.textContent = 'Hold expired.';
        }
      }
      renderSeats();
    }
  });
}

fetchSeats().then(() => {
  setupSSE();
});
