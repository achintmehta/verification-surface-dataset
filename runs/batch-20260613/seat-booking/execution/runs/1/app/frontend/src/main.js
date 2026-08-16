/**
 * main.js – Seat Booking SPA entry point.
 *
 * State machine:
 *
 *   idle  ──(select seats)──►  selecting
 *         ◄─(clear)──────────
 *
 *   selecting ──(hold)──►  holding
 *             ◄─(409)────  idle  (show conflict)
 *
 *   holding ──(confirm)──►  booked
 *           ──(release)──►  idle
 *           ──(expired) ──►  idle  (TTL countdown hits 0)
 *
 *   booked ──(new booking)──►  idle
 */

import { fetchSeats, createHold, confirmHold, releaseHold, openStream } from './api.js';
import { getSessionId } from './session.js';

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

const SESSION_ID = getSessionId();

/** @type {Map<string, object>} seatId → seat object */
const seatMap = new Map();

/** @type {Set<string>} currently selected (but not yet held) seat ids */
const selectedIds = new Set();

/** Current active hold, or null */
let activeHold = null; // { id, expiresAt, seats: [{id,...}] }

/** Countdown interval handle */
let countdownInterval = null;

/** Set of seat ids that belong to the current confirmed booking */
const bookedMineIds = new Set();

// ─────────────────────────────────────────────────────────────────────────────
// DOM refs
// ─────────────────────────────────────────────────────────────────────────────

const $seatMap          = document.getElementById('seat-map');
const $seatMapLoading   = document.getElementById('seat-map-loading');
const $sessionDisplay   = document.getElementById('session-id-display');
const $connStatus       = document.getElementById('connection-status');

const $panelIdle        = document.getElementById('panel-idle');
const $panelSelection   = document.getElementById('panel-selection');
const $panelHold        = document.getElementById('panel-hold');
const $panelBooked      = document.getElementById('panel-booked');
const $panelError       = document.getElementById('panel-error');

const $selectedCount    = document.getElementById('selected-count');
const $holdCountdown    = document.getElementById('hold-countdown');
const $holdSeatsList    = document.getElementById('hold-seats-list');
const $bookedSeatsList  = document.getElementById('booked-seats-list');
const $errorMessage     = document.getElementById('error-message');
const $conflictSeatsMsg = document.getElementById('conflict-seats-msg');
const $conflictSeatsList= document.getElementById('conflict-seats-list');

const $btnHold          = document.getElementById('btn-hold');
const $btnClearSel      = document.getElementById('btn-clear-selection');
const $btnConfirm       = document.getElementById('btn-confirm');
const $btnRelease       = document.getElementById('btn-release');
const $btnNewBooking    = document.getElementById('btn-new-booking');
const $btnErrorDismiss  = document.getElementById('btn-error-dismiss');

// ─────────────────────────────────────────────────────────────────────────────
// Initialisation
// ─────────────────────────────────────────────────────────────────────────────

$sessionDisplay.textContent = SESSION_ID.slice(0, 8) + '…';

async function init() {
  try {
    const seats = await fetchSeats();
    renderSeatMap(seats);
    $seatMapLoading.style.display = 'none';
  } catch (err) {
    $seatMapLoading.textContent = 'Failed to load seat map. Is the server running?';
    console.error(err);
  }

  connectSSE();
  bindButtons();
  showPanel('idle');
}

// ─────────────────────────────────────────────────────────────────────────────
// Seat map rendering
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the full seat map DOM from an array of seat objects.
 * Groups seats by rowLabel.
 */
function renderSeatMap(seats) {
  seatMap.clear();
  $seatMap.innerHTML = '';

  // Group by row
  const rows = new Map();
  for (const seat of seats) {
    seatMap.set(seat.id, seat);
    if (!rows.has(seat.rowLabel)) rows.set(seat.rowLabel, []);
    rows.get(seat.rowLabel).push(seat);
  }

  for (const [rowLabel, rowSeats] of rows) {
    rowSeats.sort((a, b) => a.seatNumber - b.seatNumber);

    const $row = document.createElement('div');
    $row.className = 'seat-row';
    $row.dataset.row = rowLabel;

    const $label = document.createElement('div');
    $label.className = 'row-label';
    $label.textContent = rowLabel;
    $row.appendChild($label);

    for (const seat of rowSeats) {
      $row.appendChild(createSeatEl(seat));
    }

    $seatMap.appendChild($row);
  }
}

/**
 * Create a single seat button element.
 */
function createSeatEl(seat) {
  const $seat = document.createElement('button');
  $seat.className = 'seat';
  $seat.id = `seat-${seat.id}`;
  $seat.dataset.seatId = seat.id;
  $seat.textContent = seat.seatNumber;
  $seat.title = `${seat.rowLabel}${seat.seatNumber}`;
  applySeatClass($seat, seat);
  $seat.addEventListener('click', () => onSeatClick(seat.id));
  return $seat;
}

/**
 * Derive the CSS class for a seat based on its status and our local state.
 */
function getSeatClass(seat) {
  if (bookedMineIds.has(seat.id)) return 'booked-mine';
  if (selectedIds.has(seat.id))   return 'selected';

  if (seat.status === 'booked') return 'booked';

  if (seat.status === 'held') {
    if (activeHold && activeHold.seatIds.has(seat.id)) return 'held-mine';
    return 'held-other';
  }

  // available (or expired hold treated as available)
  return 'available';
}

function applySeatClass($el, seat) {
  $el.className = `seat ${getSeatClass(seat)}`;
  const cls = getSeatClass(seat);
  $el.disabled = cls === 'held-other' || cls === 'booked' || cls === 'held-mine' || cls === 'booked-mine';
}

/**
 * Update a single seat element in the DOM.
 */
function updateSeatEl(seatId) {
  const seat = seatMap.get(seatId);
  if (!seat) return;
  const $el = document.getElementById(`seat-${seatId}`);
  if (!$el) return;
  applySeatClass($el, seat);
}

// ─────────────────────────────────────────────────────────────────────────────
// Seat click handler
// ─────────────────────────────────────────────────────────────────────────────

function onSeatClick(seatId) {
  // Ignore clicks when a hold is active or booking is confirmed.
  if (activeHold) return;

  const seat = seatMap.get(seatId);
  if (!seat || seat.status !== 'available') return;

  if (selectedIds.has(seatId)) {
    selectedIds.delete(seatId);
  } else {
    selectedIds.add(seatId);
  }

  updateSeatEl(seatId);
  updateSelectionPanel();
}

function updateSelectionPanel() {
  $selectedCount.textContent = selectedIds.size;
  if (selectedIds.size > 0) {
    showPanel('selection');
  } else {
    showPanel('idle');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Button handlers
// ─────────────────────────────────────────────────────────────────────────────

function bindButtons() {
  $btnHold.addEventListener('click', onHold);
  $btnClearSel.addEventListener('click', onClearSelection);
  $btnConfirm.addEventListener('click', onConfirm);
  $btnRelease.addEventListener('click', onRelease);
  $btnNewBooking.addEventListener('click', onNewBooking);
  $btnErrorDismiss.addEventListener('click', () => {
    if (selectedIds.size > 0) showPanel('selection');
    else showPanel('idle');
  });
}

async function onHold() {
  if (selectedIds.size === 0) return;
  $btnHold.disabled = true;

  try {
    const seatIds = [...selectedIds];
    const hold = await createHold(seatIds, SESSION_ID);

    // Store active hold
    activeHold = {
      id: hold.id,
      expiresAt: new Date(hold.expiresAt),
      seatIds: new Set(hold.seats.map((s) => s.id)),
    };

    // Update local seat map
    for (const s of hold.seats) {
      seatMap.set(s.id, s);
    }

    selectedIds.clear();

    // Update DOM
    for (const s of hold.seats) updateSeatEl(s.id);

    $holdSeatsList.textContent = hold.seats
      .map((s) => `${s.rowLabel}${s.seatNumber}`)
      .join(', ');

    startCountdown();
    showPanel('hold');
  } catch (err) {
    if (err.type === 'conflict') {
      showError(
        'Some seats are no longer available.',
        err.conflictSeatIds
      );
      // Deselect conflicting seats
      for (const id of err.conflictSeatIds) {
        selectedIds.delete(id);
        const seat = seatMap.get(id);
        if (seat) updateSeatEl(id);
      }
    } else {
      showError(err.message);
    }
  } finally {
    $btnHold.disabled = false;
  }
}

function onClearSelection() {
  for (const id of selectedIds) {
    selectedIds.delete(id);
    updateSeatEl(id);
  }
  selectedIds.clear();
  showPanel('idle');
}

async function onConfirm() {
  if (!activeHold) return;
  $btnConfirm.disabled = true;

  try {
    const result = await confirmHold(activeHold.id, SESSION_ID);

    // Mark seats as booked-mine
    for (const s of result.seats) {
      bookedMineIds.add(s.id);
      seatMap.set(s.id, { ...s, status: 'booked' });
      updateSeatEl(s.id);
    }

    $bookedSeatsList.textContent = result.seats
      .map((s) => `${s.rowLabel}${s.seatNumber}`)
      .join(', ');

    stopCountdown();
    activeHold = null;
    showPanel('booked');
  } catch (err) {
    stopCountdown();
    activeHold = null;
    showError(err.message);
    // Refresh seat map to get latest state
    refreshSeats();
  } finally {
    $btnConfirm.disabled = false;
  }
}

async function onRelease() {
  if (!activeHold) return;
  $btnRelease.disabled = true;

  try {
    await releaseHold(activeHold.id, SESSION_ID);
    stopCountdown();

    // Seats will be updated via SSE; also update locally
    for (const id of activeHold.seatIds) {
      const seat = seatMap.get(id);
      if (seat) {
        seat.status = 'available';
        seat.holdId = null;
        seat.holdExpiresAt = null;
        seatMap.set(id, seat);
        updateSeatEl(id);
      }
    }

    activeHold = null;
    showPanel('idle');
  } catch (err) {
    showError(err.message);
  } finally {
    $btnRelease.disabled = false;
  }
}

function onNewBooking() {
  bookedMineIds.clear();
  // Refresh to get latest state
  refreshSeats().then(() => showPanel('idle'));
}

// ─────────────────────────────────────────────────────────────────────────────
// Countdown timer
// ─────────────────────────────────────────────────────────────────────────────

function startCountdown() {
  stopCountdown();
  updateCountdown();
  countdownInterval = setInterval(updateCountdown, 1000);
}

function stopCountdown() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
}

function updateCountdown() {
  if (!activeHold) { stopCountdown(); return; }

  const remaining = Math.max(0, Math.floor((activeHold.expiresAt - Date.now()) / 1000));
  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  $holdCountdown.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;

  if (remaining <= 10) {
    $holdCountdown.classList.add('urgent');
  } else {
    $holdCountdown.classList.remove('urgent');
  }

  if (remaining === 0) {
    stopCountdown();
    handleHoldExpired();
  }
}

function handleHoldExpired() {
  if (!activeHold) return;

  // Update local seat state
  for (const id of activeHold.seatIds) {
    const seat = seatMap.get(id);
    if (seat && seat.status === 'held') {
      seat.status = 'available';
      seat.holdId = null;
      seat.holdExpiresAt = null;
      seatMap.set(id, seat);
      updateSeatEl(id);
    }
  }

  activeHold = null;
  showError('Your hold has expired. Please select seats again.');
}

// ─────────────────────────────────────────────────────────────────────────────
// SSE – real-time updates
// ─────────────────────────────────────────────────────────────────────────────

function connectSSE() {
  setConnectionStatus('connecting');

  const es = openStream();

  es.addEventListener('connected', () => {
    setConnectionStatus('connected');
    console.log('[sse] Connected.');
  });

  es.addEventListener('seat-update', (event) => {
    try {
      const updates = JSON.parse(event.data);
      handleSeatUpdates(updates);
    } catch (err) {
      console.error('[sse] Failed to parse seat-update:', err);
    }
  });

  es.onerror = () => {
    setConnectionStatus('disconnected');
    console.warn('[sse] Connection lost. Reconnecting…');
    // EventSource reconnects automatically; update status when it does.
    es.addEventListener('connected', () => setConnectionStatus('connected'), { once: true });
  };
}

/**
 * Apply an array of seat status updates from the SSE stream.
 */
function handleSeatUpdates(updates) {
  for (const update of updates) {
    const existing = seatMap.get(update.id);
    if (!existing) continue;

    // Merge the update into our local seat map.
    const updated = {
      ...existing,
      status: update.status,
      holdId: update.holdId ?? null,
      holdExpiresAt: update.holdExpiresAt ?? null,
      bookedBy: update.bookedBy ?? null,
    };
    seatMap.set(update.id, updated);

    // If this seat was in our active hold and it's now available (expired /
    // released by server), clear the hold.
    if (
      activeHold &&
      activeHold.seatIds.has(update.id) &&
      update.status === 'available'
    ) {
      // The server released our hold (e.g. sweep ran).
      stopCountdown();
      activeHold = null;
      showPanel('idle');
    }

    // Remove from selection if it's no longer available.
    if (update.status !== 'available' && selectedIds.has(update.id)) {
      selectedIds.delete(update.id);
      updateSelectionPanel();
    }

    updateSeatEl(update.id);
  }
}

function setConnectionStatus(state) {
  $connStatus.className = `status-dot ${state}`;
  $connStatus.title = `SSE: ${state}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Panel management
// ─────────────────────────────────────────────────────────────────────────────

const panels = {
  idle:      $panelIdle,
  selection: $panelSelection,
  hold:      $panelHold,
  booked:    $panelBooked,
  error:     $panelError,
};

function showPanel(name) {
  for (const [key, el] of Object.entries(panels)) {
    el.classList.toggle('hidden', key !== name);
  }
}

function showError(message, conflictIds = []) {
  $errorMessage.textContent = message;

  if (conflictIds.length > 0) {
    $conflictSeatsMsg.classList.remove('hidden');
    $conflictSeatsList.textContent = conflictIds.join(', ');
  } else {
    $conflictSeatsMsg.classList.add('hidden');
  }

  showPanel('error');
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function refreshSeats() {
  try {
    const seats = await fetchSeats();
    for (const seat of seats) {
      seatMap.set(seat.id, seat);
    }
    // Re-render the whole map to pick up any changes.
    renderSeatMap(seats);
  } catch (err) {
    console.error('[refreshSeats]', err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────────────────────

init();
