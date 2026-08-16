/**
 * Seat Booking – main frontend application.
 *
 * State machine:
 *   idle        → user selects seats → selecting
 *   selecting   → user clicks "Hold" → holding (API call)
 *   holding     → success → active-hold
 *   active-hold → confirm → booked | expired → idle
 *   active-hold → release → idle
 *   booked      → "new booking" → idle
 */

import { api } from './api.js';
import { getSessionId } from './session.js';

const SESSION_ID = getSessionId();
// Empty string = use Vite proxy (relative URLs); set VITE_API_BASE for production
const API_BASE = import.meta.env.VITE_API_BASE ?? '';

// ─── State ────────────────────────────────────────────────────
let seats = [];           // full seat list from server
let selectedSeatIds = new Set();  // seats the user has clicked
let activeHold = null;    // { holdId, seatIds, expiresAt }
let bookedSeatIds = [];   // seats confirmed in this session
let countdownTimer = null;

// ─── DOM refs ─────────────────────────────────────────────────
const seatMap          = document.getElementById('seat-map');
const holdPanel        = document.getElementById('hold-panel');
const activeHoldPanel  = document.getElementById('active-hold-panel');
const bookedPanel      = document.getElementById('booked-panel');
const errorPanel       = document.getElementById('error-panel');
const idleHint         = document.getElementById('idle-hint');

const selectedSeatsList = document.getElementById('selected-seats-list');
const holdSeatsList     = document.getElementById('hold-seats-list');
const bookedSeatsList   = document.getElementById('booked-seats-list');
const holdCountdown     = document.getElementById('hold-countdown');
const errorMessage      = document.getElementById('error-message');
const errorConflict     = document.getElementById('error-conflict-seats');

const btnHold           = document.getElementById('btn-hold');
const btnClearSelection = document.getElementById('btn-clear-selection');
const btnConfirm        = document.getElementById('btn-confirm');
const btnRelease        = document.getElementById('btn-release');
const btnNewBooking     = document.getElementById('btn-new-booking');
const btnDismissError   = document.getElementById('btn-dismiss-error');

const countAvailable    = document.getElementById('count-available');
const countHeld         = document.getElementById('count-held');
const countBooked       = document.getElementById('count-booked');
const countTotal        = document.getElementById('count-total');

const sseStatus         = document.getElementById('sse-status');
const sseLabel          = document.getElementById('sse-label');
const sessionDisplay    = document.getElementById('session-id-display');

// ─── Init ─────────────────────────────────────────────────────
sessionDisplay.textContent = SESSION_ID.slice(0, 8) + '…';

async function init() {
  await loadSeats();
  connectSSE();
}

// ─── Load seats ───────────────────────────────────────────────
async function loadSeats() {
  try {
    seats = await api.getSeats();
    renderSeatMap();
    updateInventory();
  } catch (err) {
    console.error('Failed to load seats:', err);
    showError('Failed to load seat map. Please refresh.');
  }
}

// ─── Seat map rendering ───────────────────────────────────────
function renderSeatMap() {
  seatMap.innerHTML = '';

  // Group by row
  const rows = {};
  for (const seat of seats) {
    if (!rows[seat.row_label]) rows[seat.row_label] = [];
    rows[seat.row_label].push(seat);
  }

  for (const [rowLabel, rowSeats] of Object.entries(rows)) {
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';
    rowEl.setAttribute('role', 'group');
    rowEl.setAttribute('aria-label', `Row ${rowLabel}`);

    const labelEl = document.createElement('div');
    labelEl.className = 'row-label';
    labelEl.textContent = rowLabel;
    rowEl.appendChild(labelEl);

    for (const seat of rowSeats.sort((a, b) => a.seat_number - b.seat_number)) {
      rowEl.appendChild(createSeatEl(seat));
    }

    seatMap.appendChild(rowEl);
  }
}

function createSeatEl(seat) {
  const el = document.createElement('button');
  el.className = 'seat';
  el.id = `seat-${seat.id}`;
  el.setAttribute('role', 'listitem');
  el.setAttribute('aria-label', `Seat ${seat.id}`);
  el.textContent = seat.seat_number;

  applySeatClass(el, seat);

  el.addEventListener('click', () => onSeatClick(seat.id));
  return el;
}

function applySeatClass(el, seat) {
  // Remove all status classes
  el.classList.remove('available', 'held', 'booked', 'selected', 'mine-held', 'mine-booked', 'loading');

  const isSelected = selectedSeatIds.has(seat.id);
  const isMineHeld = activeHold && activeHold.seatIds.includes(seat.id);
  const isMineBooked = bookedSeatIds.includes(seat.id);

  if (isMineBooked) {
    el.classList.add('mine-booked');
    el.disabled = true;
    el.title = 'Booked by you';
  } else if (isMineHeld) {
    el.classList.add('mine-held');
    el.disabled = true;
    el.title = 'Held by you';
  } else if (isSelected) {
    el.classList.add('selected');
    el.disabled = false;
    el.title = 'Selected – click to deselect';
  } else if (seat.status === 'available') {
    el.classList.add('available');
    el.disabled = false;
    el.title = `Seat ${seat.id} – click to select`;
  } else if (seat.status === 'held') {
    el.classList.add('held');
    el.disabled = true;
    el.title = 'Held by another user';
  } else if (seat.status === 'booked') {
    el.classList.add('booked');
    el.disabled = true;
    el.title = 'Already booked';
  }
}

function updateSeatEl(seatId) {
  const seat = seats.find((s) => s.id === seatId);
  if (!seat) return;
  const el = document.getElementById(`seat-${seatId}`);
  if (!el) return;
  applySeatClass(el, seat);
}

// ─── Inventory counts ─────────────────────────────────────────
function updateInventory() {
  const now = Date.now();
  let avail = 0, held = 0, booked = 0;
  for (const s of seats) {
    if (s.status === 'booked') {
      booked++;
    } else if (
      s.status === 'held' &&
      s.hold_expires_at &&
      new Date(s.hold_expires_at).getTime() > now
    ) {
      held++;
    } else {
      avail++;
    }
  }
  countAvailable.textContent = avail;
  countHeld.textContent = held;
  countBooked.textContent = booked;
  countTotal.textContent = seats.length;
}

// ─── Seat click handler ───────────────────────────────────────
function onSeatClick(seatId) {
  // Ignore if we have an active hold or booking
  if (activeHold || bookedSeatIds.length > 0) return;

  const seat = seats.find((s) => s.id === seatId);
  if (!seat || seat.status !== 'available') return;

  if (selectedSeatIds.has(seatId)) {
    selectedSeatIds.delete(seatId);
  } else {
    selectedSeatIds.add(seatId);
  }

  updateSeatEl(seatId);
  updateActionPanel();
}

// ─── Action panel ─────────────────────────────────────────────
function updateActionPanel() {
  // Hide all panels first
  holdPanel.classList.add('hidden');
  activeHoldPanel.classList.add('hidden');
  bookedPanel.classList.add('hidden');
  errorPanel.classList.add('hidden');
  idleHint.classList.add('hidden');

  if (bookedSeatIds.length > 0) {
    bookedPanel.classList.remove('hidden');
    bookedSeatsList.textContent = bookedSeatIds.join(', ');
  } else if (activeHold) {
    activeHoldPanel.classList.remove('hidden');
    holdSeatsList.textContent = activeHold.seatIds.join(', ');
    startCountdown();
  } else if (selectedSeatIds.size > 0) {
    holdPanel.classList.remove('hidden');
    selectedSeatsList.textContent = [...selectedSeatIds].join(', ');
  } else {
    idleHint.classList.remove('hidden');
  }
}

// ─── Countdown timer ──────────────────────────────────────────
function startCountdown() {
  stopCountdown();
  updateCountdownDisplay();
  countdownTimer = setInterval(() => {
    if (!activeHold) { stopCountdown(); return; }
    const remaining = new Date(activeHold.expiresAt).getTime() - Date.now();
    if (remaining <= 0) {
      stopCountdown();
      handleHoldExpired();
    } else {
      updateCountdownDisplay();
    }
  }, 500);
}

function stopCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

function updateCountdownDisplay() {
  if (!activeHold) return;
  const remaining = Math.max(0, new Date(activeHold.expiresAt).getTime() - Date.now());
  const secs = Math.ceil(remaining / 1000);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  holdCountdown.textContent = `${m}:${s.toString().padStart(2, '0')}`;
  holdCountdown.classList.toggle('urgent', secs <= 10);
}

function handleHoldExpired() {
  if (!activeHold) return;
  const expiredSeatIds = [...activeHold.seatIds];
  activeHold = null;
  selectedSeatIds.clear();

  // Update local seat state
  for (const seatId of expiredSeatIds) {
    const seat = seats.find((s) => s.id === seatId);
    if (seat) { seat.status = 'available'; seat.hold_id = null; seat.hold_expires_at = null; }
    updateSeatEl(seatId);
  }
  updateInventory();
  showError('Your hold has expired. The seats are now available again.');
}

// ─── Hold actions ─────────────────────────────────────────────
btnHold.addEventListener('click', async () => {
  if (selectedSeatIds.size === 0) return;
  btnHold.disabled = true;
  btnHold.textContent = 'Placing hold…';

  try {
    const seatIds = [...selectedSeatIds];
    const hold = await api.createHold(seatIds, SESSION_ID);

    activeHold = {
      holdId: hold.holdId,
      seatIds: hold.seatIds,
      expiresAt: hold.expiresAt,
    };
    selectedSeatIds.clear();

    // Update local seat state
    for (const seatId of hold.seatIds) {
      const seat = seats.find((s) => s.id === seatId);
      if (seat) {
        seat.status = 'held';
        seat.hold_id = hold.holdId;
        seat.hold_expires_at = hold.expiresAt;
      }
      updateSeatEl(seatId);
    }
    updateInventory();
    updateActionPanel();
  } catch (err) {
    const conflicting = err.data?.conflictingSeatIds ?? [];
    let msg = err.message || 'Failed to place hold.';
    if (conflicting.length > 0) {
      msg = 'Some seats are no longer available.';
      showError(msg, `Conflicting seats: ${conflicting.join(', ')}`);
      // Refresh seat map to get latest state
      await loadSeats();
      // Remove conflicting seats from selection
      for (const id of conflicting) selectedSeatIds.delete(id);
      updateActionPanel();
    } else {
      showError(msg);
    }
  } finally {
    btnHold.disabled = false;
    btnHold.textContent = 'Hold Selected Seats';
  }
});

btnClearSelection.addEventListener('click', () => {
  const prev = [...selectedSeatIds];
  selectedSeatIds.clear();
  for (const id of prev) updateSeatEl(id);
  updateActionPanel();
});

btnConfirm.addEventListener('click', async () => {
  if (!activeHold) return;
  btnConfirm.disabled = true;
  btnConfirm.textContent = 'Confirming…';

  try {
    const result = await api.confirmHold(activeHold.holdId, SESSION_ID);
    const confirmedSeatIds = result.seats.map((s) => s.id);

    bookedSeatIds = confirmedSeatIds;
    stopCountdown();
    activeHold = null;

    // Update local seat state
    for (const seat of result.seats) {
      const local = seats.find((s) => s.id === seat.id);
      if (local) {
        local.status = 'booked';
        local.hold_id = null;
        local.hold_expires_at = null;
        local.booked_by = seat.booked_by;
      }
      updateSeatEl(seat.id);
    }
    updateInventory();
    updateActionPanel();
  } catch (err) {
    showError(err.message || 'Failed to confirm booking.');
    if (err.status === 410) {
      // Hold expired or gone
      activeHold = null;
      stopCountdown();
      await loadSeats();
      updateActionPanel();
    }
  } finally {
    btnConfirm.disabled = false;
    btnConfirm.textContent = 'Confirm Booking';
  }
});

btnRelease.addEventListener('click', async () => {
  if (!activeHold) return;
  btnRelease.disabled = true;
  btnRelease.textContent = 'Releasing…';

  try {
    const holdId = activeHold.holdId;
    const releasedIds = [...activeHold.seatIds];
    await api.releaseHold(holdId, SESSION_ID);

    stopCountdown();
    activeHold = null;

    for (const seatId of releasedIds) {
      const seat = seats.find((s) => s.id === seatId);
      if (seat) { seat.status = 'available'; seat.hold_id = null; seat.hold_expires_at = null; }
      updateSeatEl(seatId);
    }
    updateInventory();
    updateActionPanel();
  } catch (err) {
    showError(err.message || 'Failed to release hold.');
  } finally {
    btnRelease.disabled = false;
    btnRelease.textContent = 'Release Hold';
  }
});

btnNewBooking.addEventListener('click', () => {
  bookedSeatIds = [];
  updateActionPanel();
  // Re-render so mine-booked seats show as booked (not mine-booked)
  renderSeatMap();
});

// ─── Error panel ──────────────────────────────────────────────
function showError(msg, conflictMsg) {
  errorMessage.textContent = msg;
  if (conflictMsg) {
    errorConflict.textContent = conflictMsg;
    errorConflict.classList.remove('hidden');
  } else {
    errorConflict.classList.add('hidden');
  }

  // Hide other panels
  holdPanel.classList.add('hidden');
  activeHoldPanel.classList.add('hidden');
  bookedPanel.classList.add('hidden');
  idleHint.classList.add('hidden');
  errorPanel.classList.remove('hidden');
}

btnDismissError.addEventListener('click', () => {
  errorPanel.classList.add('hidden');
  updateActionPanel();
});

// ─── SSE ──────────────────────────────────────────────────────
function connectSSE() {
  setSseStatus('connecting');
  const es = new EventSource(`${API_BASE}/api/stream`);

  es.addEventListener('connected', () => {
    setSseStatus('connected');
  });

  es.addEventListener('seat:held', (e) => {
    const { seatId, holdId, expiresAt } = JSON.parse(e.data);
    const seat = seats.find((s) => s.id === seatId);
    if (seat) {
      seat.status = 'held';
      seat.hold_id = holdId;
      seat.hold_expires_at = expiresAt;
    }
    updateSeatEl(seatId);
    updateInventory();
  });

  es.addEventListener('seat:booked', (e) => {
    const { seatId, holdId } = JSON.parse(e.data);
    const seat = seats.find((s) => s.id === seatId);
    if (seat) {
      seat.status = 'booked';
      seat.hold_id = null;
      seat.hold_expires_at = null;
      seat.booked_by = holdId;
    }
    updateSeatEl(seatId);
    updateInventory();
  });

  es.addEventListener('seat:released', (e) => {
    const { seatId } = JSON.parse(e.data);
    const seat = seats.find((s) => s.id === seatId);
    if (seat) {
      seat.status = 'available';
      seat.hold_id = null;
      seat.hold_expires_at = null;
    }
    // If this was our hold that got released externally (expiry sweep)
    if (activeHold && activeHold.seatIds.includes(seatId)) {
      // The server released our hold – treat as expired
      handleHoldExpired();
    } else {
      updateSeatEl(seatId);
    }
    updateInventory();
  });

  es.onerror = () => {
    setSseStatus('disconnected');
    // Reconnect after 3 seconds
    es.close();
    setTimeout(connectSSE, 3000);
  };
}

function setSseStatus(state) {
  sseStatus.className = `sse-${state}`;
  sseLabel.textContent =
    state === 'connected'    ? 'Live' :
    state === 'connecting'   ? 'Connecting…' :
    'Disconnected';
}

// ─── Boot ─────────────────────────────────────────────────────
init();
