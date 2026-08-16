const API_BASE = 'http://localhost:3000/api';
let sessionId = localStorage.getItem('sessionId');
if (!sessionId) {
  sessionId = crypto.randomUUID();
  localStorage.setItem('sessionId', sessionId);
}

let seats = [];
let selectedSeats = new Set();
let currentHold = null; // { holdId, expiresAt, seats }
let timerInterval = null;

const seatMapEl = document.getElementById('seatMap');
const holdBtn = document.getElementById('holdBtn');
const confirmBtn = document.getElementById('confirmBtn');
const releaseBtn = document.getElementById('releaseBtn');
const timerEl = document.getElementById('timer');
const messageEl = document.getElementById('message');

function showMessage(msg, isError = false) {
  messageEl.textContent = msg;
  messageEl.style.color = isError ? 'red' : 'black';
}

async function fetchSeats() {
  const res = await fetch(`${API_BASE}/seats`);
  seats = await res.json();
  renderSeats();
}

function renderSeats() {
  seatMapEl.innerHTML = '';
  const rows = {};
  seats.forEach(seat => {
    if (!rows[seat.row_label]) rows[seat.row_label] = [];
    rows[seat.row_label].push(seat);
  });

  for (const [rowLabel, rowSeats] of Object.entries(rows)) {
    const rowEl = document.createElement('div');
    rowEl.className = 'row';
    
    const labelEl = document.createElement('div');
    labelEl.className = 'row-label';
    labelEl.textContent = rowLabel;
    rowEl.appendChild(labelEl);

    rowSeats.forEach(seat => {
      const seatEl = document.createElement('div');
      seatEl.className = `seat ${seat.status}`;
      seatEl.textContent = seat.seat_number;
      
      if (currentHold && currentHold.seats.includes(seat.id)) {
        seatEl.className = 'seat my-held';
      } else if (seat.status === 'available' && selectedSeats.has(seat.id)) {
        seatEl.className = 'seat selected';
      }

      seatEl.addEventListener('click', () => toggleSeat(seat));
      rowEl.appendChild(seatEl);
    });

    seatMapEl.appendChild(rowEl);
  }
  updateButtons();
}

function toggleSeat(seat) {
  if (currentHold) return; // Cannot select while holding
  if (seat.status !== 'available') return;

  if (selectedSeats.has(seat.id)) {
    selectedSeats.delete(seat.id);
  } else {
    selectedSeats.add(seat.id);
  }
  renderSeats();
}

function updateButtons() {
  if (currentHold) {
    holdBtn.style.display = 'none';
    confirmBtn.style.display = 'inline-block';
    releaseBtn.style.display = 'inline-block';
  } else {
    holdBtn.style.display = 'inline-block';
    confirmBtn.style.display = 'none';
    releaseBtn.style.display = 'none';
    holdBtn.disabled = selectedSeats.size === 0;
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
    
    const data = await res.json();
    if (!res.ok) {
      if (data.conflicting) {
        showMessage(`Failed to hold seats. Conflicting: ${data.conflicting.join(', ')}`, true);
        await fetchSeats();
        selectedSeats.clear();
        renderSeats();
      } else {
        showMessage(data.error || 'Failed to hold seats', true);
      }
      return;
    }

    currentHold = data;
    selectedSeats.clear();
    startTimer();
    showMessage('Seats held successfully');
    renderSeats();
  } catch (err) {
    showMessage('Network error', true);
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
    if (!res.ok) {
      showMessage(data.error || 'Failed to confirm booking', true);
      clearHold();
      await fetchSeats();
      return;
    }

    showMessage('Booking confirmed!');
    clearHold();
    await fetchSeats();
  } catch (err) {
    showMessage('Network error', true);
  }
});

releaseBtn.addEventListener('click', async () => {
  if (!currentHold) return;
  
  try {
    await fetch(`${API_BASE}/holds/${currentHold.holdId}`, {
      method: 'DELETE'
    });
    showMessage('Hold released');
    clearHold();
    await fetchSeats();
  } catch (err) {
    showMessage('Network error', true);
  }
});

function startTimer() {
  if (timerInterval) clearInterval(timerInterval);
  
  timerInterval = setInterval(() => {
    if (!currentHold) {
      clearInterval(timerInterval);
      timerEl.textContent = '';
      return;
    }
    
    const remaining = currentHold.expiresAt - Date.now();
    if (remaining <= 0) {
      clearInterval(timerInterval);
      timerEl.textContent = 'Hold expired';
      showMessage('Hold expired', true);
      clearHold();
      fetchSeats();
    } else {
      timerEl.textContent = `Time left: ${Math.ceil(remaining / 1000)}s`;
    }
  }, 1000);
}

function clearHold() {
  currentHold = null;
  if (timerInterval) clearInterval(timerInterval);
  timerEl.textContent = '';
  updateButtons();
  renderSeats();
}

const evtSource = new EventSource(`${API_BASE}/stream`);
evtSource.addEventListener('seats_updated', (e) => {
  const data = JSON.parse(e.data);
  let changed = false;
  
  data.seats.forEach(seatId => {
    const seat = seats.find(s => s.id === seatId);
    if (seat) {
      seat.status = data.status;
      changed = true;
    }
  });
  
  if (changed) {
    if (currentHold && data.status === 'available') {
      const ourSeatsReleased = data.seats.some(id => currentHold.seats.includes(id));
      if (ourSeatsReleased) {
        clearHold();
        showMessage('Hold expired', true);
      }
    }
    renderSeats();
  }
});

fetchSeats();
