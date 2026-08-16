const API_BASE = '/api';

let seats = [];
let selectedSeatIds = new Set();
let currentHold = null; // { holdId, expiresAt, seats }
let timerInterval = null;
let sessionId = crypto.randomUUID();

const seatMapEl = document.getElementById('seat-map');
const btnHold = document.getElementById('btn-hold');
const btnConfirm = document.getElementById('btn-confirm');
const btnRelease = document.getElementById('btn-release');
const messageEl = document.getElementById('message');
const timerEl = document.getElementById('timer');

async function fetchSeats() {
  const res = await fetch(\`\${API_BASE}/seats\`);
  seats = await res.json();
  renderSeatMap();
}

function setupSSE() {
  const evtSource = new EventSource(\`\${API_BASE}/stream\`);
  evtSource.onmessage = (event) => {
    const updatedSeats = JSON.parse(event.data);
    let changed = false;
    for (const updated of updatedSeats) {
      const idx = seats.findIndex(s => s.id === updated.id);
      if (idx !== -1) {
        seats[idx] = updated;
        changed = true;
        if (updated.status !== 'available' && selectedSeatIds.has(updated.id)) {
          selectedSeatIds.delete(updated.id);
        }
      }
    }
    if (changed) {
      renderSeatMap();
      checkCurrentHold();
    }
  };
}

function checkCurrentHold() {
  if (!currentHold) return;
  // Check if our held seats are still held by us
  const ourSeats = seats.filter(s => currentHold.seats.some(cs => cs.id === s.id));
  const stillHeld = ourSeats.every(s => s.hold_id === currentHold.holdId && s.status === 'held');
  const bookedByUs = ourSeats.every(s => s.hold_id === currentHold.holdId && s.status === 'booked');

  if (bookedByUs) {
    clearHoldState();
    showMessage('Booking confirmed!', 'success');
  } else if (!stillHeld) {
    // Hold expired or was lost
    clearHoldState();
    showMessage('Hold expired.', 'error');
  }
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

    const rowSeats = rows[rowLabel].sort((a, b) => a.seat_number - b.seat_number);
    for (const seat of rowSeats) {
      const seatEl = document.createElement('div');
      seatEl.className = 'seat';
      seatEl.textContent = seat.seat_number;
      
      if (seat.status === 'booked') {
        seatEl.classList.add('booked');
      } else if (seat.status === 'held') {
        if (currentHold && seat.hold_id === currentHold.holdId) {
          seatEl.classList.add('my-held');
        } else {
          seatEl.classList.add('held');
        }
      } else {
        seatEl.classList.add('available');
        if (selectedSeatIds.has(seat.id)) {
          seatEl.classList.add('selected');
        }
        seatEl.addEventListener('click', () => toggleSeatSelection(seat.id));
      }

      rowEl.appendChild(seatEl);
    }
    seatMapEl.appendChild(rowEl);
  }

  updateControls();
}

function toggleSeatSelection(seatId) {
  if (currentHold) return; // Cannot select new seats while holding
  if (selectedSeatIds.has(seatId)) {
    selectedSeatIds.delete(seatId);
  } else {
    selectedSeatIds.add(seatId);
  }
  renderSeatMap();
}

function updateControls() {
  if (currentHold) {
    btnHold.classList.add('hidden');
    btnConfirm.classList.remove('hidden');
    btnRelease.classList.remove('hidden');
  } else {
    btnHold.classList.remove('hidden');
    btnConfirm.classList.add('hidden');
    btnRelease.classList.add('hidden');
    btnHold.disabled = selectedSeatIds.size === 0;
  }
}

function showMessage(msg, type = 'info') {
  messageEl.textContent = msg;
  messageEl.style.color = type === 'error' ? 'red' : type === 'success' ? 'green' : 'black';
}

function startTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerEl.classList.remove('hidden');
  
  timerInterval = setInterval(() => {
    if (!currentHold) {
      clearInterval(timerInterval);
      timerEl.classList.add('hidden');
      return;
    }
    const remaining = Math.max(0, Math.floor((currentHold.expiresAt - Date.now()) / 1000));
    timerEl.textContent = \`Time left: \${remaining}s\`;
    if (remaining <= 0) {
      clearInterval(timerInterval);
      timerEl.classList.add('hidden');
      clearHoldState();
      showMessage('Hold expired.', 'error');
    }
  }, 1000);
}

function clearHoldState() {
  currentHold = null;
  selectedSeatIds.clear();
  if (timerInterval) clearInterval(timerInterval);
  timerEl.classList.add('hidden');
  updateControls();
  renderSeatMap();
}

btnHold.addEventListener('click', async () => {
  if (selectedSeatIds.size === 0) return;
  
  const seatIds = Array.from(selectedSeatIds);
  try {
    const res = await fetch(\`\${API_BASE}/holds\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId })
    });
    
    const data = await res.json();
    if (res.ok) {
      currentHold = data;
      selectedSeatIds.clear();
      showMessage('Seats held! Please confirm.', 'success');
      startTimer();
      renderSeatMap();
    } else if (res.status === 409) {
      showMessage('Some seats were already taken.', 'error');
      selectedSeatIds.clear();
      // The SSE will update the map, but we can also fetch
      fetchSeats();
    } else {
      showMessage(data.error || 'Failed to hold seats', 'error');
    }
  } catch (err) {
    console.error(err);
    showMessage('Network error', 'error');
  }
});

btnConfirm.addEventListener('click', async () => {
  if (!currentHold) return;
  
  try {
    const res = await fetch(\`\${API_BASE}/holds/\${currentHold.holdId}/confirm\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    });
    
    const data = await res.json();
    if (res.ok) {
      showMessage('Booking confirmed!', 'success');
      clearHoldState();
    } else {
      showMessage(data.error || 'Failed to confirm booking', 'error');
      clearHoldState();
      fetchSeats();
    }
  } catch (err) {
    console.error(err);
    showMessage('Network error', 'error');
  }
});

btnRelease.addEventListener('click', async () => {
  if (!currentHold) return;
  
  try {
    await fetch(\`\${API_BASE}/holds/\${currentHold.holdId}\`, {
      method: 'DELETE'
    });
    showMessage('Hold released.', 'info');
    clearHoldState();
  } catch (err) {
    console.error(err);
  }
});

// Init
fetchSeats();
setupSSE();
