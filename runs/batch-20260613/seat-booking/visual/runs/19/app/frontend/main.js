import { v4 as uuidv4 } from 'uuid';

const API_BASE = '/api';
let sessionId = localStorage.getItem('sessionId');
if (!sessionId) {
  sessionId = uuidv4();
  localStorage.setItem('sessionId', sessionId);
}

let seats = [];
let selectedSeatIds = new Set();
let currentHoldId = null;
let holdExpiresAt = null;
let timerInterval = null;

const seatMapEl = document.getElementById('seat-map');
const holdBtn = document.getElementById('hold-btn');
const confirmBtn = document.getElementById('confirm-btn');
const releaseBtn = document.getElementById('release-btn');
const statusMessageEl = document.getElementById('status-message');
const timerEl = document.getElementById('timer');

async function fetchSeats() {
  const res = await fetch(`${API_BASE}/seats`);
  seats = await res.json();
  renderSeats();
}

function renderSeats() {
  seatMapEl.innerHTML = '';
  seats.forEach(seat => {
    const seatEl = document.createElement('div');
    seatEl.className = `seat ${seat.status}`;
    if (seat.status === 'held' && seat.hold_id === currentHoldId) {
      seatEl.classList.add('my-hold');
    }
    if (selectedSeatIds.has(seat.id) && seat.status === 'available') {
      seatEl.classList.add('selected');
    }
    seatEl.textContent = seat.id;
    
    seatEl.addEventListener('click', () => {
      if (seat.status !== 'available') return;
      if (currentHoldId) return; // Cannot select new seats while holding
      
      if (selectedSeatIds.has(seat.id)) {
        selectedSeatIds.delete(seat.id);
      } else {
        selectedSeatIds.add(seat.id);
      }
      renderSeats();
      updateControls();
    });
    
    seatMapEl.appendChild(seatEl);
  });
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

function startTimer() {
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    if (!holdExpiresAt) {
      timerEl.textContent = '';
      clearInterval(timerInterval);
      return;
    }
    const remaining = Math.max(0, Math.floor((holdExpiresAt - Date.now()) / 1000));
    if (remaining > 0) {
      timerEl.textContent = `Hold expires in ${remaining}s`;
    } else {
      timerEl.textContent = 'Hold expired';
      currentHoldId = null;
      holdExpiresAt = null;
      selectedSeatIds.clear();
      updateControls();
      renderSeats();
      clearInterval(timerInterval);
    }
  }, 1000);
}

holdBtn.addEventListener('click', async () => {
  if (selectedSeatIds.size === 0) return;
  
  try {
    const res = await fetch(`${API_BASE}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds: Array.from(selectedSeatIds), sessionId })
    });
    
    const data = await res.json();
    if (res.ok) {
      currentHoldId = data.holdId;
      holdExpiresAt = data.expiresAt;
      statusMessageEl.textContent = 'Seats held!';
      startTimer();
      updateControls();
      // Local update before SSE arrives
      seats.forEach(s => {
        if (selectedSeatIds.has(s.id)) {
          s.status = 'held';
          s.hold_id = currentHoldId;
        }
      });
      renderSeats();
    } else if (res.status === 409) {
      statusMessageEl.textContent = 'Some seats are unavailable!';
      selectedSeatIds.clear();
      await fetchSeats();
      updateControls();
    } else {
      statusMessageEl.textContent = 'Error holding seats';
    }
  } catch (err) {
    console.error(err);
    statusMessageEl.textContent = 'Network error';
  }
});

confirmBtn.addEventListener('click', async () => {
  if (!currentHoldId) return;
  
  try {
    const res = await fetch(`${API_BASE}/holds/${currentHoldId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    });
    
    const data = await res.json();
    if (res.ok) {
      statusMessageEl.textContent = 'Booking confirmed!';
      currentHoldId = null;
      holdExpiresAt = null;
      selectedSeatIds.clear();
      timerEl.textContent = '';
      clearInterval(timerInterval);
      updateControls();
      // Local update
      seats.forEach(s => {
        if (data.seatIds.includes(s.id)) {
          s.status = 'booked';
        }
      });
      renderSeats();
    } else {
      statusMessageEl.textContent = data.error || 'Error confirming booking';
      currentHoldId = null;
      holdExpiresAt = null;
      selectedSeatIds.clear();
      timerEl.textContent = '';
      clearInterval(timerInterval);
      updateControls();
      await fetchSeats();
    }
  } catch (err) {
    console.error(err);
    statusMessageEl.textContent = 'Network error';
  }
});

releaseBtn.addEventListener('click', async () => {
  if (!currentHoldId) return;
  
  try {
    await fetch(`${API_BASE}/holds/${currentHoldId}`, { method: 'DELETE' });
    statusMessageEl.textContent = 'Hold released';
    currentHoldId = null;
    holdExpiresAt = null;
    selectedSeatIds.clear();
    timerEl.textContent = '';
    clearInterval(timerInterval);
    updateControls();
    await fetchSeats();
  } catch (err) {
    console.error(err);
  }
});

function setupSSE() {
  const evtSource = new EventSource(`${API_BASE}/stream`);
  evtSource.addEventListener('error', () => {
    fetchSeats();
  });
  evtSource.addEventListener('seats_updated', (e) => {
    const data = JSON.parse(e.data);
    let changed = false;
    data.seats.forEach(updatedSeat => {
      const seat = seats.find(s => s.id === updatedSeat.id);
      if (seat) {
        seat.status = updatedSeat.status;
        if (updatedSeat.hold_id !== undefined) seat.hold_id = updatedSeat.hold_id;
        changed = true;
        
        // If our held seat was released (e.g. expired)
        if (currentHoldId && seat.status === 'available' && selectedSeatIds.has(seat.id)) {
          currentHoldId = null;
          holdExpiresAt = null;
          selectedSeatIds.clear();
          timerEl.textContent = 'Hold expired';
          clearInterval(timerInterval);
          updateControls();
        }
      }
    });
    if (changed) renderSeats();
  });
}

fetchSeats().then(() => {
  setupSSE();
});
