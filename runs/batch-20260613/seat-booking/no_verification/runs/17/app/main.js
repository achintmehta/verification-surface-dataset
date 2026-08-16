import { v4 as uuidv4 } from 'uuid';

let sessionId = localStorage.getItem('sessionId');
if (!sessionId) {
  sessionId = uuidv4();
  localStorage.setItem('sessionId', sessionId);
}

let seats = [];
let selectedSeatIds = new Set();
let currentHold = null; // { holdId, expiresAt, seatIds }
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
    seatEl.className = `seat ${seat.status}`;
    seatEl.textContent = seat.id;
    
    if (seat.status === 'available' && selectedSeatIds.has(seat.id)) {
      seatEl.classList.add('selected');
    }
    
    if (currentHold && currentHold.seatIds.includes(seat.id) && seat.status === 'held') {
      seatEl.classList.add('held-by-me');
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

function showMessage(msg, isError = false) {
  messageEl.textContent = msg;
  messageEl.style.color = isError ? 'red' : 'black';
  setTimeout(() => {
    if (messageEl.textContent === msg) messageEl.textContent = '';
  }, 5000);
}

function startCountdown() {
  if (countdownInterval) clearInterval(countdownInterval);
  
  countdownInterval = setInterval(() => {
    if (!currentHold) {
      clearInterval(countdownInterval);
      countdownEl.textContent = '';
      return;
    }
    
    const remaining = currentHold.expiresAt - Date.now();
    if (remaining <= 0) {
      clearInterval(countdownInterval);
      countdownEl.textContent = 'Hold expired';
      currentHold = null;
      selectedSeatIds.clear();
      renderSeats();
    } else {
      countdownEl.textContent = `Hold expires in ${Math.ceil(remaining / 1000)}s`;
    }
  }, 1000);
}

holdBtn.addEventListener('click', async () => {
  const seatIds = Array.from(selectedSeatIds);
  try {
    const res = await fetch('/api/holds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId })
    });
    
    const data = await res.json();
    if (res.ok) {
      currentHold = data;
      selectedSeatIds.clear();
      startCountdown();
      showMessage('Seats held successfully');
      // Optimistically update
      seats.forEach(s => {
        if (seatIds.includes(s.id)) s.status = 'held';
      });
      renderSeats();
    } else if (res.status === 409) {
      showMessage('Some seats are already taken', true);
      selectedSeatIds.clear();
      await fetchSeats();
    } else {
      showMessage(data.error || 'Failed to hold seats', true);
    }
  } catch (err) {
    showMessage('Network error', true);
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
    
    const data = await res.json();
    if (res.ok) {
      showMessage('Seats booked successfully!');
      currentHold = null;
      clearInterval(countdownInterval);
      countdownEl.textContent = '';
      // Optimistically update
      seats.forEach(s => {
        if (data.seatIds.includes(s.id)) s.status = 'booked';
      });
      renderSeats();
    } else {
      showMessage(data.error || 'Failed to confirm hold', true);
      currentHold = null;
      clearInterval(countdownInterval);
      countdownEl.textContent = '';
      await fetchSeats();
    }
  } catch (err) {
    showMessage('Network error', true);
  }
});

releaseBtn.addEventListener('click', async () => {
  if (!currentHold) return;
  try {
    await fetch(`/api/holds/${currentHold.holdId}`, { method: 'DELETE' });
    currentHold = null;
    clearInterval(countdownInterval);
    countdownEl.textContent = '';
    showMessage('Hold released');
    await fetchSeats();
  } catch (err) {
    showMessage('Network error', true);
  }
});

function setupSSE() {
  const evtSource = new EventSource('/api/stream');
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
          
          // If a seat we were holding was released (e.g. expired)
          if (currentHold && currentHold.seatIds.includes(seat.id) && update.status === 'available') {
            currentHold = null;
            clearInterval(countdownInterval);
            countdownEl.textContent = 'Hold expired';
          }
        }
      });
      if (changed) renderSeats();
    }
  };
}

fetchSeats().then(setupSSE);
