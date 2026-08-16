/**
 * Seat Booking – Vanilla JS SPA
 *
 * State machine:
 *   idle → selecting → holding → confirmed
 *                   ↘ error
 */

const API = 'http://localhost:3001/api';

// ─── Session ID ──────────────────────────────────────────────────────────────
function getSessionId() {
  let id = sessionStorage.getItem('sessionId');
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem('sessionId', id);
  }
  return id;
}

const SESSION_ID = getSessionId();
document.getElementById('session-id-display').textContent =
  SESSION_ID.slice(0, 8) + '…';

// ─── Application state ───────────────────────────────────────────────────────
const state = {
  seats: {},          // id → seat object
  selected: new Set(),// ids of seats the user has clicked
  hold: null,         // { holdId, seatIds, expiresAt, ttlSeconds }
  booking: null,      // { holdId, seatIds }
  countdownTimer: null,
};

// ─── DOM refs ────────────────────────────────────────────────────────────────
const seatMapEl       = document.getElementById('seat-map');
const panelIdle       = document.getElementById('panel-idle');
const panelSelect     = document.getElementById('panel-select');
const panelHold       = document.getElementById('panel-hold');
const panelBooked     = document.getElementById('panel-booked');
const panelError      = document.getElementById('panel-error');
const selectedCount   = document.getElementById('selected-count');
const holdSeatsList   = document.getElementById('hold-seats-list');
const holdCountdown   = document.getElementById('hold-countdown');
const bookedSeatsList = document.getElementById('booked-seats-list');
const errorMessage    = document.getElementById('error-message');
const errorConflicts  = document.getElementById('error-conflicts');

const btnHold         = document.getElementById('btn-hold');
const btnClear        = document.getElementById('btn-clear');
const btnConfirm      = document.getElementById('btn-confirm');
const btnRelease      = document.getElementById('btn-release');
const btnNewBooking   = document.getElementById('btn-new-booking');
const btnErrorDismiss = document.getElementById('btn-error-dismiss');

const invAvailable    = document.getElementById('inv-available');
const invHeld         = document.getElementById('inv-held');
const invBooked       = document.getElementById('inv-booked');
const invTotal        = document.getElementById('inv-total');

// ─── Panel management ────────────────────────────────────────────────────────
function showPanel(name) {
  for (const p of [panelIdle, panelSelect, panelHold, panelBooked, panelError]) {
    p.classList.add('hidden');
  }
  const map = {
    idle: panelIdle, select: panelSelect, hold: panelHold,
    booked: panelBooked, error: panelError,
  };
  map[name]?.classList.remove('hidden');
}

// ─── Inventory update ────────────────────────────────────────────────────────
function updateInventory() {
  const seats = Object.values(state.seats);
  const available = seats.filter(s => s.status === 'available').length;
  const held      = seats.filter(s => s.status === 'held').length;
  const booked    = seats.filter(s => s.status === 'booked').length;
  invAvailable.textContent = available;
  invHeld.textContent      = held;
  invBooked.textContent    = booked;
  invTotal.textContent     = seats.length;
}

// ─── Seat map rendering ──────────────────────────────────────────────────────
function effectiveStatus(seat) {
  if (seat.status === 'held') {
    // If the hold has expired, treat as available
    if (seat.hold_expires_at && new Date(seat.hold_expires_at) <= new Date()) {
      return 'available';
    }
    // If this is our own hold, show held-mine
    if (state.hold && state.hold.seatIds.includes(seat.id)) {
      return 'held-mine';
    }
    return 'held';
  }
  return seat.status;
}

function seatClass(seat) {
  if (state.selected.has(seat.id)) return 'selected';
  return effectiveStatus(seat);
}

function renderSeatMap() {
  const seats = Object.values(state.seats);
  if (seats.length === 0) {
    seatMapEl.innerHTML = '<div class="loading">No seats found.</div>';
    return;
  }

  // Group by row
  const rows = {};
  for (const seat of seats) {
    if (!rows[seat.row_label]) rows[seat.row_label] = [];
    rows[seat.row_label].push(seat);
  }

  seatMapEl.innerHTML = '';
  for (const rowLabel of Object.keys(rows).sort()) {
    const rowSeats = rows[rowLabel].sort((a, b) => a.seat_number - b.seat_number);
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';

    const labelEl = document.createElement('div');
    labelEl.className = 'row-label';
    labelEl.textContent = rowLabel;
    rowEl.appendChild(labelEl);

    for (const seat of rowSeats) {
      const seatEl = document.createElement('div');
      seatEl.className = `seat ${seatClass(seat)}`;
      seatEl.dataset.id = seat.id;
      seatEl.textContent = seat.seat_number;
      seatEl.title = `${seat.row_label}${seat.seat_number} – ${effectiveStatus(seat)}`;
      seatEl.addEventListener('click', () => onSeatClick(seat.id));
      rowEl.appendChild(seatEl);
    }

    seatMapEl.appendChild(rowEl);
  }

  updateInventory();
}

function updateSeatElement(seatId) {
  const seat = state.seats[seatId];
  if (!seat) return;
  const el = seatMapEl.querySelector(`[data-id="${seatId}"]`);
  if (!el) return;
  const cls = seatClass(seat);
  el.className = `seat ${cls}`;
  el.title = `${seat.row_label}${seat.seat_number} – ${effectiveStatus(seat)}`;
  // Pulse animation
  el.classList.add('pulse');
  el.addEventListener('animationend', () => el.classList.remove('pulse'), { once: true });
}

// ─── Seat click handler ───────────────────────────────────────────────────────
function onSeatClick(seatId) {
  // Ignore clicks when a hold or booking is active
  if (state.hold || state.booking) return;

  const seat = state.seats[seatId];
  if (!seat) return;

  const eff = effectiveStatus(seat);
  if (eff !== 'available' && !state.selected.has(seatId)) return;

  if (state.selected.has(seatId)) {
    state.selected.delete(seatId);
  } else {
    state.selected.add(seatId);
  }

  updateSeatElement(seatId);
  updateSelectionPanel();
}

function updateSelectionPanel() {
  const count = state.selected.size;
  selectedCount.textContent = count;
  if (count > 0) {
    showPanel('select');
  } else {
    showPanel('idle');
  }
}

// ─── Hold actions ─────────────────────────────────────────────────────────────
btnHold.addEventListener('click', async () => {
  if (state.selected.size === 0) return;
  btnHold.disabled = true;

  try {
    const seatIds = [...state.selected];
    const resp = await fetch(`${API}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId: SESSION_ID }),
    });

    const data = await resp.json();

    if (!resp.ok) {
      // Show error panel
      errorMessage.textContent = data.error || 'Failed to place hold.';
      if (data.conflictingSeatIds?.length) {
        errorConflicts.textContent =
          `Conflicting seats: ${data.conflictingSeatIds.join(', ')}`;
        errorConflicts.classList.remove('hidden');
        // Refresh seat map to show current state
        await loadSeats();
      } else {
        errorConflicts.classList.add('hidden');
      }
      state.selected.clear();
      showPanel('error');
      return;
    }

    // Success
    state.hold = {
      holdId: data.holdId,
      seatIds: data.seatIds,
      expiresAt: new Date(data.expiresAt),
      ttlSeconds: data.ttlSeconds,
    };
    state.selected.clear();

    // Update seat states locally
    for (const id of data.seatIds) {
      if (state.seats[id]) {
        state.seats[id].status = 'held';
        state.seats[id].hold_id = data.holdId;
        state.seats[id].hold_expires_at = data.expiresAt;
      }
    }
    renderSeatMap();
    showHoldPanel();
  } catch (err) {
    console.error(err);
    errorMessage.textContent = 'Network error. Please try again.';
    errorConflicts.classList.add('hidden');
    showPanel('error');
  } finally {
    btnHold.disabled = false;
  }
});

function showHoldPanel() {
  if (!state.hold) return;
  holdSeatsList.textContent = state.hold.seatIds.join(', ');
  showPanel('hold');
  startCountdown();
}

function startCountdown() {
  if (state.countdownTimer) clearInterval(state.countdownTimer);

  function tick() {
    if (!state.hold) { clearInterval(state.countdownTimer); return; }
    const remaining = Math.max(0, state.hold.expiresAt - Date.now());
    const secs = Math.ceil(remaining / 1000);
    holdCountdown.textContent = `${secs}s`;
    holdCountdown.classList.toggle('urgent', secs <= 10);

    if (remaining <= 0) {
      clearInterval(state.countdownTimer);
      // Hold expired client-side
      onHoldExpiredLocally();
    }
  }

  tick();
  state.countdownTimer = setInterval(tick, 500);
}

function onHoldExpiredLocally() {
  if (!state.hold) return;
  const { seatIds } = state.hold;
  state.hold = null;

  for (const id of seatIds) {
    if (state.seats[id]) {
      state.seats[id].status = 'available';
      state.seats[id].hold_id = null;
      state.seats[id].hold_expires_at = null;
    }
  }
  renderSeatMap();
  errorMessage.textContent = 'Your hold has expired. Please select seats again.';
  errorConflicts.classList.add('hidden');
  showPanel('error');
}

// ─── Confirm ──────────────────────────────────────────────────────────────────
btnConfirm.addEventListener('click', async () => {
  if (!state.hold) return;
  btnConfirm.disabled = true;

  try {
    const resp = await fetch(`${API}/holds/${state.hold.holdId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });

    const data = await resp.json();

    if (!resp.ok) {
      errorMessage.textContent = data.error || 'Confirmation failed.';
      errorConflicts.classList.add('hidden');
      state.hold = null;
      if (state.countdownTimer) clearInterval(state.countdownTimer);
      await loadSeats();
      showPanel('error');
      return;
    }

    // Success
    const bookedSeatIds = data.seatIds;
    state.booking = { holdId: data.holdId, seatIds: bookedSeatIds };
    state.hold = null;
    if (state.countdownTimer) clearInterval(state.countdownTimer);

    for (const id of bookedSeatIds) {
      if (state.seats[id]) {
        state.seats[id].status = 'booked';
        state.seats[id].booked_by = SESSION_ID;
        state.seats[id].hold_id = null;
        state.seats[id].hold_expires_at = null;
      }
    }
    renderSeatMap();

    bookedSeatsList.textContent = bookedSeatIds.join(', ');
    showPanel('booked');
  } catch (err) {
    console.error(err);
    errorMessage.textContent = 'Network error during confirmation.';
    errorConflicts.classList.add('hidden');
    showPanel('error');
  } finally {
    btnConfirm.disabled = false;
  }
});

// ─── Release hold ─────────────────────────────────────────────────────────────
btnRelease.addEventListener('click', async () => {
  if (!state.hold) return;
  btnRelease.disabled = true;

  try {
    const resp = await fetch(`${API}/holds/${state.hold.holdId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });

    const data = await resp.json();

    if (!resp.ok) {
      errorMessage.textContent = data.error || 'Failed to release hold.';
      errorConflicts.classList.add('hidden');
      showPanel('error');
      return;
    }

    const releasedIds = data.seatIds;
    state.hold = null;
    if (state.countdownTimer) clearInterval(state.countdownTimer);

    for (const id of releasedIds) {
      if (state.seats[id]) {
        state.seats[id].status = 'available';
        state.seats[id].hold_id = null;
        state.seats[id].hold_expires_at = null;
      }
    }
    renderSeatMap();
    showPanel('idle');
  } catch (err) {
    console.error(err);
    errorMessage.textContent = 'Network error releasing hold.';
    errorConflicts.classList.add('hidden');
    showPanel('error');
  } finally {
    btnRelease.disabled = false;
  }
});

// ─── New booking ──────────────────────────────────────────────────────────────
btnNewBooking.addEventListener('click', () => {
  state.booking = null;
  showPanel('idle');
});

// ─── Clear selection ──────────────────────────────────────────────────────────
btnClear.addEventListener('click', () => {
  for (const id of state.selected) updateSeatElement(id);
  state.selected.clear();
  showPanel('idle');
});

// ─── Error dismiss ────────────────────────────────────────────────────────────
btnErrorDismiss.addEventListener('click', () => {
  showPanel('idle');
});

// ─── Load seats from API ──────────────────────────────────────────────────────
async function loadSeats() {
  try {
    const resp = await fetch(`${API}/seats`);
    const data = await resp.json();
    for (const seat of data.seats) {
      state.seats[seat.id] = seat;
    }
    renderSeatMap();
  } catch (err) {
    console.error('[loadSeats]', err);
    seatMapEl.innerHTML = '<div class="loading">Failed to load seats. Retrying…</div>';
    setTimeout(loadSeats, 3000);
  }
}

// ─── SSE ──────────────────────────────────────────────────────────────────────
function connectSSE() {
  const es = new EventSource(`${API}/stream`);

  es.addEventListener('seat-update', (e) => {
    try {
      const { type, seats } = JSON.parse(e.data);
      handleSeatUpdate(type, seats);
    } catch (err) {
      console.error('[SSE parse error]', err);
    }
  });

  es.addEventListener('error', () => {
    console.warn('[SSE] Connection lost, reconnecting…');
    es.close();
    setTimeout(connectSSE, 3000);
  });
}

function handleSeatUpdate(type, updatedSeats) {
  for (const update of updatedSeats) {
    const seat = state.seats[update.id];
    if (!seat) continue;

    const prevStatus = seat.status;

    if (type === 'held') {
      // Don't overwrite our own hold's state
      if (state.hold && state.hold.seatIds.includes(update.id)) continue;
      seat.status = 'held';
      seat.hold_id = update.holdId || null;
      seat.hold_expires_at = update.expiresAt || null;
    } else if (type === 'booked') {
      // If this is our own booking, don't overwrite
      if (state.booking && state.booking.seatIds.includes(update.id)) continue;
      seat.status = 'booked';
      seat.hold_id = null;
      seat.hold_expires_at = null;
      seat.booked_by = update.sessionId || null;
    } else if (type === 'released') {
      // Don't overwrite our own hold's state
      if (state.hold && state.hold.seatIds.includes(update.id)) continue;
      seat.status = 'available';
      seat.hold_id = null;
      seat.hold_expires_at = null;
    }

    if (seat.status !== prevStatus) {
      updateSeatElement(update.id);
    }
  }

  updateInventory();
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────
(async () => {
  showPanel('idle');
  await loadSeats();
  connectSSE();
})();
