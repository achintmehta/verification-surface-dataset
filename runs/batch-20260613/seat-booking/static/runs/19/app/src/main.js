const sessionId = window.crypto && window.crypto.randomUUID 
  ? window.crypto.randomUUID() 
  : Math.random().toString(36).substring(2) + Date.now().toString(36);
let seats = [];
let selectedSeats = new Set();
let currentHold = null;
let timerInterval = null;

const seatMapEl = document.getElementById('seat-map');
const holdBtn = document.getElementById('hold-btn');
const confirmBtn = document.getElementById('confirm-btn');
const releaseBtn = document.getElementById('release-btn');
const timerEl = document.getElementById('timer');
const messagesEl = document.getElementById('messages');

function showMessage(msg) {
  messagesEl.textContent = msg;
  setTimeout(() => {
    if (messagesEl.textContent === msg) messagesEl.textContent = '';
  }, 5000);
}

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
    
    let status = seat.status;
    if (status === 'held' && currentHold && currentHold.seatIds.includes(seat.id)) {
      status = 'my-held';
    }
    
    seatEl.classList.add(status);
    if (selectedSeats.has(seat.id)) {
      seatEl.classList.add('selected');
    }

    seatEl.addEventListener('click', () => {
      if (status === 'available') {
        if (selectedSeats.has(seat.id)) {
          selectedSeats.delete(seat.id);
        } else {
          selectedSeats.add(seat.id);
        }
        renderSeats();
        updateButtons();
      }
    });

    seatMapEl.appendChild(seatEl);
  });
}

function updateButtons() {
  holdBtn.disabled = selectedSeats.size === 0 || currentHold !== null;
  confirmBtn.disabled = currentHold === null;
  releaseBtn.disabled = currentHold === null;
}

function updateTimer() {
  if (!currentHold) {
    timerEl.textContent = '';
    if (timerInterval) clearInterval(timerInterval);
    return;
  }
  
  const now = Date.now();
  const remaining = Math.max(0, Math.floor((currentHold.expiresAt - now) / 1000));
  timerEl.textContent = `Hold expires in ${remaining}s`;
  
  if (remaining === 0) {
    currentHold = null;
    selectedSeats.clear();
    updateButtons();
    renderSeats();
    showMessage('Hold expired');
  }
}

holdBtn.addEventListener('click', async () => {
  const seatIds = Array.from(selectedSeats);
  const res = await fetch('/api/holds', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seatIds, sessionId })
  });
  
  if (res.ok) {
    const data = await res.json();
    currentHold = data;
    selectedSeats.clear();
    updateButtons();
    renderSeats();
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(updateTimer, 1000);
    updateTimer();
  } else if (res.status === 409) {
    const data = await res.json();
    showMessage(`Seats unavailable: ${data.conflictingSeatIds.join(', ')}`);
    selectedSeats.clear();
    await fetchSeats();
  } else {
    showMessage('Failed to hold seats');
  }
});

confirmBtn.addEventListener('click', async () => {
  if (!currentHold) return;
  const res = await fetch(`/api/holds/${currentHold.holdId}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId })
  });
  
  if (res.ok) {
    currentHold = null;
    updateButtons();
    if (timerInterval) clearInterval(timerInterval);
    timerEl.textContent = '';
    showMessage('Booking confirmed!');
    await fetchSeats();
  } else {
    showMessage('Failed to confirm booking');
    currentHold = null;
    updateButtons();
    if (timerInterval) clearInterval(timerInterval);
    timerEl.textContent = '';
    await fetchSeats();
  }
});

releaseBtn.addEventListener('click', async () => {
  if (!currentHold) return;
  const res = await fetch(`/api/holds/${currentHold.holdId}`, {
    method: 'DELETE'
  });
  
  if (res.ok) {
    currentHold = null;
    updateButtons();
    if (timerInterval) clearInterval(timerInterval);
    timerEl.textContent = '';
    await fetchSeats();
  }
});

function setupSSE() {
  const evtSource = new EventSource('/api/stream');
  evtSource.addEventListener('seats_updated', (e) => {
    const data = JSON.parse(e.data);
    let changed = false;
    data.seats.forEach(seatId => {
      const seat = seats.find(s => s.id === seatId);
      if (seat) {
        seat.status = data.status;
        if (data.status !== 'available' && selectedSeats.has(seatId)) {
          // If it's our own hold, we might want to keep it selected? No, we clear selectedSeats on hold success.
          selectedSeats.delete(seatId);
        }
        changed = true;
      }
    });
    if (changed) {
      updateButtons();
      renderSeats();
    }
  });
}

fetchSeats().then(() => {
  setupSSE();
});
