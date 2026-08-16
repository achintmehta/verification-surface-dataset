// ─── State ────────────────────────────────────────────
const API_BASE = '/api';

const state = {
  seats: [],
  selectedSeatIds: new Set(),
  sessionId: generateSessionId(),
  currentHold: null, // { holdId, seatIds, expiresAt }
  holdTtlSeconds: 30,
  countdownTimer: null,
  eventSource: null,
};

function generateSessionId() {
  // Check localStorage for existing session
  let sid = localStorage.getItem('seat-booking-session');
  if (!sid) {
    sid = 'session-' + crypto.randomUUID();
    localStorage.setItem('seat-booking-session', sid);
  }
  return sid;
}

// ─── DOM refs ─────────────────────────────────────────
const seatMapEl = document.getElementById('seat-map');
const inventoryEl = document.getElementById('inventory');
const selectionInfoEl = document.getElementById('selection-info');
const holdInfoEl = document.getElementById('hold-info');
const countdownEl = document.getElementById('countdown');
const notificationsEl = document.getElementById('notifications');
const btnHold = document.getElementById('btn-hold');
const btnConfirm = document.getElementById('btn-confirm');
const btnRelease = document.getElementById('btn-release');
const btnClear = document.getElementById('btn-clear');
const sseStatus = document.getElementById('sse-status');
const sseText = document.getElementById('sse-text');

// ─── Notifications ────────────────────────────────────
function notify(message, type = 'info', duration = 3000) {
  const el = document.createElement('div');
  el.className = `notification ${type}`;
  el.textContent = message;
  notificationsEl.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
  }, duration);
}

// ─── API calls ────────────────────────────────────────
async function fetchSeats() {
  try {
    const res = await fetch(`${API_BASE}/seats`);
    const data = await res.json();
    state.seats = data.seats;
    state.holdTtlSeconds = data.holdTtlSeconds || 30;
    renderSeatMap();
    updateInventory();
  } catch (err) {
    console.error('Failed to fetch seats:', err);
    notify('Failed to load seats', 'error');
  }
}

async function requestHold() {
  const seatIds = Array.from(state.selectedSeatIds);
  if (seatIds.length === 0) return;

  try {
    const res = await fetch(`${API_BASE}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId: state.sessionId }),
    });

    const data = await res.json();

    if (!res.ok) {
      if (res.status === 409 && data.conflicting) {
        // Highlight conflicting seats
        const conflictIds = new Set(data.conflicting.map(s => s.id));
        state.selectedSeatIds = new Set(
          [...state.selectedSeatIds].filter(id => !conflictIds.has(id))
        );
        renderSeatMap();
        // Shake conflicting seats
        for (const id of conflictIds) {
          const el = document.querySelector(`[data-seat-id="${id}"]`);
          if (el) {
            el.classList.add('conflict');
            setTimeout(() => el.classList.remove('conflict'), 600);
          }
        }
        notify(`Seats already taken: ${data.conflicting.map(s => s.row_label + s.seat_number).join(', ')}`, 'error');
        // Refresh seats
        await fetchSeats();
      } else {
        notify(data.error || 'Failed to hold seats', 'error');
      }
      return;
    }

    // Success
    state.currentHold = {
      holdId: data.holdId,
      seatIds: data.seatIds,
      expiresAt: new Date(data.expiresAt),
    };
    state.selectedSeatIds.clear();
    notify(`Hold placed on ${data.seatIds.length} seat(s)`, 'success');
    startCountdown();
    updateButtons();
    // Update seats from response
    if (data.seats) {
      for (const updatedSeat of data.seats) {
        const idx = state.seats.findIndex(s => s.id === updatedSeat.id);
        if (idx >= 0) state.seats[idx] = updatedSeat;
      }
    }
    renderSeatMap();
    updateInventory();
  } catch (err) {
    console.error('Hold error:', err);
    notify('Network error placing hold', 'error');
  }
}

async function confirmHold() {
  if (!state.currentHold) return;

  try {
    const res = await fetch(`${API_BASE}/holds/${state.currentHold.holdId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    const data = await res.json();

    if (!res.ok) {
      notify(data.error || 'Failed to confirm', 'error');
      if (res.status === 410) {
        // Hold expired
        clearHoldState();
        await fetchSeats();
      }
      return;
    }

    notify('Booking confirmed! 🎉', 'success');
    clearHoldState();
    // Update seats
    if (data.seats) {
      for (const updatedSeat of data.seats) {
        const idx = state.seats.findIndex(s => s.id === updatedSeat.id);
        if (idx >= 0) state.seats[idx] = updatedSeat;
      }
    }
    renderSeatMap();
    updateInventory();
  } catch (err) {
    console.error('Confirm error:', err);
    notify('Network error confirming booking', 'error');
  }
}

async function releaseHold() {
  if (!state.currentHold) return;

  try {
    const res = await fetch(`${API_BASE}/holds/${state.currentHold.holdId}`, {
      method: 'DELETE',
    });

    if (!res.ok) {
      const data = await res.json();
      notify(data.error || 'Failed to release hold', 'error');
      return;
    }

    notify('Hold released', 'info');
    clearHoldState();
    await fetchSeats();
  } catch (err) {
    console.error('Release error:', err);
    notify('Network error releasing hold', 'error');
  }
}

function clearHoldState() {
  state.currentHold = null;
  if (state.countdownTimer) {
    clearInterval(state.countdownTimer);
    state.countdownTimer = null;
  }
  countdownEl.textContent = '';
  holdInfoEl.textContent = '';
  updateButtons();
}

function clearSelection() {
  state.selectedSeatIds.clear();
  renderSeatMap();
  updateButtons();
}

// ─── Countdown ────────────────────────────────────────
function startCountdown() {
  if (state.countdownTimer) clearInterval(state.countdownTimer);

  function update() {
    if (!state.currentHold) {
      countdownEl.textContent = '';
      return;
    }
    const remaining = Math.max(0, Math.floor((state.currentHold.expiresAt - Date.now()) / 1000));
    if (remaining <= 0) {
      countdownEl.textContent = 'Hold expired!';
      holdInfoEl.textContent = '';
      clearInterval(state.countdownTimer);
      state.countdownTimer = null;
      // Remove hold state
      state.currentHold = null;
      updateButtons();
      fetchSeats();
      notify('Your hold has expired', 'error');
      return;
    }
    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    countdownEl.textContent = `⏱ Hold expires in ${mins}:${secs.toString().padStart(2, '0')}`;
    holdInfoEl.textContent = `Hold ID: ${state.currentHold.holdId.slice(0, 8)}...`;
  }

  update();
  state.countdownTimer = setInterval(update, 500);
}

// ─── Rendering ────────────────────────────────────────
function renderSeatMap() {
  // Group seats by row
  const rows = {};
  for (const seat of state.seats) {
    if (!rows[seat.row_label]) rows[seat.row_label] = [];
    rows[seat.row_label].push(seat);
  }

  seatMapEl.innerHTML = '';

  const rowLabels = Object.keys(rows).sort();
  for (const rowLabel of rowLabels) {
    const rowSeats = rows[rowLabel].sort((a, b) => a.seat_number - b.seat_number);
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';

    const labelEl = document.createElement('div');
    labelEl.className = 'row-label';
    labelEl.textContent = rowLabel;
    rowEl.appendChild(labelEl);

    for (const seat of rowSeats) {
      const seatEl = document.createElement('div');
      seatEl.className = 'seat';
      seatEl.dataset.seatId = seat.id;
      seatEl.textContent = seat.seat_number;

      // Determine display class
      if (state.selectedSeatIds.has(seat.id)) {
        seatEl.classList.add('selected');
      } else if (seat.status === 'held' && seat.session_id === state.sessionId) {
        seatEl.classList.add('held-mine');
      } else {
        seatEl.classList.add(seat.status);
      }

      seatEl.addEventListener('click', () => onSeatClick(seat));
      rowEl.appendChild(seatEl);
    }

    // Right label
    const labelRight = document.createElement('div');
    labelRight.className = 'row-label';
    labelRight.textContent = rowLabel;
    rowEl.appendChild(labelRight);

    seatMapEl.appendChild(rowEl);
  }

  updateSelectionInfo();
  updateButtons();
}

function updateInventory() {
  let available = 0, held = 0, booked = 0;
  for (const seat of state.seats) {
    if (seat.status === 'available') available++;
    else if (seat.status === 'held') held++;
    else if (seat.status === 'booked') booked++;
  }
  inventoryEl.innerHTML = `
    <span>Available: ${available}</span>
    <span>Held: ${held}</span>
    <span>Booked: ${booked}</span>
    <span>Total: ${available + held + booked}</span>
  `;
}

function updateSelectionInfo() {
  if (state.selectedSeatIds.size === 0) {
    selectionInfoEl.textContent = 'Click seats to select them';
  } else {
    const selected = state.seats
      .filter(s => state.selectedSeatIds.has(s.id))
      .map(s => s.row_label + s.seat_number)
      .join(', ');
    selectionInfoEl.textContent = `Selected: ${selected} (${state.selectedSeatIds.size} seat${state.selectedSeatIds.size > 1 ? 's' : ''})`;
  }
}

function updateButtons() {
  const hasSelection = state.selectedSeatIds.size > 0;
  const hasHold = !!state.currentHold;

  btnHold.disabled = !hasSelection || hasHold;
  btnConfirm.disabled = !hasHold;
  btnRelease.disabled = !hasHold;
  btnClear.disabled = !hasSelection;
}

// ─── Seat interaction ─────────────────────────────────
function onSeatClick(seat) {
  // Can't select if we have an active hold
  if (state.currentHold) return;

  // Can only select available seats
  if (seat.status !== 'available') return;

  // Can't select if held by someone else
  if (seat.status === 'held' && seat.session_id !== state.sessionId) return;

  if (state.selectedSeatIds.has(seat.id)) {
    state.selectedSeatIds.delete(seat.id);
  } else {
    state.selectedSeatIds.add(seat.id);
  }

  renderSeatMap();
}

// ─── SSE ──────────────────────────────────────────────
function connectSSE() {
  if (state.eventSource) {
    state.eventSource.close();
  }

  const es = new EventSource(`${API_BASE}/stream`);
  state.eventSource = es;

  es.onopen = () => {
    sseStatus.className = 'sse-indicator connected';
    sseText.textContent = 'Connected';
  };

  es.addEventListener('seats-updated', (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.seats && Array.isArray(data.seats)) {
        for (const updatedSeat of data.seats) {
          const idx = state.seats.findIndex(s => s.id === updatedSeat.id);
          if (idx >= 0) {
            state.seats[idx] = { ...state.seats[idx], ...updatedSeat };
          }
        }

        // If our hold expired (seats went available and holdId matches our hold)
        if (
          data.reason === 'expired' &&
          state.currentHold &&
          data.holdId === state.currentHold.holdId
        ) {
          // This is handled by countdown, but also handle here
        }

        // Remove any conflicting selections
        for (const updatedSeat of data.seats) {
          if (updatedSeat.status !== 'available' && state.selectedSeatIds.has(updatedSeat.id)) {
            state.selectedSeatIds.delete(updatedSeat.id);
          }
        }

        renderSeatMap();
        updateInventory();
      }
    } catch (err) {
      console.error('SSE parse error:', err);
    }
  });

  es.onerror = () => {
    sseStatus.className = 'sse-indicator disconnected';
    sseText.textContent = 'Reconnecting...';
    // EventSource auto-reconnects
  };
}

// ─── Event listeners ──────────────────────────────────
btnHold.addEventListener('click', requestHold);
btnConfirm.addEventListener('click', confirmHold);
btnRelease.addEventListener('click', releaseHold);
btnClear.addEventListener('click', clearSelection);

// ─── Initialize ───────────────────────────────────────
async function init() {
  await fetchSeats();
  connectSSE();
}

init();
