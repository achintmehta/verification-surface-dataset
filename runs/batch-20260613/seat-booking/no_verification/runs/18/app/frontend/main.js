const API_URL = 'http://localhost:3000/api';

let seats = [];
let selectedSeatIds = new Set();
let currentHoldId = null;
let holdExpiresAt = null;
let sessionId = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2);
let timerInterval = null;

const seatMapEl = document.getElementById('seat-map');
const holdBtn = document.getElementById('hold-btn');
const confirmBtn = document.getElementById('confirm-btn');
const releaseBtn = document.getElementById('release-btn');
const timerEl = document.getElementById('timer');

async function fetchSeats() {
  const res = await fetch(`${API_URL}/seats`);
  seats = await res.json();
  renderSeats();
}

function renderSeats() {
  seatMapEl.innerHTML = '';
  seats.forEach(seat => {
    const el = document.createElement('div');
    el.className = 'seat';
    el.textContent = seat.id;
    
    if (seat.status === 'available') {
      el.classList.add('available');
      if (selectedSeatIds.has(seat.id)) {
        el.classList.add('selected');
      }
      el.addEventListener('click', () => toggleSelection(seat.id));
    } else if (seat.status === 'held') {
      if (seat.hold_id === currentHoldId) {
        el.classList.add('held-by-me');
      } else {
        el.classList.add('held');
      }
    } else if (seat.status === 'booked') {
      el.classList.add('booked');
    }
    
    seatMapEl.appendChild(el);
  });
  updateControls();
}

function toggleSelection(id) {
  if (selectedSeatIds.has(id)) {
    selectedSeatIds.delete(id);
  } else {
    selectedSeatIds.add(id);
  }
  renderSeats();
}

function updateControls() {
  holdBtn.disabled = selectedSeatIds.size === 0 || currentHoldId !== null;
  confirmBtn.disabled = currentHoldId === null;
  releaseBtn.disabled = currentHoldId === null;
}

holdBtn.addEventListener('click', async () => {
  if (selectedSeatIds.size === 0) return;
  
  const res = await fetch(`${API_URL}/holds`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      seatIds: Array.from(selectedSeatIds),
      sessionId
    })
  });
  
  if (res.ok) {
    const data = await res.json();
    currentHoldId = data.holdId;
    holdExpiresAt = data.expiresAt;
    selectedSeatIds.clear();
    startTimer();
    updateSeats(data.seats);
  } else if (res.status === 409) {
    const data = await res.json();
    alert(`Seats unavailable: ${data.conflictingSeatIds.join(', ')}`);
    selectedSeatIds.clear();
    fetchSeats();
  }
});

confirmBtn.addEventListener('click', async () => {
  if (!currentHoldId) return;
  
  const res = await fetch(`${API_URL}/holds/${currentHoldId}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId })
  });
  
  if (res.ok) {
    const data = await res.json();
    currentHoldId = null;
    holdExpiresAt = null;
    stopTimer();
    updateSeats(data.seats);
  } else {
    const data = await res.json();
    alert(`Confirm failed: ${data.error}`);
    currentHoldId = null;
    holdExpiresAt = null;
    stopTimer();
    fetchSeats();
  }
});

releaseBtn.addEventListener('click', async () => {
  if (!currentHoldId) return;
  
  const res = await fetch(`${API_URL}/holds/${currentHoldId}`, {
    method: 'DELETE'
  });
  
  if (res.ok) {
    currentHoldId = null;
    holdExpiresAt = null;
    stopTimer();
    fetchSeats();
  }
});

function startTimer() {
  stopTimer();
  timerInterval = setInterval(() => {
    const remaining = Math.max(0, holdExpiresAt - Date.now());
    if (remaining === 0) {
      stopTimer();
      currentHoldId = null;
      holdExpiresAt = null;
      alert('Hold expired');
      fetchSeats();
    } else {
      timerEl.textContent = `Hold expires in ${Math.ceil(remaining / 1000)}s`;
    }
  }, 1000);
}

function stopTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
  timerEl.textContent = '';
}

function updateSeats(updatedSeats) {
  const updatedMap = new Map(updatedSeats.map(s => [s.id, s]));
  seats = seats.map(s => updatedMap.has(s.id) ? updatedMap.get(s.id) : s);
  
  // Remove unavailable seats from selection
  for (const id of selectedSeatIds) {
    const seat = seats.find(s => s.id === id);
    if (seat && seat.status !== 'available') {
      selectedSeatIds.delete(id);
    }
  }
  
  // If our hold expired or was released by server
  if (currentHoldId) {
    const ourHeldSeats = seats.filter(s => s.hold_id === currentHoldId);
    if (ourHeldSeats.length === 0) {
      currentHoldId = null;
      holdExpiresAt = null;
      stopTimer();
    }
  }
  
  renderSeats();
}

function setupSSE() {
  const evtSource = new EventSource(`${API_URL}/stream`);
  evtSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'seats_updated') {
      updateSeats(data.seats);
    }
  };
}

fetchSeats();
setupSSE();
