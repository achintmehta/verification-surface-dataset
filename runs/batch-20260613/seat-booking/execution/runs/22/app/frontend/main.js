// ========== Session Management ==========
function getSessionId() {
  let id = localStorage.getItem('seat-booking-session');
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : 
      'sess-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('seat-booking-session', id);
  }
  return id;
}

const SESSION_ID = getSessionId();

// ========== State ==========
let seats = [];
let selectedSeatIds = new Set();
let currentHold = null; // { id, seatIds, expiresAt, status }
let holdTimerInterval = null;

// ========== API helpers ==========
const API_BASE = '/api';

async function api(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error || 'API Error');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ========== Fetch seats ==========
async function fetchSeats() {
  const data = await api('/seats');
  seats = data.seats;
  renderSeatMap();
  updateInventory();
}

// ========== Rendering ==========
function renderSeatMap() {
  const container = document.getElementById('seat-map');
  container.innerHTML = '';

  // Group by row
  const rows = {};
  for (const seat of seats) {
    if (!rows[seat.row_label]) rows[seat.row_label] = [];
    rows[seat.row_label].push(seat);
  }

  for (const [rowLabel, rowSeats] of Object.entries(rows)) {
    rowSeats.sort((a, b) => a.seat_number - b.seat_number);
    
    const rowDiv = document.createElement('div');
    rowDiv.className = 'seat-row';

    const label = document.createElement('div');
    label.className = 'row-label';
    label.textContent = rowLabel;
    rowDiv.appendChild(label);

    for (const seat of rowSeats) {
      const seatEl = document.createElement('div');
      seatEl.className = `seat ${getEffectiveStatus(seat)}`;
      seatEl.dataset.id = seat.id;
      seatEl.textContent = seat.seat_number;

      // Mark if held by me
      if (seat.status === 'held' && seat.session_id === SESSION_ID) {
        seatEl.classList.add('held-by-me');
        seatEl.classList.remove('held');
      }

      // Mark if selected
      if (selectedSeatIds.has(seat.id)) {
        seatEl.classList.add('selected');
      }

      seatEl.addEventListener('click', () => onSeatClick(seat));
      rowDiv.appendChild(seatEl);
    }

    // Right label
    const labelR = document.createElement('div');
    labelR.className = 'row-label';
    labelR.textContent = rowLabel;
    rowDiv.appendChild(labelR);

    container.appendChild(rowDiv);
  }

  // Legend
  let legend = document.querySelector('.legend');
  if (!legend) {
    legend = document.createElement('div');
    legend.className = 'legend';
    legend.innerHTML = `
      <div class="legend-item"><div class="legend-swatch" style="background:#2d6a4f"></div> Available</div>
      <div class="legend-item"><div class="legend-swatch" style="background:#00b4d8"></div> Selected</div>
      <div class="legend-item"><div class="legend-swatch" style="background:#e9c46a"></div> Your Hold</div>
      <div class="legend-item"><div class="legend-swatch" style="background:#e76f51"></div> Held</div>
      <div class="legend-item"><div class="legend-swatch" style="background:#555"></div> Booked</div>
    `;
    container.after(legend);
  }
}

function getEffectiveStatus(seat) {
  if (seat.status === 'held' && seat.hold_expires_at && new Date(seat.hold_expires_at) <= new Date()) {
    return 'available';
  }
  return seat.status;
}

function updateInventory() {
  const inv = { available: 0, held: 0, booked: 0 };
  for (const seat of seats) {
    const s = getEffectiveStatus(seat);
    inv[s] = (inv[s] || 0) + 1;
  }
  const el = document.getElementById('inventory');
  el.innerHTML = `
    <span class="inv-available">Available: ${inv.available}</span>
    <span class="inv-held">Held: ${inv.held}</span>
    <span class="inv-booked">Booked: ${inv.booked}</span>
  `;
}

function updateSelectedList() {
  const el = document.getElementById('selected-list');
  if (selectedSeatIds.size === 0) {
    el.textContent = 'None';
    document.getElementById('btn-hold').disabled = true;
  } else {
    const seatLabels = [];
    for (const id of selectedSeatIds) {
      const seat = seats.find(s => s.id === id);
      if (seat) seatLabels.push(`${seat.row_label}${seat.seat_number}`);
    }
    el.textContent = seatLabels.join(', ');
    document.getElementById('btn-hold').disabled = false;
  }
}

// ========== Interactions ==========
function onSeatClick(seat) {
  // Can't select while holding
  if (currentHold && currentHold.status === 'active') return;
  
  const status = getEffectiveStatus(seat);
  if (status !== 'available') return;

  if (selectedSeatIds.has(seat.id)) {
    selectedSeatIds.delete(seat.id);
  } else {
    selectedSeatIds.add(seat.id);
  }
  renderSeatMap();
  updateSelectedList();
}

async function onHoldClick() {
  if (selectedSeatIds.size === 0) return;
  clearError();

  try {
    const result = await api('/holds', {
      method: 'POST',
      body: JSON.stringify({
        seatIds: [...selectedSeatIds],
        sessionId: SESSION_ID
      })
    });
    
    currentHold = result.hold;
    selectedSeatIds.clear();
    
    // Update local seat state
    for (const seat of result.seats) {
      updateLocalSeat(seat);
    }
    
    showHoldPanel();
    renderSeatMap();
    updateSelectedList();
    updateInventory();
  } catch (err) {
    if (err.status === 409) {
      showError(`Some seats are already taken: ${(err.data.conflictingSeatIds || []).map(id => {
        const s = seats.find(s => s.id === id);
        return s ? `${s.row_label}${s.seat_number}` : id;
      }).join(', ')}`);
      // Deselect conflicting seats
      if (err.data.conflictingSeatIds) {
        for (const id of err.data.conflictingSeatIds) {
          selectedSeatIds.delete(id);
        }
      }
      await fetchSeats();
      updateSelectedList();
    } else {
      showError(err.message || 'Failed to hold seats');
    }
  }
}

async function onConfirmClick() {
  if (!currentHold) return;
  clearError();

  try {
    const result = await api(`/holds/${currentHold.id}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ sessionId: SESSION_ID })
    });

    currentHold = null;
    clearHoldTimer();

    // Update local state
    for (const seat of result.seats) {
      updateLocalSeat(seat);
    }

    showBookingPanel(result.seats);
    renderSeatMap();
    updateInventory();
  } catch (err) {
    showError(err.message || 'Failed to confirm booking');
    if (err.status === 410 || err.status === 404) {
      // Hold expired or not found
      currentHold = null;
      clearHoldTimer();
      hideHoldPanel();
      await fetchSeats();
    }
  }
}

async function onReleaseClick() {
  if (!currentHold) return;
  clearError();

  try {
    await api(`/holds/${currentHold.id}?sessionId=${SESSION_ID}`, {
      method: 'DELETE'
    });

    currentHold = null;
    clearHoldTimer();
    hideHoldPanel();
    await fetchSeats();
  } catch (err) {
    showError(err.message || 'Failed to release hold');
  }
}

// ========== Hold Timer ==========
function showHoldPanel() {
  document.getElementById('selection-info').style.display = 'none';
  document.getElementById('btn-hold').style.display = 'none';
  document.getElementById('hold-info').style.display = 'block';
  document.getElementById('booking-info').style.display = 'none';

  document.getElementById('hold-id').textContent = currentHold.id.slice(0, 8) + '...';
  
  const seatLabels = currentHold.seatIds.map(id => {
    const s = seats.find(s => s.id === id);
    return s ? `${s.row_label}${s.seat_number}` : id;
  });
  document.getElementById('hold-seats').textContent = seatLabels.join(', ');

  startHoldTimer();
}

function hideHoldPanel() {
  document.getElementById('selection-info').style.display = 'block';
  document.getElementById('btn-hold').style.display = 'block';
  document.getElementById('hold-info').style.display = 'none';
  document.getElementById('booking-info').style.display = 'none';
}

function showBookingPanel(bookedSeats) {
  document.getElementById('selection-info').style.display = 'none';
  document.getElementById('btn-hold').style.display = 'none';
  document.getElementById('hold-info').style.display = 'none';
  document.getElementById('booking-info').style.display = 'block';

  const seatLabels = bookedSeats.map(s => `${s.row_label}${s.seat_number}`);
  document.getElementById('booked-seats').textContent = seatLabels.join(', ');

  // Auto-hide after 5 seconds
  setTimeout(() => {
    hideHoldPanel();
  }, 5000);
}

function startHoldTimer() {
  clearHoldTimer();
  updateHoldTimer();
  holdTimerInterval = setInterval(updateHoldTimer, 200);
}

function clearHoldTimer() {
  if (holdTimerInterval) {
    clearInterval(holdTimerInterval);
    holdTimerInterval = null;
  }
}

function updateHoldTimer() {
  if (!currentHold) {
    clearHoldTimer();
    return;
  }
  const remaining = new Date(currentHold.expiresAt) - new Date();
  const el = document.getElementById('hold-timer');
  if (remaining <= 0) {
    el.textContent = 'EXPIRED';
    el.style.color = '#c1121f';
    clearHoldTimer();
    // Auto-cleanup
    setTimeout(async () => {
      currentHold = null;
      hideHoldPanel();
      await fetchSeats();
    }, 1000);
  } else {
    const secs = Math.ceil(remaining / 1000);
    el.textContent = `${secs}s`;
    el.style.color = secs <= 5 ? '#c1121f' : '#e9c46a';
  }
}

// ========== Local state updates ==========
function updateLocalSeat(updatedSeat) {
  const idx = seats.findIndex(s => s.id === updatedSeat.id);
  if (idx >= 0) {
    seats[idx] = { ...seats[idx], ...updatedSeat };
  }
}

// ========== Error display ==========
function showError(msg) {
  const el = document.getElementById('error-msg');
  el.textContent = msg;
  el.style.display = 'block';
  setTimeout(() => {
    el.style.display = 'none';
  }, 5000);
}

function clearError() {
  document.getElementById('error-msg').style.display = 'none';
}

// ========== SSE ==========
function connectSSE() {
  const evtSource = new EventSource(`${API_BASE}/stream`);

  evtSource.addEventListener('seat-update', (event) => {
    try {
      const data = JSON.parse(event.data);
      updateLocalSeat(data);
      renderSeatMap();
      updateInventory();
    } catch (e) {
      console.error('SSE parse error:', e);
    }
  });

  evtSource.onerror = () => {
    console.log('SSE connection error, reconnecting...');
    evtSource.close();
    setTimeout(connectSSE, 2000);
  };
}

// ========== Init ==========
document.getElementById('btn-hold').addEventListener('click', onHoldClick);
document.getElementById('btn-confirm').addEventListener('click', onConfirmClick);
document.getElementById('btn-release').addEventListener('click', onReleaseClick);

fetchSeats().then(() => {
  connectSSE();
});
