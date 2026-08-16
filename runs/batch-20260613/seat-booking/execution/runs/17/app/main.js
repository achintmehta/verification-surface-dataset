import { v4 as uuidv4 } from 'uuid';

const API_BASE = 'http://localhost:3000/api';
let sessionId = localStorage.getItem('sessionId');
if (!sessionId) {
  sessionId = uuidv4();
  localStorage.setItem('sessionId', sessionId);
}

let seats = {};
let selectedSeats = new Set();
let currentHold = null;
let countdownInterval = null;

const seatMapEl = document.getElementById('seat-map');
const holdBtn = document.getElementById('hold-btn');
const confirmBtn = document.getElementById('confirm-btn');
const releaseBtn = document.getElementById('release-btn');
const countdownEl = document.getElementById('countdown');

async function fetchSeats() {
  const res = await fetch(`${API_BASE}/seats`);
  const data = await res.json();
  data.forEach(seat => {
    seats[seat.id] = seat;
  });
  renderSeats();
}

function renderSeats() {
  seatMapEl.innerHTML = '';
  const sortedIds = Object.keys(seats).sort((a, b) => {
    const rowA = a.match(/[A-Z]+/)[0];
    const rowB = b.match(/[A-Z]+/)[0];
    if (rowA !== rowB) return rowA.localeCompare(rowB);
    const numA = parseInt(a.match(/\d+/)[0]);
    const numB = parseInt(b.match(/\d+/)[0]);
    return numA - numB;
  });

  sortedIds.forEach(id => {
    const seat = seats[id];
    const el = document.createElement('div');
    el.className = `seat ${seat.status}`;
    el.textContent = id;
    
    if (currentHold && currentHold.seats.includes(id)) {
      el.classList.add('my-hold');
    } else if (selectedSeats.has(id)) {
      el.classList.add('selected');
    }

    el.addEventListener('click', () => toggleSeatSelection(id));
    seatMapEl.appendChild(el);
  });
  updateControls();
}

function toggleSeatSelection(id) {
  const seat = seats[id];
  if (seat.status !== 'available') return;
  if (currentHold) return; // Cannot select more if already holding

  if (selectedSeats.has(id)) {
    selectedSeats.delete(id);
  } else {
    selectedSeats.add(id);
  }
  renderSeats();
}

function updateControls() {
  if (currentHold) {
    holdBtn.style.display = 'none';
    confirmBtn.style.display = 'inline-block';
    releaseBtn.style.display = 'inline-block';
  } else {
    holdBtn.style.display = 'inline-block';
    confirmBtn.style.display = 'none';
    releaseBtn.style.display = 'none';
    holdBtn.disabled = selectedSeats.size === 0;
    countdownEl.textContent = '';
  }
}

holdBtn.addEventListener('click', async () => {
  if (selectedSeats.size === 0) return;
  const seatIds = Array.from(selectedSeats);
  
  try {
    const res = await fetch(`${API_BASE}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId })
    });
    
    if (res.status === 409) {
      const data = await res.json();
      alert(`Seats unavailable: ${data.conflictingSeatIds.join(', ')}`);
      selectedSeats.clear();
      await fetchSeats();
      return;
    }
    
    if (!res.ok) throw new Error('Failed to hold seats');
    
    const data = await res.json();
    currentHold = data;
    selectedSeats.clear();
    startCountdown();
    renderSeats();
  } catch (err) {
    console.error(err);
    alert('Error holding seats');
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
    
    if (!res.ok) {
      const data = await res.json();
      alert(`Confirm failed: ${data.error}`);
      currentHold = null;
      stopCountdown();
      await fetchSeats();
      return;
    }
    
    currentHold = null;
    stopCountdown();
    renderSeats();
  } catch (err) {
    console.error(err);
    alert('Error confirming hold');
  }
});

releaseBtn.addEventListener('click', async () => {
  if (!currentHold) return;
  try {
    await fetch(`${API_BASE}/holds/${currentHold.holdId}`, {
      method: 'DELETE'
    });
    currentHold = null;
    stopCountdown();
    renderSeats();
  } catch (err) {
    console.error(err);
  }
});

function startCountdown() {
  stopCountdown();
  countdownInterval = setInterval(() => {
    if (!currentHold) {
      stopCountdown();
      return;
    }
    const remaining = currentHold.expiresAt - Date.now();
    if (remaining <= 0) {
      stopCountdown();
      currentHold = null;
      countdownEl.textContent = 'Hold expired';
      renderSeats();
    } else {
      countdownEl.textContent = `Hold expires in ${Math.ceil(remaining / 1000)}s`;
    }
  }, 1000);
}

function stopCountdown() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
  countdownEl.textContent = '';
}

function setupSSE() {
  const evtSource = new EventSource(`${API_BASE}/stream`);
  evtSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'seats_updated') {
      let needsRender = false;
      data.seats.forEach(updatedSeat => {
        if (seats[updatedSeat.id]) {
          seats[updatedSeat.id].status = updatedSeat.status;
          seats[updatedSeat.id].hold_id = updatedSeat.hold_id;
          needsRender = true;
          
          if (updatedSeat.status !== 'available' && selectedSeats.has(updatedSeat.id)) {
            selectedSeats.delete(updatedSeat.id);
          }
          
          // If our held seat was released or booked
          if (currentHold && currentHold.seats.includes(updatedSeat.id) && updatedSeat.status !== 'held') {
            currentHold = null;
            stopCountdown();
          }
        }
      });
      if (needsRender) renderSeats();
    }
  };
}

fetchSeats().then(setupSSE);
