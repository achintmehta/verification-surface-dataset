/**
 * Seat Booking – main application entry point.
 *
 * Responsibilities:
 *  - Render the seat map from the API
 *  - Manage local selection state
 *  - Drive the hold → confirm / release flow
 *  - Listen to SSE and update the seat map live
 *  - Keep the countdown timer for the active hold
 */

import { fetchSeats, createHold, confirmHold, releaseHold } from './api.js';
import { getSessionId } from './session.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const SESSION_ID = getSessionId();

/** @type {Map<string, object>} seatId → seat object */
let seats = new Map();

/** @type {Set<string>} currently selected (but not yet held) seat ids */
let selected = new Set();

/** Active hold state */
let activeHold = null; // { holdId, seatIds, expiresAt }

/** Countdown interval handle */
let countdownTimer = null;

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const seatMapEl      = document.getElementById('seat-map');
const statusBar      = document.getElementById('status-bar');
const selectionInfo  = document.getElementById('selection-info');
const selectedCount  = document.getElementById('selected-count');
const holdPanel      = document.getElementById('hold-panel');
const countdownEl    = document.getElementById('countdown');
const heldSeatsList  = document.getElementById('held-seats-list');
const btnHold        = document.getElementById('btn-hold');
const btnConfirm     = document.getElementById('btn-confirm');
const btnRelease     = document.getElementById('btn-release');
const btnClear       = document.getElementById('btn-clear');
const invAvailable   = document.getElementById('inv-available');
const invHeld        = document.getElementById('inv-held');
const invBooked      = document.getElementById('inv-booked');
const invTotal       = document.getElementById('inv-total');

// ---------------------------------------------------------------------------
// Status bar helpers
// ---------------------------------------------------------------------------

/**
 * @param {string} msg
 * @param {'info'|'success'|'error'|'warning'} [type]
 */
function setStatus(msg, type = 'info') {
  statusBar.textContent = msg;
  statusBar.className = `status-bar ${type}`;
}

// ---------------------------------------------------------------------------
// Seat map rendering
// ---------------------------------------------------------------------------

/**
 * Determine the CSS class for a seat given current state.
 * @param {object} seat
 * @returns {string}
 */
function seatClass(seat) {
  if (selected.has(seat.id)) return 'seat--selected';

  if (activeHold && activeHold.seatIds.includes(seat.id)) {
    return 'seat--held-own';
  }

  switch (seat.status) {
    case 'available': return 'seat--available';
    case 'held':      return 'seat--held-other';
    case 'booked':    return 'seat--booked';
    default:          return 'seat--available';
  }
}

/**
 * Build the full seat map DOM from scratch.
 */
function renderSeatMap() {
  seatMapEl.innerHTML = '';

  // Group by row
  const rows = new Map();
  for (const seat of seats.values()) {
    if (!rows.has(seat.row_label)) rows.set(seat.row_label, []);
    rows.get(seat.row_label).push(seat);
  }

  // Sort rows alphabetically, seats numerically
  const sortedRows = [...rows.entries()].sort(([a], [b]) => a.localeCompare(b));

  for (const [rowLabel, rowSeats] of sortedRows) {
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';
    rowEl.dataset.row = rowLabel;

    const labelEl = document.createElement('span');
    labelEl.className = 'row-label';
    labelEl.textContent = rowLabel;
    rowEl.appendChild(labelEl);

    rowSeats.sort((a, b) => a.seat_number - b.seat_number);

    for (const seat of rowSeats) {
      const el = createSeatElement(seat);
      rowEl.appendChild(el);
    }

    seatMapEl.appendChild(rowEl);
  }

  updateInventory();
}

/**
 * Create a single seat button element.
 * @param {object} seat
 * @returns {HTMLButtonElement}
 */
function createSeatElement(seat) {
  const el = document.createElement('button');
  el.className = `seat ${seatClass(seat)}`;
  el.id = `seat-${seat.id}`;
  el.dataset.seatId = seat.id;
  el.textContent = seat.seat_number;
  el.setAttribute('aria-label', `Row ${seat.row_label} Seat ${seat.seat_number} – ${seat.status}`);

  const isInteractive =
    seat.status === 'available' ||
    selected.has(seat.id) ||
    (activeHold && activeHold.seatIds.includes(seat.id));

  el.disabled = !isInteractive;

  el.addEventListener('click', () => onSeatClick(seat.id));
  return el;
}

/**
 * Update a single seat element in-place (avoids full re-render).
 * @param {string} seatId
 */
function updateSeatElement(seatId) {
  const seat = seats.get(seatId);
  if (!seat) return;

  const el = document.getElementById(`seat-${seatId}`);
  if (!el) {
    // Element doesn't exist yet – full re-render needed
    renderSeatMap();
    return;
  }

  const cls = seatClass(seat);
  el.className = `seat ${cls}`;
  el.setAttribute('aria-label', `Row ${seat.row_label} Seat ${seat.seat_number} – ${seat.status}`);

  const isInteractive =
    seat.status === 'available' ||
    selected.has(seat.id) ||
    (activeHold && activeHold.seatIds.includes(seat.id));

  el.disabled = !isInteractive;
}

// ---------------------------------------------------------------------------
// Inventory summary
// ---------------------------------------------------------------------------

function updateInventory() {
  let available = 0, held = 0, booked = 0;
  for (const seat of seats.values()) {
    if (seat.status === 'available') available++;
    else if (seat.status === 'held') held++;
    else if (seat.status === 'booked') booked++;
  }
  invAvailable.textContent = available;
  invHeld.textContent      = held;
  invBooked.textContent    = booked;
  invTotal.textContent     = seats.size;
}

// ---------------------------------------------------------------------------
// UI state sync
// ---------------------------------------------------------------------------

function syncUI() {
  const hasSelection = selected.size > 0;
  const hasHold      = activeHold !== null;

  // Selection info
  if (hasSelection) {
    selectionInfo.classList.remove('hidden');
    selectedCount.textContent = selected.size;
  } else {
    selectionInfo.classList.add('hidden');
  }

  // Hold panel
  if (hasHold) {
    holdPanel.classList.remove('hidden');
    heldSeatsList.textContent = activeHold.seatIds.join(', ');
  } else {
    holdPanel.classList.add('hidden');
  }

  // Buttons
  btnHold.disabled    = !hasSelection || hasHold;
  btnConfirm.disabled = !hasHold;
  btnRelease.disabled = !hasHold;
  btnClear.disabled   = !hasSelection;
}

// ---------------------------------------------------------------------------
// Countdown timer
// ---------------------------------------------------------------------------

function startCountdown(expiresAt) {
  stopCountdown();
  countdownTimer = setInterval(() => {
    const remaining = Math.max(0, Math.floor((new Date(expiresAt) - Date.now()) / 1000));
    const mins = Math.floor(remaining / 60).toString().padStart(2, '0');
    const secs = (remaining % 60).toString().padStart(2, '0');
    countdownEl.textContent = `${mins}:${secs}`;
    countdownEl.classList.toggle('urgent', remaining <= 10);

    if (remaining === 0) {
      stopCountdown();
      // Hold has expired locally – clear it
      handleHoldExpired();
    }
  }, 500);
}

function stopCountdown() {
  if (countdownTimer !== null) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  countdownEl.textContent = '--';
  countdownEl.classList.remove('urgent');
}

function handleHoldExpired() {
  if (!activeHold) return;
  setStatus('Your hold has expired. Those seats are now available again.', 'warning');
  clearActiveHold();
}

// ---------------------------------------------------------------------------
// Active hold management
// ---------------------------------------------------------------------------

function setActiveHold(hold) {
  activeHold = hold;
  selected.clear();
  startCountdown(hold.expiresAt);
  syncUI();
  // Re-render so held-own seats show correctly
  for (const id of hold.seatIds) updateSeatElement(id);
}

function clearActiveHold() {
  if (!activeHold) return;
  const oldSeatIds = activeHold.seatIds;
  activeHold = null;
  stopCountdown();
  // Re-render previously held seats
  for (const id of oldSeatIds) updateSeatElement(id);
  syncUI();
}

// ---------------------------------------------------------------------------
// Seat click handler
// ---------------------------------------------------------------------------

function onSeatClick(seatId) {
  // If we have an active hold, seat clicks are disabled for non-held seats
  if (activeHold) return;

  const seat = seats.get(seatId);
  if (!seat || seat.status !== 'available') return;

  if (selected.has(seatId)) {
    selected.delete(seatId);
  } else {
    selected.add(seatId);
  }

  updateSeatElement(seatId);
  syncUI();
}

// ---------------------------------------------------------------------------
// Button handlers
// ---------------------------------------------------------------------------

btnHold.addEventListener('click', async () => {
  if (selected.size === 0) return;
  const seatIds = [...selected];

  btnHold.disabled = true;
  setStatus('Requesting hold…', 'info');

  try {
    const hold = await createHold(seatIds, SESSION_ID);
    setActiveHold({
      holdId: hold.holdId,
      seatIds: hold.seatIds,
      expiresAt: hold.expiresAt,
    });
    setStatus(
      `Hold placed on ${hold.seatIds.length} seat(s). Confirm within ${hold.ttlSeconds}s.`,
      'success'
    );
  } catch (err) {
    if (err.status === 409 && err.data?.conflictingSeatIds) {
      const conflicting = err.data.conflictingSeatIds;
      setStatus(
        `Seats already taken: ${conflicting.join(', ')}. Please choose different seats.`,
        'error'
      );
      // Flash conflicting seats and remove them from selection
      for (const id of conflicting) {
        selected.delete(id);
        const el = document.getElementById(`seat-${id}`);
        if (el) {
          el.classList.add('seat--conflict');
          setTimeout(() => el.classList.remove('seat--conflict'), 2000);
        }
      }
      // Refresh seat map to get latest state
      await loadSeats();
    } else {
      setStatus(err.message ?? 'Failed to place hold.', 'error');
    }
    syncUI();
  }
});

btnConfirm.addEventListener('click', async () => {
  if (!activeHold) return;
  btnConfirm.disabled = true;
  setStatus('Confirming booking…', 'info');

  try {
    const result = await confirmHold(activeHold.holdId, SESSION_ID);
    const msg = result.alreadyConfirmed
      ? `Booking already confirmed for seats: ${result.seatIds.join(', ')}`
      : `Booking confirmed! Seats: ${result.seatIds.join(', ')}`;
    setStatus(msg, 'success');
    clearActiveHold();
    // Update local seat state to booked
    for (const id of result.seatIds) {
      const seat = seats.get(id);
      if (seat) {
        seat.status = 'booked';
        seat.hold_id = null;
        seat.hold_expires_at = null;
      }
      updateSeatElement(id);
    }
    updateInventory();
  } catch (err) {
    setStatus(err.message ?? 'Failed to confirm booking.', 'error');
    if (err.status === 410 || err.status === 404) {
      // Hold expired or gone
      clearActiveHold();
      await loadSeats();
    }
    syncUI();
  }
});

btnRelease.addEventListener('click', async () => {
  if (!activeHold) return;
  btnRelease.disabled = true;
  setStatus('Releasing hold…', 'info');

  try {
    await releaseHold(activeHold.holdId, SESSION_ID);
    setStatus('Hold released. Seats are available again.', 'info');
    clearActiveHold();
    await loadSeats();
  } catch (err) {
    setStatus(err.message ?? 'Failed to release hold.', 'error');
    syncUI();
  }
});

btnClear.addEventListener('click', () => {
  const prev = [...selected];
  selected.clear();
  for (const id of prev) updateSeatElement(id);
  syncUI();
  setStatus('Selection cleared.', 'info');
});

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function loadSeats() {
  try {
    const data = await fetchSeats();
    seats.clear();
    for (const seat of data) {
      seats.set(seat.id, seat);
    }
    renderSeatMap();
    syncUI();
  } catch (err) {
    setStatus('Failed to load seat map. Retrying…', 'error');
    console.error('[loadSeats]', err);
    setTimeout(loadSeats, 3000);
  }
}

// ---------------------------------------------------------------------------
// SSE – real-time seat updates
// ---------------------------------------------------------------------------

function connectSSE() {
  const es = new EventSource('/api/stream');

  es.addEventListener('connected', () => {
    console.log('[sse] Connected.');
    setStatus('Connected – seat map is live.', 'success');
  });

  es.addEventListener('seat-update', (e) => {
    try {
      const update = JSON.parse(e.data);
      applySeatUpdate(update);
    } catch (err) {
      console.error('[sse] Failed to parse seat-update:', err);
    }
  });

  es.addEventListener('error', () => {
    console.warn('[sse] Connection lost. Reconnecting…');
    setStatus('Connection lost. Reconnecting…', 'warning');
    es.close();
    setTimeout(connectSSE, 3000);
  });
}

/**
 * Apply a seat-update event from SSE.
 * @param {{ id: string, status: string, holdId?: string, expiresAt?: string }} update
 */
function applySeatUpdate(update) {
  const seat = seats.get(update.id);
  if (!seat) return;

  const prevStatus = seat.status;

  seat.status = update.status;

  if (update.status === 'held') {
    seat.hold_id = update.holdId ?? null;
    seat.hold_expires_at = update.expiresAt ?? null;
  } else if (update.status === 'available') {
    seat.hold_id = null;
    seat.hold_expires_at = null;
    seat.booked_by = null;

    // If this was one of our held seats and the server released it (expiry)
    if (activeHold && activeHold.seatIds.includes(update.id)) {
      // Check if all our held seats are now available (hold expired server-side)
      const allReleased = activeHold.seatIds.every(
        (id) => seats.get(id)?.status === 'available'
      );
      if (allReleased) {
        handleHoldExpired();
      }
    }
  } else if (update.status === 'booked') {
    seat.hold_id = null;
    seat.hold_expires_at = null;
    seat.booked_by = update.bookedBy ?? null;
  }

  // If the seat was in our selection and is no longer available, remove it
  if (selected.has(update.id) && update.status !== 'available') {
    selected.delete(update.id);
    syncUI();
  }

  // Don't override our own held seats with 'held-other' styling
  if (
    update.status === 'held' &&
    activeHold &&
    activeHold.seatIds.includes(update.id)
  ) {
    // This is our own hold being echoed back – keep held-own styling
  }

  updateSeatElement(update.id);
  updateInventory();

  if (prevStatus !== update.status) {
    console.log(`[sse] Seat ${update.id}: ${prevStatus} → ${update.status}`);
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function init() {
  setStatus('Loading seat map…', 'info');
  await loadSeats();
  connectSSE();
}

init();
