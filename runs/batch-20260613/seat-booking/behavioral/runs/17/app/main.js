const API_BASE = 'http://localhost:3000/api';
let sessionId = localStorage.getItem('sessionId');
if (!sessionId) {
  sessionId = crypto.randomUUID();
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
  const res = await fetch(`${API_BASE}/seats`);
  seats = await res.json();
  renderSeats();
}

function renderSeats() {
  seatMapEl.innerHTML = '';
  seats.forEach(seat => {
    const seatEl = document.createElement('div');
    seatEl.className = 'seat';
    seatEl.textContent = seat.id;
    
    let status = seat.status;
    if (status === 'held' && currentHold && currentHold.seatIds.includes(seat.id)) {
      status = 'my-held';
    } else if (status === 'available' && selectedSeatIds.has(seat.id)) {
      status = 'selected';
    }
    
    seatEl.classList.add(status);
    
    seatEl.addEventListener('click', () => {
      if (seat.status === 'available' && !currentHold) {
        if (selectedSeatIds.has(seat.id)) {
          selectedSeatIds.delete(seat.id);
        } else {
          selectedSeatIds.add(seat.id);
        }
        renderSeats();
        updateControls();
      }
    });
    
    seatMapEl.appendChild(seatEl);
  });
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
  }, 3000);
}

function startCountdown() {
  if (countdownInterval) clearInterval(countdownInterval);
  
  countdownInterval = setInterval(() => {
    if (!currentHold) {
      clearInterval(countdownInterval);
      countdownEl.textContent = '';
      return;
    }
    
    const remaining = Math.max(0, new Date(currentHold.expiresAt) - new Date());
    if (remaining === 0) {
      clearInterval(countdownInterval);
      countdownEl.textContent = 'Hold expired';
      currentHold = null;
      selectedSeatIds.clear();
      updateControls();
      renderSeats();
    } else {
      countdownEl.textContent = `Hold expires in ${Math.ceil(remaining / 1000)}s`;
    }
  }, 1000);
}

holdBtn.addEventListener('click', async () => {
  const seatIds = Array.from(selectedSeatIds);
  try {
    const res = await fetch(`${API_BASE}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId })
    });
    
    if (res.status === 409) {
      const data = await res.json();
      showMessage(`Conflict: ${data.conflicts.join(', ')} already taken`, true);
      selectedSeatIds.clear();
      await fetchSeats();
    } else if (res.ok) {
      currentHold = await res.json();
      selectedSeatIds.clear();
      startCountdown();
      updateControls();
      renderSeats();
      showMessage('Seats held successfully');
    } else {
      showMessage('Failed to hold seats', true);
    }
  } catch (err) {
    showMessage('Network error', true);
  }
});

confirmBtn.addEventListener('click', async () => {
  if (!currentHold) return;
  
  try {
    const res = await fetch(`${API_BASE}/holds/${currentHold.holdId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    });
    
    if (res.ok) {
      currentHold = null;
      clearInterval(countdownInterval);
      countdownEl.textContent = '';
      updateControls();
      showMessage('Seats booked successfully!');
      await fetchSeats();
    } else {
      const data = await res.json();
      showMessage(data.error || 'Failed to confirm hold', true);
      currentHold = null;
      clearInterval(countdownInterval);
      countdownEl.textContent = '';
      updateControls();
      await fetchSeats();
    }
  } catch (err) {
    showMessage('Network error', true);
  }
});

releaseBtn.addEventListener('click', async () => {
  if (!currentHold) return;
  
  try {
    await fetch(`${API_BASE}/holds/${currentHold.holdId}`, {
      method: 'DELETE'
    });
    currentHold = null;
    clearInterval(countdownInterval);
    countdownEl.textContent = '';
    updateControls();
    showMessage('Hold released');
    await fetchSeats();
  } catch (err) {
    showMessage('Network error', true);
  }
});

function setupSSE() {
  const evtSource = new EventSource(`${API_BASE}/stream`);
  evtSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'seats_updated') {
      let changed = false;
      data.seats.forEach(seatId => {
        const seat = seats.find(s => s.id === seatId);
        if (seat) {
          seat.status = data.status;
          changed = true;
        }
      });
      if (changed) {
        // If our held seats were released by expiry
        if (currentHold && data.status === 'available') {
          const ourSeatsReleased = data.seats.some(id => currentHold.seatIds.includes(id));
          if (ourSeatsReleased) {
            currentHold = null;
            clearInterval(countdownInterval);
            countdownEl.textContent = 'Hold expired';
            updateControls();
          }
        }
        renderSeats();
      }
    }
  };
}

fetchSeats().then(() => {
  setupSSE();
});
