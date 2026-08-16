/**
 * Main application entry point.
 *
 * Responsibilities:
 *  - Manage application state (seats, selection, active hold, booking).
 *  - Render the seat map and action panel.
 *  - Handle user interactions (select, hold, confirm, release).
 *  - Connect to the SSE stream and apply live updates.
 */

import { api } from './api.js';
import { getSessionId } from './session.js';
import { renderSeatMap, updateSeat } from './seatMap.js';

// ── State ──────────────────────────────────────────────────────────────────
const SESSION_ID = getSessionId();

/** @type {Map<string, object>} seatId → seat object */
const seats = new Map();

/** @type {Set<string>} */
const selectedIds = new Set();

/** @type {{ holdId: string, seatIds: string[], expiresAt: string } | null} */
let activeHold = null;

/** @type {Set<string>} seat ids booked by this session */
const bookedIds = new Set();

let countdownTimer = null;

// ── DOM refs ───────────────────────────────────────────────────────────────
const sessionDisplay   = document.getElementById('session-id-display');
const seatMapLoading   = document.getElementById('seat-map-loading');
const btnHold          = document.getElementById('btn-hold');
const btnConfirm       = document.getElementById('btn-confirm');
const btnRelease       = document.getElementById('btn-release');
const btnNewBooking    = document.getElementById('btn-new-booking');
const btnErrorDismiss  = document.getElementById('btn-error-dismiss');
const selectionInfo    = document.getElementById('selection-info');
const holdSeatList     = document.getElementById('hold-seat-list');
const holdCountdown    = document.getElementById('hold-countdown');
const bookedSeatList   = document.getElementById('booked-seat-list');
const errorMessage     = document.getElementById('error-message');
const errorDetail      = document.getElementById('error-detail');
const connectionDot    = document.getElementById('connection-status');

const panelSelect  = document.getElementById('panel-select');
const panelHold    = document.getElementById('panel-hold');
const panelBooked  = document.getElementById('panel-booked');
const panelError   = document.getElementById('panel-error');

// ── Helpers ────────────────────────────────────────────────────────────────
function getState() {
  return { selectedIds, activeHold, bookedIds, sessionId: SESSION_ID };
}

function updateInventory() {
  let available = 0, held = 0, booked = 0;
  for (const seat of seats.values()) {
    if (seat.status === 'available') available++;
    else if (seat.status === 'held') held++;
    else if (seat.status === 'booked') booked++;
  }
  document.getElementById('inv-available').textContent = available;
  document.getElementById('inv-held').textContent = held;
  document.getElementById('inv-booked').textContent = booked;
  document.getElementById('inv-total').textContent = seats.size;
}

function showPanel(name) {
  panelSelect.classList.toggle('hidden', name !== 'select');
  panelHold.classList.toggle('hidden', name !== 'hold');
  panelBooked.classList.toggle('hidden', name !== 'booked');
  panelError.classList.toggle('hidden', name !== 'error');
}

function showError(msg, detail = '') {
  errorMessage.textContent = msg;
  errorDetail.textContent = detail;
  showPanel('error');
}

function formatCountdown(ms) {
  if (ms <= 0) return '0s';
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function startCountdown(expiresAt) {
  if (countdownTimer) clearInterval(countdownTimer);
  const tick = () => {
    const remaining = new Date(expiresAt) - Date.now();
    holdCountdown.textContent = formatCountdown(remaining);
    if (remaining <= 0) {
      clearInterval(countdownTimer);
      countdownTimer = null;
      // Hold expired – reset UI
      handleHoldExpired();
    }
  };
  tick();
  countdownTimer = setInterval(tick, 500);
}

function stopCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

// ── Seat click handler ─────────────────────────────────────────────────────
function onSeatClick(seatId) {
  // Ignore clicks when a hold is active or booking is done.
  if (activeHold || panelBooked.classList.contains('hidden') === false) return;

  const seat = seats.get(seatId);
  if (!seat || seat.status !== 'available') return;

  if (selectedIds.has(seatId)) {
    selectedIds.delete(seatId);
  } else {
    selectedIds.add(seatId);
  }

  // Update just this seat element.
  updateSeat(seat, getState(), onSeatClick);

  // Update selection info.
  const count = selectedIds.size;
  selectionInfo.textContent =
    count === 0
      ? 'Click available seats to select them.'
      : `${count} seat${count > 1 ? 's' : ''} selected.`;
  btnHold.disabled = count === 0;
}

// ── Hold flow ──────────────────────────────────────────────────────────────
async function requestHold() {
  if (selectedIds.size === 0) return;
  btnHold.disabled = true;

  try {
    const seatIds = [...selectedIds];
    const data = await api.createHold(seatIds, SESSION_ID);

    activeHold = {
      holdId: data.holdId,
      seatIds: data.seats.map((s) => s.id),
      expiresAt: data.expiresAt,
    };

    // Update local seat state.
    for (const s of data.seats) {
      seats.set(s.id, s);
    }
    selectedIds.clear();

    // Re-render affected seats.
    for (const s of data.seats) {
      updateSeat(s, getState(), onSeatClick);
    }
    updateInventory();

    // Show hold panel.
    holdSeatList.textContent = activeHold.seatIds.join(', ');
    startCountdown(activeHold.expiresAt);
    showPanel('hold');
  } catch (err) {
    btnHold.disabled = selectedIds.size === 0;
    if (err.status === 409) {
      const conflicting = err.data?.conflictingSeats ?? [];
      showError(
        '⚠️ Some seats are no longer available.',
        conflicting.length > 0 ? `Taken: ${conflicting.join(', ')}` : ''
      );
      // Refresh seat map so the user sees the current state.
      await loadSeats();
    } else {
      showError('Failed to place hold.', err.message);
    }
  }
}

async function confirmHold() {
  if (!activeHold) return;
  btnConfirm.disabled = true;
  btnRelease.disabled = true;

  try {
    const data = await api.confirmHold(activeHold.holdId, SESSION_ID);

    stopCountdown();

    // Mark seats as booked locally.
    for (const s of data.seats) {
      seats.set(s.id, s);
      bookedIds.add(s.id);
    }
    activeHold = null;

    for (const s of data.seats) {
      updateSeat(s, getState(), onSeatClick);
    }
    updateInventory();

    bookedSeatList.textContent = data.seats.map((s) => s.id).join(', ');
    showPanel('booked');
  } catch (err) {
    btnConfirm.disabled = false;
    btnRelease.disabled = false;
    if (err.status === 410) {
      showError('Hold has expired.', 'Please select seats again.');
      handleHoldExpired();
    } else {
      showError('Failed to confirm booking.', err.message);
    }
  }
}

async function releaseHold() {
  if (!activeHold) return;
  btnRelease.disabled = true;
  btnConfirm.disabled = true;

  try {
    await api.releaseHold(activeHold.holdId, SESSION_ID);
    stopCountdown();
    const releasedSeatIds = activeHold.seatIds;
    activeHold = null;

    // Update local state.
    for (const id of releasedSeatIds) {
      const seat = seats.get(id);
      if (seat) {
        seat.status = 'available';
        seat.holdId = null;
        seat.holdExpiresAt = null;
        updateSeat(seat, getState(), onSeatClick);
      }
    }
    updateInventory();
    resetToSelectPanel();
  } catch (err) {
    btnRelease.disabled = false;
    btnConfirm.disabled = false;
    showError('Failed to release hold.', err.message);
  }
}

function handleHoldExpired() {
  if (!activeHold) return;
  const expiredSeatIds = activeHold.seatIds;
  stopCountdown();
  activeHold = null;

  // Reset those seats to available locally (server will have done the same).
  for (const id of expiredSeatIds) {
    const seat = seats.get(id);
    if (seat && seat.status === 'held') {
      seat.status = 'available';
      seat.holdId = null;
      seat.holdExpiresAt = null;
      updateSeat(seat, getState(), onSeatClick);
    }
  }
  updateInventory();
  showError('Your hold has expired.', 'Please select seats again.');
}

function resetToSelectPanel() {
  selectedIds.clear();
  selectionInfo.textContent = 'Click available seats to select them.';
  btnHold.disabled = true;
  showPanel('select');
}

// ── Load seats ─────────────────────────────────────────────────────────────
async function loadSeats() {
  seatMapLoading.classList.remove('hidden');
  try {
    const data = await api.getSeats();
    seats.clear();
    for (const s of data.seats) {
      seats.set(s.id, s);
    }
    renderSeatMap(data.seats, getState(), onSeatClick);
    updateInventory();
  } catch (err) {
    console.error('Failed to load seats:', err);
  } finally {
    seatMapLoading.classList.add('hidden');
  }
}

// ── SSE ────────────────────────────────────────────────────────────────────
function connectSSE() {
  connectionDot.className = 'status-dot connecting';

  const es = new EventSource('/api/stream');

  es.addEventListener('connected', () => {
    connectionDot.className = 'status-dot connected';
  });

  es.addEventListener('seats:held', (e) => {
    const { holdId, seats: updatedSeats } = JSON.parse(e.data);
    for (const s of updatedSeats) {
      // Don't overwrite our own hold data (we already applied it).
      if (activeHold && activeHold.holdId === holdId) continue;
      seats.set(s.id, s);
      // If the user had this seat selected, deselect it – it's no longer available.
      if (selectedIds.has(s.id)) {
        selectedIds.delete(s.id);
        const count = selectedIds.size;
        selectionInfo.textContent =
          count === 0
            ? 'Click available seats to select them.'
            : `${count} seat${count > 1 ? 's' : ''} selected.`;
        btnHold.disabled = count === 0;
      }
      updateSeat(s, getState(), onSeatClick);
    }
    updateInventory();
  });

  es.addEventListener('seats:booked', (e) => {
    const { seats: updatedSeats } = JSON.parse(e.data);
    for (const s of updatedSeats) {
      seats.set(s.id, s);
      // Deselect if somehow selected (shouldn't happen but be safe).
      selectedIds.delete(s.id);
      updateSeat(s, getState(), onSeatClick);
    }
    updateInventory();
  });

  es.addEventListener('seats:released', (e) => {
    const { seats: releasedSeats } = JSON.parse(e.data);
    for (const s of releasedSeats) {
      const existing = seats.get(s.id);
      if (existing) {
        existing.status = 'available';
        existing.holdId = null;
        existing.holdExpiresAt = null;
        updateSeat(existing, getState(), onSeatClick);
      }
    }
    updateInventory();
  });

  es.onerror = () => {
    connectionDot.className = 'status-dot disconnected';
    es.close();
    // Reconnect after 3 s.
    setTimeout(connectSSE, 3000);
  };
}

// ── Event listeners ────────────────────────────────────────────────────────
btnHold.addEventListener('click', requestHold);
btnConfirm.addEventListener('click', confirmHold);
btnRelease.addEventListener('click', releaseHold);
btnNewBooking.addEventListener('click', () => {
  showPanel('select');
  resetToSelectPanel();
});
btnErrorDismiss.addEventListener('click', () => {
  // If we had an active hold that expired, go back to select.
  if (!activeHold) {
    resetToSelectPanel();
  } else {
    showPanel('hold');
  }
});

// ── Boot ───────────────────────────────────────────────────────────────────
sessionDisplay.textContent = SESSION_ID.slice(0, 8) + '…';
showPanel('select');
connectSSE();
loadSeats();
