const API_URL = 'http://localhost:3001/api';

let seats = [];
let selectedSeatIds = new Set();
let currentHoldId = null;
let holdExpiresAt = null;
let timerInterval = null;

// Generate a simple session ID
const sessionId = Math.random().toString(36).substring(2, 15);

const seatMapEl = document.getElementById('seat-map');
const holdBtn = document.getElementById('hold-btn');
const confirmBtn = document.getElementById('confirm-btn');
const releaseBtn = document.getElementById('release-btn');
const statusMessageEl = document.getElementById('status-message');
const timerEl = document.getElementById('timer');

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

    seatEl.addEventListener('click', () => toggleSeatSelection(seat));
    seatMapEl.appendChild(seatEl);
  });
  updateControls();
}

function toggleSeatSelection(seat) {
  if (currentHoldId) return; // Cannot select new seats while holding
  if (seat.status !== 'available') return;

  if (selectedSeatIds.has(seat.id)) {
    selectedSeatIds.delete(seat.id);
  } else {
    selectedSeatIds.add(seat.id);
  }
  renderSeats();
}

function updateControls() {
  if (currentHoldId) {
    holdBtn.disabled = true;
    confirmBtn.disabled = false;
    releaseBtn.disabled = false;
  } else {
    holdBtn.disabled = selectedSeatIds.size === 0;
    confirmBtn.disabled = true;
    releaseBtn.disabled = true;
  }
}

holdBtn.addEventListener('click', async () => {
  if (selectedSeatIds.size === 0) return;
  
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
    
    if (res.ok) {
      currentHoldId = data.holdId;
      holdExpiresAt = new Date(data.expiresAt);

      //const HOLD_TTL_SECONDS = 60;                                  // must match backend
      //holdExpiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000);
      selectedSeatIds.clear();
      startTimer();
      statusMessageEl.textContent = 'Seats held. Please confirm.';
      
      // Update local state
      data.seats.forEach(updatedSeat => {
        const seat = seats.find(s => s.id === updatedSeat.id);
        if (seat) {
          Object.assign(seat, updatedSeat);
        }
      });
      renderSeats();
    } else if (res.status === 409) {
      statusMessageEl.textContent = `Failed: Seats ${data.conflictingSeatIds.join(', ')} are unavailable.`;
      selectedSeatIds.clear();
      await fetchSeats();
    } else {
      statusMessageEl.textContent = `Error: ${data.error}`;
    }
  } catch (err) {
    console.error(err);
    statusMessageEl.textContent = 'Network error.';
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
    
    if (res.ok) {
      statusMessageEl.textContent = 'Booking confirmed!';
      clearHoldState();
      
      data.seats.forEach(updatedSeat => {
        const seat = seats.find(s => s.id === updatedSeat.id);
        if (seat) {
          Object.assign(seat, updatedSeat);
        }
      });
      renderSeats();
    } else {
      statusMessageEl.textContent = `Confirm failed: ${data.error}`;
      clearHoldState();
      await fetchSeats();
    }
  } catch (err) {
    console.error(err);
    statusMessageEl.textContent = 'Network error.';
  }
});

releaseBtn.addEventListener('click', async () => {
  if (!currentHoldId) return;
  
  try {
    await fetch(`${API_URL}/holds/${currentHoldId}`, {
      method: 'DELETE'
    });
    statusMessageEl.textContent = 'Hold released.';
    clearHoldState();
    await fetchSeats();
  } catch (err) {
    console.error(err);
  }
});

function clearHoldState() {
  currentHoldId = null;
  holdExpiresAt = null;
  stopTimer();
  timerEl.textContent = '';
  updateControls();
}

function startTimer() {
  stopTimer();
  updateTimer();
  timerInterval = setInterval(updateTimer, 1000);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function updateTimer() {
  if (!holdExpiresAt) return;
  
  const now = new Date();
  const diff = Math.max(0, Math.floor((holdExpiresAt - now) / 1000));
  
  if (diff === 0) {
    statusMessageEl.textContent = 'Hold expired.';
    clearHoldState();
    fetchSeats();
  } else {
    timerEl.textContent = `Time left: ${diff}s`;
  }
}

function setupSSE() {
  const evtSource = new EventSource(`${API_URL}/stream`);
  evtSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'seats_updated') {
      let needsRender = false;
      data.seats.forEach(updatedSeat => {
        const seat = seats.find(s => s.id === updatedSeat.id);
        if (seat) {
          Object.assign(seat, updatedSeat);
          needsRender = true;
          
          // If our hold expired on the server
          if (currentHoldId && seat.hold_id !== currentHoldId && seat.status !== 'booked') {
            // We might have lost the hold
            // Wait, if we lost the hold, we should clear it if all our seats are gone
            // For simplicity, if any of our held seats is no longer ours, clear hold state
            // Actually, let's just rely on the timer or a full fetch
          }
        }
      });
      if (needsRender) {
        renderSeats();
      }
    }
  };
}

// Init
fetchSeats().then(() => {
  setupSSE();
});
