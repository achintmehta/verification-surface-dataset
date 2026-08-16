// ─── State ──────────────────────────────────────────────────
const state = {
  sessionId: getOrCreateSessionId(),
  seats: [],          // full seat list from server
  selectedSeatIds: new Set(),
  currentHold: null,  // { id, seatIds, expiresAt }
  countdownInterval: null,
};

function getOrCreateSessionId() {
  let sid = localStorage.getItem('seatBookingSessionId');
  if (!sid) {
    sid = 'sess-' + crypto.randomUUID();
    localStorage.setItem('seatBookingSessionId', sid);
  }
  return sid;
}

// ─── API Helpers ────────────────────────────────────────────
const API_BASE = '/api';

async function apiGet(path) {
  const res = await fetch(`${API_BASE}${path}`);
  return res;
}

async function apiPost(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res;
}

async function apiDelete(path) {
  const res = await fetch(`${API_BASE}${path}`, { method: 'DELETE' });
  return res;
}

// ─── Seat Map Rendering ─────────────────────────────────────
function renderSeatMap() {
  const container = document.getElementById('seat-map');
  container.innerHTML = '';

  // Group seats by row
  const rowMap = new Map();
  for (const seat of state.seats) {
    if (!rowMap.has(seat.row_label)) {
      rowMap.set(seat.row_label, []);
    }
    rowMap.get(seat.row_label).push(seat);
  }

  for (const [rowLabel, rowSeats] of rowMap) {
    rowSeats.sort((a, b) => a.seat_number - b.seat_number);

    const rowDiv = document.createElement('div');
    rowDiv.classList.add('seat-row');

    const label = document.createElement('span');
    label.classList.add('row-label');
    label.textContent = rowLabel;
    rowDiv.appendChild(label);

    for (const seat of rowSeats) {
      const seatEl = document.createElement('div');
      seatEl.classList.add('seat');
      seatEl.dataset.seatId = seat.id;
      seatEl.textContent = seat.seat_number;

      // Determine visual state
      const isSelected = state.selectedSeatIds.has(seat.id);
      const isMyHold = seat.status === 'held' && seat.session_id === state.sessionId;

      if (isSelected) {
        seatEl.classList.add('selected');
      } else if (seat.status === 'available') {
        seatEl.classList.add('available');
      } else if (seat.status === 'held' && isMyHold) {
        seatEl.classList.add('held-mine');
      } else if (seat.status === 'held') {
        seatEl.classList.add('held');
      } else if (seat.status === 'booked') {
        seatEl.classList.add('booked');
      }

      seatEl.title = `${rowLabel}${seat.seat_number} - ${seat.status}${isMyHold ? ' (yours)' : ''}`;

      seatEl.addEventListener('click', () => handleSeatClick(seat));
      rowDiv.appendChild(seatEl);
    }

    container.appendChild(rowDiv);
  }

  updateInventory();
  updateSelectionDisplay();
  updateButtons();
}

function handleSeatClick(seat) {
  // If we have a confirmed booking, don't allow new selections
  // If the seat is booked, ignore
  if (seat.status === 'booked') return;

  // If the seat is held by someone else, ignore
  if (seat.status === 'held' && seat.session_id !== state.sessionId) return;

  // If we have an active hold, don't allow selecting new seats
  if (state.currentHold) return;

  // Toggle selection for available seats
  if (seat.status === 'available') {
    if (state.selectedSeatIds.has(seat.id)) {
      state.selectedSeatIds.delete(seat.id);
    } else {
      state.selectedSeatIds.add(seat.id);
    }
    renderSeatMap();
  }
}

function updateSelectionDisplay() {
  const display = document.getElementById('selected-seats-display');
  if (state.selectedSeatIds.size === 0 && !state.currentHold) {
    display.textContent = 'None';
    return;
  }

  const ids = state.currentHold
    ? state.currentHold.seatIds
    : [...state.selectedSeatIds];

  const seatLabels = ids.map(id => {
    const seat = state.seats.find(s => s.id === id);
    return seat ? `${seat.row_label}${seat.seat_number}` : `#${id}`;
  });

  display.textContent = seatLabels.join(', ');
}

function updateButtons() {
  const holdBtn = document.getElementById('hold-btn');
  const confirmBtn = document.getElementById('confirm-btn');
  const releaseBtn = document.getElementById('release-btn');

  holdBtn.disabled = state.selectedSeatIds.size === 0 || state.currentHold !== null;
  confirmBtn.disabled = state.currentHold === null;
  releaseBtn.disabled = state.currentHold === null;
}

function updateInventory() {
  const available = state.seats.filter(s => s.status === 'available').length;
  const held = state.seats.filter(s => s.status === 'held').length;
  const booked = state.seats.filter(s => s.status === 'booked').length;
  const total = state.seats.length;

  document.getElementById('count-available').textContent = available;
  document.getElementById('count-held').textContent = held;
  document.getElementById('count-booked').textContent = booked;
  document.getElementById('count-total').textContent = total;
}

function showStatus(message, type = 'info') {
  const el = document.getElementById('status-message');
  el.textContent = message;
  el.className = type;
}

// ─── Hold Timer ─────────────────────────────────────────────
function startCountdown(expiresAt) {
  stopCountdown();
  const timerEl = document.getElementById('hold-timer');
  const countdownEl = document.getElementById('countdown');
  timerEl.classList.remove('hidden');

  state.countdownInterval = setInterval(() => {
    const remaining = Math.max(0, Math.ceil((new Date(expiresAt) - Date.now()) / 1000));
    countdownEl.textContent = remaining;

    if (remaining <= 5) {
      timerEl.classList.add('warning');
    } else {
      timerEl.classList.remove('warning');
    }

    if (remaining <= 0) {
      stopCountdown();
      // Hold has expired
      state.currentHold = null;
      state.selectedSeatIds.clear();
      showStatus('Your hold has expired. Seats have been released.', 'error');
      loadSeats(); // Refresh
    }
  }, 200);
}

function stopCountdown() {
  if (state.countdownInterval) {
    clearInterval(state.countdownInterval);
    state.countdownInterval = null;
  }
  const timerEl = document.getElementById('hold-timer');
  timerEl.classList.add('hidden');
  timerEl.classList.remove('warning');
}

// ─── Actions ────────────────────────────────────────────────
async function holdSeats() {
  const seatIds = [...state.selectedSeatIds];
  if (seatIds.length === 0) return;

  showStatus('Requesting hold...', 'info');

  try {
    const res = await apiPost('/holds', {
      seatIds,
      sessionId: state.sessionId,
    });

    if (res.status === 201) {
      const data = await res.json();
      state.currentHold = {
        id: data.hold.id,
        seatIds: data.hold.seatIds,
        expiresAt: data.hold.expiresAt,
      };
      state.selectedSeatIds.clear();

      // Update seat states locally
      for (const updatedSeat of data.seats) {
        const idx = state.seats.findIndex(s => s.id === updatedSeat.id);
        if (idx !== -1) {
          state.seats[idx] = { ...state.seats[idx], ...updatedSeat };
        }
      }

      showStatus(`Hold acquired! Confirm within ${Math.ceil((new Date(data.hold.expiresAt) - Date.now()) / 1000)}s`, 'success');
      startCountdown(data.hold.expiresAt);
      renderSeatMap();
    } else if (res.status === 409) {
      const data = await res.json();
      state.selectedSeatIds.clear();
      const conflictLabels = data.conflicting.map(s => `${s.row_label}${s.seat_number}`).join(', ');
      showStatus(`Seats already taken: ${conflictLabels}`, 'error');
      await loadSeats();
    } else {
      const data = await res.json();
      showStatus(`Hold failed: ${data.error || 'Unknown error'}`, 'error');
    }
  } catch (err) {
    console.error('Hold error:', err);
    showStatus('Network error while requesting hold', 'error');
  }
}

async function confirmHold() {
  if (!state.currentHold) return;

  showStatus('Confirming booking...', 'info');

  try {
    const res = await apiPost(`/holds/${state.currentHold.id}/confirm`);

    if (res.ok) {
      const data = await res.json();
      stopCountdown();

      // Update seat states locally
      for (const updatedSeat of data.seats) {
        const idx = state.seats.findIndex(s => s.id === updatedSeat.id);
        if (idx !== -1) {
          state.seats[idx] = { ...state.seats[idx], ...updatedSeat };
        }
      }

      state.currentHold = null;
      state.selectedSeatIds.clear();
      showStatus('Booking confirmed! 🎉', 'success');
      renderSeatMap();
    } else {
      const data = await res.json();
      stopCountdown();
      state.currentHold = null;
      state.selectedSeatIds.clear();
      showStatus(`Confirmation failed: ${data.error || 'Unknown error'}`, 'error');
      await loadSeats();
    }
  } catch (err) {
    console.error('Confirm error:', err);
    showStatus('Network error while confirming', 'error');
  }
}

async function releaseHold() {
  if (!state.currentHold) return;

  showStatus('Releasing hold...', 'info');

  try {
    const res = await apiDelete(`/holds/${state.currentHold.id}`);

    if (res.ok) {
      stopCountdown();
      state.currentHold = null;
      state.selectedSeatIds.clear();
      showStatus('Hold released.', 'info');
      await loadSeats();
    } else {
      const data = await res.json();
      showStatus(`Release failed: ${data.error || 'Unknown error'}`, 'error');
    }
  } catch (err) {
    console.error('Release error:', err);
    showStatus('Network error while releasing hold', 'error');
  }
}

// ─── Load Seats ─────────────────────────────────────────────
async function loadSeats() {
  try {
    const res = await apiGet('/seats');
    if (res.ok) {
      const data = await res.json();
      state.seats = data.seats;
      renderSeatMap();
    }
  } catch (err) {
    console.error('Failed to load seats:', err);
    showStatus('Failed to load seat map', 'error');
  }
}

// ─── SSE ────────────────────────────────────────────────────
function connectSSE() {
  const evtSource = new EventSource(`${API_BASE}/stream`);

  evtSource.addEventListener('seats-updated', (event) => {
    try {
      const updatedSeats = JSON.parse(event.data);
      for (const updated of updatedSeats) {
        const idx = state.seats.findIndex(s => s.id === updated.id);
        if (idx !== -1) {
          state.seats[idx] = { ...state.seats[idx], ...updated };
        }
      }

      // If our held seats were released by expiry (from server-side),
      // check if currentHold seats are no longer held
      if (state.currentHold) {
        const holdSeatIds = new Set(state.currentHold.seatIds);
        const anyReleased = updatedSeats.some(
          s => holdSeatIds.has(s.id) && s.status === 'available'
        );
        if (anyReleased) {
          stopCountdown();
          state.currentHold = null;
          state.selectedSeatIds.clear();
          showStatus('Your hold has expired. Seats have been released.', 'error');
        }
      }

      renderSeatMap();
    } catch (err) {
      console.error('SSE parse error:', err);
    }
  });

  evtSource.onerror = () => {
    console.warn('SSE connection lost, reconnecting...');
    // EventSource will auto-reconnect
  };
}

// ─── Init ───────────────────────────────────────────────────
document.getElementById('session-id-display').textContent = state.sessionId;
document.getElementById('hold-btn').addEventListener('click', holdSeats);
document.getElementById('confirm-btn').addEventListener('click', confirmHold);
document.getElementById('release-btn').addEventListener('click', releaseHold);

loadSeats();
connectSSE();
