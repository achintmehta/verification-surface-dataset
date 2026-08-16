/**
 * Seat Booking – main application module.
 *
 * Responsibilities:
 *  - Render the seat map from the REST API on load.
 *  - Allow the user to select available seats and request a hold.
 *  - Show a live countdown for the active hold TTL.
 *  - Allow confirming or releasing the active hold.
 *  - Connect to the SSE stream and apply real-time seat updates.
 *  - Handle 409 conflicts by highlighting the conflicting seats.
 */

import { fetchSeats, createHold, confirmHold, releaseHold } from './api.js';
import { getSessionId } from './session.js';

// ── Session ───────────────────────────────────────────────────────────────────
const SESSION_ID = getSessionId();
document.getElementById('session-id-display').textContent = `Session: ${SESSION_ID.slice(0, 16)}`;

// ── State ─────────────────────────────────────────────────────────────────────
/** @type {Map<string, object>} seatId → seat object */
const seatMap = new Map();

/** @type {Set<string>} currently selected seat IDs (before hold) */
const selectedSeats = new Set();

/** Active hold state */
let activeHold = null; // { holdId, seatIds, expiresAt }
let countdownHandle = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const seatMapEl        = document.getElementById('seat-map');
const invAvailable     = document.getElementById('inv-available');
const invHeld          = document.getElementById('inv-held');
const invBooked        = document.getElementById('inv-booked');
const invTotal         = document.getElementById('inv-total');

const panelSelect      = document.getElementById('panel-select');
const panelHold        = document.getElementById('panel-hold');
const panelBooked      = document.getElementById('panel-booked');
const panelError       = document.getElementById('panel-error');

const selectedCountEl  = document.getElementById('selected-count');
const holdSeatsList    = document.getElementById('hold-seats-list');
const holdCountdown    = document.getElementById('hold-countdown');
const bookedSeatsList  = document.getElementById('booked-seats-list');
const errorMsgEl       = document.getElementById('error-msg');

const btnHold          = document.getElementById('btn-hold');
const btnClearSel      = document.getElementById('btn-clear-selection');
const btnConfirm       = document.getElementById('btn-confirm');
const btnRelease       = document.getElementById('btn-release');
const btnNewBooking    = document.getElementById('btn-new-booking');
const btnDismissError  = document.getElementById('btn-dismiss-error');

const connStatusEl     = document.getElementById('connection-status');

// ── Utility ───────────────────────────────────────────────────────────────────
function showPanel(name) {
  for (const p of [panelSelect, panelHold, panelBooked, panelError]) {
    p.classList.add('hidden');
  }
  if (name === 'select')  panelSelect.classList.remove('hidden');
  if (name === 'hold')    panelHold.classList.remove('hidden');
  if (name === 'booked')  panelBooked.classList.remove('hidden');
  if (name === 'error')   panelError.classList.remove('hidden');
}

function hideAllPanels() {
  for (const p of [panelSelect, panelHold, panelBooked, panelError]) {
    p.classList.add('hidden');
  }
}

function formatCountdown(ms) {
  if (ms <= 0) return '0s';
  const s = Math.ceil(ms / 1000);
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${s}s`;
}

function updateInventory() {
  let available = 0, held = 0, booked = 0;
  for (const seat of seatMap.values()) {
    if (seat.status === 'available') available++;
    else if (seat.status === 'held') held++;
    else if (seat.status === 'booked') booked++;
  }
  invAvailable.textContent = available;
  invHeld.textContent      = held;
  invBooked.textContent    = booked;
  invTotal.textContent     = seatMap.size;
}

// ── Seat element helpers ──────────────────────────────────────────────────────

/**
 * Determine the CSS class for a seat given its data and current UI state.
 */
function seatClass(seat) {
  if (selectedSeats.has(seat.id)) return 'selected';

  switch (seat.status) {
    case 'available': return 'available';
    case 'booked':    return 'booked';
    case 'held':
      // Is this seat part of our own active hold?
      if (activeHold && activeHold.seatIds.includes(seat.id)) return 'held-own';
      return 'held-other';
    default:          return 'available';
  }
}

/**
 * Create or update the DOM element for a single seat.
 */
function renderSeat(seat) {
  let el = document.getElementById(`seat-${seat.id}`);
  const cls = seatClass(seat);

  if (!el) {
    el = document.createElement('div');
    el.id = `seat-${seat.id}`;
    el.className = `seat ${cls}`;
    el.textContent = seat.seatNumber ?? seat.id;
    el.title = `${seat.rowLabel ?? ''}${seat.seatNumber ?? seat.id}`;
    el.addEventListener('click', () => onSeatClick(seat.id));
    return el;
  }

  // Update existing element.
  const prevCls = [...el.classList].find(c => ['available','selected','held-own','held-other','booked'].includes(c));
  if (prevCls !== cls) {
    el.classList.remove('available', 'selected', 'held-own', 'held-other', 'booked');
    el.classList.add(cls);
    // Flash animation on state change.
    el.classList.remove('flash');
    void el.offsetWidth; // reflow
    el.classList.add('flash');
  }

  return el;
}

/**
 * Build the full seat map DOM from the current seatMap state.
 */
function renderSeatMap() {
  seatMapEl.innerHTML = '';

  // Group by row.
  const rows = new Map();
  for (const seat of seatMap.values()) {
    const r = seat.rowLabel;
    if (!rows.has(r)) rows.set(r, []);
    rows.get(r).push(seat);
  }

  // Sort rows alphabetically, seats numerically.
  const sortedRows = [...rows.entries()].sort(([a], [b]) => a.localeCompare(b));

  for (const [rowLabel, seats] of sortedRows) {
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';

    const labelEl = document.createElement('div');
    labelEl.className = 'row-label';
    labelEl.textContent = rowLabel;
    rowEl.appendChild(labelEl);

    seats.sort((a, b) => a.seatNumber - b.seatNumber);
    for (const seat of seats) {
      rowEl.appendChild(renderSeat(seat));
    }

    seatMapEl.appendChild(rowEl);
  }

  updateInventory();
}

/**
 * Apply a partial update to the seat map (from SSE or API response).
 * Only re-renders the affected seat elements.
 */
function applySeatsUpdate(updatedSeats) {
  for (const s of updatedSeats) {
    seatMap.set(s.id, { ...seatMap.get(s.id), ...s });
    renderSeat(seatMap.get(s.id)); // updates existing DOM element in-place
  }
  updateInventory();
}

// ── Seat click handler ────────────────────────────────────────────────────────
function onSeatClick(seatId) {
  // Ignore clicks when a hold is active or booking is confirmed.
  if (activeHold) return;

  const seat = seatMap.get(seatId);
  if (!seat || seat.status !== 'available') return;

  if (selectedSeats.has(seatId)) {
    selectedSeats.delete(seatId);
  } else {
    selectedSeats.add(seatId);
  }

  renderSeat(seat);
  updateSelectionPanel();
}

function updateSelectionPanel() {
  selectedCountEl.textContent = selectedSeats.size;
  if (selectedSeats.size > 0 && !activeHold) {
    showPanel('select');
  } else if (selectedSeats.size === 0 && !activeHold) {
    hideAllPanels();
  }
}

// ── Hold countdown ────────────────────────────────────────────────────────────
function startCountdown(expiresAt) {
  stopCountdown();
  countdownHandle = setInterval(() => {
    const remaining = new Date(expiresAt) - Date.now();
    if (remaining <= 0) {
      holdCountdown.textContent = 'Expired';
      holdCountdown.classList.add('urgent');
      stopCountdown();
      // The hold has expired; reset UI.
      onHoldExpiredLocally();
      return;
    }
    holdCountdown.textContent = formatCountdown(remaining);
    holdCountdown.classList.toggle('urgent', remaining < 15_000);
  }, 500);
}

function stopCountdown() {
  if (countdownHandle) {
    clearInterval(countdownHandle);
    countdownHandle = null;
  }
}

function onHoldExpiredLocally() {
  // The hold expired client-side; the server will have already released the
  // seats.  Reset local state and show an informational error.
  const expiredSeatIds = activeHold?.seatIds ?? [];
  activeHold = null;
  selectedSeats.clear();

  // Visually reset the seats (SSE will confirm, but update optimistically).
  for (const id of expiredSeatIds) {
    const seat = seatMap.get(id);
    if (seat && seat.status === 'held') {
      seat.status = 'available';
      seat.holdId = null;
      seat.holdExpiresAt = null;
      renderSeat(seat);
    }
  }
  updateInventory();

  showError('Your hold has expired. The seats have been released back to the pool.');
}

// ── Button handlers ───────────────────────────────────────────────────────────
btnHold.addEventListener('click', async () => {
  if (selectedSeats.size === 0) return;
  btnHold.disabled = true;

  try {
    const seatIds = [...selectedSeats];
    const hold = await createHold(seatIds, SESSION_ID);

    activeHold = {
      holdId:    hold.holdId,
      seatIds:   hold.seatIds,
      expiresAt: hold.expiresAt,
    };

    selectedSeats.clear();

    // Update seat states optimistically (SSE will confirm).
    for (const id of hold.seatIds) {
      const seat = seatMap.get(id);
      if (seat) {
        seat.status = 'held';
        seat.holdId = hold.holdId;
        seat.holdExpiresAt = hold.expiresAt;
        renderSeat(seat);
      }
    }
    updateInventory();

    holdSeatsList.textContent = hold.seatIds.join(', ');
    startCountdown(hold.expiresAt);
    showPanel('hold');
  } catch (err) {
    if (err.status === 409) {
      const conflicting = err.conflictingSeatIds ?? [];
      showError(
        `The following seat(s) are no longer available: ${conflicting.join(', ')}. ` +
        `Please deselect them and try again.`
      );
      // Highlight conflicting seats.
      for (const id of conflicting) {
        const seat = seatMap.get(id);
        if (seat) {
          seat.status = 'held'; // treat as held-other visually
          renderSeat(seat);
        }
      }
      // Deselect conflicting seats.
      for (const id of conflicting) selectedSeats.delete(id);
      updateSelectionPanel();
    } else {
      showError(`Failed to place hold: ${err.message}`);
    }
  } finally {
    btnHold.disabled = false;
  }
});

btnClearSel.addEventListener('click', () => {
  selectedSeats.clear();
  // Re-render all seats to remove 'selected' class.
  for (const seat of seatMap.values()) renderSeat(seat);
  hideAllPanels();
});

btnConfirm.addEventListener('click', async () => {
  if (!activeHold) return;
  btnConfirm.disabled = true;
  btnRelease.disabled = true;

  try {
    const result = await confirmHold(activeHold.holdId, SESSION_ID);
    const bookedIds = result.seatIds ?? result.seats?.map(s => s.id) ?? activeHold.seatIds;

    stopCountdown();

    // Update seat states optimistically.
    for (const id of bookedIds) {
      const seat = seatMap.get(id);
      if (seat) {
        seat.status = 'booked';
        seat.holdId = null;
        seat.holdExpiresAt = null;
        seat.bookedBy = SESSION_ID;
        renderSeat(seat);
      }
    }
    updateInventory();

    bookedSeatsList.textContent = bookedIds.join(', ');
    activeHold = null;
    showPanel('booked');
  } catch (err) {
    showError(`Confirmation failed: ${err.message}`);
    // If the hold expired, reset state.
    if (err.status === 410 || err.status === 404) {
      stopCountdown();
      const expiredIds = activeHold?.seatIds ?? [];
      activeHold = null;
      for (const id of expiredIds) {
        const seat = seatMap.get(id);
        if (seat && seat.status === 'held') {
          seat.status = 'available';
          seat.holdId = null;
          seat.holdExpiresAt = null;
          renderSeat(seat);
        }
      }
      updateInventory();
    }
  } finally {
    btnConfirm.disabled = false;
    btnRelease.disabled = false;
  }
});

btnRelease.addEventListener('click', async () => {
  if (!activeHold) return;
  btnRelease.disabled = true;
  btnConfirm.disabled = true;

  try {
    await releaseHold(activeHold.holdId, SESSION_ID);
    stopCountdown();

    const releasedIds = activeHold.seatIds;
    activeHold = null;

    for (const id of releasedIds) {
      const seat = seatMap.get(id);
      if (seat) {
        seat.status = 'available';
        seat.holdId = null;
        seat.holdExpiresAt = null;
        renderSeat(seat);
      }
    }
    updateInventory();
    hideAllPanels();
  } catch (err) {
    showError(`Failed to release hold: ${err.message}`);
  } finally {
    btnRelease.disabled = false;
    btnConfirm.disabled = false;
  }
});

btnNewBooking.addEventListener('click', () => {
  hideAllPanels();
});

btnDismissError.addEventListener('click', () => {
  hideAllPanels();
  updateSelectionPanel();
});

function showError(msg) {
  errorMsgEl.textContent = msg;
  showPanel('error');
}

// ── SSE connection ────────────────────────────────────────────────────────────
function connectSSE() {
  connStatusEl.className = 'status-dot connecting';

  const es = new EventSource('/api/stream');

  es.addEventListener('connected', (e) => {
    connStatusEl.className = 'status-dot connected';
    const data = JSON.parse(e.data);
    // Replace the entire seat map with the snapshot.
    seatMap.clear();
    for (const seat of data.seats) {
      seatMap.set(seat.id, seat);
    }
    renderSeatMap();
  });

  es.addEventListener('seat-update', (e) => {
    const data = JSON.parse(e.data);
    applySeatsUpdate(data.seats);

    // If our active hold's seats were released by the server (expiry), reset.
    if (activeHold && data.type === 'released') {
      const releasedIds = new Set(data.seats.map(s => s.id));
      const ourSeatsReleased = activeHold.seatIds.some(id => releasedIds.has(id));
      if (ourSeatsReleased) {
        stopCountdown();
        activeHold = null;
        showError('Your hold was released (expired or cancelled by the server).');
      }
    }
  });

  es.onerror = () => {
    connStatusEl.className = 'status-dot disconnected';
    es.close();
    // Reconnect after a short delay.
    setTimeout(connectSSE, 3000);
  };
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function init() {
  try {
    const { seats } = await fetchSeats();
    for (const seat of seats) {
      seatMap.set(seat.id, seat);
    }
    renderSeatMap();
  } catch (err) {
    seatMapEl.innerHTML = `<div class="loading">Failed to load seat map: ${err.message}</div>`;
  }

  connectSSE();
}

init();
