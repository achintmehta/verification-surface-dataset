const API_BASE = window.location.origin;

// Generate or retrieve session ID
function getSessionId() {
  let id = sessionStorage.getItem('sessionId');
  if (!id) {
    id = 'session-' + Math.random().toString(36).substring(2, 10) + '-' + Date.now();
    sessionStorage.setItem('sessionId', id);
  }
  return id;
}

const sessionId = getSessionId();
document.getElementById('session-id').textContent = sessionId.substring(0, 16) + '…';

// App state
let seats = [];
let selectedSeatIds = new Set();
let currentHold = null; // { holdId, expiresAt, seatIds }
let timerInterval = null;

// DOM elements
const seatMap = document.getElementById('seat-map');
const btnHold = document.getElementById('btn-hold');
const btnConfirm = document.getElementById('btn-confirm');
const btnRelease = document.getElementById('btn-release');
const selectionInfo = document.getElementById('selection-info');
const holdTimer = document.getElementById('hold-timer');
const timerValue = document.getElementById('timer-value');
const errorMessage = document.getElementById('error-message');
const countAvailable = document.getElementById('count-available');
const countHeld = document.getElementById('count-held');
const countBooked = document.getElementById('count-booked');
const countTotal = document.getElementById('count-total');

// ===== API calls =====

async function fetchSeats() {
  const res = await fetch(`${API_BASE}/api/seats`);
  const data = await res.json();
  seats = data.seats;
  renderSeatMap();
  updateInventory();
}

async function requestHold() {
  const seatIds = Array.from(selectedSeatIds);
  hideError();

  try {
    const res = await fetch(`${API_BASE}/api/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId }),
    });

    if (res.status === 409) {
      const data = await res.json();
      const conflictIds = data.conflicting ? data.conflicting.map(c => c.id) : [];
      showError(`Seats already taken: ${data.conflicting?.map(c => `${c.row_label}${c.seat_number}`).join(', ') || 'unknown'}`);
      // Deselect conflicting seats
      conflictIds.forEach(id => selectedSeatIds.delete(id));
      await fetchSeats();
      return;
    }

    if (!res.ok) {
      const data = await res.json();
      showError(data.error || 'Failed to hold seats');
      return;
    }

    const data = await res.json();
    currentHold = {
      holdId: data.holdId,
      expiresAt: new Date(data.expiresAt),
      seatIds: seatIds,
      ttlSeconds: data.ttlSeconds,
    };
    selectedSeatIds.clear();

    // Update seats from response
    for (const updatedSeat of data.seats) {
      const idx = seats.findIndex(s => s.id === updatedSeat.id);
      if (idx !== -1) seats[idx] = updatedSeat;
    }

    renderSeatMap();
    updateControls();
    updateInventory();
    startTimer();
  } catch (err) {
    showError('Network error');
    console.error(err);
  }
}

async function confirmHold() {
  if (!currentHold) return;
  hideError();

  try {
    const res = await fetch(`${API_BASE}/api/holds/${currentHold.holdId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!res.ok) {
      const data = await res.json();
      showError(data.error || 'Failed to confirm booking');
      if (res.status === 410 || res.status === 404) {
        // Hold expired or not found
        clearHold();
        await fetchSeats();
      }
      return;
    }

    const data = await res.json();
    // Update seats
    for (const updatedSeat of data.seats) {
      const idx = seats.findIndex(s => s.id === updatedSeat.id);
      if (idx !== -1) seats[idx] = updatedSeat;
    }

    clearHold();
    renderSeatMap();
    updateControls();
    updateInventory();
    selectionInfo.textContent = '✅ Booking confirmed!';
  } catch (err) {
    showError('Network error');
    console.error(err);
  }
}

async function releaseHold() {
  if (!currentHold) return;
  hideError();

  try {
    const res = await fetch(`${API_BASE}/api/holds/${currentHold.holdId}`, {
      method: 'DELETE',
    });

    if (!res.ok) {
      const data = await res.json();
      showError(data.error || 'Failed to release hold');
    }

    clearHold();
    await fetchSeats();
  } catch (err) {
    showError('Network error');
    console.error(err);
  }
}

// ===== Rendering =====

function renderSeatMap() {
  // Group seats by row
  const rows = {};
  for (const seat of seats) {
    if (!rows[seat.row_label]) rows[seat.row_label] = [];
    rows[seat.row_label].push(seat);
  }

  seatMap.innerHTML = '';

  const sortedRowLabels = Object.keys(rows).sort();

  for (const rowLabel of sortedRowLabels) {
    const rowDiv = document.createElement('div');
    rowDiv.className = 'seat-row';

    const label = document.createElement('span');
    label.className = 'row-label';
    label.textContent = rowLabel;
    rowDiv.appendChild(label);

    const rowSeats = rows[rowLabel].sort((a, b) => a.seat_number - b.seat_number);

    for (const seat of rowSeats) {
      const seatEl = document.createElement('div');
      seatEl.dataset.seatId = seat.id;

      let cls = 'seat ';
      if (selectedSeatIds.has(seat.id)) {
        cls += 'selected';
      } else if (currentHold && currentHold.seatIds.includes(seat.id)) {
        cls += 'my-hold';
      } else if (seat.status === 'held') {
        cls += 'held';
      } else if (seat.status === 'booked') {
        cls += 'booked';
      } else {
        cls += 'available';
      }

      seatEl.className = cls;
      seatEl.textContent = seat.seat_number;
      seatEl.title = `${seat.row_label}${seat.seat_number} - ${seat.status}`;

      seatEl.addEventListener('click', () => onSeatClick(seat));
      rowDiv.appendChild(seatEl);
    }

    // Right label
    const labelR = document.createElement('span');
    labelR.className = 'row-label';
    labelR.textContent = rowLabel;
    rowDiv.appendChild(labelR);

    seatMap.appendChild(rowDiv);
  }
}

function updateInventory() {
  let available = 0, held = 0, booked = 0;
  for (const seat of seats) {
    if (seat.status === 'available') available++;
    else if (seat.status === 'held') held++;
    else if (seat.status === 'booked') booked++;
  }
  // Count my selected but not yet held seats as available
  countAvailable.textContent = available;
  countHeld.textContent = held;
  countBooked.textContent = booked;
  countTotal.textContent = seats.length;
}

function updateControls() {
  if (currentHold) {
    btnHold.style.display = 'none';
    btnConfirm.style.display = '';
    btnConfirm.disabled = false;
    btnRelease.style.display = '';
    btnRelease.disabled = false;
    selectionInfo.textContent = `Holding ${currentHold.seatIds.length} seat(s)`;
  } else {
    btnHold.style.display = '';
    btnHold.disabled = selectedSeatIds.size === 0;
    btnConfirm.style.display = 'none';
    btnRelease.style.display = 'none';
    holdTimer.style.display = 'none';

    if (selectedSeatIds.size > 0) {
      selectionInfo.textContent = `${selectedSeatIds.size} seat(s) selected`;
    } else {
      selectionInfo.textContent = 'Select seats to hold them';
    }
  }
}

// ===== Interactions =====

function onSeatClick(seat) {
  // If we have an active hold, don't allow selecting more seats
  if (currentHold) return;

  if (seat.status !== 'available') return;

  if (selectedSeatIds.has(seat.id)) {
    selectedSeatIds.delete(seat.id);
  } else {
    selectedSeatIds.add(seat.id);
  }

  renderSeatMap();
  updateControls();
}

// ===== Timer =====

function startTimer() {
  if (timerInterval) clearInterval(timerInterval);
  holdTimer.style.display = '';

  const tick = () => {
    if (!currentHold) {
      clearInterval(timerInterval);
      holdTimer.style.display = 'none';
      return;
    }

    const remaining = Math.max(0, Math.ceil((currentHold.expiresAt - Date.now()) / 1000));
    timerValue.textContent = remaining;

    if (remaining <= 0) {
      clearInterval(timerInterval);
      // Hold expired on the client side
      clearHold();
      fetchSeats();
      selectionInfo.textContent = '⏰ Hold expired!';
    }
  };

  tick();
  timerInterval = setInterval(tick, 500);
}

function clearHold() {
  currentHold = null;
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  holdTimer.style.display = 'none';
  updateControls();
}

// ===== SSE =====

function connectSSE() {
  const eventSource = new EventSource(`${API_BASE}/api/stream`);

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'seat-update' && data.seats) {
        handleSeatUpdates(data.seats);
      }
    } catch (err) {
      console.error('SSE parse error:', err);
    }
  };

  eventSource.onerror = () => {
    console.warn('SSE connection error, reconnecting...');
    eventSource.close();
    setTimeout(connectSSE, 2000);
  };
}

function handleSeatUpdates(updatedSeats) {
  let changed = false;

  for (const updated of updatedSeats) {
    const idx = seats.findIndex(s => s.id === updated.id);
    if (idx !== -1) {
      const old = seats[idx];
      if (old.status !== updated.status || old.hold_id !== updated.hold_id) {
        seats[idx] = { ...seats[idx], ...updated };
        changed = true;

        // If one of our held seats became available or booked by someone else
        if (currentHold && currentHold.seatIds.includes(updated.id)) {
          if (updated.status === 'available') {
            // Our hold expired
            clearHold();
            selectionInfo.textContent = '⏰ Hold expired!';
          }
        }

        // Deselect if no longer available
        if (updated.status !== 'available') {
          selectedSeatIds.delete(updated.id);
        }
      }
    }
  }

  if (changed) {
    renderSeatMap();
    updateControls();
    updateInventory();
  }
}

// ===== Error handling =====

function showError(msg) {
  errorMessage.textContent = msg;
  errorMessage.style.display = '';
}

function hideError() {
  errorMessage.style.display = 'none';
}

// ===== Event listeners =====

btnHold.addEventListener('click', requestHold);
btnConfirm.addEventListener('click', confirmHold);
btnRelease.addEventListener('click', releaseHold);

// ===== Init =====

fetchSeats().then(() => {
  connectSSE();
  updateControls();
});
