const API_URL = 'http://localhost:3000/api';
const sessionId = Math.random().toString(36).substring(2);

let seats = [];
let selectedSeatIds = new Set();
let currentHold = null;
let timerInterval = null;

const seatMapEl = document.getElementById('seat-map');
const holdBtn = document.getElementById('hold-btn');
const confirmBtn = document.getElementById('confirm-btn');
const releaseBtn = document.getElementById('release-btn');
const timerEl = document.getElementById('timer');
const messagesEl = document.getElementById('messages');

async function fetchSeats() {
  const res = await fetch(`${API_URL}/seats`);
  seats = await res.json();
  renderSeats();
}

function renderSeats() {
  seatMapEl.innerHTML = '';
  seats.forEach(seat => {
    const seatEl = document.createElement('div');
    seatEl.className = `seat ${seat.status}`;
    if (currentHold && currentHold.seatIds.includes(seat.id) && seat.status === 'held') {
      seatEl.classList.add('my-hold');
    }
    if (selectedSeatIds.has(seat.id)) {
      seatEl.classList.add('selected');
    }
    seatEl.textContent = seat.id;
    seatEl.addEventListener('click', () => toggleSeatSelection(seat));
    seatMapEl.appendChild(seatEl);
  });
  updateButtons();
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

function updateButtons() {
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
    const res = await fetch(`${API_URL}/holds`, {
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
      showMessage(`Seats unavailable: ${data.conflicting.join(', ')}`);
      selectedSeatIds.clear();
      fetchSeats();
    } else {
      showMessage('Failed to hold seats');
    }
  } catch (err) {
    showMessage('Network error');
  }
});

confirmBtn.addEventListener('click', async () => {
  if (!currentHold) return;
  try {
    const res = await fetch(`${API_URL}/holds/${currentHold.holdId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    });
    
    if (res.ok) {
      clearTimer();
      currentHold = null;
      showMessage('Booking confirmed!');
      fetchSeats();
    } else {
      const data = await res.json();
      showMessage(`Confirm failed: ${data.error}`);
      clearTimer();
      currentHold = null;
      fetchSeats();
    }
  } catch (err) {
    showMessage('Network error');
  }
});

releaseBtn.addEventListener('click', async () => {
  if (!currentHold) return;
  try {
    await fetch(`${API_URL}/holds/${currentHold.holdId}`, {
      method: 'DELETE'
    });
    clearTimer();
    currentHold = null;
    fetchSeats();
  } catch (err) {
    showMessage('Network error');
  }
});

function startTimer() {
  clearTimer();
  updateTimerDisplay();
  timerInterval = setInterval(() => {
    updateTimerDisplay();
  }, 1000);
}

function updateTimerDisplay() {
  if (!currentHold) return;
  const remaining = Math.max(0, currentHold.expiresAt - Date.now());
  if (remaining === 0) {
    clearTimer();
    currentHold = null;
    showMessage('Hold expired');
    fetchSeats();
  } else {
    timerEl.textContent = `Hold expires in ${Math.ceil(remaining / 1000)}s`;
  }
}

function clearTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
  timerEl.textContent = '';
}

function setupSSE() {
  const evtSource = new EventSource(`${API_URL}/stream`);
  
  evtSource.onopen = () => {
    fetchSeats();
  };

  evtSource.addEventListener('seats_updated', (e) => {
    const data = JSON.parse(e.data);
    let changed = false;
    data.seats.forEach(updatedSeat => {
      const seat = seats.find(s => s.id === updatedSeat.id);
      if (seat && seat.status !== updatedSeat.status) {
        seat.status = updatedSeat.status;
        if (seat.status !== 'available' && selectedSeatIds.has(seat.id)) {
          selectedSeatIds.delete(seat.id);
        }
        changed = true;
      }
    });
    if (currentHold) {
      const holdExpired = currentHold.seatIds.some(id => {
        const seat = seats.find(s => s.id === id);
        return seat && seat.status === 'available';
      });
      if (holdExpired) {
        clearTimer();
        currentHold = null;
        showMessage('Hold expired');
        changed = true;
      }
    }
    if (changed) renderSeats();
  });
}

setupSSE();