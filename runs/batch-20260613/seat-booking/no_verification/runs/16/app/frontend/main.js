const API_URL = 'http://localhost:3000/api';

let seats = [];
let selectedSeatIds = new Set();
let currentHold = null;
let holdTimer = null;
const sessionId = crypto.randomUUID();

const seatMapEl = document.getElementById('seat-map');
const holdBtn = document.getElementById('hold-btn');
const confirmBtn = document.getElementById('confirm-btn');
const releaseBtn = document.getElementById('release-btn');
const holdStatusEl = document.getElementById('hold-status');

async function fetchSeats() {
  const res = await fetch(`${API_URL}/seats`);
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
    if (status === 'held' && new Date(seat.hold_expires_at) <= new Date()) {
      status = 'available';
    }

    seatEl.classList.add(status);

    if (status === 'available' && selectedSeatIds.has(seat.id)) {
      seatEl.classList.add('selected');
    }

    if (status === 'held' && currentHold && currentHold.seats.some(s => s.id === seat.id)) {
      seatEl.classList.add('my-hold');
    }

    seatEl.addEventListener('click', () => {
      if (status === 'available' && !currentHold) {
        if (selectedSeatIds.has(seat.id)) {
          selectedSeatIds.delete(seat.id);
        } else {
          selectedSeatIds.add(seat.id);
        }
        renderSeats();
        updateButtons();
      }
    });

    seatMapEl.appendChild(seatEl);
  });
}

function updateButtons() {
  holdBtn.disabled = selectedSeatIds.size === 0 || currentHold !== null;
  confirmBtn.disabled = currentHold === null;
  releaseBtn.disabled = currentHold === null;
}

function startHoldTimer() {
  if (holdTimer) clearInterval(holdTimer);
  
  const updateTimer = () => {
    if (!currentHold) return;
    const now = new Date();
    const expiresAt = new Date(currentHold.expiresAt);
    const remaining = Math.max(0, Math.floor((expiresAt - now) / 1000));
    
    if (remaining > 0) {
      holdStatusEl.textContent = `Hold active: ${remaining}s remaining`;
    } else {
      holdStatusEl.textContent = 'Hold expired';
      currentHold = null;
      selectedSeatIds.clear();
      updateButtons();
      renderSeats();
      clearInterval(holdTimer);
    }
  };
  
  updateTimer();
  holdTimer = setInterval(updateTimer, 1000);
}

holdBtn.addEventListener('click', async () => {
  if (selectedSeatIds.size === 0) return;
  
  const seatIds = Array.from(selectedSeatIds);
  try {
    const res = await fetch(`${API_URL}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId })
    });
    
    const data = await res.json();
    if (res.ok) {
      currentHold = data;
      selectedSeatIds.clear();
      startHoldTimer();
      updateButtons();
      data.seats.forEach(s => {
        const seat = seats.find(x => x.id === s.id);
        if (seat) {
          seat.status = s.status;
          seat.hold_expires_at = s.hold_expires_at;
        }
      });
      renderSeats();
    } else if (res.status === 409) {
      alert(`Seats unavailable: ${data.conflictingSeatIds.join(', ')}`);
      selectedSeatIds.clear();
      await fetchSeats();
    } else {
      alert(data.error || 'Failed to hold seats');
    }
  } catch (err) {
    console.error(err);
    alert('Error holding seats');
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
    
    const data = await res.json();
    if (res.ok) {
      alert('Booking confirmed!');
      currentHold = null;
      if (holdTimer) clearInterval(holdTimer);
      holdStatusEl.textContent = 'No active hold';
      updateButtons();
      await fetchSeats();
    } else {
      alert(data.error || 'Failed to confirm booking');
      currentHold = null;
      if (holdTimer) clearInterval(holdTimer);
      holdStatusEl.textContent = 'No active hold';
      updateButtons();
      await fetchSeats();
    }
  } catch (err) {
    console.error(err);
    alert('Error confirming booking');
  }
});

releaseBtn.addEventListener('click', async () => {
  if (!currentHold) return;
  
  try {
    await fetch(`${API_URL}/holds/${currentHold.holdId}`, {
      method: 'DELETE'
    });
    currentHold = null;
    if (holdTimer) clearInterval(holdTimer);
    holdStatusEl.textContent = 'No active hold';
    updateButtons();
    await fetchSeats();
  } catch (err) {
    console.error(err);
  }
});

function setupSSE() {
  const evtSource = new EventSource(`${API_URL}/stream`);
  evtSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'seats_updated') {
      data.seats.forEach(updatedSeat => {
        const seat = seats.find(s => s.id === updatedSeat.id);
        if (seat) {
          seat.status = updatedSeat.status;
          if (updatedSeat.hold_expires_at !== undefined) {
            seat.hold_expires_at = updatedSeat.hold_expires_at;
          }
          if (seat.status !== 'available' && (!currentHold || !currentHold.seats.some(s => s.id === seat.id))) {
            selectedSeatIds.delete(seat.id);
          }
        }
      });
      renderSeats();
      updateButtons();
    }
  };
}

fetchSeats().then(() => {
  setupSSE();
});