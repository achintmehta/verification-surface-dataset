const sessionId = crypto.randomUUID();
let seats = [];
let selectedSeats = new Set();
let currentHold = null;
let timerInterval = null;

const seatMapEl = document.getElementById('seat-map');
const holdBtn = document.getElementById('hold-btn');
const confirmBtn = document.getElementById('confirm-btn');
const releaseBtn = document.getElementById('release-btn');
const timerEl = document.getElementById('timer');
const messageEl = document.getElementById('message');

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
      seatEl.addEventListener('click', () => toggleSeat(seat.id));
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

function toggleSeat(id) {
  if (currentHold) return; // Cannot select new seats while holding
  if (selectedSeats.has(id)) {
    selectedSeats.delete(id);
  } else {
    selectedSeats.add(id);
  }
  renderSeats();
}

function updateControls() {
  holdBtn.disabled = selectedSeats.size === 0 || currentHold !== null;
  confirmBtn.disabled = currentHold === null;
  releaseBtn.disabled = currentHold === null;
}

let messageTimeout = null;
function showMessage(msg) {
  messageEl.textContent = msg;
  if (messageTimeout) clearTimeout(messageTimeout);
  messageTimeout = setTimeout(() => { messageEl.textContent = ''; }, 5000);
}

holdBtn.addEventListener('click', async () => {
  const seatIds = Array.from(selectedSeats);
  try {
    const res = await fetch('/api/holds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId })
    });
    
    if (res.ok) {
      const data = await res.json();
      currentHold = { ...data, expiresAt: Date.now() + 60000 };
      selectedSeats.clear();
      startTimer();
      renderSeats();
    } else if (res.status === 409) {
      const data = await res.json();
      showMessage(`Seats unavailable: ${data.conflicting.join(', ')}`);
      selectedSeats.clear();
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
    if (Date.now() > currentHold.expiresAt) {
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
  evtSource.addEventListener('seats_updated', (e) => {
    const data = JSON.parse(e.data);
    let changed = false;
    data.seats.forEach(id => {
      const seat = seats.find(s => s.id === id);
      if (seat && seat.status !== data.status) {
        seat.status = data.status;
        changed = true;
        if (data.status !== 'available') {
          selectedSeats.delete(id);
        }
        if (currentHold && currentHold.seatIds.includes(id) && data.status === 'available') {
          stopTimer();
          currentHold = null;
          showMessage('Hold expired');
        }
      }
    });
    if (changed) renderSeats();
  });
}

fetchSeats().then(setupSSE);
