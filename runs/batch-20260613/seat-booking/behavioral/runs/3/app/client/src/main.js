/**
 * Seat Booking SPA – main entry point.
 *
 * State machine:
 *   idle       → user selects seats → hold-pending
 *   hold-pending → hold created     → holding
 *   holding    → confirmed          → booked
 *   holding    → released / expired → idle
 *   booked     → new booking        → idle
 */

import { fetchSeats, createHold, confirmHold, releaseHold, openEventStream } from './api.js';

/* ------------------------------------------------------------------ */
/* Session identity                                                     */
/* ------------------------------------------------------------------ */
function getSessionId() {
  let id = sessionStorage.getItem('sessionId');
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem('sessionId', id);
  }
  return id;
}

const SESSION_ID = getSessionId();

/* ------------------------------------------------------------------ */
/* Application state                                                    */
/* ------------------------------------------------------------------ */
const state = {
  seats: {},          // id → seat object
  selected: new Set(),// ids of seats the user has clicked
  hold: null,         // { holdId, seatIds, expiresAt, ttlSeconds }
  booking: null,      // { holdId, seatIds }
  phase: 'idle',      // idle | holding | booked
};

/* ------------------------------------------------------------------ */
/* DOM refs                                                             */
/* ------------------------------------------------------------------ */
const $seatMap        = document.getElementById('seat-map');
const $selectionInfo  = document.getElementById('selection-info');
const $holdSection    = document.getElementById('hold-section');
const $confirmSection = document.getElementById('confirm-section');
const $bookedSection  = document.getElementById('booked-section');
const $errorSection   = document.getElementById('error-section');
const $selectedLabel  = document.getElementById('selected-seats-label');
const $holdInfo       = document.getElementById('hold-info');
const $bookedInfo     = document.getElementById('booked-info');
const $errorMsg       = document.getElementById('error-msg');
const $btnHold        = document.getElementById('btn-hold');
const $btnConfirm     = document.getElementById('btn-confirm');
const $btnRelease     = document.getElementById('btn-release');
const $btnNewBooking  = document.getElementById('btn-new-booking');
const $btnDismiss     = document.getElementById('btn-dismiss-error');
const $countdownFill  = document.getElementById('countdown-fill');
const $countdownLabel = document.getElementById('countdown-label');
const $connDot        = document.getElementById('connection-status');
const $invAvailable   = document.getElementById('inv-available');
const $invHeld        = document.getElementById('inv-held');
const $invBooked      = document.getElementById('inv-booked');
const $invTotal       = document.getElementById('inv-total');

/* ------------------------------------------------------------------ */
/* Countdown timer                                                      */
/* ------------------------------------------------------------------ */
let countdownInterval = null;

function startCountdown(expiresAt, ttlSeconds) {
  clearInterval(countdownInterval);
  const expiry = new Date(expiresAt).getTime();

  function tick() {
    const remaining = Math.max(0, expiry - Date.now());
    const pct = (remaining / (ttlSeconds * 1000)) * 100;
    $countdownFill.style.width = `${pct}%`;
    $countdownFill.classList.toggle('urgent', pct < 25);

    const secs = Math.ceil(remaining / 1000);
    $countdownLabel.textContent = remaining > 0
      ? `Hold expires in ${secs}s`
      : 'Hold expired';

    if (remaining === 0) {
      clearInterval(countdownInterval);
      // The SSE will push the release; we just update the label.
    }
  }

  tick();
  countdownInterval = setInterval(tick, 500);
}

function stopCountdown() {
  clearInterval(countdownInterval);
  countdownInterval = null;
}

/* ------------------------------------------------------------------ */
/* Render                                                               */
/* ------------------------------------------------------------------ */
function renderSeatMap() {
  // Group seats by row.
  const rows = {};
  for (const seat of Object.values(state.seats)) {
    if (!rows[seat.row_label]) rows[seat.row_label] = [];
    rows[seat.row_label].push(seat);
  }

  $seatMap.innerHTML = '';

  for (const rowLabel of Object.keys(rows).sort()) {
    const rowSeats = rows[rowLabel].sort((a, b) => a.seat_number - b.seat_number);

    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';

    const labelEl = document.createElement('span');
    labelEl.className = 'row-label';
    labelEl.textContent = rowLabel;
    rowEl.appendChild(labelEl);

    for (const seat of rowSeats) {
      rowEl.appendChild(createSeatEl(seat));
    }

    $seatMap.appendChild(rowEl);
  }

  updateInventory();
}

function createSeatEl(seat) {
  const el = document.createElement('button');
  el.className = `seat ${getSeatClass(seat)}`;
  el.id = `seat-${seat.id}`;
  el.textContent = seat.seat_number;
  el.setAttribute('aria-label', `Row ${seat.row_label} Seat ${seat.seat_number} – ${seat.status}`);
  el.setAttribute('title', `${seat.id} (${seat.status})`);

  if (seat.status === 'available' && state.phase === 'idle') {
    el.addEventListener('click', () => toggleSeat(seat.id));
  }

  return el;
}

function getSeatClass(seat) {
  if (state.phase === 'holding' && state.hold?.seatIds.includes(seat.id)) {
    return 'held-mine';
  }
  if (state.phase === 'booked' && state.booking?.seatIds.includes(seat.id)) {
    return 'booked';
  }
  if (state.selected.has(seat.id)) return 'selected';
  return seat.status;
}

function updateSeatEl(seatId) {
  const seat = state.seats[seatId];
  if (!seat) return;

  const existing = document.getElementById(`seat-${seatId}`);
  if (!existing) return;

  const newEl = createSeatEl(seat);
  newEl.classList.add('flash');
  existing.replaceWith(newEl);
}

function updateInventory() {
  const seats = Object.values(state.seats);
  const available = seats.filter(s => s.status === 'available').length;
  const held      = seats.filter(s => s.status === 'held').length;
  const booked    = seats.filter(s => s.status === 'booked').length;

  $invAvailable.textContent = available;
  $invHeld.textContent      = held;
  $invBooked.textContent    = booked;
  $invTotal.textContent     = seats.length;
}

/* ------------------------------------------------------------------ */
/* Panel rendering                                                      */
/* ------------------------------------------------------------------ */
function renderPanel() {
  // Hide all sections first.
  $holdSection.classList.add('hidden');
  $confirmSection.classList.add('hidden');
  $bookedSection.classList.add('hidden');
  $errorSection.classList.add('hidden');

  if (state.phase === 'idle') {
    if (state.selected.size === 0) {
      $selectionInfo.textContent = 'Click available seats to select them.';
    } else {
      $selectionInfo.textContent = `${state.selected.size} seat(s) selected.`;
      $selectedLabel.textContent = `Seats: ${[...state.selected].join(', ')}`;
      $holdSection.classList.remove('hidden');
    }
  } else if (state.phase === 'holding') {
    $selectionInfo.textContent = 'You have an active hold.';
    const ids = state.hold.seatIds.join(', ');
    $holdInfo.textContent = `Holding seats: ${ids}`;
    $confirmSection.classList.remove('hidden');
    startCountdown(state.hold.expiresAt, state.hold.ttlSeconds);
  } else if (state.phase === 'booked') {
    $selectionInfo.textContent = 'Booking confirmed!';
    const ids = state.booking.seatIds.join(', ');
    $bookedInfo.textContent = `✅ Booked seats: ${ids}`;
    $bookedSection.classList.remove('hidden');
    stopCountdown();
  }
}

function showError(msg) {
  $errorMsg.textContent = msg;
  $errorSection.classList.remove('hidden');
}

/* ------------------------------------------------------------------ */
/* Seat selection                                                       */
/* ------------------------------------------------------------------ */
function toggleSeat(seatId) {
  if (state.phase !== 'idle') return;
  const seat = state.seats[seatId];
  if (!seat || seat.status !== 'available') return;

  if (state.selected.has(seatId)) {
    state.selected.delete(seatId);
  } else {
    state.selected.add(seatId);
  }

  updateSeatEl(seatId);
  renderPanel();
}

/* ------------------------------------------------------------------ */
/* Actions                                                              */
/* ------------------------------------------------------------------ */
$btnHold.addEventListener('click', async () => {
  if (state.selected.size === 0) return;
  $btnHold.disabled = true;

  try {
    const seatIds = [...state.selected];
    const hold = await createHold(seatIds, SESSION_ID);

    state.hold = {
      holdId: hold.holdId,
      seatIds: hold.seatIds,
      expiresAt: hold.expiresAt,
      ttlSeconds: hold.ttlSeconds,
    };
    state.phase = 'holding';
    state.selected.clear();

    // Update local seat state.
    for (const id of hold.seatIds) {
      if (state.seats[id]) state.seats[id].status = 'held';
    }

    renderSeatMap();
    renderPanel();
  } catch (err) {
    $btnHold.disabled = false;
    if (err.status === 409) {
      const conflicts = err.body?.conflictingSeatIds || [];
      showError(
        `Seats already taken: ${conflicts.join(', ')}. Please deselect them and try again.`
      );
      // Refresh seat map to show current state.
      await loadSeats();
      // Remove conflicting seats from selection.
      for (const id of conflicts) state.selected.delete(id);
      renderSeatMap();
      renderPanel();
    } else {
      showError(err.message || 'Failed to create hold. Please try again.');
    }
  }
});

$btnConfirm.addEventListener('click', async () => {
  if (!state.hold) return;
  $btnConfirm.disabled = true;

  try {
    const booking = await confirmHold(state.hold.holdId, SESSION_ID);

    state.booking = { holdId: booking.holdId, seatIds: booking.seatIds };
    state.phase = 'booked';
    state.hold = null;

    // Update local seat state.
    for (const id of booking.seatIds) {
      if (state.seats[id]) state.seats[id].status = 'booked';
    }

    renderSeatMap();
    renderPanel();
  } catch (err) {
    $btnConfirm.disabled = false;
    if (err.status === 410) {
      showError('Your hold has expired. Please select seats again.');
      state.hold = null;
      state.phase = 'idle';
      await loadSeats();
      renderSeatMap();
      renderPanel();
    } else {
      showError(err.message || 'Failed to confirm booking. Please try again.');
    }
  }
});

$btnRelease.addEventListener('click', async () => {
  if (!state.hold) return;
  $btnRelease.disabled = true;

  try {
    await releaseHold(state.hold.holdId, SESSION_ID);

    // Update local seat state.
    for (const id of state.hold.seatIds) {
      if (state.seats[id]) state.seats[id].status = 'available';
    }

    state.hold = null;
    state.phase = 'idle';
    stopCountdown();

    renderSeatMap();
    renderPanel();
  } catch (err) {
    $btnRelease.disabled = false;
    showError(err.message || 'Failed to release hold.');
  }
});

$btnNewBooking.addEventListener('click', () => {
  state.booking = null;
  state.phase = 'idle';
  state.selected.clear();
  renderSeatMap();
  renderPanel();
});

$btnDismiss.addEventListener('click', () => {
  $errorSection.classList.add('hidden');
  $btnHold.disabled = false;
  $btnConfirm.disabled = false;
  $btnRelease.disabled = false;
});

/* ------------------------------------------------------------------ */
/* SSE                                                                  */
/* ------------------------------------------------------------------ */
function connectSSE() {
  $connDot.className = 'status-dot connecting';

  const es = openEventStream();

  es.onopen = () => {
    $connDot.className = 'status-dot connected';
  };

  es.addEventListener('seatUpdate', (e) => {
    try {
      const { type, seats } = JSON.parse(e.data);
      handleSeatUpdate(type, seats);
    } catch {
      // Ignore malformed events.
    }
  });

  es.onerror = () => {
    $connDot.className = 'status-dot disconnected';
    es.close();
    // Reconnect after 3 seconds.
    setTimeout(connectSSE, 3000);
  };
}

function handleSeatUpdate(type, seats) {
  let changed = false;

  for (const update of seats) {
    const seat = state.seats[update.id];
    if (!seat) continue;

    // Don't overwrite our own hold/booking with SSE (we already updated locally).
    if (state.phase === 'holding' && state.hold?.seatIds.includes(update.id)) continue;
    if (state.phase === 'booked' && state.booking?.seatIds.includes(update.id)) continue;

    const newStatus = update.status;
    if (seat.status !== newStatus) {
      seat.status = newStatus;
      // Clear hold metadata if released.
      if (newStatus === 'available') {
        seat.hold_id = null;
        seat.hold_expires_at = null;
      }
      updateSeatEl(update.id);
      changed = true;
    }
  }

  if (changed) {
    updateInventory();

    // If our hold was released by expiry (SSE says our held seats are now available).
    if (state.phase === 'holding' && state.hold) {
      const allReleased = state.hold.seatIds.every(
        id => state.seats[id]?.status === 'available'
      );
      if (allReleased) {
        state.hold = null;
        state.phase = 'idle';
        stopCountdown();
        showError('Your hold expired and seats were released.');
        renderPanel();
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Initial load                                                         */
/* ------------------------------------------------------------------ */
async function loadSeats() {
  const seats = await fetchSeats();
  state.seats = {};
  for (const seat of seats) {
    state.seats[seat.id] = seat;
  }
}

async function init() {
  try {
    await loadSeats();
    renderSeatMap();
    renderPanel();
    connectSSE();
  } catch (err) {
    console.error('Failed to initialise:', err);
    showError('Failed to load seat map. Please refresh the page.');
  }
}

init();
