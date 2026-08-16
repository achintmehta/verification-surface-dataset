/**
 * Seat-booking SPA – main entry point.
 *
 * State machine:
 *   idle        → user selects seats → selection
 *   selection   → user clicks "Hold" → holding (or back to idle on 409)
 *   holding     → user confirms      → booked
 *   holding     → TTL expires        → idle  (via SSE or countdown)
 *   holding     → user releases      → idle
 *   booked      → user clicks "Book More" → idle
 */

import { fetchSeats, createHold, confirmHold, releaseHold } from './api.js';
import { getSessionId } from './session.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {'idle'|'selection'|'holding'|'booked'} */
let appState = 'idle';

/** @type {Map<string, import('./api.js').Seat>} */
const seatMap = new Map();

/** Seat ids the user has clicked but not yet held */
const selectedIds = new Set();

/** Current active hold (if any) */
let activeHold = null; // { holdId, seatIds, expiresAt: Date, ttlSeconds }

/** Confirmed booking (if any) */
let activeBooking = null; // { holdId, seatIds }

/** Countdown interval handle */
let countdownInterval = null;

const sessionId = getSessionId();

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const seatMapEl       = document.getElementById('seat-map');
const selectionInfo   = document.getElementById('selection-info');
const selectionCount  = document.getElementById('selection-count');
const btnHold         = document.getElementById('btn-hold');
const holdInfo        = document.getElementById('hold-info');
const holdSeatsEl     = document.getElementById('hold-seats');
const countdownEl     = document.getElementById('countdown');
const btnConfirm      = document.getElementById('btn-confirm');
const btnRelease      = document.getElementById('btn-release');
const bookingInfo     = document.getElementById('booking-info');
const bookedSeatsEl   = document.getElementById('booked-seats');
const btnNewBooking   = document.getElementById('btn-new-booking');
const errorBanner     = document.getElementById('error-banner');
const infoBanner      = document.getElementById('info-banner');

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function showError(msg) {
  errorBanner.textContent = msg;
  errorBanner.classList.remove('hidden');
  infoBanner.classList.add('hidden');
  setTimeout(() => errorBanner.classList.add('hidden'), 6000);
}

function showInfo(msg) {
  infoBanner.textContent = msg;
  infoBanner.classList.remove('hidden');
  errorBanner.classList.add('hidden');
  setTimeout(() => infoBanner.classList.add('hidden'), 4000);
}

function clearBanners() {
  errorBanner.classList.add('hidden');
  infoBanner.classList.add('hidden');
}

// ---------------------------------------------------------------------------
// Seat rendering
// ---------------------------------------------------------------------------

/**
 * Determine the CSS class for a seat given the current app state.
 * @param {import('./api.js').Seat} seat
 * @returns {string}
 */
function seatClass(seat) {
  if (selectedIds.has(seat.id)) return 'selected';
  if (seat.status === 'booked') return 'booked';
  if (seat.status === 'held') {
    if (activeHold && activeHold.seatIds.includes(seat.id)) return 'held-own';
    return 'held-other';
  }
  return 'available';
}

function buildSeatMap() {
  seatMapEl.innerHTML = '';

  // Group by row
  const rows = new Map();
  for (const seat of seatMap.values()) {
    if (!rows.has(seat.rowLabel)) rows.set(seat.rowLabel, []);
    rows.get(seat.rowLabel).push(seat);
  }

  for (const [rowLabel, seats] of [...rows.entries()].sort()) {
    seats.sort((a, b) => a.seatNumber - b.seatNumber);

    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';
    rowEl.dataset.row = rowLabel;

    const labelEl = document.createElement('span');
    labelEl.className = 'row-label';
    labelEl.textContent = rowLabel;
    rowEl.appendChild(labelEl);

    const seatsContainer = document.createElement('div');
    seatsContainer.className = 'seats-container';

    for (const seat of seats) {
      seatsContainer.appendChild(buildSeatButton(seat));
    }

    rowEl.appendChild(seatsContainer);
    seatMapEl.appendChild(rowEl);
  }
}

/**
 * @param {import('./api.js').Seat} seat
 * @returns {HTMLButtonElement}
 */
function buildSeatButton(seat) {
  const btn = document.createElement('button');
  btn.className = `seat ${seatClass(seat)}`;
  btn.dataset.seatId = seat.id;
  btn.textContent = seat.seatNumber;
  btn.title = `${seat.rowLabel}${seat.seatNumber} – ${seatClass(seat)}`;
  btn.setAttribute('aria-label', `Row ${seat.rowLabel} seat ${seat.seatNumber}`);

  const cls = seatClass(seat);
  if (cls === 'booked' || cls === 'held-other') {
    btn.disabled = true;
    btn.setAttribute('aria-disabled', 'true');
  }

  btn.addEventListener('click', () => onSeatClick(seat.id));
  return btn;
}

/**
 * Update a single seat button in place (avoids full re-render).
 * @param {import('./api.js').Seat} seat
 */
function updateSeatButton(seat) {
  const btn = seatMapEl.querySelector(`[data-seat-id="${seat.id}"]`);
  if (!btn) return;

  const cls = seatClass(seat);
  btn.className = `seat ${cls}`;
  btn.title = `${seat.rowLabel}${seat.seatNumber} – ${cls}`;
  btn.disabled = cls === 'booked' || cls === 'held-other';
  btn.setAttribute('aria-disabled', String(btn.disabled));
}

// ---------------------------------------------------------------------------
// Seat click handler
// ---------------------------------------------------------------------------

function onSeatClick(seatId) {
  if (appState !== 'idle' && appState !== 'selection') return;

  const seat = seatMap.get(seatId);
  if (!seat || seat.status !== 'available') return;

  if (selectedIds.has(seatId)) {
    selectedIds.delete(seatId);
  } else {
    selectedIds.add(seatId);
  }

  appState = selectedIds.size > 0 ? 'selection' : 'idle';
  updateSeatButton(seat);
  renderActionPanel();
}

// ---------------------------------------------------------------------------
// Action panel rendering
// ---------------------------------------------------------------------------

function renderActionPanel() {
  selectionInfo.classList.add('hidden');
  holdInfo.classList.add('hidden');
  bookingInfo.classList.add('hidden');

  if (appState === 'selection') {
    selectionInfo.classList.remove('hidden');
    selectionCount.textContent =
      selectedIds.size === 1 ? '1 seat selected' : `${selectedIds.size} seats selected`;
  } else if (appState === 'holding' && activeHold) {
    holdInfo.classList.remove('hidden');
    holdSeatsEl.textContent = `Seats: ${activeHold.seatIds.join(', ')}`;
    startCountdown();
  } else if (appState === 'booked' && activeBooking) {
    bookingInfo.classList.remove('hidden');
    bookedSeatsEl.textContent = activeBooking.seatIds.join(', ');
    stopCountdown();
  }
}

// ---------------------------------------------------------------------------
// Countdown
// ---------------------------------------------------------------------------

function startCountdown() {
  stopCountdown();
  updateCountdown();
  countdownInterval = setInterval(updateCountdown, 1000);
}

function stopCountdown() {
  if (countdownInterval !== null) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
}

function updateCountdown() {
  if (!activeHold) { stopCountdown(); return; }

  const remaining = Math.max(0, activeHold.expiresAt.getTime() - Date.now());
  const secs = Math.ceil(remaining / 1000);
  const mm = String(Math.floor(secs / 60)).padStart(2, '0');
  const ss = String(secs % 60).padStart(2, '0');
  countdownEl.textContent = `${mm}:${ss}`;
  countdownEl.classList.toggle('urgent', secs <= 10);

  if (remaining <= 0) {
    stopCountdown();
    // Hold expired locally – transition to idle
    if (appState === 'holding') {
      showError('Your hold has expired. The seats are now available again.');
      transitionToIdle();
    }
  }
}

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

function transitionToIdle() {
  stopCountdown();
  appState = 'idle';
  selectedIds.clear();
  activeHold = null;
  // Refresh seat map to get latest state
  loadSeats();
  renderActionPanel();
}

// ---------------------------------------------------------------------------
// Button handlers
// ---------------------------------------------------------------------------

btnHold.addEventListener('click', async () => {
  if (selectedIds.size === 0) return;
  btnHold.disabled = true;
  clearBanners();

  try {
    const seatIds = [...selectedIds];
    const hold = await createHold({ seatIds, sessionId });

    activeHold = {
      holdId: hold.holdId,
      seatIds: hold.seatIds,
      expiresAt: new Date(hold.expiresAt),
      ttlSeconds: hold.ttlSeconds,
    };

    // Update local seat map
    for (const id of hold.seatIds) {
      const seat = seatMap.get(id);
      if (seat) {
        seat.status = 'held';
        seat.holdId = hold.holdId;
        seat.holdExpiresAt = hold.expiresAt;
      }
    }

    selectedIds.clear();
    appState = 'holding';
    buildSeatMap(); // full re-render to reflect held state
    renderActionPanel();
    showInfo(`Hold placed! You have ${hold.ttlSeconds}s to confirm.`);
  } catch (err) {
    if (err.status === 409 && err.data?.conflictingSeatIds) {
      const conflicting = err.data.conflictingSeatIds;
      showError(
        `Seats ${conflicting.join(', ')} are no longer available. Please choose different seats.`
      );
      // Flash conflicting seats
      for (const id of conflicting) {
        const btn = seatMapEl.querySelector(`[data-seat-id="${id}"]`);
        if (btn) {
          btn.classList.add('conflict');
          setTimeout(() => btn.classList.remove('conflict'), 2000);
        }
        // Deselect them
        selectedIds.delete(id);
      }
      // Refresh to get latest state
      await loadSeats();
      appState = selectedIds.size > 0 ? 'selection' : 'idle';
      renderActionPanel();
    } else {
      showError(err.message ?? 'Failed to place hold.');
    }
  } finally {
    btnHold.disabled = false;
  }
});

btnConfirm.addEventListener('click', async () => {
  if (!activeHold) return;
  btnConfirm.disabled = true;
  btnRelease.disabled = true;
  clearBanners();

  try {
    const booking = await confirmHold(activeHold.holdId, { sessionId });

    activeBooking = {
      holdId: booking.holdId,
      seatIds: booking.seatIds,
    };

    // Update local seat map
    for (const id of booking.seatIds) {
      const seat = seatMap.get(id);
      if (seat) {
        seat.status = 'booked';
        seat.holdId = null;
        seat.holdExpiresAt = null;
        seat.bookedBy = booking.holdId;
      }
    }

    activeHold = null;
    appState = 'booked';
    buildSeatMap();
    renderActionPanel();
    showInfo('Booking confirmed! 🎉');
  } catch (err) {
    if (err.status === 410) {
      showError('Your hold has expired. Please select seats again.');
      transitionToIdle();
    } else {
      showError(err.message ?? 'Failed to confirm booking.');
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
  clearBanners();

  try {
    await releaseHold(activeHold.holdId, { sessionId });
    showInfo('Hold released. Seats are available again.');
    transitionToIdle();
  } catch (err) {
    showError(err.message ?? 'Failed to release hold.');
  } finally {
    btnRelease.disabled = false;
    btnConfirm.disabled = false;
  }
});

btnNewBooking.addEventListener('click', () => {
  activeBooking = null;
  transitionToIdle();
});

// ---------------------------------------------------------------------------
// Load seats
// ---------------------------------------------------------------------------

async function loadSeats() {
  try {
    const { seats } = await fetchSeats();
    seatMap.clear();
    for (const seat of seats) {
      seatMap.set(seat.id, seat);
    }
    buildSeatMap();
  } catch (err) {
    seatMapEl.innerHTML = '<div class="loading">Failed to load seats. Retrying…</div>';
    setTimeout(loadSeats, 3000);
  }
}

// ---------------------------------------------------------------------------
// SSE – real-time updates
// ---------------------------------------------------------------------------

function connectSSE() {
  const es = new EventSource('/api/stream');

  es.addEventListener('seats_held', (e) => {
    const { holdId, seatIds, sessionId: holderSession, expiresAt } = JSON.parse(e.data);
    // Don't overwrite our own hold (we already updated locally)
    if (holderSession === sessionId) return;

    for (const id of seatIds) {
      const seat = seatMap.get(id);
      if (seat) {
        seat.status = 'held';
        seat.holdId = holdId;
        seat.holdExpiresAt = expiresAt;
        updateSeatButton(seat);
      }
    }
  });

  es.addEventListener('seats_booked', (e) => {
    const { holdId, seatIds, sessionId: bookerSession } = JSON.parse(e.data);
    if (bookerSession === sessionId) return;

    for (const id of seatIds) {
      const seat = seatMap.get(id);
      if (seat) {
        seat.status = 'booked';
        seat.holdId = null;
        seat.holdExpiresAt = null;
        seat.bookedBy = holdId;
        updateSeatButton(seat);
      }
    }
  });

  es.addEventListener('seats_released', (e) => {
    const { seatIds, holdId } = JSON.parse(e.data);

    // If our own hold was released by the server (expiry), transition to idle
    if (activeHold && holdId === activeHold.holdId) {
      showError('Your hold has expired. The seats are now available again.');
      transitionToIdle();
      return;
    }

    for (const id of seatIds) {
      const seat = seatMap.get(id);
      if (seat && seat.status === 'held') {
        seat.status = 'available';
        seat.holdId = null;
        seat.holdExpiresAt = null;
        updateSeatButton(seat);
      }
    }
  });

  es.onerror = () => {
    // EventSource auto-reconnects; just log
    console.warn('SSE connection lost, reconnecting…');
  };
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

(async () => {
  await loadSeats();
  renderActionPanel();
  connectSSE();
})();
