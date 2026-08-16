const API_URL = '/api';

let sessionId = localStorage.getItem('sessionId');
if (!sessionId) {
  sessionId = crypto.randomUUID();
  localStorage.setItem('sessionId', sessionId);
}

let seats = [];
let selectedSeatIds = new Set();
let currentHoldId = null;
let holdExpiresAt = null;
let countdownInterval = null;

const seatMapEl = document.getElementById('seat-map');
const holdBtn = document.getElementById('hold-btn');
const confirmBtn = document.getElementById('confirm-btn');
const releaseBtn = document.getElementById('release-btn');
const messageEl = document.getElementById('message');
const countdownEl = document.getElementById('countdown');

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
    seatEl.textContent = seat.id;
    
    if (seat.status === 'available' && selectedSeatIds.has(seat.id)) {
      seatEl.classList.add('selected');
    }
    
    if (seat.status === 'held' && seat.hold_id === currentHoldId) {
      seatEl.classList.add('my-hold');
    }

    if (seat.status === 'booked' && seat.booked_by === sessionId) {
      seatEl.classList.add('my-booking');
    }

    seatEl.addEventListener('click', () => toggleSeatSelection(seat));
    seatMapEl.appendChild(seatEl);
  });
  updateControls();
}

function toggleSeatSelection(seat) {
  if (seat.status !== 'available') return;
  if (currentHoldId) return; // Can't select new seats while holding

  if (selectedSeatIds.has(seat.id)) {
    selectedSeatIds.delete(seat.id);
  } else {
    selectedSeatIds.add(seat.id);
  }
  renderSeats();
}

function updateControls() {
  holdBtn.disabled = selectedSeatIds.size === 0 || currentHoldId !== null;
  confirmBtn.disabled = currentHoldId === null;
  releaseBtn.disabled = currentHoldId === null;
}

function showMessage(msg, isError = false) {
  messageEl.textContent = msg;
  messageEl.style.color = isError ? 'red' : 'black';
  setTimeout(() => { messageEl.textContent = ''; }, 3000);
}

function startCountdown() {
  if (countdownInterval) clearInterval(countdownInterval);
  
  const update = () => {
    if (!holdExpiresAt) {
      countdownEl.textContent = '';
      return;
    }
    const now = new Date();
    const expires = new Date(holdExpiresAt);
    const diff = Math.max(0, Math.floor((expires - now) / 1000));
    
    if (diff === 0) {
      countdownEl.textContent = 'Hold expired';
      currentHoldId = null;
      holdExpiresAt = null;
      selectedSeatIds.clear();
      clearInterval(countdownInterval);
      updateControls();
      renderSeats();
    } else {
      countdownEl.textContent = `Hold expires in ${diff}s`;
    }
  };
  
  update();
  countdownInterval = setInterval(update, 1000);
}

holdBtn.addEventListener('click', async () => {
  try {
    const res = await fetch(`${API_URL}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        seatIds: Array.from(selectedSeatIds),
        sessionId
      })
    });
    
    const data = await res.json();
    
    if (!res.ok) {
      if (res.status === 409) {
        showMessage('Some seats are no longer available', true);
        selectedSeatIds.clear();
        await fetchSeats();
      } else {
        showMessage(data.error || 'Failed to hold seats', true);
      }
      return;
    }
    
    currentHoldId = data.holdId;
    holdExpiresAt = data.expiresAt;
    selectedSeatIds.clear();
    
    data.seats.forEach(updatedSeat => {
      const seat = seats.find(s => s.id === updatedSeat.id);
      if (seat) {
        Object.assign(seat, updatedSeat);
      }
    });
    
    startCountdown();
    renderSeats();
    showMessage('Seats held successfully');
  } catch (err) {
    showMessage('Network error', true);
  }
});

confirmBtn.addEventListener('click', async () => {
  if (!currentHoldId) return;
  
  try {
    const res = await fetch(`${API_URL}/holds/${currentHoldId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    });
    
    const data = await res.json();
    
    if (!res.ok) {
      showMessage(data.error || 'Failed to confirm booking', true);
      currentHoldId = null;
      holdExpiresAt = null;
      clearInterval(countdownInterval);
      countdownEl.textContent = '';
      await fetchSeats();
      return;
    }
    
    currentHoldId = null;
    holdExpiresAt = null;
    clearInterval(countdownInterval);
    countdownEl.textContent = '';
    
    data.seats.forEach(updatedSeat => {
      const seat = seats.find(s => s.id === updatedSeat.id);
      if (seat) {
        Object.assign(seat, updatedSeat);
        seat.booked_by = sessionId;
      }
    });
    
    renderSeats();
    showMessage('Booking confirmed!');
  } catch (err) {
    showMessage('Network error', true);
  }
});

releaseBtn.addEventListener('click', async () => {
  if (!currentHoldId) return;
  
  try {
    await fetch(`${API_URL}/holds/${currentHoldId}`, {
      method: 'DELETE'
    });
    
    currentHoldId = null;
    holdExpiresAt = null;
    clearInterval(countdownInterval);
    countdownEl.textContent = '';
    
    await fetchSeats();
    showMessage('Hold released');
  } catch (err) {
    showMessage('Network error', true);
  }
});

const eventSource = new EventSource(`${API_URL}/stream`);
eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.type === 'seats_updated') {
    let needsRender = false;
    data.seats.forEach(updatedSeat => {
      const seat = seats.find(s => s.id === updatedSeat.id);
      if (seat) {
        Object.assign(seat, updatedSeat);
        needsRender = true;
      }
    });
    
    if (currentHoldId) {
      const ourSeats = seats.filter(s => s.hold_id === currentHoldId);
      if (ourSeats.length === 0) {
        currentHoldId = null;
        holdExpiresAt = null;
        clearInterval(countdownInterval);
        countdownEl.textContent = 'Hold expired';
      }
    }
    
    if (needsRender) {
      renderSeats();
    }
  }
};

fetchSeats();