const API_URL = '/api';

let seats = [];
let selectedSeatIds = new Set();
let currentHold = null;
let holdTimer = null;
const sessionId = crypto.randomUUID();

const seatMapEl = document.getElementById('seat-map');
const holdBtn = document.getElementById('hold-btn');
const confirmBtn = document.getElementById('confirm-btn');
const releaseBtn = document.getElementById('release-btn');
const errorEl = document.getElementById('error-message');
const holdStatusEl = document.getElementById('hold-status');
const connectionStatusEl = document.getElementById('connection-status');

async function fetchSeats() {
  try {
    const res = await fetch(\`\${API_URL}/seats\`);
    seats = await res.json();
    renderSeats();
  } catch (err) {
    showError('Failed to fetch seats');
  }
}

function renderSeats() {
  seatMapEl.innerHTML = '';
  seats.forEach(seat => {
    const el = document.createElement('div');
    el.className = \`seat \${seat.status}\`;
    if (seat.status === 'held' && currentHold && currentHold.seatIds.includes(seat.id)) {
      el.classList.add('my-hold');
    }
    if (selectedSeatIds.has(seat.id)) {
      el.classList.add('selected');
    }
    el.textContent = seat.id;
    
    el.addEventListener('click', () => toggleSeatSelection(seat));
    seatMapEl.appendChild(el);
  });
  updateControls();
}

function toggleSeatSelection(seat) {
  if (seat.status !== 'available') return;
  if (currentHold) return; // Cannot select new seats while holding

  if (selectedSeatIds.has(seat.id)) {
    selectedSeatIds.delete(seat.id);
  } else {
    selectedSeatIds.add(seat.id);
  }
  renderSeats();
}

function updateControls() {
  holdBtn.disabled = selectedSeatIds.size === 0 || currentHold !== null;
  confirmBtn.disabled = currentHold === null;
  releaseBtn.disabled = currentHold === null;
}

function showError(msg) {
  errorEl.textContent = msg;
  setTimeout(() => { errorEl.textContent = ''; }, 5000);
}

function startHoldTimer() {
  if (holdTimer) clearInterval(holdTimer);
  
  const updateTimer = () => {
    if (!currentHold) {
      holdStatusEl.textContent = '';
      clearInterval(holdTimer);
      return;
    }
    
    const remaining = Math.max(0, currentHold.expiresAt - Date.now());
    if (remaining === 0) {
      holdStatusEl.textContent = 'Hold expired';
      currentHold = null;
      selectedSeatIds.clear();
      renderSeats();
      clearInterval(holdTimer);
    } else {
      holdStatusEl.textContent = \`Hold expires in \${Math.ceil(remaining / 1000)}s\`;
    }
  };
  
  updateTimer();
  holdTimer = setInterval(updateTimer, 1000);
}

holdBtn.addEventListener('click', async () => {
  if (selectedSeatIds.size === 0) return;
  
  try {
    const res = await fetch(\`\${API_URL}/holds\`, {
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
        showError(\`Seats unavailable: \${data.conflictingIds.join(', ')}\`);
        selectedSeatIds.clear();
        await fetchSeats(); // Refresh to get latest state
      } else {
        showError(data.error || 'Failed to hold seats');
      }
      return;
    }
    
    currentHold = {
      id: data.holdId,
      expiresAt: data.expiresAt,
      seatIds: data.seatIds
    };
    selectedSeatIds.clear();
    startHoldTimer();
    renderSeats();
  } catch (err) {
    showError('Network error');
  }
});

confirmBtn.addEventListener('click', async () => {
  if (!currentHold) return;
  
  try {
    const res = await fetch(\`\${API_URL}/holds/\${currentHold.id}/confirm\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    });
    
    const data = await res.json();
    
    if (!res.ok) {
      showError(data.error || 'Failed to confirm hold');
      currentHold = null;
      renderSeats();
      return;
    }
    
    currentHold = null;
    holdStatusEl.textContent = 'Booking confirmed!';
    renderSeats();
  } catch (err) {
    showError('Network error');
  }
});

releaseBtn.addEventListener('click', async () => {
  if (!currentHold) return;
  
  try {
    await fetch(\`\${API_URL}/holds/\${currentHold.id}\`, {
      method: 'DELETE'
    });
    currentHold = null;
    holdStatusEl.textContent = '';
    renderSeats();
  } catch (err) {
    showError('Network error');
  }
});

function setupSSE() {
  const evtSource = new EventSource(\`\${API_URL}/stream\`);
  
  evtSource.onopen = () => {
    connectionStatusEl.textContent = 'Connected (Live)';
    connectionStatusEl.style.color = 'green';
  };
  
  evtSource.onerror = () => {
    connectionStatusEl.textContent = 'Disconnected - Reconnecting...';
    connectionStatusEl.style.color = 'red';
  };
  
  evtSource.addEventListener('seats_updated', (e) => {
    const data = JSON.parse(e.data);
    let changed = false;
    
    data.seats.forEach(updatedSeat => {
      const seat = seats.find(s => s.id === updatedSeat.id);
      if (seat) {
        seat.status = updatedSeat.status;
        seat.hold_id = updatedSeat.hold_id;
        seat.hold_expires_at = updatedSeat.hold_expires_at;
        seat.booked_by = updatedSeat.booked_by;
        changed = true;
        
        // If a seat we selected was held/booked by someone else, deselect it
        if (selectedSeatIds.has(seat.id) && seat.status !== 'available') {
          selectedSeatIds.delete(seat.id);
        }
      }
    });
    
    if (changed) {
      renderSeats();
    }
  });
}

fetchSeats().then(setupSSE);
