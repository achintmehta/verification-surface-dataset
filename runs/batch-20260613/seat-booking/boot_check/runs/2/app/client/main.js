/**
 * Seat Booking – Vanilla JS SPA
 *
 * State machine:
 *   idle       → user selects seats → hold-pending
 *   hold-pending → POST /api/holds → active-hold | error
 *   active-hold  → POST /api/holds/:id/confirm → booked | error
 *   active-hold  → DELETE /api/holds/:id       → idle
 *   booked       → btn-new-booking             → idle
 */

const API = '/api';

// ── Session ID ────────────────────────────────────────────────────────────
function getSessionId() {
  let id = sessionStorage.getItem('sessionId');
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem('sessionId', id);
  }
  return id;
}

const SESSION_ID = getSessionId();
document.getElementById('session-id-display').textContent = SESSION_ID.slice(0, 8) + '…';

// ── Application state ─────────────────────────────────────────────────────
const state = {
  seats: {},           // id → seat object
  selected: new Set(), // ids of seats the user has clicked (pre-hold)
  hold: null,          // { holdId, seatIds, expiresAt }
  booked: null,        // { holdId, seatIds }
  countdownTimer: null,
};

// ── DOM refs ──────────────────────────────────────────────────────────────
const seatMapEl        = document.getElementById('seat-map');
const holdPanel        = document.getElementById('hold-panel');
const activeHoldPanel  = document.getElementById('active-hold-panel');
const bookedPanel      = document.getElementById('booked-panel');
const errorPanel       = document.getElementById('error-panel');
const idlePanel        = document.getElementById('idle-panel');
const selectedList     = document.getElementById('selected-seats-list');
const heldList         = document.getElementById('held-seats-list');
const bookedList       = document.getElementById('booked-seats-list');
const errorMsg         = document.getElementById('error-message');
const conflictSeats    = document.getElementById('conflict-seats');
const holdCountdown    = document.getElementById('hold-countdown');
const btnHold          = document.getElementById('btn-hold');
const btnClear         = document.getElementById('btn-clear');
const btnConfirm       = document.getElementById('btn-confirm');
const btnRelease       = document.getElementById('btn-release');
const btnNewBooking    = document.getElementById('btn-new-booking');
const btnErrorDismiss  = document.getElementById('btn-error-dismiss');
const sessionInfoEl    = document.getElementById('session-info');

// ── Inventory counters ────────────────────────────────────────────────────
const invAvailable = document.getElementById('inv-available');
const invHeld      = document.getElementById('inv-held');
const invBooked    = document.getElementById('inv-booked');
const invTotal     = document.getElementById('inv-total');

// ── Utility ───────────────────────────────────────────────────────────────
function showPanel(name) {
  [holdPanel, activeHoldPanel, bookedPanel, errorPanel, idlePanel].forEach(p => p.classList.add('hidden'));
  const map = {
    hold: holdPanel,
    'active-hold': activeHoldPanel,
    booked: bookedPanel,
    error: errorPanel,
    idle: idlePanel,
  };
  if (map[name]) map[name].classList.remove('hidden');
}

function renderTags(container, ids, extraClass = '') {
  container.innerHTML = '';
  for (const id of ids) {
    const tag = document.createElement('span');
    tag.className = 'seat-tag' + (extraClass ? ' ' + extraClass : '');
    tag.textContent = id;
    container.appendChild(tag);
  }
}

function updateInventory() {
  const seats = Object.values(state.seats);
  const now = Date.now();
  let available = 0, held = 0, booked = 0;
  for (const s of seats) {
    const eff = effectiveStatus(s, now);
    if (eff === 'available') available++;
    else if (eff === 'held') held++;
    else if (eff === 'booked') booked++;
  }
  invAvailable.textContent = available;
  invHeld.textContent = held;
  invBooked.textContent = booked;
  invTotal.textContent = seats.length;
}

function effectiveStatus(seat, now = Date.now()) {
  if (seat.status === 'held') {
    if (seat.hold_expires_at && new Date(seat.hold_expires_at).getTime() <= now) {
      return 'available';
    }
  }
  return seat.status;
}

// ── Seat map rendering ────────────────────────────────────────────────────
function buildSeatMap(seats) {
  // Group by row
  const rows = {};
  for (const seat of seats) {
    if (!rows[seat.row_label]) rows[seat.row_label] = [];
    rows[seat.row_label].push(seat);
    state.seats[seat.id] = seat;
  }

  seatMapEl.innerHTML = '';

  for (const rowLabel of Object.keys(rows).sort()) {
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';
    rowEl.dataset.row = rowLabel;

    const labelEl = document.createElement('span');
    labelEl.className = 'row-label';
    labelEl.textContent = rowLabel;
    rowEl.appendChild(labelEl);

    for (const seat of rows[rowLabel].sort((a, b) => a.seat_number - b.seat_number)) {
      rowEl.appendChild(createSeatEl(seat));
    }

    seatMapEl.appendChild(rowEl);
  }

  updateInventory();
}

function createSeatEl(seat) {
  const btn = document.createElement('button');
  btn.className = 'seat';
  btn.id = `seat-${seat.id}`;
  btn.dataset.id = seat.id;
  btn.textContent = seat.seat_number;
  btn.title = `${seat.row_label}${seat.seat_number}`;
  applySeatClass(btn, seat);
  btn.addEventListener('click', () => onSeatClick(seat.id));
  return btn;
}

function applySeatClass(btn, seat) {
  const now = Date.now();
  const eff = effectiveStatus(seat, now);
  const isSelected = state.selected.has(seat.id);
  const isMyHeld = state.hold && state.hold.seatIds.includes(seat.id);

  btn.className = 'seat';
  btn.disabled = false;

  if (isSelected) {
    btn.classList.add('selected');
  } else if (eff === 'booked') {
    btn.classList.add('booked');
    btn.disabled = true;
  } else if (eff === 'held') {
    if (isMyHeld) {
      btn.classList.add('held-mine');
    } else {
      btn.classList.add('held-other');
      btn.disabled = true;
    }
  } else {
    btn.classList.add('available');
  }
}

function refreshSeatEl(seatId) {
  const seat = state.seats[seatId];
  if (!seat) return;
  const btn = document.getElementById(`seat-${seatId}`);
  if (!btn) return;
  applySeatClass(btn, seat);
}

function refreshAllSeats() {
  for (const id of Object.keys(state.seats)) {
    refreshSeatEl(id);
  }
  updateInventory();
}

// ── Seat click handler ────────────────────────────────────────────────────
function onSeatClick(seatId) {
  // Only allow selection when idle (no active hold)
  if (state.hold) return;

  const seat = state.seats[seatId];
  if (!seat) return;

  const eff = effectiveStatus(seat);
  if (eff !== 'available') return;

  if (state.selected.has(seatId)) {
    state.selected.delete(seatId);
  } else {
    state.selected.add(seatId);
  }

  refreshSeatEl(seatId);
  updateSelectionPanel();
}

function updateSelectionPanel() {
  if (state.selected.size === 0) {
    showPanel('idle');
    return;
  }
  renderTags(selectedList, [...state.selected]);
  showPanel('hold');
}

// ── Hold actions ──────────────────────────────────────────────────────────
btnHold.addEventListener('click', async () => {
  if (state.selected.size === 0) return;
  btnHold.disabled = true;
  btnHold.textContent = 'Holding…';

  try {
    const res = await fetch(`${API}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds: [...state.selected], sessionId: SESSION_ID }),
    });

    const data = await res.json();

    if (res.ok) {
      // Success
      state.hold = {
        holdId: data.holdId,
        seatIds: data.seatIds,
        expiresAt: new Date(data.expiresAt),
      };
      state.selected.clear();

      // Update local seat state
      for (const id of state.hold.seatIds) {
        if (state.seats[id]) {
          state.seats[id].status = 'held';
          state.seats[id].hold_id = data.holdId;
          state.seats[id].hold_expires_at = data.expiresAt;
        }
      }

      refreshAllSeats();
      renderTags(heldList, state.hold.seatIds);
      showPanel('active-hold');
      startCountdown();
    } else if (res.status === 409) {
      // Conflict
      showError(
        `${data.conflictIds?.length || 'Some'} seat(s) are no longer available.`,
        data.conflictIds || []
      );
      // Refresh seat map to reflect reality
      await loadSeats();
      state.selected.clear();
    } else {
      showError(data.error || 'Failed to create hold');
    }
  } catch (err) {
    showError('Network error: ' + err.message);
  } finally {
    btnHold.disabled = false;
    btnHold.textContent = 'Hold Selected Seats';
  }
});

btnClear.addEventListener('click', () => {
  state.selected.clear();
  refreshAllSeats();
  showPanel('idle');
});

// ── Confirm ───────────────────────────────────────────────────────────────
btnConfirm.addEventListener('click', async () => {
  if (!state.hold) return;
  btnConfirm.disabled = true;
  btnConfirm.textContent = 'Confirming…';

  try {
    const res = await fetch(`${API}/holds/${state.hold.holdId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });

    const data = await res.json();

    if (res.ok) {
      const bookedIds = data.seats.map(s => s.id);

      // Update local state
      for (const id of bookedIds) {
        if (state.seats[id]) {
          state.seats[id].status = 'booked';
          state.seats[id].hold_expires_at = null;
        }
      }

      state.booked = { holdId: state.hold.holdId, seatIds: bookedIds };
      clearCountdown();
      state.hold = null;

      refreshAllSeats();
      renderTags(bookedList, bookedIds);
      showPanel('booked');
    } else if (res.status === 410) {
      showError('Your hold has expired. Please select seats again.');
      clearCountdown();
      state.hold = null;
      await loadSeats();
    } else {
      showError(data.error || 'Failed to confirm booking');
    }
  } catch (err) {
    showError('Network error: ' + err.message);
  } finally {
    btnConfirm.disabled = false;
    btnConfirm.textContent = '✓ Confirm Booking';
  }
});

// ── Release ───────────────────────────────────────────────────────────────
btnRelease.addEventListener('click', async () => {
  if (!state.hold) return;
  btnRelease.disabled = true;

  try {
    const res = await fetch(`${API}/holds/${state.hold.holdId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });

    if (res.ok) {
      const data = await res.json();
      for (const id of (data.releasedSeatIds || state.hold.seatIds)) {
        if (state.seats[id]) {
          state.seats[id].status = 'available';
          state.seats[id].hold_id = null;
          state.seats[id].hold_expires_at = null;
        }
      }
      clearCountdown();
      state.hold = null;
      refreshAllSeats();
      showPanel('idle');
    } else {
      const data = await res.json();
      showError(data.error || 'Failed to release hold');
    }
  } catch (err) {
    showError('Network error: ' + err.message);
  } finally {
    btnRelease.disabled = false;
  }
});

// ── New booking ───────────────────────────────────────────────────────────
btnNewBooking.addEventListener('click', () => {
  state.booked = null;
  showPanel('idle');
});

// ── Error panel ───────────────────────────────────────────────────────────
btnErrorDismiss.addEventListener('click', () => {
  if (state.hold) {
    showPanel('active-hold');
  } else if (state.selected.size > 0) {
    showPanel('hold');
  } else {
    showPanel('idle');
  }
});

function showError(message, conflictIds = []) {
  errorMsg.textContent = message;
  if (conflictIds.length > 0) {
    renderTags(conflictSeats, conflictIds);
    conflictSeats.classList.remove('hidden');
  } else {
    conflictSeats.classList.add('hidden');
  }
  showPanel('error');
}

// ── Countdown timer ───────────────────────────────────────────────────────
function startCountdown() {
  clearCountdown();
  updateCountdown();
  state.countdownTimer = setInterval(updateCountdown, 1000);
}

function updateCountdown() {
  if (!state.hold) { clearCountdown(); return; }
  const remaining = Math.max(0, Math.floor((state.hold.expiresAt - Date.now()) / 1000));
  holdCountdown.textContent = `${remaining}s`;

  holdCountdown.className = 'countdown';
  if (remaining <= 10) holdCountdown.classList.add('urgent');
  else if (remaining <= 20) holdCountdown.classList.add('warning');
  else holdCountdown.classList.add('ok');

  if (remaining === 0) {
    clearCountdown();
    // Hold expired – update UI
    if (state.hold) {
      for (const id of state.hold.seatIds) {
        if (state.seats[id]) {
          state.seats[id].status = 'available';
          state.seats[id].hold_id = null;
          state.seats[id].hold_expires_at = null;
        }
      }
      state.hold = null;
      refreshAllSeats();
      showError('Your hold has expired. Please select seats again.');
    }
  }
}

function clearCountdown() {
  if (state.countdownTimer) {
    clearInterval(state.countdownTimer);
    state.countdownTimer = null;
  }
}

// ── Load seats from API ───────────────────────────────────────────────────
async function loadSeats() {
  try {
    const res = await fetch(`${API}/seats`);
    const data = await res.json();
    buildSeatMap(data.seats);
  } catch (err) {
    seatMapEl.innerHTML = `<div class="loading">Failed to load seats: ${err.message}</div>`;
  }
}

// ── SSE connection ────────────────────────────────────────────────────────
function connectSSE() {
  const es = new EventSource(`${API}/stream`);

  es.addEventListener('connected', () => {
    sessionInfoEl.className = 'connected';
    console.log('[SSE] Connected');
  });

  es.addEventListener('seats:held', (e) => {
    const { holdId, sessionId, seatIds, expiresAt } = JSON.parse(e.data);
    if (sessionId === SESSION_ID) return; // we already updated locally

    for (const id of seatIds) {
      if (state.seats[id]) {
        state.seats[id].status = 'held';
        state.seats[id].hold_id = holdId;
        state.seats[id].hold_expires_at = expiresAt;

        // Remove from selection if another user grabbed it
        state.selected.delete(id);

        const btn = document.getElementById(`seat-${id}`);
        if (btn) {
          applySeatClass(btn, state.seats[id]);
          btn.classList.add('just-held');
          setTimeout(() => btn.classList.remove('just-held'), 700);
        }
      }
    }
    updateInventory();
    // If we had these selected, update the selection panel
    if (state.selected.size === 0 && !state.hold) showPanel('idle');
    else if (state.selected.size > 0 && !state.hold) updateSelectionPanel();
  });

  es.addEventListener('seats:booked', (e) => {
    const { holdId, sessionId, seatIds } = JSON.parse(e.data);
    if (sessionId === SESSION_ID) return;

    for (const id of seatIds) {
      if (state.seats[id]) {
        state.seats[id].status = 'booked';
        state.seats[id].hold_expires_at = null;

        const btn = document.getElementById(`seat-${id}`);
        if (btn) {
          applySeatClass(btn, state.seats[id]);
          btn.classList.add('just-booked');
          setTimeout(() => btn.classList.remove('just-booked'), 700);
        }
      }
    }
    updateInventory();
  });

  es.addEventListener('seats:released', (e) => {
    const data = JSON.parse(e.data);
    // data may have { seats: [...] } (expiry sweep) or { holdId, seatIds } (manual release)
    const ids = data.seats ? data.seats.map(s => s.id) : (data.seatIds || []);

    for (const id of ids) {
      if (state.seats[id]) {
        state.seats[id].status = 'available';
        state.seats[id].hold_id = null;
        state.seats[id].hold_expires_at = null;

        // If this was our hold that got expired server-side
        if (state.hold && state.hold.seatIds.includes(id)) {
          // Will be handled when all seats are processed
        }

        refreshSeatEl(id);
      }
    }

    // Check if our hold was released externally
    if (state.hold) {
      const ourSeatsReleased = state.hold.seatIds.every(id => ids.includes(id));
      if (ourSeatsReleased) {
        clearCountdown();
        state.hold = null;
        showError('Your hold was released (expired or cancelled).');
      }
    }

    updateInventory();
  });

  es.onerror = () => {
    sessionInfoEl.className = 'disconnected';
    console.warn('[SSE] Connection lost, reconnecting…');
    // EventSource auto-reconnects
  };

  es.onopen = () => {
    sessionInfoEl.className = 'connected';
  };
}

// ── Bootstrap ─────────────────────────────────────────────────────────────
(async () => {
  showPanel('idle');
  await loadSeats();
  connectSSE();
})();
