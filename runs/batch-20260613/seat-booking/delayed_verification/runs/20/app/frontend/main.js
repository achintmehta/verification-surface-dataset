const API_URL = 'http://localhost:3001/api';
const sessionId = crypto.randomUUID();

let seats = [];
let selectedSeatIds = new Set();
let currentHoldId = null;
let holdExpiresAt = null;
let timerInterval = null;

const seatMapEl = document.getElementById('seat-map');
const holdBtn = document.getElementById('hold-btn');
const confirmBtn = document.getElementById('confirm-btn');
const releaseBtn = document.getElementById('release-btn');
const timerEl = document.getElementById('timer');

async function fetchSeats() {
  const res = await fetch(`${API_URL}/seats`);
  seats = await res.json();
  
  if (currentHoldId) {
    const ourHoldStillActive = seats.some(s => s.hold_id === currentHoldId);
    if (!ourHoldStillActive) {
      clearHoldState();
    }
  }
  
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
      seatEl.addEventListener('click', () => toggleSeatSelection(seat.id));
    } else if (seat.status === 'held') {
      if (seat.hold_id === currentHoldId) {
        seatEl.classList.add('held-by-me');
      } else {
        seatEl.classList.add('held');
      }
    } else if (seat.status === 'booked') {
      seatEl.classList.add('booked');
    }
    
    seatMapEl.appendChild(seatEl);
  });
  updateButtons();
}

function toggleSeatSelection(seatId) {
  if (currentHoldId) return; // Cannot select new seats while holding
  if (selectedSeatIds.has(seatId)) {
    selectedSeatIds.delete(seatId);
  } else {
    selectedSeatIds.add(seatId);
  }
  renderSeats();
}

function updateButtons() {
  holdBtn.disabled = selectedSeatIds.size === 0 || currentHoldId !== null;
  confirmBtn.disabled = currentHoldId === null;
  releaseBtn.disabled = currentHoldId === null;
}

holdBtn.addEventListener('click', async () => {
  if (selectedSeatIds.size === 0) return;
  
  try {
    const res = await fetch(`${API_URL}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds: Array.from(selectedSeatIds), sessionId })
    });
    
    if (res.status === 409) {
      const data = await res.json();
      alert(`Seats unavailable: ${data.conflictingSeatIds.join(', ')}`);
      selectedSeatIds.clear();
      await fetchSeats();
      return;
    }
    
    if (!res.ok) throw new Error('Failed to hold seats');
    
    const data = await res.json();
    currentHoldId = data.holdId;
    holdExpiresAt = data.expiresAt;
    selectedSeatIds.clear();
    
    startTimer();
    updateSeatsLocally(data.seats);
  } catch (err) {
    console.error(err);
    alert('Error holding seats');
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
    
    if (!res.ok) {
      const data = await res.json();
      alert(`Confirm failed: ${data.error}`);
      clearHoldState();
      await fetchSeats();
      return;
    }
    
    const data = await res.json();
    clearHoldState();
    updateSeatsLocally(data.seats);
  } catch (err) {
    console.error(err);
    alert('Error confirming hold');
  }
});

releaseBtn.addEventListener('click', async () => {
  if (!currentHoldId) return;
  
  try {
    await fetch(`${API_URL}/holds/${currentHoldId}`, { method: 'DELETE' });
    clearHoldState();
    await fetchSeats();
  } catch (err) {
    console.error(err);
  }
});

function startTimer() {
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    const remaining = Math.max(0, holdExpiresAt - Date.now());
    if (remaining === 0) {
      clearHoldState();
      fetchSeats();
    } else {
      timerEl.textContent = `Hold expires in ${Math.ceil(remaining / 1000)}s`;
    }
  }, 1000);
}

function clearHoldState() {
  currentHoldId = null;
  holdExpiresAt = null;
  clearInterval(timerInterval);
  timerEl.textContent = '';
  updateButtons();
}

function updateSeatsLocally(updatedSeats) {
  const updatedMap = new Map(updatedSeats.map(s => [s.id, s]));
  seats = seats.map(s => updatedMap.has(s.id) ? { ...s, ...updatedMap.get(s.id) } : s);
  renderSeats();
}

function setupSSE() {
  const eventSource = new EventSource(`${API_URL}/stream`);
  
  eventSource.onopen = () => {
    fetchSeats();
  };

  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'seats_updated') {
      updateSeatsLocally(data.seats);
      
      // If our held seats were released (e.g. by sweep)
      if (currentHoldId) {
        const ourHoldStillActive = seats.some(s => s.hold_id === currentHoldId);
        if (!ourHoldStillActive) {
          clearHoldState();
        }
      }
    }
  };
}

setupSSE();