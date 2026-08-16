// ─── State ─────────────────────────────────────────────────────────────────────
const sessionId = crypto.randomUUID ? crypto.randomUUID() : 'session-' + Math.random().toString(36).slice(2);
let seats = [];           // Array of seat objects from server
let selectedIds = new Set(); // Set of seat IDs user has selected
let currentHold = null;   // { holdId, expiresAt, seatIds }
let timerInterval = null;
let eventSource = null;

// ─── DOM refs ──────────────────────────────────────────────────────────────────
const seatMapEl = document.getElementById('seat-map');
const btnHold = document.getElementById('btn-hold');
const btnConfirm = document.getElementById('btn-confirm');
const btnRelease = document.getElementById('btn-release');
const holdInfoEl = document.getElementById('hold-info');
const holdTimerEl = document.getElementById('hold-timer');
const selectionInfoEl = document.getElementById('selection-info');
const connectionStatusEl = document.getElementById('connection-status');
const toastContainer = document.getElementById('toast-container');

// ─── Helpers ───────────────────────────────────────────────────────────────────
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, 4000);
}

function getEffectiveStatus(seat) {
  if (seat.status === 'held' && seat.hold_expires_at && new Date(seat.hold_expires_at) <= new Date()) {
    return 'available';
  }
  return seat.status;
}

function isMine(seat) {
  return seat.session_id === sessionId;
}

// ─── API calls ─────────────────────────────────────────────────────────────────
async function fetchSeats() {
  const res = await fetch('/api/seats');
  const data = await res.json();
  seats = data.seats;
  renderSeatMap();
  updateInventory();
}

async function requestHold(seatIds) {
  const res = await fetch('/api/holds', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seatIds: Array.from(seatIds), sessionId }),
  });

  const data = await res.json();

  if (!res.ok) {
    if (res.status === 409) {
      showToast(`Seats unavailable: ${data.conflictingSeatIds?.map(id => {
        const s = seats.find(seat => seat.id === id);
        return s ? `${s.row_label}${s.seat_number}` : id;
      }).join(', ')}`, 'error');
      // Clear selection and refresh
      selectedIds.clear();
      await fetchSeats();
    } else {
      showToast(data.error || 'Failed to hold seats', 'error');
    }
    return;
  }

  currentHold = {
    holdId: data.holdId,
    expiresAt: new Date(data.expiresAt),
    seatIds: data.seats.map(s => s.id),
  };

  selectedIds.clear();

  // Update local seat state
  for (const updatedSeat of data.seats) {
    const idx = seats.findIndex(s => s.id === updatedSeat.id);
    if (idx !== -1) seats[idx] = updatedSeat;
  }

  renderSeatMap();
  updateInventory();
  showHoldUI();
  showToast('Seats held successfully!', 'success');
}

async function confirmHold() {
  if (!currentHold) return;

  const res = await fetch(`/api/holds/${currentHold.holdId}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });

  const data = await res.json();

  if (!res.ok) {
    showToast(data.error || 'Failed to confirm booking', 'error');
    clearHoldUI();
    await fetchSeats();
    return;
  }

  // Update local seat state
  if (data.seats) {
    for (const updatedSeat of data.seats) {
      const idx = seats.findIndex(s => s.id === updatedSeat.id);
      if (idx !== -1) seats[idx] = updatedSeat;
    }
  }

  clearHoldUI();
  renderSeatMap();
  updateInventory();
  showToast('Booking confirmed! 🎉', 'success');
}

async function releaseHold() {
  if (!currentHold) return;

  const res = await fetch(`/api/holds/${currentHold.holdId}`, {
    method: 'DELETE',
  });

  if (!res.ok) {
    const data = await res.json();
    showToast(data.error || 'Failed to release hold', 'error');
  } else {
    showToast('Hold released', 'info');
  }

  clearHoldUI();
  await fetchSeats();
}

// ─── Rendering ─────────────────────────────────────────────────────────────────
function renderSeatMap() {
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

  // Stage indicator
  const stage = document.createElement('div');
  stage.className = 'stage';
  stage.textContent = 'STAGE';
  seatMapEl.appendChild(stage);

  for (const [rowLabel, rowSeats] of sortedRows) {
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';

    const label = document.createElement('div');
    label.className = 'row-label';
    label.textContent = rowLabel;
    rowEl.appendChild(label);

    // Sort seats by number
    rowSeats.sort((a, b) => a.seat_number - b.seat_number);

    for (const seat of rowSeats) {
      const seatEl = document.createElement('div');
      seatEl.className = 'seat';
      seatEl.textContent = seat.seat_number;
      seatEl.dataset.seatId = seat.id;

      const effective = getEffectiveStatus(seat);

      if (selectedIds.has(seat.id)) {
        seatEl.classList.add('selected');
      } else if (effective === 'available') {
        seatEl.classList.add('available');
      } else if (effective === 'held') {
        if (isMine(seat)) {
          seatEl.classList.add('held-mine');
        } else {
          seatEl.classList.add('held');
        }
      } else if (effective === 'booked') {
        seatEl.classList.add('booked');
      }

      seatEl.addEventListener('click', () => handleSeatClick(seat));
      rowEl.appendChild(seatEl);
    }

    seatMapEl.appendChild(rowEl);
  }
}

function updateInventory() {
  let available = 0, held = 0, booked = 0;
  for (const seat of seats) {
    const eff = getEffectiveStatus(seat);
    if (eff === 'available') available++;
    else if (eff === 'held') held++;
    else if (eff === 'booked') booked++;
  }
  document.getElementById('inv-available').textContent = `Available: ${available}`;
  document.getElementById('inv-held').textContent = `Held: ${held}`;
  document.getElementById('inv-booked').textContent = `Booked: ${booked}`;
  document.getElementById('inv-total').textContent = `Total: ${seats.length}`;
}

// ─── Interaction ───────────────────────────────────────────────────────────────
function handleSeatClick(seat) {
  // Can't select if we have an active hold
  if (currentHold) return;

  const effective = getEffectiveStatus(seat);
  if (effective !== 'available') return;

  if (selectedIds.has(seat.id)) {
    selectedIds.delete(seat.id);
  } else {
    selectedIds.add(seat.id);
  }

  renderSeatMap();
  updateSelectionUI();
}

function updateSelectionUI() {
  if (selectedIds.size === 0) {
    selectionInfoEl.textContent = 'Select seats to hold';
    btnHold.disabled = true;
  } else {
    const names = Array.from(selectedIds).map(id => {
      const s = seats.find(seat => seat.id === id);
      return s ? `${s.row_label}${s.seat_number}` : id;
    });
    selectionInfoEl.textContent = `Selected: ${names.join(', ')}`;
    btnHold.disabled = false;
  }
}

function showHoldUI() {
  holdInfoEl.style.display = 'flex';
  btnHold.style.display = 'none';
  selectionInfoEl.textContent = `Hold active for seats: ${currentHold.seatIds.map(id => {
    const s = seats.find(seat => seat.id === id);
    return s ? `${s.row_label}${s.seat_number}` : id;
  }).join(', ')}`;

  startTimer();
}

function clearHoldUI() {
  currentHold = null;
  holdInfoEl.style.display = 'none';
  btnHold.style.display = '';
  btnHold.disabled = true;
  selectionInfoEl.textContent = 'Select seats to hold';
  stopTimer();
}

function startTimer() {
  updateTimer();
  timerInterval = setInterval(updateTimer, 250);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  holdTimerEl.textContent = '';
}

function updateTimer() {
  if (!currentHold) {
    stopTimer();
    return;
  }

  const remaining = Math.max(0, currentHold.expiresAt.getTime() - Date.now());
  const seconds = Math.ceil(remaining / 1000);

  if (remaining <= 0) {
    holdTimerEl.textContent = 'Expired';
    stopTimer();
    // Auto-cleanup
    setTimeout(() => {
      clearHoldUI();
      fetchSeats();
      showToast('Hold expired', 'error');
    }, 500);
    return;
  }

  holdTimerEl.textContent = `⏱ ${seconds}s remaining`;
}

// ─── SSE ───────────────────────────────────────────────────────────────────────
function connectSSE() {
  if (eventSource) {
    eventSource.close();
  }

  eventSource = new EventSource('/api/stream');

  eventSource.onopen = () => {
    connectionStatusEl.textContent = 'Connected';
    connectionStatusEl.className = 'status-connected';
  };

  eventSource.onerror = () => {
    connectionStatusEl.textContent = 'Disconnected';
    connectionStatusEl.className = 'status-disconnected';
    // EventSource will auto-reconnect
  };

  eventSource.addEventListener('seat-update', (event) => {
    const updatedSeats = JSON.parse(event.data);

    for (const updatedSeat of updatedSeats) {
      const idx = seats.findIndex(s => s.id === updatedSeat.id);
      if (idx !== -1) {
        seats[idx] = { ...seats[idx], ...updatedSeat };
      }

      // If a seat we selected became unavailable, remove from selection
      if (selectedIds.has(updatedSeat.id)) {
        const effective = getEffectiveStatus(updatedSeat);
        if (effective !== 'available') {
          selectedIds.delete(updatedSeat.id);
        }
      }

      // If our held seat got released/expired by the server
      if (currentHold && currentHold.seatIds.includes(updatedSeat.id)) {
        if (updatedSeat.status === 'available' && updatedSeat.hold_id === null) {
          // Our hold was released/expired
          // Check if all our held seats are released
          const allReleased = currentHold.seatIds.every(id => {
            const s = seats.find(seat => seat.id === id);
            return s && s.status === 'available';
          });
          if (allReleased) {
            clearHoldUI();
            showToast('Your hold expired', 'error');
          }
        }
      }
    }

    renderSeatMap();
    updateInventory();
    updateSelectionUI();
  });
}

// ─── Event listeners ───────────────────────────────────────────────────────────
btnHold.addEventListener('click', () => {
  if (selectedIds.size > 0) {
    requestHold(selectedIds);
  }
});

btnConfirm.addEventListener('click', confirmHold);
btnRelease.addEventListener('click', releaseHold);

// ─── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  await fetchSeats();
  connectSSE();
}

init();
