/**
 * main.js – Application bootstrap and event wiring.
 */

import { api }                                  from './api.js';
import { getSessionId }                         from './session.js';
import { getState, setState, subscribe,
         applySeatUpdates }                     from './store.js';
import { renderSeatMap }                        from './seatMap.js';
import {
  showNotification,
  hideNotification,
  updateInventory,
  renderActionPanel,
  startCountdown,
  stopCountdown,
} from './ui.js';
import { connectSSE } from './sse.js';

// ── Session ────────────────────────────────────────────────────────────────
const sessionId = getSessionId();
document.getElementById('session-id-display').textContent =
  sessionId.slice(0, 8) + '…';

// Expose sessionId on state so seatMap.js can read it.
setState({ sessionId });

// ── Subscribe to state changes ─────────────────────────────────────────────
subscribe(() => {
  renderSeatMap();
  renderActionPanel();
  updateInventory();
});

// ── Button wiring ──────────────────────────────────────────────────────────
document.getElementById('btn-hold').addEventListener('click', handleHold);
document.getElementById('btn-clear-selection').addEventListener('click', clearSelection);
document.getElementById('btn-confirm').addEventListener('click', handleConfirm);
document.getElementById('btn-release').addEventListener('click', handleRelease);
document.getElementById('btn-new-booking').addEventListener('click', resetBooking);

// ── Hold expiry watcher ────────────────────────────────────────────────────
// Polls every second; if our active hold has expired, clears it and notifies.
let expiryWatcher = null;

function startExpiryWatcher(expiresAt) {
  stopExpiryWatcher();
  expiryWatcher = setInterval(() => {
    if (new Date(expiresAt) <= new Date()) {
      stopExpiryWatcher();
      const { activeHold } = getState();
      if (activeHold) {
        showNotification('warning', '⏰ Your hold has expired. The seats are now available again.');
        setState({ activeHold: null, selectedIds: new Set() });
        stopCountdown();
      }
    }
  }, 1000);
}

function stopExpiryWatcher() {
  if (expiryWatcher) { clearInterval(expiryWatcher); expiryWatcher = null; }
}

// ── Actions ────────────────────────────────────────────────────────────────

async function handleHold() {
  const { selectedIds } = getState();
  if (selectedIds.size === 0) return;

  const seatIds = [...selectedIds];
  setState({ loading: true });
  document.getElementById('btn-hold').disabled = true;

  try {
    const hold = await api.createHold(seatIds, sessionId);

    // Update seat statuses locally.
    applySeatUpdates(hold.seatIds, 'held', { expiresAt: hold.expiresAt });

    setState({
      loading:     false,
      selectedIds: new Set(),
      activeHold:  hold,
    });

    startCountdown(hold.expiresAt);
    startExpiryWatcher(hold.expiresAt);
    showNotification('info', `✋ Hold placed on ${hold.seatIds.join(', ')}. Confirm within the countdown.`);
  } catch (err) {
    setState({ loading: false });
    document.getElementById('btn-hold').disabled = false;

    if (err.status === 409) {
      const conflicting = err.data?.conflicting ?? [];
      showNotification(
        'error',
        `❌ Seats already taken: ${conflicting.join(', ')}. Please choose different seats.`,
        8000
      );
      // Refresh seat map to show current state.
      await loadSeats();
    } else {
      showNotification('error', `❌ Failed to place hold: ${err.message}`);
    }
  }
}

async function handleConfirm() {
  const { activeHold } = getState();
  if (!activeHold) return;

  document.getElementById('btn-confirm').disabled = true;
  document.getElementById('btn-release').disabled = true;

  try {
    const booking = await api.confirmHold(activeHold.id, sessionId);

    // Update seat statuses locally.
    applySeatUpdates(booking.seatIds, 'booked', { holdId: booking.holdId });

    stopCountdown();
    stopExpiryWatcher();

    setState({
      activeHold: null,
      booking,
    });

    showNotification('success', `🎉 Booking confirmed for seats: ${booking.seatIds.join(', ')}`, 0);
  } catch (err) {
    document.getElementById('btn-confirm').disabled = false;
    document.getElementById('btn-release').disabled = false;

    if (err.status === 410 || err.status === 404) {
      showNotification('error', `❌ Hold expired or not found. Please try again.`);
      stopCountdown();
      stopExpiryWatcher();
      setState({ activeHold: null, selectedIds: new Set() });
      await loadSeats();
    } else {
      showNotification('error', `❌ Confirmation failed: ${err.message}`);
    }
  }
}

async function handleRelease() {
  const { activeHold } = getState();
  if (!activeHold) return;

  document.getElementById('btn-confirm').disabled = true;
  document.getElementById('btn-release').disabled = true;

  try {
    await api.releaseHold(activeHold.id, sessionId);

    // Update seat statuses locally.
    applySeatUpdates(activeHold.seatIds, 'available', {});

    stopCountdown();
    stopExpiryWatcher();

    setState({ activeHold: null, selectedIds: new Set() });
    showNotification('info', `🔓 Hold released. Seats are available again.`);
  } catch (err) {
    document.getElementById('btn-confirm').disabled = false;
    document.getElementById('btn-release').disabled = false;

    if (err.status === 404) {
      // Hold already gone (expired server-side).
      stopCountdown();
      stopExpiryWatcher();
      setState({ activeHold: null, selectedIds: new Set() });
      await loadSeats();
    } else {
      showNotification('error', `❌ Release failed: ${err.message}`);
    }
  }
}

function clearSelection() {
  setState({ selectedIds: new Set() });
}

function resetBooking() {
  setState({ booking: null, selectedIds: new Set() });
  hideNotification();
}

// ── Initial data load ──────────────────────────────────────────────────────

async function loadSeats() {
  try {
    const seats = await api.getSeats();
    setState({ seats });
  } catch (err) {
    showNotification('error', `❌ Failed to load seats: ${err.message}`);
  }
}

// ── Boot ───────────────────────────────────────────────────────────────────

async function boot() {
  await loadSeats();
  connectSSE(sessionId);
}

boot();
