/**
 * Main application entry point.
 *
 * State machine:
 *   idle  →  selecting  →  holding  →  booked
 *                ↑____________↓ (release / expiry)
 */

import { api } from './api.js';
import { getSessionId } from './session.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const SESSION_ID = getSessionId();

/** @type {'idle'|'selecting'|'holding'|'booked'} */
let appState = 'idle';

/** @type {Map<string, object>} seatId → seat object */
let seatMap = new Map();

/** @type {Set<string>} currently selected seat ids */
let selectedIds = new Set();

/** Active hold metadata */
let activeHold = null; // { id, expiresAt, seatIds }

/** Countdown interval handle */
let countdownInterval = null;

/** Notification auto-hide handle */
let notifTimeout = null;

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const $seatMap         = document.getElementById('seat-map');
const $panelIdle       = document.getElementById('panel-idle');
const $panelSelect     = document.getElementById('panel-select');
const $panelHold       = document.getElementById('panel-hold');
const $panelBooked     = document.getElementById('panel-booked');
const $selectionInfo   = document.getElementById('selection-info');
const $holdSeatsLabel  = document.getElementById('hold-seats-label');
const $bookedSeatsLabel = document.getElementById('booked-seats-label');
const $countdown       = document.getElementById('countdown');
const $notification    = document.getElementById('notification');

const $btnHold       = document.getElementById('btn-hold');
const $btnClear      = document.getElementById('btn-clear');
const $btnConfirm    = document.getElementById('btn-confirm');
const $btnRelease    = document.getElementById('btn-release');
const $btnNewBooking = document.getElementById('btn-new-booking');

// ---------------------------------------------------------------------------
// Notification helper
// ---------------------------------------------------------------------------

function notify(message, type = 'info', duration = 5000) {
  clearTimeout(notifTimeout);
  $notification.textContent = message;
  $notification.className = `notification ${type}`;
  if (duration > 0) {
    notifTimeout = setTimeout(() => {
      $notification.className = 'notification hidden';
    }, duration);
  }
}

// ---------------------------------------------------------------------------
// Panel management
// ---------------------------------------------------------------------------

function showPanel(name) {
  for (const el of [$panelIdle, $panelSelect, $panelHold, $panelBooked]) {
    el.classList.add('hidden');
  }
  const panels = {
    idle:      $panelIdle,
    selecting: $panelSelect,
    holding:   $panelHold,
    booked:    $panelBooked,
  };
  const target = panels[name];
  if (target) target.classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// Seat rendering
// ---------------------------------------------------------------------------

/**
 * Determine the CSS class for a seat given the current app state.
 * @param {object} seat
 * @returns {string}
 */
function seatClass(seat) {
  const id = seat.id;

  // If we have an active hold and this seat belongs to it → held-own
  if (activeHold && activeHold.seatIds.includes(id)) {
    return 'held-own';
  }

  // If the seat is selected by the user
  if (selectedIds.has(id)) return 'selected';

  switch (seat.status) {
    case 'available': return 'available';
    case 'held':      return 'held-other';
    case 'booked':    return 'booked';
    default:          return 'available';
  }
}

function buildSeatMap(seats) {
  // Group by row.
  const rows = new Map();
  for (const seat of seats) {
    if (!rows.has(seat.rowLabel)) rows.set(seat.rowLabel, []);
    rows.get(seat.rowLabel).push(seat);
  }

  $seatMap.innerHTML = '';

  for (const [rowLabel, rowSeats] of rows) {
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';
    rowEl.dataset.row = rowLabel;

    const labelEl = document.createElement('div');
    labelEl.className = 'row-label';
    labelEl.textContent = rowLabel;
    rowEl.appendChild(labelEl);

    const seatsEl = document.createElement('div');
    seatsEl.className = 'seats-in-row';

    for (const seat of rowSeats.sort((a, b) => a.seatNumber - b.seatNumber)) {
      const btn = document.createElement('button');
      btn.className = `seat ${seatClass(seat)}`;
      btn.dataset.seatId = seat.id;
      btn.textContent = String(seat.seatNumber);
      btn.title = `${seat.rowLabel}${seat.seatNumber} – ${seat.status}`;
      btn.setAttribute('aria-label', `Seat ${seat.rowLabel}${seat.seatNumber}`);
      btn.addEventListener('click', () => onSeatClick(seat.id));
      seatsEl.appendChild(btn);
    }

    rowEl.appendChild(seatsEl);
    $seatMap.appendChild(rowEl);
  }
}

/**
 * Update a single seat button's appearance without rebuilding the whole map.
 * @param {string} seatId
 */
function refreshSeatButton(seatId) {
  const seat = seatMap.get(seatId);
  if (!seat) return;
  const btn = $seatMap.querySelector(`[data-seat-id="${seatId}"]`);
  if (!btn) return;
  btn.className = `seat ${seatClass(seat)}`;
  btn.title = `${seat.rowLabel}${seat.seatNumber} – ${seat.status}`;
}

// ---------------------------------------------------------------------------
// Seat click handler
// ---------------------------------------------------------------------------

function onSeatClick(seatId) {
  // Only allow selection in idle / selecting states.
  if (appState !== 'idle' && appState !== 'selecting') return;

  const seat = seatMap.get(seatId);
  if (!seat) return;

  // Only available seats can be selected.
  if (seat.status !== 'available') return;

  if (selectedIds.has(seatId)) {
    selectedIds.delete(seatId);
  } else {
    selectedIds.add(seatId);
  }

  refreshSeatButton(seatId);
  updateSelectionPanel();
}

function updateSelectionPanel() {
  if (selectedIds.size === 0) {
    appState = 'idle';
    showPanel('idle');
  } else {
    appState = 'selecting';
    const ids = [...selectedIds].join(', ');
    $selectionInfo.textContent = `${selectedIds.size} seat(s) selected: ${ids}`;
    showPanel('selecting');
  }
}

// ---------------------------------------------------------------------------
// Hold flow
// ---------------------------------------------------------------------------

async function onHoldClick() {
  if (selectedIds.size === 0) return;
  $btnHold.disabled = true;

  try {
    const result = await api.createHold([...selectedIds], SESSION_ID);
    const { hold } = result;

    activeHold = {
      id: hold.id,
      expiresAt: new Date(hold.expiresAt),
      seatIds: hold.seatIds,
    };

    // Update local seat state.
    for (const seatId of hold.seatIds) {
      const seat = seatMap.get(seatId);
      if (seat) {
        seat.status = 'held';
        seat.holdId = hold.id;
        seat.holdExpiresAt = hold.expiresAt;
      }
    }

    selectedIds.clear();
    appState = 'holding';

    // Rebuild the map to reflect the new state.
    buildSeatMap([...seatMap.values()]);
    showHoldPanel();

    const remaining = Math.round((activeHold.expiresAt - Date.now()) / 1000);
    notify(`Hold placed! You have ${remaining}s to confirm.`, 'success');
  } catch (err) {
    if (err.status === 409 && err.data?.conflictingSeats) {
      const conflicting = err.data.conflictingSeats;
      notify(`Seats already taken: ${conflicting.join(', ')}. Please choose different seats.`, 'error');

      // Highlight conflicting seats briefly.
      for (const id of conflicting) {
        const btn = $seatMap.querySelector(`[data-seat-id="${id}"]`);
        if (btn) {
          btn.classList.add('conflict');
          setTimeout(() => btn.classList.remove('conflict'), 600);
        }
        // Remove from selection.
        selectedIds.delete(id);
      }
      updateSelectionPanel();
      // Refresh seat data from server.
      await loadSeats();
    } else {
      notify(`Failed to place hold: ${err.message}`, 'error');
    }
  } finally {
    $btnHold.disabled = false;
  }
}

function showHoldPanel() {
  const ids = activeHold.seatIds.join(', ');
  $holdSeatsLabel.textContent = `Holding: ${ids}`;
  showPanel('holding');
  startCountdown();
}

function startCountdown() {
  clearInterval(countdownInterval);
  countdownInterval = setInterval(() => {
    if (!activeHold) {
      clearInterval(countdownInterval);
      return;
    }
    const remaining = Math.max(0, Math.floor((activeHold.expiresAt - Date.now()) / 1000));
    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    $countdown.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
    $countdown.classList.toggle('urgent', remaining <= 10);

    if (remaining === 0) {
      clearInterval(countdownInterval);
      onHoldExpired();
    }
  }, 500);
}

function onHoldExpired() {
  notify('Your hold has expired. The seats are now available again.', 'error', 8000);
  activeHold = null;
  appState = 'idle';
  showPanel('idle');
  loadSeats();
}

// ---------------------------------------------------------------------------
// Confirm flow
// ---------------------------------------------------------------------------

async function onConfirmClick() {
  if (!activeHold) return;
  $btnConfirm.disabled = true;

  try {
    const result = await api.confirmHold(activeHold.id, SESSION_ID);

    // Update local seat state.
    for (const seatId of result.seatIds) {
      const seat = seatMap.get(seatId);
      if (seat) {
        seat.status = 'booked';
        seat.holdId = null;
        seat.holdExpiresAt = null;
        seat.bookedBy = result.holdId;
      }
    }

    clearInterval(countdownInterval);
    const bookedIds = result.seatIds.join(', ');
    $bookedSeatsLabel.textContent = `Booked seats: ${bookedIds}`;

    activeHold = null;
    appState = 'booked';
    buildSeatMap([...seatMap.values()]);
    showPanel('booked');
    notify('Booking confirmed! Enjoy the show! 🎉', 'success', 0);
  } catch (err) {
    if (err.status === 410) {
      notify('Hold expired before confirmation. Please start over.', 'error');
      activeHold = null;
      appState = 'idle';
      showPanel('idle');
      await loadSeats();
    } else {
      notify(`Confirmation failed: ${err.message}`, 'error');
    }
  } finally {
    $btnConfirm.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Release flow
// ---------------------------------------------------------------------------

async function onReleaseClick() {
  if (!activeHold) return;
  $btnRelease.disabled = true;

  try {
    await api.releaseHold(activeHold.id, SESSION_ID);

    // Update local seat state.
    for (const seatId of activeHold.seatIds) {
      const seat = seatMap.get(seatId);
      if (seat) {
        seat.status = 'available';
        seat.holdId = null;
        seat.holdExpiresAt = null;
      }
    }

    clearInterval(countdownInterval);
    activeHold = null;
    appState = 'idle';
    buildSeatMap([...seatMap.values()]);
    showPanel('idle');
    notify('Hold released. Seats are available again.', 'info');
  } catch (err) {
    notify(`Release failed: ${err.message}`, 'error');
  } finally {
    $btnRelease.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// New booking
// ---------------------------------------------------------------------------

function onNewBookingClick() {
  appState = 'idle';
  selectedIds.clear();
  $notification.className = 'notification hidden';
  showPanel('idle');
}

// ---------------------------------------------------------------------------
// Load seats
// ---------------------------------------------------------------------------

async function loadSeats() {
  try {
    $seatMap.innerHTML = '<div class="seat-map-loading">Loading seat map…</div>';
    const { seats } = await api.getSeats();

    seatMap.clear();
    for (const seat of seats) seatMap.set(seat.id, seat);

    buildSeatMap(seats);
  } catch (err) {
    $seatMap.innerHTML = '<div class="seat-map-loading">Failed to load seats. Please refresh.</div>';
    console.error('Failed to load seats:', err);
  }
}

// ---------------------------------------------------------------------------
// SSE – real-time updates
// ---------------------------------------------------------------------------

function connectSSE() {
  const es = new EventSource('/api/stream');

  es.addEventListener('connected', () => {
    console.log('[sse] Connected.');
  });

  es.addEventListener('seat-update', (e) => {
    try {
      const { type, seats } = JSON.parse(e.data);
      handleSeatUpdate(type, seats);
    } catch (parseErr) {
      console.error('[sse] Parse error:', parseErr);
    }
  });

  es.onerror = () => {
    console.warn('[sse] Connection lost, will reconnect automatically…');
    // EventSource reconnects automatically.
  };
}

/**
 * Apply a seat-status update received via SSE.
 *
 * @param {'held'|'booked'|'released'} type
 * @param {Array<{id:string, status:string, holdId?:string, bookedBy?:string, holdExpiresAt?:string}>} seats
 */
function handleSeatUpdate(type, seats) {
  let changed = false;

  for (const update of seats) {
    const seat = seatMap.get(update.id);
    if (!seat) continue;

    // Don't overwrite our own hold with an SSE echo.
    if (type === 'held' && activeHold && activeHold.seatIds.includes(update.id)) {
      continue;
    }

    const newStatus = update.status;
    if (seat.status !== newStatus) {
      seat.status = newStatus;
      seat.holdId = update.holdId ?? null;
      seat.holdExpiresAt = update.holdExpiresAt ?? null;
      seat.bookedBy = update.bookedBy ?? null;
      changed = true;

      // If one of our held seats was released by the server (expiry), handle it.
      if (type === 'released' && activeHold && activeHold.seatIds.includes(update.id)) {
        clearInterval(countdownInterval);
        activeHold = null;
        appState = 'idle';
        showPanel('idle');
        notify('Your hold expired and seats were released.', 'error', 8000);
      }
    }

    // Remove from selection if it's no longer available.
    if (newStatus !== 'available') {
      selectedIds.delete(update.id);
    }

    refreshSeatButton(update.id);
  }

  if (changed && appState === 'selecting') {
    updateSelectionPanel();
  }
}

// ---------------------------------------------------------------------------
// Wire up buttons
// ---------------------------------------------------------------------------

$btnHold.addEventListener('click', onHoldClick);
$btnClear.addEventListener('click', () => {
  selectedIds.clear();
  appState = 'idle';
  buildSeatMap([...seatMap.values()]);
  showPanel('idle');
});
$btnConfirm.addEventListener('click', onConfirmClick);
$btnRelease.addEventListener('click', onReleaseClick);
$btnNewBooking.addEventListener('click', onNewBookingClick);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

showPanel('idle');
loadSeats();
connectSSE();
