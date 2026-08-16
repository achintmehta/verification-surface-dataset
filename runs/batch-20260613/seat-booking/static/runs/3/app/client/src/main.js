/**
 * Main application entry point.
 *
 * Orchestrates:
 *   - Session identity
 *   - Initial seat-map load
 *   - SSE connection for live updates
 *   - Hold / confirm / release flows
 *   - UI state machine
 */

import { getSessionId } from './session.js';
import { fetchSeats, createHold, confirmHold, releaseHold } from './api.js';
import {
  initSeatMap,
  patchSeats,
  setActiveHold,
  clearSelection,
  getSelection,
  flashConflict,
} from './seatMap.js';
import {
  showPanel,
  notify,
  clearNotification,
  startCountdown,
  stopCountdown,
  updateSelectionCount,
} from './ui.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const sessionId = getSessionId();

/** @type {{ id: string, seatIds: string[], expiresAt: string } | null} */
let activeHold = null;

/** Whether a network request is in flight (prevents double-submits). */
let busy = false;

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  try {
    const { seats } = await fetchSeats();
    initSeatMap(seats, sessionId, activeHold, onSelectionChange);
    showPanel(null);
    connectSSE();
    bindButtons();
  } catch (err) {
    console.error('[boot]', err);
    notify('Failed to load seat map. Please refresh.', 'error', 0);
  }
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

function connectSSE() {
  const es = new EventSource(`${BASE_URL}/api/stream`);

  es.addEventListener('seats:snapshot', (e) => {
    const { seats } = JSON.parse(e.data);
    initSeatMap(seats, sessionId, activeHold, onSelectionChange);
  });

  es.addEventListener('seats:held', (e) => {
    const { holdId, seatIds, expiresAt } = JSON.parse(e.data);
    patchSeats(seatIds, { status: 'held', hold_id: holdId, hold_expires_at: expiresAt }, sessionId);
  });

  es.addEventListener('seats:booked', (e) => {
    const { seatIds } = JSON.parse(e.data);
    patchSeats(seatIds, { status: 'booked', hold_id: null, hold_expires_at: null }, sessionId);
  });

  es.addEventListener('seats:released', (e) => {
    const { seatIds } = JSON.parse(e.data);
    patchSeats(seatIds, { status: 'available', hold_id: null, hold_expires_at: null }, sessionId);
  });

  es.onerror = () => {
    // EventSource auto-reconnects; just log.
    console.warn('[SSE] connection error – will retry');
  };
}

// ---------------------------------------------------------------------------
// Selection callback
// ---------------------------------------------------------------------------

function onSelectionChange(sel) {
  const count = sel.size;
  updateSelectionCount(count);

  if (count > 0 && !activeHold) {
    showPanel('hold');
  } else if (count === 0 && !activeHold) {
    showPanel(null);
  }
}

// ---------------------------------------------------------------------------
// Button bindings
// ---------------------------------------------------------------------------

function bindButtons() {
  document.getElementById('btn-hold')?.addEventListener('click', handleHold);
  document.getElementById('btn-clear')?.addEventListener('click', handleClear);
  document.getElementById('btn-confirm')?.addEventListener('click', handleConfirm);
  document.getElementById('btn-release')?.addEventListener('click', handleRelease);
  document.getElementById('btn-new-booking')?.addEventListener('click', handleNewBooking);
}

// ---------------------------------------------------------------------------
// Hold flow
// ---------------------------------------------------------------------------

async function handleHold() {
  if (busy) return;
  const seatIds = getSelection();
  if (seatIds.length === 0) return;

  busy = true;
  setButtonsDisabled(true);
  clearNotification();

  try {
    const { hold } = await createHold(seatIds, sessionId);

    activeHold = {
      id: hold.id,
      seatIds: hold.seatIds,
      expiresAt: hold.expiresAt,
    };

    // Update seat map state.
    clearSelection(sessionId);
    setActiveHold(activeHold, sessionId);

    // Update UI.
    const seatsLabel = hold.seatIds.join(', ');
    const holdSeatsEl = document.getElementById('hold-seats');
    if (holdSeatsEl) holdSeatsEl.textContent = seatsLabel;

    showPanel('active-hold');
    startCountdown(hold.expiresAt, onHoldExpired);
    notify(`Hold placed on ${hold.seatIds.length} seat(s). Confirm within the time limit.`, 'info', 5000);
  } catch (err) {
    if (err.status === 409) {
      const conflicting = err.body?.conflictingSeatIds ?? [];
      flashConflict(conflicting);
      notify(
        `${conflicting.length} seat(s) are no longer available: ${conflicting.join(', ')}. Please choose different seats.`,
        'error',
        6000,
      );
      // Refresh seat map to reflect current state.
      await refreshSeats();
    } else {
      notify(`Failed to place hold: ${err.message}`, 'error');
    }
  } finally {
    busy = false;
    setButtonsDisabled(false);
  }
}

function handleClear() {
  clearSelection(sessionId);
  showPanel(null);
  clearNotification();
}

// ---------------------------------------------------------------------------
// Confirm flow
// ---------------------------------------------------------------------------

async function handleConfirm() {
  if (busy || !activeHold) return;

  busy = true;
  setButtonsDisabled(true);
  clearNotification();

  try {
    const { booking } = await confirmHold(activeHold.id, sessionId);

    stopCountdown();

    // Update seat map.
    patchSeats(booking.seatIds, { status: 'booked', hold_id: null, hold_expires_at: null }, sessionId);
    setActiveHold(null, sessionId);
    activeHold = null;

    // Show booked panel.
    const bookedSeatsEl = document.getElementById('booked-seats');
    if (bookedSeatsEl) bookedSeatsEl.textContent = booking.seatIds.join(', ');
    showPanel('booked');
    notify('🎉 Booking confirmed!', 'success', 6000);
  } catch (err) {
    if (err.status === 410) {
      notify('Your hold has expired. Please select seats again.', 'warning', 6000);
      await handleHoldExpiredCleanup();
    } else if (err.status === 404) {
      notify('Hold not found. Please start over.', 'error', 6000);
      await handleHoldExpiredCleanup();
    } else {
      notify(`Failed to confirm booking: ${err.message}`, 'error');
    }
  } finally {
    busy = false;
    setButtonsDisabled(false);
  }
}

// ---------------------------------------------------------------------------
// Release flow
// ---------------------------------------------------------------------------

async function handleRelease() {
  if (busy || !activeHold) return;

  busy = true;
  setButtonsDisabled(true);
  clearNotification();

  try {
    await releaseHold(activeHold.id, sessionId);

    stopCountdown();
    patchSeats(activeHold.seatIds, { status: 'available', hold_id: null, hold_expires_at: null }, sessionId);
    setActiveHold(null, sessionId);
    activeHold = null;

    showPanel(null);
    notify('Hold released. Seats are available again.', 'info', 4000);
  } catch (err) {
    if (err.status === 404 || err.status === 410) {
      // Hold already expired/gone.
      await handleHoldExpiredCleanup();
    } else {
      notify(`Failed to release hold: ${err.message}`, 'error');
    }
  } finally {
    busy = false;
    setButtonsDisabled(false);
  }
}

// ---------------------------------------------------------------------------
// New booking
// ---------------------------------------------------------------------------

function handleNewBooking() {
  showPanel(null);
  clearNotification();
  // Re-render so available seats are clickable again.
  setActiveHold(null, sessionId);
}

// ---------------------------------------------------------------------------
// Hold expiry
// ---------------------------------------------------------------------------

function onHoldExpired() {
  notify('Your hold has expired. The seats are now available again.', 'warning', 8000);
  handleHoldExpiredCleanup();
}

async function handleHoldExpiredCleanup() {
  stopCountdown();
  const expiredHold = activeHold;
  activeHold = null;
  setActiveHold(null, sessionId);
  showPanel(null);

  // Refresh to get accurate server state.
  await refreshSeats();

  if (expiredHold) {
    // Optimistically mark the seats as available (server sweep will confirm).
    patchSeats(expiredHold.seatIds, { status: 'available', hold_id: null, hold_expires_at: null }, sessionId);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function refreshSeats() {
  try {
    const { seats } = await fetchSeats();
    initSeatMap(seats, sessionId, activeHold, onSelectionChange);
  } catch (err) {
    console.error('[refreshSeats]', err);
  }
}

function setButtonsDisabled(disabled) {
  const ids = ['btn-hold', 'btn-clear', 'btn-confirm', 'btn-release', 'btn-new-booking'];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) el.disabled = disabled;
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

boot();
