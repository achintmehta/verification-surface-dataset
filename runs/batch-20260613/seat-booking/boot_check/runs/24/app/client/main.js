// Seat Booking Frontend - Vanilla JS

const API_BASE = '/api';

// Generate a unique session ID for this browser tab
const SESSION_ID = crypto.randomUUID ? crypto.randomUUID() : 
  'sess-' + Math.random().toString(36).slice(2) + Date.now().toString(36);

// State
let seats = [];
let selectedSeatIds = new Set();
let currentHold = null; // { id, sessionId, seatIds, expiresAt }
let holdTimerInterval = null;
let confirmedHoldIds = new Set();

// DOM elements
const seatMapEl = document.getElementById('seat-map');
const selectionInfoEl = document.getElementById('selection-info');
const holdInfoEl = document.getElementById('hold-info');
const holdTimerEl = document.getElementById('hold-timer');
const btnHold = document.getElementById('btn-hold');
const btnConfirm = document.getElementById('btn-confirm');
const btnRelease = document.getElementById('btn-release');
const inventoryEl = document.getElementById('inventory');
const messagesEl = document.getElementById('messages');
const connectionStatusEl = document.getElementById('connection-status');

// ─── API ────────────────────────────────────────────────────

async function fetchSeats() {
  const res = await fetch(`${API_BASE}/seats`);
  const data = await res.json();
  seats = data.seats;
  render();
  updateInventory();
}

async function requestHold(seatIds) {
  const res = await fetch(`${API_BASE}/holds`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seatIds: Array.from(seatIds), sessionId: SESSION_ID })
  });
  const data = await res.json();
  if (!res.ok) {
    if (res.status === 409) {
      showMessage(`Seats unavailable: ${data.conflicting.map(s => s.row_label + s.seat_number).join(', ')}`, 'error');
      // Refresh seat map
      await fetchSeats();
    } else {
      showMessage(data.error || 'Failed to hold seats', 'error');
    }
    return null;
  }
  return data;
}

async function confirmHold(holdId) {
  const res = await fetch(`${API_BASE}/holds/${holdId}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  });
  const data = await res.json();
  if (!res.ok) {
    showMessage(data.error || 'Failed to confirm booking', 'error');
    return null;
  }
  return data;
}

async function releaseHold(holdId) {
  const res = await fetch(`${API_BASE}/holds/${holdId}`, {
    method: 'DELETE'
  });
  const data = await res.json();
  return data;
}

// ─── SSE ────────────────────────────────────────────────────

function connectSSE() {
  const es = new EventSource(`${API_BASE}/stream`);

  es.onopen = () => {
    connectionStatusEl.textContent = '🟢 Connected (live updates)';
    connectionStatusEl.className = 'connection-status connected';
  };

  es.addEventListener('seat-update', (event) => {
    const updatedSeat = JSON.parse(event.data);
    // Update local state
    const idx = seats.findIndex(s => s.id === updatedSeat.id);
    if (idx >= 0) {
      seats[idx] = { ...seats[idx], ...updatedSeat };
    } else {
      seats.push(updatedSeat);
    }

    // If our held seat became available (expired), clear hold state
    if (currentHold && currentHold.seatIds.includes(updatedSeat.id) && updatedSeat.status === 'available') {
      // Check if the hold actually expired (not just us releasing)
      if (updatedSeat.hold_id !== currentHold.id) {
        // Our hold is gone for this seat
      }
    }

    render();
    updateInventory();
  });

  es.onerror = () => {
    connectionStatusEl.textContent = '🔴 Disconnected (reconnecting...)';
    connectionStatusEl.className = 'connection-status disconnected';
  };
}

// ─── Rendering ──────────────────────────────────────────────

function render() {
  // Group seats by row
  const rowMap = new Map();
  for (const seat of seats) {
    if (!rowMap.has(seat.row_label)) {
      rowMap.set(seat.row_label, []);
    }
    rowMap.get(seat.row_label).push(seat);
  }

  // Sort rows alphabetically
  const sortedRows = Array.from(rowMap.entries()).sort((a, b) => a[0].localeCompare(b[0]));

  seatMapEl.innerHTML = '';

  for (const [rowLabel, rowSeats] of sortedRows) {
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';

    const labelEl = document.createElement('span');
    labelEl.className = 'row-label';
    labelEl.textContent = rowLabel;
    rowEl.appendChild(labelEl);

    // Sort seats by seat_number
    rowSeats.sort((a, b) => a.seat_number - b.seat_number);

    for (const seat of rowSeats) {
      const seatEl = document.createElement('div');
      seatEl.className = 'seat ' + getEffectiveClass(seat);
      seatEl.textContent = seat.seat_number;
      seatEl.dataset.seatId = seat.id;
      seatEl.title = `${seat.row_label}${seat.seat_number} - ${getEffectiveStatus(seat)}`;

      seatEl.addEventListener('click', () => handleSeatClick(seat));
      rowEl.appendChild(seatEl);
    }

    // Right label
    const labelEl2 = document.createElement('span');
    labelEl2.className = 'row-label';
    labelEl2.textContent = rowLabel;
    rowEl.appendChild(labelEl2);

    seatMapEl.appendChild(rowEl);
  }

  // Update selection info
  if (selectedSeatIds.size > 0 && !currentHold) {
    const seatLabels = Array.from(selectedSeatIds).map(id => {
      const s = seats.find(st => st.id === id);
      return s ? `${s.row_label}${s.seat_number}` : id;
    });
    selectionInfoEl.textContent = `Selected: ${seatLabels.join(', ')}`;
    btnHold.disabled = false;
  } else {
    selectionInfoEl.textContent = currentHold ? '' : 'Click on available seats to select them';
    btnHold.disabled = true;
  }

  // Show/hide hold button vs hold info
  if (currentHold) {
    btnHold.style.display = 'none';
    holdInfoEl.style.display = 'block';
  } else {
    btnHold.style.display = '';
    holdInfoEl.style.display = 'none';
  }
}

function getEffectiveStatus(seat) {
  if (selectedSeatIds.has(seat.id)) return 'selected';
  if (seat.status === 'held') {
    if (seat.hold_expires_at && new Date(seat.hold_expires_at) < new Date()) return 'available';
    if (seat.session_id === SESSION_ID) return 'mine';
    return 'held';
  }
  if (seat.status === 'booked') {
    if (seat.booked_by && confirmedHoldIds.has(seat.booked_by)) return 'my-booked';
    return 'booked';
  }
  return seat.status;
}

function getEffectiveClass(seat) {
  return getEffectiveStatus(seat);
}

function handleSeatClick(seat) {
  // If we have an active hold, don't allow new selections
  if (currentHold) {
    // Allow clicking own held seats to deselect (but we don't support partial release)
    return;
  }

  const effectiveStatus = getEffectiveStatus(seat);

  if (effectiveStatus === 'available') {
    if (selectedSeatIds.has(seat.id)) {
      selectedSeatIds.delete(seat.id);
    } else {
      selectedSeatIds.add(seat.id);
    }
    render();
  } else if (effectiveStatus === 'selected') {
    selectedSeatIds.delete(seat.id);
    render();
  }
  // held/booked seats cannot be clicked
}

// ─── Hold Timer ─────────────────────────────────────────────

function startHoldTimer() {
  stopHoldTimer();
  updateHoldTimer();
  holdTimerInterval = setInterval(updateHoldTimer, 250);
}

function stopHoldTimer() {
  if (holdTimerInterval) {
    clearInterval(holdTimerInterval);
    holdTimerInterval = null;
  }
}

function updateHoldTimer() {
  if (!currentHold) {
    stopHoldTimer();
    return;
  }

  const remaining = new Date(currentHold.expiresAt) - new Date();
  if (remaining <= 0) {
    holdTimerEl.textContent = 'EXPIRED';
    stopHoldTimer();
    showMessage('Your hold has expired. Seats have been released.', 'info');
    currentHold = null;
    selectedSeatIds.clear();
    fetchSeats();
    return;
  }

  const seconds = Math.ceil(remaining / 1000);
  holdTimerEl.textContent = `${seconds}s`;
}

// ─── Actions ────────────────────────────────────────────────

btnHold.addEventListener('click', async () => {
  if (selectedSeatIds.size === 0) return;
  btnHold.disabled = true;
  btnHold.textContent = 'Holding...';

  const result = await requestHold(selectedSeatIds);
  btnHold.textContent = 'Hold Selected Seats';

  if (result) {
    currentHold = result.hold;
    selectedSeatIds.clear();
    showMessage(`Hold placed! You have ${Math.ceil((new Date(currentHold.expiresAt) - new Date()) / 1000)}s to confirm.`, 'success');
    // Update seats from response
    if (result.seats) {
      for (const updatedSeat of result.seats) {
        const idx = seats.findIndex(s => s.id === updatedSeat.id);
        if (idx >= 0) seats[idx] = { ...seats[idx], ...updatedSeat };
      }
    }
    render();
    startHoldTimer();
  } else {
    btnHold.disabled = selectedSeatIds.size === 0;
  }
});

btnConfirm.addEventListener('click', async () => {
  if (!currentHold) return;
  btnConfirm.disabled = true;
  btnConfirm.textContent = 'Confirming...';

  const result = await confirmHold(currentHold.id);

  btnConfirm.textContent = 'Confirm Booking';
  btnConfirm.disabled = false;

  if (result) {
    confirmedHoldIds.add(currentHold.id);
    showMessage('🎉 Booking confirmed! Enjoy the show!', 'success');
    stopHoldTimer();
    currentHold = null;
    selectedSeatIds.clear();
    // Update seats from response
    if (result.seats) {
      for (const updatedSeat of result.seats) {
        const idx = seats.findIndex(s => s.id === updatedSeat.id);
        if (idx >= 0) seats[idx] = { ...seats[idx], ...updatedSeat };
      }
    }
    render();
    updateInventory();
  }
});

btnRelease.addEventListener('click', async () => {
  if (!currentHold) return;
  btnRelease.disabled = true;
  btnRelease.textContent = 'Releasing...';

  await releaseHold(currentHold.id);

  btnRelease.textContent = 'Release Hold';
  btnRelease.disabled = false;

  showMessage('Hold released.', 'info');
  stopHoldTimer();
  currentHold = null;
  selectedSeatIds.clear();
  await fetchSeats();
});

// ─── Inventory ──────────────────────────────────────────────

function updateInventory() {
  let available = 0, held = 0, booked = 0;
  const now = new Date();
  for (const seat of seats) {
    if (seat.status === 'booked') {
      booked++;
    } else if (seat.status === 'held' && seat.hold_expires_at && new Date(seat.hold_expires_at) > now) {
      held++;
    } else {
      available++;
    }
  }
  inventoryEl.innerHTML = `
    <span>Available: ${available}</span>
    <span>Held: ${held}</span>
    <span>Booked: ${booked}</span>
    <span>Total: ${seats.length}</span>
  `;
}

// ─── Messages ───────────────────────────────────────────────

function showMessage(text, type = 'info') {
  const el = document.createElement('div');
  el.className = `msg ${type}`;
  el.textContent = text;
  messagesEl.appendChild(el);

  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.5s';
    setTimeout(() => el.remove(), 500);
  }, 4000);

  // Keep only last 3 messages
  while (messagesEl.children.length > 3) {
    messagesEl.removeChild(messagesEl.firstChild);
  }
}

// ─── Init ───────────────────────────────────────────────────

async function init() {
  await fetchSeats();
  connectSSE();
}

init();
