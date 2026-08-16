/**
 * Seat-booking SPA – Vanilla JS
 *
 * State machine:
 *   idle      → user selects seats → selection
 *   selection → user clicks "Hold" → holding (or error)
 *   holding   → user confirms      → booked
 *   holding   → user releases      → idle
 *   holding   → TTL expires        → idle (via SSE)
 *   booked    → user clicks "New"  → idle
 */

import { api } from './api.js';

// ─── Session ID ──────────────────────────────────────────────────────────────
const SESSION_ID = (() => {
  let id = sessionStorage.getItem('seat-booking-session');
  if (!id) {
    id = `sess-${Math.random().toString(36).slice(2, 10)}-${Date.now()}`;
    sessionStorage.setItem('seat-booking-session', id);
  }
  return id;
})();

document.getElementById('session-id-display').textContent = SESSION_ID.slice(0, 16) + '…';

// ─── Application state ───────────────────────────────────────────────────────
const state = {
  seats: {},          // id → seat object
  selected: new Set(),
  hold: null,         // { holdId, seatIds, expiresAt }
  booking: null,      // { seatIds }
  countdownTimer: null,
};

// ─── DOM refs ────────────────────────────────────────────────────────────────
const seatMapEl       = document.getElementById('seat-map');
const selectionInfo   = document.getElementById('selection-info');
const selectedCount   = document.getElementById('selected-count');
const selectedIds     = document.getElementById('selected-ids');
const btnHold         = document.getElementById('btn-hold');
const holdInfo        = document.getElementById('hold-info');
const holdSeatIds     = document.getElementById('hold-seat-ids');
const holdCountdown   = document.getElementById('hold-countdown');
const btnConfirm      = document.getElementById('btn-confirm');
const btnRelease      = document.getElementById('btn-release');
const bookingInfo     = document.getElementById('booking-info');
const bookedSeatIds   = document.getElementById('booked-seat-ids');
const btnNewBooking   = document.getElementById('btn-new-booking');
const errorInfo       = document.getElementById('error-info');
const errorMessage    = document.getElementById('error-message');
const btnDismissError = document.getElementById('btn-dismiss-error');
const invAvailable    = document.getElementById('inv-available');
const invHeld         = document.getElementById('inv-held');
const invBooked       = document.getElementById('inv-booked');
const invTotal        = document.getElementById('inv-total');

// ─── Seat map rendering ──────────────────────────────────────────────────────
function renderSeatMap() {
  // Group by row
  const rows = {};
  for (const seat of Object.values(state.seats)) {
    if (!rows[seat.row_label]) rows[seat.row_label] = [];
    rows[seat.row_label].push(seat);
  }

  seatMapEl.innerHTML = '';

  for (const rowLabel of Object.keys(rows).sort()) {
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';

    const labelEl = document.createElement('div');
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
  const el = document.createElement('div');
  el.className = `seat ${getSeatClass(seat)}`;
  el.dataset.id = seat.id;
  el.title = `${seat.id} – ${getSeatLabel(seat)}`;
  el.textContent = seat.seat_number;
  el.addEventListener('click', () => onSeatClick(seat.id));
  return el;
}

function getSeatClass(seat) {
  if (state.booking && state.booking.seatIds.includes(seat.id)) return 'booked-mine';
  if (state.hold && state.hold.seatIds.includes(seat.id)) return 'held-mine';
  if (state.selected.has(seat.id)) return 'selected';
  if (seat.status === 'available') return 'available';
  if (seat.status === 'held') return 'held-other';
  if (seat.status === 'booked') return 'booked';
  return 'available';
}

function getSeatLabel(seat) {
  if (seat.status === 'booked') return 'Booked';
  if (seat.status === 'held') return 'Held';
  return 'Available';
}

function updateSeatEl(seatId) {
  const seat = state.seats[seatId];
  if (!seat) return;
  const el = seatMapEl.querySelector(`[data-id="${seatId}"]`);
  if (!el) return;
  el.className = `seat ${getSeatClass(seat)}`;
  el.title = `${seat.id} – ${getSeatLabel(seat)}`;
}

function updateInventory() {
  const seats = Object.values(state.seats);
  const available = seats.filter((s) => s.status === 'available').length;
  const held      = seats.filter((s) => s.status === 'held').length;
  const booked    = seats.filter((s) => s.status === 'booked').length;
  invAvailable.textContent = available;
  invHeld.textContent      = held;
  invBooked.textContent    = booked;
  invTotal.textContent     = seats.length;
}

// ─── Seat click handler ──────────────────────────────────────────────────────
function onSeatClick(seatId) {
  // Ignore clicks when a hold or booking is active
  if (state.hold || state.booking) return;

  const seat = state.seats[seatId];
  if (!seat || seat.status !== 'available') return;

  if (state.selected.has(seatId)) {
    state.selected.delete(seatId);
  } else {
    state.selected.add(seatId);
  }

  updateSeatEl(seatId);
  renderActionPanel();
}

// ─── Action panel ────────────────────────────────────────────────────────────
function renderActionPanel() {
  hideAll();

  if (state.booking) {
    bookingInfo.classList.remove('hidden');
    bookedSeatIds.textContent = state.booking.seatIds.join(', ');
    return;
  }

  if (state.hold) {
    holdInfo.classList.remove('hidden');
    holdSeatIds.textContent = state.hold.seatIds.join(', ');
    startCountdown();
    return;
  }

  if (state.selected.size > 0) {
    selectionInfo.classList.remove('hidden');
    selectedCount.textContent = state.selected.size;
    selectedIds.textContent = [...state.selected].sort().join(', ');
    return;
  }
}

function hideAll() {
  selectionInfo.classList.add('hidden');
  holdInfo.classList.add('hidden');
  bookingInfo.classList.add('hidden');
  errorInfo.classList.add('hidden');
}

function showError(msg) {
  hideAll();
  errorInfo.classList.remove('hidden');
  errorMessage.textContent = msg;
}

// ─── Countdown timer ─────────────────────────────────────────────────────────
function startCountdown() {
  stopCountdown();
  tick();
  state.countdownTimer = setInterval(tick, 1000);

  function tick() {
    if (!state.hold) { stopCountdown(); return; }
    const remaining = Math.max(0, Math.floor((new Date(state.hold.expiresAt) - Date.now()) / 1000));
    const mins = Math.floor(remaining / 60).toString().padStart(2, '0');
    const secs = (remaining % 60).toString().padStart(2, '0');
    holdCountdown.textContent = `${mins}:${secs}`;
    holdCountdown.classList.toggle('urgent', remaining <= 10);

    if (remaining === 0) {
      stopCountdown();
      // Hold expired client-side – reset UI (SSE will confirm)
      state.hold = null;
      state.selected.clear();
      renderSeatMap();
      renderActionPanel();
    }
  }
}

function stopCountdown() {
  if (state.countdownTimer) {
    clearInterval(state.countdownTimer);
    state.countdownTimer = null;
  }
}

// ─── Button handlers ─────────────────────────────────────────────────────────
btnHold.addEventListener('click', async () => {
  if (state.selected.size === 0) return;
  const seatIds = [...state.selected].sort();

  btnHold.disabled = true;
  try {
    const hold = await api.createHold(seatIds, SESSION_ID);
    state.hold = { holdId: hold.holdId, seatIds: hold.seatIds, expiresAt: hold.expiresAt };
    state.selected.clear();

    // Update local seat state
    for (const id of hold.seatIds) {
      if (state.seats[id]) state.seats[id].status = 'held';
    }

    renderSeatMap();
    renderActionPanel();
  } catch (err) {
    if (err.status === 409 && err.body?.conflictIds) {
      const taken = err.body.conflictIds.join(', ');
      showError(`⚠️ Seats already taken: ${taken}. Please choose different seats.`);
      // Refresh seat map to show current state
      await loadSeats();
    } else {
      showError(`Failed to hold seats: ${err.message}`);
    }
  } finally {
    btnHold.disabled = false;
  }
});

btnConfirm.addEventListener('click', async () => {
  if (!state.hold) return;
  btnConfirm.disabled = true;
  try {
    const result = await api.confirmHold(state.hold.holdId, SESSION_ID);
    state.booking = { seatIds: result.seatIds };

    // Update local seat state
    for (const id of result.seatIds) {
      if (state.seats[id]) state.seats[id].status = 'booked';
    }

    stopCountdown();
    state.hold = null;
    renderSeatMap();
    renderActionPanel();
  } catch (err) {
    if (err.status === 410) {
      showError('Your hold has expired. Please select seats again.');
      state.hold = null;
      stopCountdown();
      await loadSeats();
    } else {
      showError(`Failed to confirm booking: ${err.message}`);
    }
  } finally {
    btnConfirm.disabled = false;
  }
});

btnRelease.addEventListener('click', async () => {
  if (!state.hold) return;
  btnRelease.disabled = true;
  try {
    await api.releaseHold(state.hold.holdId, SESSION_ID);

    // Update local seat state
    for (const id of state.hold.seatIds) {
      if (state.seats[id]) state.seats[id].status = 'available';
    }

    stopCountdown();
    state.hold = null;
    renderSeatMap();
    renderActionPanel();
  } catch (err) {
    showError(`Failed to release hold: ${err.message}`);
  } finally {
    btnRelease.disabled = false;
  }
});

btnNewBooking.addEventListener('click', () => {
  state.booking = null;
  renderSeatMap();
  renderActionPanel();
});

btnDismissError.addEventListener('click', () => {
  hideAll();
  renderActionPanel();
});

// ─── SSE ─────────────────────────────────────────────────────────────────────
function connectSSE() {
  const BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';
  const es = new EventSource(`${BASE}/api/stream`);

  es.addEventListener('seat-held', (e) => {
    const seats = JSON.parse(e.data);
    applySSEUpdate(seats, 'held');
  });

  es.addEventListener('seat-booked', (e) => {
    const seats = JSON.parse(e.data);
    applySSEUpdate(seats, 'booked');
  });

  es.addEventListener('seat-released', (e) => {
    const seats = JSON.parse(e.data);
    applySSEUpdate(seats, 'available');
  });

  es.addEventListener('connected', () => {
    console.log('SSE connected');
  });

  es.onerror = () => {
    console.warn('SSE disconnected, reconnecting in 3s…');
    es.close();
    setTimeout(connectSSE, 3000);
  };
}

function applySSEUpdate(seats, status) {
  for (const seat of seats) {
    const id = seat.id;
    if (!state.seats[id]) continue;

    // Don't overwrite our own hold/booking with SSE (we already updated locally)
    const isOurHold    = state.hold    && state.hold.seatIds.includes(id);
    const isOurBooking = state.booking && state.booking.seatIds.includes(id);

    if (!isOurHold && !isOurBooking) {
      state.seats[id].status = status;
      updateSeatEl(id);
    }
  }
  updateInventory();
}

// ─── Initial load ─────────────────────────────────────────────────────────────
async function loadSeats() {
  try {
    const seats = await api.getSeats();
    state.seats = {};
    for (const seat of seats) {
      state.seats[seat.id] = seat;
    }
    renderSeatMap();
  } catch (err) {
    seatMapEl.innerHTML = `<div class="loading">Failed to load seats: ${err.message}</div>`;
  }
}

async function init() {
  await loadSeats();
  renderActionPanel();
  connectSSE();
}

init();
