/**
 * Seat Booking – main application entry point.
 *
 * State machine
 * ─────────────
 * The UI has three mutually exclusive phases:
 *
 *   SELECTING  – user is clicking available seats to build a selection.
 *   HOLDING    – a hold is active; countdown ticking; user can confirm or release.
 *   BOOKED     – hold confirmed; seats are permanently booked.
 *
 * Seat rendering
 * ──────────────
 * Each seat button gets a CSS class based on its *effective* status:
 *   available   – can be clicked to select/deselect
 *   selected    – available + chosen by this user (pre-hold)
 *   held-own    – held by this session's current hold
 *   held-other  – held by another session
 *   booked      – permanently booked (by anyone)
 *
 * SSE updates
 * ───────────
 * The EventSource receives `seatUpdate` events containing an array of changed
 * seat objects.  We merge them into our local seat map and re-render only the
 * affected buttons.
 */

import { getSeats, createHold, confirmHold, releaseHold } from './api.js';
import { getSessionId } from './session.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const SESSION_ID = getSessionId();

/** @type {Map<string, object>} seatId → seat object */
const seatMap = new Map();

/** @type {Set<string>} seat ids selected by the user (pre-hold) */
const selectedIds = new Set();

/** Current hold object returned by the server, or null. */
let currentHold = null;

/** Set of seat ids belonging to the current hold. */
let holdSeatIds = new Set();

/** Interval handle for the hold countdown. */
let countdownInterval = null;

/** Phase: 'selecting' | 'holding' | 'booked' */
let phase = 'selecting';

/** Set of seat ids that are booked by this session. */
let bookedSeatIds = new Set();

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
const seatMapEl       = document.getElementById('seat-map');
const actionPanel     = document.getElementById('action-panel');
const selectionInfo   = document.getElementById('selection-info');
const holdInfo        = document.getElementById('hold-info');
const bookingInfo     = document.getElementById('booking-info');
const selectedList    = document.getElementById('selected-seats-list');
const holdSeatsList   = document.getElementById('hold-seats-list');
const bookedSeatsList = document.getElementById('booked-seats-list');
const btnHold         = document.getElementById('btn-hold');
const btnConfirm      = document.getElementById('btn-confirm');
const btnRelease      = document.getElementById('btn-release');
const btnNewBooking   = document.getElementById('btn-new-booking');
const holdCountdown   = document.getElementById('hold-countdown');
const notification    = document.getElementById('notification');

// ---------------------------------------------------------------------------
// Notification helpers
// ---------------------------------------------------------------------------
let notifTimeout = null;

function showNotification(message, type = 'info', durationMs = 4000) {
  notification.textContent = message;
  notification.className = `notification ${type}`;
  if (notifTimeout) clearTimeout(notifTimeout);
  notifTimeout = setTimeout(() => {
    notification.classList.add('hidden');
  }, durationMs);
}

// ---------------------------------------------------------------------------
// Seat rendering
// ---------------------------------------------------------------------------

/**
 * Determine the CSS class for a seat button given the current app state.
 */
function seatClass(seat) {
  if (seat.status === 'booked') return 'booked';

  if (seat.status === 'held') {
    if (currentHold && seat.hold_id === currentHold.id) return 'held-own';
    return 'held-other';
  }

  // available
  if (selectedIds.has(seat.id)) return 'selected';
  return 'available';
}

/**
 * Build the full seat map DOM from scratch.
 */
function renderSeatMap() {
  // Group seats by row.
  const rows = new Map();
  for (const seat of seatMap.values()) {
    if (!rows.has(seat.row_label)) rows.set(seat.row_label, []);
    rows.get(seat.row_label).push(seat);
  }

  // Sort rows alphabetically.
  const sortedRows = [...rows.entries()].sort(([a], [b]) => a.localeCompare(b));

  seatMapEl.innerHTML = '';

  for (const [rowLabel, seats] of sortedRows) {
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';

    const labelEl = document.createElement('div');
    labelEl.className = 'row-label';
    labelEl.textContent = rowLabel;
    rowEl.appendChild(labelEl);

    const seatsEl = document.createElement('div');
    seatsEl.className = 'seats-in-row';

    // Sort seats by seat_number.
    seats.sort((a, b) => a.seat_number - b.seat_number);

    for (const seat of seats) {
      seatsEl.appendChild(buildSeatButton(seat));
    }

    rowEl.appendChild(seatsEl);
    seatMapEl.appendChild(rowEl);
  }
}

/**
 * Build a single seat button element.
 */
function buildSeatButton(seat) {
  const btn = document.createElement('button');
  btn.className = `seat ${seatClass(seat)}`;
  btn.dataset.seatId = seat.id;
  btn.textContent = seat.seat_number;
  btn.title = `${seat.row_label}${seat.seat_number} – ${seat.status}`;
  btn.setAttribute('aria-label', `Row ${seat.row_label} Seat ${seat.seat_number}`);

  const cls = seatClass(seat);
  if (cls === 'available' || cls === 'selected') {
    btn.addEventListener('click', () => onSeatClick(seat.id));
  } else {
    btn.disabled = true;
  }

  return btn;
}

/**
 * Update only the changed seat buttons without re-rendering the whole map.
 */
function updateSeatButtons(changedSeats) {
  for (const seat of changedSeats) {
    const btn = seatMapEl.querySelector(`[data-seat-id="${seat.id}"]`);
    if (!btn) continue;

    const cls = seatClass(seat);
    btn.className = `seat ${cls}`;
    btn.title = `${seat.row_label}${seat.seat_number} – ${seat.status}`;

    // Re-wire click handler.
    const newBtn = btn.cloneNode(true); // removes old listeners
    if (cls === 'available' || cls === 'selected') {
      newBtn.addEventListener('click', () => onSeatClick(seat.id));
      newBtn.disabled = false;
    } else {
      newBtn.disabled = true;
    }
    btn.replaceWith(newBtn);
  }
}

// ---------------------------------------------------------------------------
// Action panel rendering
// ---------------------------------------------------------------------------

function renderActionPanel() {
  // Show/hide the panel itself.
  const showPanel =
    phase === 'holding' ||
    phase === 'booked' ||
    (phase === 'selecting' && selectedIds.size > 0);

  actionPanel.classList.toggle('hidden', !showPanel);

  // Show the right section.
  selectionInfo.classList.toggle('hidden', phase !== 'selecting');
  holdInfo.classList.toggle('hidden', phase !== 'holding');
  bookingInfo.classList.toggle('hidden', phase !== 'booked');

  if (phase === 'selecting') {
    renderChips(selectedList, [...selectedIds]);
    btnHold.disabled = selectedIds.size === 0;
  } else if (phase === 'holding') {
    renderChips(holdSeatsList, [...holdSeatIds]);
  } else if (phase === 'booked') {
    renderChips(bookedSeatsList, [...bookedSeatIds]);
  }
}

function renderChips(container, seatIds) {
  container.innerHTML = '';
  for (const id of seatIds) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = id;
    container.appendChild(chip);
  }
}

// ---------------------------------------------------------------------------
// Countdown timer
// ---------------------------------------------------------------------------

function startCountdown(expiresAt) {
  stopCountdown();
  const expiresMs = new Date(expiresAt).getTime();

  function tick() {
    const remaining = Math.max(0, expiresMs - Date.now());
    const secs = Math.ceil(remaining / 1000);
    const mins = Math.floor(secs / 60);
    const s = secs % 60;
    holdCountdown.textContent = `${mins}:${String(s).padStart(2, '0')}`;
    holdCountdown.classList.toggle('urgent', secs <= 10);

    if (remaining <= 0) {
      stopCountdown();
      onHoldExpiredLocally();
    }
  }

  tick();
  countdownInterval = setInterval(tick, 500);
}

function stopCountdown() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
}

/**
 * Called when the local countdown reaches zero.
 * The server will have already expired the hold; we just update the UI.
 */
function onHoldExpiredLocally() {
  showNotification('Your hold has expired. The seats are now available again.', 'warning', 6000);
  resetToSelecting();
}

// ---------------------------------------------------------------------------
// Phase transitions
// ---------------------------------------------------------------------------

function resetToSelecting() {
  stopCountdown();
  currentHold = null;
  holdSeatIds = new Set();
  selectedIds.clear();
  phase = 'selecting';
  renderSeatMap();
  renderActionPanel();
}

function enterHoldingPhase(hold, seats) {
  currentHold = hold;
  holdSeatIds = new Set(seats.map((s) => s.id));
  selectedIds.clear();
  phase = 'holding';
  startCountdown(hold.expires_at);
  renderSeatMap();
  renderActionPanel();
}

function enterBookedPhase(seats) {
  stopCountdown();
  bookedSeatIds = new Set(seats.map((s) => s.id));
  currentHold = null;
  holdSeatIds = new Set();
  phase = 'booked';
  renderSeatMap();
  renderActionPanel();
}

// ---------------------------------------------------------------------------
// User interactions
// ---------------------------------------------------------------------------

function onSeatClick(seatId) {
  if (phase !== 'selecting') return;

  const seat = seatMap.get(seatId);
  if (!seat || seat.status !== 'available') return;

  if (selectedIds.has(seatId)) {
    selectedIds.delete(seatId);
  } else {
    selectedIds.add(seatId);
  }

  // Update just this button.
  updateSeatButtons([seat]);
  renderActionPanel();
}

async function onHoldClick() {
  if (selectedIds.size === 0) return;
  btnHold.disabled = true;
  btnHold.textContent = 'Placing hold…';

  const { data, error, status } = await createHold([...selectedIds], SESSION_ID);

  btnHold.textContent = 'Place Hold';

  if (error) {
    if (status === 409 && error.conflictingSeatIds) {
      showNotification(
        `Seats ${error.conflictingSeatIds.join(', ')} are no longer available. Please reselect.`,
        'error',
        6000,
      );
      // Refresh seat map to show current state.
      await refreshSeats();
      selectedIds.clear();
      renderActionPanel();
    } else {
      showNotification(error.error || 'Failed to place hold. Please try again.', 'error');
      btnHold.disabled = false;
    }
    return;
  }

  enterHoldingPhase(data.hold, data.seats);
  showNotification(`Hold placed for ${data.seats.length} seat(s)! Confirm within 60 seconds.`, 'success');
}

async function onConfirmClick() {
  if (!currentHold) return;
  btnConfirm.disabled = true;
  btnConfirm.textContent = 'Confirming…';

  const { data, error } = await confirmHold(currentHold.id, SESSION_ID);

  btnConfirm.textContent = 'Confirm Booking';
  btnConfirm.disabled = false;

  if (error) {
    showNotification(error.error || 'Confirmation failed.', 'error', 6000);
    if (error.error && (error.error.includes('expired') || error.error.includes('not found'))) {
      resetToSelecting();
      await refreshSeats();
    }
    return;
  }

  enterBookedPhase(data.seats);
  showNotification(`🎉 Booking confirmed for ${data.seats.length} seat(s)!`, 'success', 8000);
}

async function onReleaseClick() {
  if (!currentHold) return;
  btnRelease.disabled = true;
  btnRelease.textContent = 'Releasing…';

  const holdId = currentHold.id;
  const { error } = await releaseHold(holdId, SESSION_ID);

  btnRelease.textContent = 'Release Hold';
  btnRelease.disabled = false;

  if (error && !error.error?.includes('already released')) {
    showNotification(error.error || 'Failed to release hold.', 'error');
    return;
  }

  showNotification('Hold released. Seats are available again.', 'info');
  resetToSelecting();
  await refreshSeats();
}

function onNewBookingClick() {
  bookedSeatIds = new Set();
  phase = 'selecting';
  renderActionPanel();
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function refreshSeats() {
  const { data, error } = await getSeats();
  if (error) {
    showNotification('Failed to load seats.', 'error');
    return;
  }
  for (const seat of data) {
    seatMap.set(seat.id, seat);
  }
  renderSeatMap();
}

// ---------------------------------------------------------------------------
// SSE – real-time updates
// ---------------------------------------------------------------------------

function connectSSE() {
  const es = new EventSource('/api/stream');

  es.addEventListener('connected', (e) => {
    const seats = JSON.parse(e.data);
    for (const seat of seats) {
      seatMap.set(seat.id, seat);
    }
    renderSeatMap();
    renderActionPanel();
    console.log('[sse] Connected, received', seats.length, 'seats.');
  });

  es.addEventListener('seatUpdate', (e) => {
    const changedSeats = JSON.parse(e.data);
    const affected = [];

    for (const seat of changedSeats) {
      seatMap.set(seat.id, seat);
      affected.push(seat);

      // If a seat we're holding was released/booked by someone else, reset.
      if (
        phase === 'holding' &&
        holdSeatIds.has(seat.id) &&
        seat.hold_id !== currentHold?.id &&
        seat.status !== 'held'
      ) {
        // Our hold was superseded (shouldn't happen with correct locking, but
        // handle gracefully).
        showNotification('Your hold was invalidated by a concurrent change.', 'warning', 6000);
        resetToSelecting();
      }

      // If a seat we selected is no longer available, deselect it.
      if (phase === 'selecting' && selectedIds.has(seat.id) && seat.status !== 'available') {
        selectedIds.delete(seat.id);
      }
    }

    updateSeatButtons(affected);
    renderActionPanel();
  });

  es.onerror = () => {
    console.warn('[sse] Connection lost, reconnecting…');
    // EventSource auto-reconnects; just log.
  };

  return es;
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function init() {
  // Wire up button handlers.
  btnHold.addEventListener('click', onHoldClick);
  btnConfirm.addEventListener('click', onConfirmClick);
  btnRelease.addEventListener('click', onReleaseClick);
  btnNewBooking.addEventListener('click', onNewBookingClick);

  // Connect SSE first (it sends the initial snapshot).
  connectSSE();
}

init();
