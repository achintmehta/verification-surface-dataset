/**
 * main.js – Seat-booking SPA entry point.
 *
 * Responsibilities:
 *   • Render the seat map from the store.
 *   • Handle seat selection, hold creation, confirmation, and release.
 *   • Connect to the SSE stream and apply live updates.
 *   • Show a countdown for the active hold.
 *   • Handle 409 conflicts by highlighting conflicting seats.
 */

import { api } from './api.js';
import { createStore } from './store.js';

// ── Session id ─────────────────────────────────────────────────────────────
const SESSION_ID = (() => {
  const key = 'seat_booking_session';
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(key, id);
  }
  return id;
})();

document.getElementById('session-id-display').textContent =
  SESSION_ID.slice(0, 8) + '…';

// ── State ──────────────────────────────────────────────────────────────────
const store = createStore();

/** Set of seat ids the user has clicked but not yet held. */
const selectedIds = new Set();

/** Currently active hold (or null). */
let activeHold = null; // { id, seatIds, expiresAt: Date }

/** Countdown interval handle. */
let countdownInterval = null;

/** Set of seat ids that were in conflict on the last failed hold attempt. */
const conflictIds = new Set();

// ── DOM refs ───────────────────────────────────────────────────────────────
const seatMapEl         = document.getElementById('seat-map');
const holdPanel         = document.getElementById('hold-panel');
const activeHoldPanel   = document.getElementById('active-hold-panel');
const bookingPanel      = document.getElementById('booking-panel');
const errorPanel        = document.getElementById('error-panel');
const idleHint          = document.getElementById('idle-hint');
const selectedSeatsInfo = document.getElementById('selected-seats-info');
const holdSeatsInfo     = document.getElementById('hold-seats-info');
const bookingInfo       = document.getElementById('booking-info');
const errorMessage      = document.getElementById('error-message');
const countdownEl       = document.getElementById('countdown');
const btnHold           = document.getElementById('btn-hold');
const btnClearSelection = document.getElementById('btn-clear-selection');
const btnConfirm        = document.getElementById('btn-confirm');
const btnRelease        = document.getElementById('btn-release');
const btnNewBooking     = document.getElementById('btn-new-booking');
const btnDismissError   = document.getElementById('btn-dismiss-error');
const invAvailable      = document.getElementById('inv-available');
const invHeld           = document.getElementById('inv-held');
const invBooked         = document.getElementById('inv-booked');
const invTotal          = document.getElementById('inv-total');

// ── Render ─────────────────────────────────────────────────────────────────

/**
 * Full re-render of the seat map from the store.
 * @param {object[]} seats
 */
function renderSeatMap(seats) {
  // Group by row label.
  const rows = new Map();
  for (const seat of seats) {
    if (!rows.has(seat.rowLabel)) rows.set(seat.rowLabel, []);
    rows.get(seat.rowLabel).push(seat);
  }

  seatMapEl.innerHTML = '';

  for (const [rowLabel, rowSeats] of rows) {
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';

    const labelEl = document.createElement('div');
    labelEl.className = 'row-label';
    labelEl.textContent = rowLabel;
    rowEl.appendChild(labelEl);

    for (const seat of rowSeats) {
      rowEl.appendChild(buildSeatEl(seat));
    }

    seatMapEl.appendChild(rowEl);
  }

  updateInventory(seats);
}

/**
 * Build a single seat button element.
 */
function buildSeatEl(seat) {
  const el = document.createElement('button');
  el.className = 'seat';
  el.dataset.id = seat.id;
  el.textContent = seat.seatNumber;
  el.setAttribute('aria-label', `Row ${seat.rowLabel} Seat ${seat.seatNumber}`);
  applySeatClass(el, seat);
  el.addEventListener('click', () => onSeatClick(seat.id));
  return el;
}

/**
 * Determine and apply the visual CSS class for a seat element.
 * Priority: conflict > selected > held-mine > held > booked > available
 */
function applySeatClass(el, seat) {
  el.classList.remove('available', 'held', 'held-mine', 'booked', 'selected', 'conflict');

  if (conflictIds.has(seat.id)) {
    // Show the real status but add conflict highlight.
    el.classList.add(seat.status === 'available' ? 'available' : seat.status);
    el.classList.add('conflict');
    return;
  }

  if (selectedIds.has(seat.id)) {
    el.classList.add('selected');
    return;
  }

  const isMyHeld =
    seat.status === 'held' &&
    activeHold !== null &&
    activeHold.seatIds.includes(seat.id);

  if (isMyHeld) {
    el.classList.add('held-mine');
  } else {
    el.classList.add(seat.status);
  }
}

/**
 * Patch individual seat elements in-place (no full re-render).
 * @param {Array<{id:string}>} updates – list of seat ids to refresh
 */
function patchSeatElements(updates) {
  for (const u of updates) {
    const el = seatMapEl.querySelector(`[data-id="${u.id}"]`);
    if (!el) continue;
    const seat = store.getSeat(u.id);
    if (!seat) continue;
    applySeatClass(el, seat);
    // Brief pulse animation to draw attention.
    el.classList.remove('pulse');
    void el.offsetWidth; // force reflow to restart animation
    el.classList.add('pulse');
  }
  updateInventory(store.getSeats());
}

/**
 * Update the inventory summary bar.
 */
function updateInventory(seats) {
  let available = 0, held = 0, booked = 0;
  for (const s of seats) {
    if (s.status === 'available') available++;
    else if (s.status === 'held') held++;
    else if (s.status === 'booked') booked++;
  }
  invAvailable.textContent = available;
  invHeld.textContent      = held;
  invBooked.textContent    = booked;
  invTotal.textContent     = seats.length;
}

// ── Panel management ───────────────────────────────────────────────────────

function showPanel(name) {
  holdPanel.classList.add('hidden');
  activeHoldPanel.classList.add('hidden');
  bookingPanel.classList.add('hidden');
  errorPanel.classList.add('hidden');
  idleHint.classList.add('hidden');

  switch (name) {
    case 'hold':        holdPanel.classList.remove('hidden');       break;
    case 'active-hold': activeHoldPanel.classList.remove('hidden'); break;
    case 'booking':     bookingPanel.classList.remove('hidden');    break;
    case 'error':       errorPanel.classList.remove('hidden');      break;
    default:            idleHint.classList.remove('hidden');        break;
  }
}

// ── Seat click ─────────────────────────────────────────────────────────────

function onSeatClick(seatId) {
  const seat = store.getSeat(seatId);
  if (!seat) return;

  // While a hold is active, seat clicks are disabled (except for info).
  if (activeHold) return;

  // Cannot select booked or held-by-others seats.
  if (seat.status === 'booked') return;
  if (seat.status === 'held') return;

  // Clear conflict highlight when the user interacts with the seat.
  conflictIds.delete(seatId);

  // Toggle selection.
  if (selectedIds.has(seatId)) {
    selectedIds.delete(seatId);
  } else {
    selectedIds.add(seatId);
  }

  // Re-apply class for this seat only.
  const el = seatMapEl.querySelector(`[data-id="${seatId}"]`);
  if (el) applySeatClass(el, seat);

  updateSelectionPanel();
}

function updateSelectionPanel() {
  if (selectedIds.size === 0) {
    showPanel('idle');
    return;
  }
  const ids = [...selectedIds].join(', ');
  selectedSeatsInfo.textContent =
    `Selected: ${ids} (${selectedIds.size} seat${selectedIds.size !== 1 ? 's' : ''})`;
  showPanel('hold');
}

// ── Hold actions ───────────────────────────────────────────────────────────

btnHold.addEventListener('click', async () => {
  if (selectedIds.size === 0) return;
  btnHold.disabled = true;
  btnClearSelection.disabled = true;

  const seatIds = [...selectedIds];
  const res = await api.createHold(seatIds, SESSION_ID);

  btnHold.disabled = false;
  btnClearSelection.disabled = false;

  if (res.ok) {
    const { hold } = res.data;

    activeHold = {
      id: hold.id,
      seatIds: hold.seatIds,
      expiresAt: new Date(hold.expiresAt),
    };

    selectedIds.clear();
    conflictIds.clear();

    // Optimistically update the store (SSE will confirm shortly).
    store.patchSeats(
      hold.seatIds.map(id => ({
        id,
        status: 'held',
        holdId: hold.id,
        holdExpiresAt: hold.expiresAt,
      }))
    );
    patchSeatElements(hold.seatIds.map(id => ({ id })));

    holdSeatsInfo.textContent =
      `Seats: ${hold.seatIds.join(', ')} — confirm before the timer runs out!`;
    showPanel('active-hold');
    startCountdown(activeHold.expiresAt);

  } else if (res.status === 409) {
    const conflicting = res.data.conflictingSeatIds ?? [];

    // Highlight conflicting seats.
    conflictIds.clear();
    for (const id of conflicting) conflictIds.add(id);

    // Remove conflicting seats from selection.
    for (const id of conflicting) selectedIds.delete(id);

    // Re-render affected seats.
    for (const id of conflicting) {
      const el = seatMapEl.querySelector(`[data-id="${id}"]`);
      if (el) {
        const seat = store.getSeat(id);
        if (seat) applySeatClass(el, seat);
      }
    }

    updateSelectionPanel();
    showError(
      `Seat${conflicting.length !== 1 ? 's' : ''} ${conflicting.join(', ')} ` +
      `${conflicting.length !== 1 ? 'are' : 'is'} no longer available and ` +
      `${conflicting.length !== 1 ? 'have' : 'has'} been removed from your selection.`
    );

    // Refresh from server to get accurate state.
    await refreshSeats();

  } else {
    showError(res.data.error ?? 'Failed to place hold. Please try again.');
  }
});

btnClearSelection.addEventListener('click', () => {
  selectedIds.clear();
  conflictIds.clear();
  renderSeatMap(store.getSeats());
  showPanel('idle');
});

btnConfirm.addEventListener('click', async () => {
  if (!activeHold) return;
  btnConfirm.disabled = true;
  btnRelease.disabled = true;

  const holdId = activeHold.id;
  const res = await api.confirmHold(holdId, SESSION_ID);

  btnConfirm.disabled = false;
  btnRelease.disabled = false;

  if (res.ok) {
    const { booking } = res.data;
    stopCountdown();

    // Update store.
    store.patchSeats(
      booking.seatIds.map(id => ({
        id,
        status: 'booked',
        holdId: null,
        holdExpiresAt: null,
        bookedBy: SESSION_ID,
      }))
    );
    renderSeatMap(store.getSeats());

    bookingInfo.textContent =
      `Seats ${booking.seatIds.join(', ')} are now permanently booked for your session.`;
    activeHold = null;
    showPanel('booking');

  } else if (res.status === 410 || res.status === 404) {
    stopCountdown();
    const seatIds = activeHold ? activeHold.seatIds : [];
    activeHold = null;
    // Optimistically mark as available (server will confirm via SSE).
    store.patchSeats(seatIds.map(id => ({ id, status: 'available', holdId: null, holdExpiresAt: null })));
    renderSeatMap(store.getSeats());
    showError('Your hold has expired. Please select seats again.');
    await refreshSeats();

  } else {
    showError(res.data.error ?? 'Failed to confirm booking. Please try again.');
  }
});

btnRelease.addEventListener('click', async () => {
  if (!activeHold) return;
  btnRelease.disabled = true;
  btnConfirm.disabled = true;

  const holdId = activeHold.id;
  const seatIds = activeHold.seatIds;
  const res = await api.releaseHold(holdId, SESSION_ID);

  btnRelease.disabled = false;
  btnConfirm.disabled = false;
  stopCountdown();

  if (res.ok) {
    activeHold = null;
    // Optimistically update store.
    store.patchSeats(seatIds.map(id => ({
      id,
      status: 'available',
      holdId: null,
      holdExpiresAt: null,
    })));
    renderSeatMap(store.getSeats());
    showPanel('idle');

  } else {
    activeHold = null;
    showError(res.data.error ?? 'Failed to release hold.');
    await refreshSeats();
  }
});

btnNewBooking.addEventListener('click', () => {
  showPanel('idle');
});

btnDismissError.addEventListener('click', () => {
  if (activeHold) {
    showPanel('active-hold');
  } else if (selectedIds.size > 0) {
    showPanel('hold');
  } else {
    showPanel('idle');
  }
});

// ── Countdown ──────────────────────────────────────────────────────────────

function startCountdown(expiresAt) {
  stopCountdown();
  countdownInterval = setInterval(() => {
    const remaining = Math.max(0, expiresAt.getTime() - Date.now());
    const secs = Math.ceil(remaining / 1000);
    const mm = String(Math.floor(secs / 60)).padStart(2, '0');
    const ss = String(secs % 60).padStart(2, '0');
    countdownEl.textContent = `${mm}:${ss}`;
    countdownEl.classList.toggle('urgent', secs <= 10);

    if (remaining === 0) {
      stopCountdown();
      // Hold expired client-side – update UI proactively.
      if (activeHold) {
        const seatIds = activeHold.seatIds;
        activeHold = null;
        store.patchSeats(seatIds.map(id => ({
          id,
          status: 'available',
          holdId: null,
          holdExpiresAt: null,
        })));
        renderSeatMap(store.getSeats());
        showError('Your hold has expired. The seats are now available again.');
      }
    }
  }, 500);
}

function stopCountdown() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
  countdownEl.textContent = '--';
  countdownEl.classList.remove('urgent');
}

// ── Error display ──────────────────────────────────────────────────────────

function showError(msg) {
  errorMessage.textContent = msg;
  showPanel('error');
}

// ── SSE ────────────────────────────────────────────────────────────────────

function connectSSE() {
  // In dev, Vite proxies /api → backend. In prod, VITE_API_BASE points to backend.
  const BASE = import.meta.env.VITE_API_BASE ?? '';
  const es = new EventSource(`${BASE}/api/stream`);

  es.addEventListener('seat_update', (e) => {
    const { seats } = JSON.parse(e.data);

    // Patch the store with incoming updates.
    store.patchSeats(seats);
    patchSeatElements(seats);

    // If any of our held seats were released by the server (expiry / conflict),
    // update the UI accordingly.
    if (activeHold) {
      const mySeats = new Set(activeHold.seatIds);
      const released = seats.filter(
        s => mySeats.has(s.id) && s.status !== 'held'
      );
      if (released.length > 0) {
        stopCountdown();
        activeHold = null;
        showError('Your hold has expired or been released by the server.');
      }
    }
  });

  es.addEventListener('connected', () => {
    console.log('[SSE] Connected to seat-update stream.');
  });

  es.onerror = () => {
    console.warn('[SSE] Connection lost, will reconnect in 3 s…');
    es.close();
    setTimeout(connectSSE, 3000);
  };
}

// ── Data loading ───────────────────────────────────────────────────────────

async function refreshSeats() {
  const res = await api.getSeats();
  if (res.ok) {
    store.setSeats(res.data.seats);
    renderSeatMap(store.getSeats());
  }
}

// ── Init ───────────────────────────────────────────────────────────────────

(async () => {
  showPanel('idle');
  await refreshSeats();
  connectSSE();
})();
