const API_BASE = 'http://localhost:3000/api';

let sessionId = localStorage.getItem('sessionId');
if (!sessionId) {
  sessionId = Math.random().toString(36).substring(2, 15);
  localStorage.setItem('sessionId', sessionId);
}

let seats = [];
let selectedSeatIds = new Set();
let currentHold = null; // { holdId, expiresAt, seatIds }
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
  renderSeatMap();
}

function renderSeatMap() {
  seatMapEl.innerHTML = '';
  
  // Group by row
  const rows = {};
  for (const seat of seats) {
    if (!rows[seat.row_label]) rows[seat.row_label] = [];
    rows[seat.row_label].push(seat);
  }

  for (const rowLabel of Object.keys(rows).sort()) {
    const rowEl = document.createElement('div');
    rowEl.className = 'row';
    
    const labelEl = document.createElement('div');
    labelEl.className = 'row-label';
    labelEl.textContent = rowLabel;
    rowEl.appendChild(labelEl);

    rows[rowLabel].sort((a, b) => a.seat_number - b.seat_number).forEach(seat => {
      const seatEl = document.createElement('div');
      seatEl.className = 'seat';
      seatEl.textContent = seat.seat_number;
      
      let statusClass = seat.status;
      
      // If it's held by us, show it differently
      if (currentHold && currentHold.seatIds.includes(seat.id) && seat.status === 'held') {
        statusClass = 'my-hold';
      }

      seatEl.classList.add(statusClass);
      
      if (selectedSeatIds.has(seat.id)) {
        seatEl.classList.add('selected');
      }

      seatEl.addEventListener('click', () => toggleSeatSelection(seat));
      rowEl.appendChild(seatEl);
    });

    seatMapEl.appendChild(rowEl);
  }
  
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
  renderSeatMap();
}

function updateButtons() {
  holdBtn.disabled = selectedSeatIds.size === 0 || currentHold !== null;
  confirmBtn.disabled = currentHold === null;
  releaseBtn.disabled = currentHold === null;
}

function showMessage(msg) {
  statusMessageEl.textContent = msg;
  setTimeout(() => { statusMessageEl.textContent = ''; }, 5000);
}

function startTimer() {
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    if (!currentHold) {
      clearInterval(timerInterval);
      timerEl.textContent = '';
      return;
    }
    const remaining = Math.max(0, Math.floor((currentHold.expiresAt - Date.now()) / 1000));
    if (remaining > 0) {
      timerEl.textContent = `Hold expires in ${remaining}s`;
    } else {
      timerEl.textContent = 'Hold expired';
      currentHold = null;
      selectedSeatIds.clear();
      clearInterval(timerInterval);
      renderSeatMap();
    }
  }, 1000);
}

holdBtn.addEventListener('click', async () => {
  if (selectedSeatIds.size === 0) return;
  
  const seatIds = Array.from(selectedSeatIds);
  try {
    const res = await fetch(`${API_BASE}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId })
    });
    
    const data = await res.json();
    if (res.ok) {
      currentHold = data;
      selectedSeatIds.clear();
      startTimer();
      showMessage('Seats held successfully!');
    } else if (res.status === 409) {
      showMessage('Some seats are no longer available.');
      selectedSeatIds.clear();
      await fetchSeats();
    } else {
      showMessage(data.error || 'Failed to hold seats.');
    }
  } catch (err) {
    showMessage('Network error.');
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
    
    const data = await res.json();
    if (res.ok) {
      showMessage('Booking confirmed!');
      currentHold = null;
      clearInterval(timerInterval);
      timerEl.textContent = '';
      // Seats will be updated via SSE
    } else {
      showMessage(data.error || 'Failed to confirm booking.');
      currentHold = null;
      clearInterval(timerInterval);
      timerEl.textContent = '';
      await fetchSeats();
    }
  } catch (err) {
    showMessage('Network error.');
  }
});

releaseBtn.addEventListener('click', async () => {
  if (!currentHold) return;
  
  try {
    await fetch(`${API_BASE}/holds/${currentHold.holdId}`, {
      method: 'DELETE'
    });
    currentHold = null;
    clearInterval(timerInterval);
    timerEl.textContent = '';
    showMessage('Hold released.');
  } catch (err) {
    showMessage('Network error.');
  }
});

function setupSSE() {
  const evtSource = new EventSource(`${API_BASE}/stream`);
  evtSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'seats_updated') {
      let changed = false;
      for (const updatedSeat of data.seats) {
        const seat = seats.find(s => s.id === updatedSeat.id);
        if (seat && seat.status !== updatedSeat.status) {
          seat.status = updatedSeat.status;
          changed = true;
          
          // If a seat we selected became unavailable, deselect it
          if (seat.status !== 'available' && selectedSeatIds.has(seat.id)) {
            selectedSeatIds.delete(seat.id);
          }
        }
      }
      if (changed) {
        renderSeatMap();
      }
    }
  };
}

fetchSeats().then(setupSSE);
