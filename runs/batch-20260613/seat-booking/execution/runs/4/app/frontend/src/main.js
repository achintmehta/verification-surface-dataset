/**
 * main.js – Seat Booking SPA
 *
 * Responsibilities:
 *   1. Fetch and render the seat map from GET /api/seats.
 *   2. Allow the user to select available seats and request a hold.
 *   3. Show a live countdown for the active hold.
 *   4. Allow confirming or releasing the active hold.
 *   5. Connect to GET /api/stream (SSE) and apply live seat-status updates.
 *   6. Handle 409 conflicts by highlighting the conflicting seats.
 */

// ── Session identity ──────────────────────────────────────────────────────────

function getSessionId() {
  let id = sessionStorage.getItem('sessionId');
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem('sessionId', id);
  }
  return id;
}

const SESSION_ID = getSessionId();

// ── State ─────────────────────────────────────────────────────────────────────

/** @type {Map<string, object>} seatId → seat object */
let seats = new Map();

/** Currently selected seat ids (before a hold is placed). */
let selectedIds = new Set();

/** Active hold state. */
let activeHold = null; // { holdId, seatIds, expiresAt }

/** Countdown interval handle. */
let countdownInterval = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────

const seatMapEl       = document.getElementById('seat-map');
const notificationEl  = document.getElementById('notification');
const selectionInfoEl = document.getElementById('selection-info');
const btnHold         = document.getElementById('btn-hold');
const panelSelect     = document.getElementById('panel-select');
const panelHold       = document.getElementById('panel-hold');
const panelBooked     = document.getElementById('panel-booked');
const countdownEl     = document.getElementById('countdown');
const holdSeatsInfoEl = document.getElementById('hold-seats-info');
const bookedSeatsInfoEl = document.getElementById('booked-seats-info');
const btnConfirm      = document.getElementById('btn-confirm');
const btnRelease      = document.getElementById('btn-release');
const btnNewBooking   = document.getElementById('btn-new-booking');
const invAvailable    = document.getElementById('inv-available');
const invHeld         = document.getElementById('inv-held');
const invBooked       = document.getElementById('inv-booked');
const invTotal        = document.getElementById('inv-total');

// ── Notification helpers ──────────────────────────────────────────────────────

let notifTimeout = null;

function showNotification(message, type = 'info', durationMs = 4000) {
  notificationEl.textContent = message;
  notificationEl.className = `notification ${type}`;
  if (notifTimeout) clearTimeout(notifTimeout);
  if (durationMs > 0) {
    notifTimeout = setTimeout(() => {
      notificationEl.className = 'notification hidden';
    }, durationMs);
  }
}

// ── Seat map rendering ────────────────────────────────────────────────────────

/**
 * Determine the CSS class for a seat given its data and current app state.
 */
function seatClass(seat) {
  if (activeHold && activeHold.seatIds.includes(seat.id)) {
    return 'held-mine';
  }
  if (selectedIds.has(seat.id)) {
    return 'selected';
  }
  switch (seat.status) {
    case 'booked':    return 'booked';
    case 'held':      return 'held-other';
    case 'available': return 'available';
    default:          return 'available';
  }
}

function renderSeatMap() {
  seatMapEl.innerHTML = '';

  // Group by row.
  const rows = new Map();
  for (const seat of seats.values()) {
    if (!rows.has(seat.row_label)) rows.set(seat.row_label, []);
    rows.get(seat.row_label).push(seat);
  }

  // Sort rows alphabetically, seats numerically.
  const sortedRows = [...rows.entries()].sort(([a], [b]) => a.localeCompare(b));

  for (const [rowLabel, rowSeats] of sortedRows) {
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';

    const labelEl = document.createElement('div');
    labelEl.className = 'row-label';
    labelEl.textContent = rowLabel;
    rowEl.appendChild(labelEl);

    rowSeats.sort((a, b) => a.seat_number - b.seat_number);

    for (const seat of rowSeats) {
      const seatEl = document.createElement('div');
      seatEl.className = `seat ${seatClass(seat)}`;
      seatEl.dataset.id = seat.id;
      seatEl.textContent = seat.seat_number;
      seatEl.title = `${seat.row_label}${seat.seat_number} – ${seat.status}`;
      seatEl.addEventListener('click', () => onSeatClick(seat.id));
      rowEl.appendChild(seatEl);
    }

    seatMapEl.appendChild(rowEl);
  }

  updateInventory();
}

/**
 * Update a single seat element in the DOM without a full re-render.
 */
function updateSeatElement(seatId) {
  const seat = seats.get(seatId);
  if (!seat) return;
  const el = seatMapEl.querySelector(`[data-id="${seatId}"]`);
  if (!el) return;
  el.className = `seat ${seatClass(seat)}`;
  el.title = `${seat.row_label}${seat.seat_number} – ${seat.status}`;
}

// ── Inventory summary ─────────────────────────────────────────────────────────

function updateInventory() {
  let available = 0, held = 0, booked = 0;
  for (const seat of seats.values()) {
    if (seat.status === 'available') available++;
    else if (seat.status === 'held') held++;
    else if (seat.status === 'booked') booked++;
  }
  invAvailable.textContent = available;
  invHeld.textContent = held;
  invBooked.textContent = booked;
  invTotal.textContent = seats.size;
}

// ── Seat click handler ────────────────────────────────────────────────────────

function onSeatClick(seatId) {
  // Ignore clicks when a hold is active.
  if (activeHold) return;

  const seat = seats.get(seatId);
  if (!seat || seat.status !== 'available') return;

  if (selectedIds.has(seatId)) {
    selectedIds.delete(seatId);
  } else {
    selectedIds.add(seatId);
  }

  updateSeatElement(seatId);
  updateSelectionUI();
}

function updateSelectionUI() {
  const count = selectedIds.size;
  if (count === 0) {
    selectionInfoEl.textContent = 'Click available seats to select them.';
    btnHold.disabled = true;
  } else {
    selectionInfoEl.textContent = `${count} seat${count > 1 ? 's' : ''} selected: ${[...selectedIds].join(', ')}`;
    btnHold.disabled = false;
  }
}

// ── Panel switching ───────────────────────────────────────────────────────────

function showPanel(name) {
  panelSelect.classList.toggle('hidden', name !== 'select');
  panelHold.classList.toggle('hidden', name !== 'hold');
  panelBooked.classList.toggle('hidden', name !== 'booked');
}

// ── Countdown timer ───────────────────────────────────────────────────────────

function startCountdown(expiresAt) {
  if (countdownInterval) clearInterval(countdownInterval);

  function tick() {
    const remaining = Math.max(0, Math.floor((new Date(expiresAt) - Date.now()) / 1000));
    const mins = String(Math.floor(remaining / 60)).padStart(2, '0');
    const secs = String(remaining % 60).padStart(2, '0');
    countdownEl.textContent = `${mins}:${secs}`;
    countdownEl.classList.toggle('urgent', remaining <= 30);

    if (remaining === 0) {
      clearInterval(countdownInterval);
      countdownInterval = null;
      onHoldExpiredLocally();
    }
  }

  tick();
  countdownInterval = setInterval(tick, 1000);
}

function stopCountdown() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
}

/**
 * Called when the local countdown reaches zero (the hold has expired on our end).
 * The server will also release it; we just update the UI proactively.
 */
function onHoldExpiredLocally() {
  if (!activeHold) return;
  showNotification('Your hold has expired. The seats are now available again.', 'warning', 6000);
  clearActiveHold();
  showPanel('select');
  // Refresh the seat map to get the latest state.
  fetchSeats();
}

// ── Hold management ───────────────────────────────────────────────────────────

function setActiveHold(hold) {
  activeHold = hold;
  holdSeatsInfoEl.textContent = `Seats: ${hold.seatIds.join(', ')}`;
  showPanel('hold');
  startCountdown(hold.expiresAt);

  // Re-render so held-mine seats show the right colour.
  renderSeatMap();
}

function clearActiveHold() {
  activeHold = null;
  selectedIds.clear();
  stopCountdown();
  updateSelectionUI();
}

// ── API calls ─────────────────────────────────────────────────────────────────

async function fetchSeats() {
  try {
    const res = await fetch('/api/seats');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    seats.clear();
    for (const seat of data) seats.set(seat.id, seat);
    renderSeatMap();
  } catch (err) {
    console.error('Failed to fetch seats:', err);
    seatMapEl.innerHTML = '<div class="loading">Failed to load seat map. Retrying…</div>';
    setTimeout(fetchSeats, 3000);
  }
}

async function requestHold() {
  if (selectedIds.size === 0) return;
  btnHold.disabled = true;

  try {
    const res = await fetch('/api/holds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds: [...selectedIds], sessionId: SESSION_ID }),
    });

    const data = await res.json();

    if (res.status === 201) {
      // Success.
      showNotification(`Hold placed for ${data.seatIds.length} seat(s)! You have ${data.ttlSeconds}s to confirm.`, 'success');
      setActiveHold({
        holdId: data.holdId,
        seatIds: data.seatIds,
        expiresAt: data.expiresAt,
      });
      selectedIds.clear();
    } else if (res.status === 409) {
      // Conflict – some seats were taken.
      const conflicting = data.conflictingIds ?? [];
      showNotification(
        `Seats ${conflicting.join(', ')} are no longer available. Please re-select.`,
        'error'
      );
      // Flash the conflicting seats.
      flashConflictSeats(conflicting);
      // Deselect the conflicting seats.
      for (const id of conflicting) selectedIds.delete(id);
      // Refresh the seat map.
      await fetchSeats();
      updateSelectionUI();
      btnHold.disabled = selectedIds.size === 0;
    } else {
      showNotification(data.error ?? 'Failed to place hold.', 'error');
      btnHold.disabled = false;
    }
  } catch (err) {
    console.error('requestHold error:', err);
    showNotification('Network error. Please try again.', 'error');
    btnHold.disabled = false;
  }
}

async function confirmHold() {
  if (!activeHold) return;
  btnConfirm.disabled = true;
  btnRelease.disabled = true;

  try {
    const res = await fetch(`/api/holds/${activeHold.holdId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });

    const data = await res.json();

    if (res.ok) {
      const seatList = data.seatIds.join(', ');
      bookedSeatsInfoEl.textContent = `Seats ${seatList} are booked! 🎉`;
      showNotification(`Booking confirmed for seats: ${seatList}`, 'success', 0);
      stopCountdown();
      activeHold = null;
      showPanel('booked');
      // Update local seat state.
      for (const id of data.seatIds) {
        const seat = seats.get(id);
        if (seat) { seat.status = 'booked'; seat.hold_id = data.holdId; }
      }
      renderSeatMap();
    } else if (res.status === 410 || res.status === 404) {
      showNotification('Your hold has expired. Please select seats again.', 'warning', 6000);
      clearActiveHold();
      showPanel('select');
      await fetchSeats();
    } else {
      showNotification(data.error ?? 'Failed to confirm booking.', 'error');
      btnConfirm.disabled = false;
      btnRelease.disabled = false;
    }
  } catch (err) {
    console.error('confirmHold error:', err);
    showNotification('Network error. Please try again.', 'error');
    btnConfirm.disabled = false;
    btnRelease.disabled = false;
  }
}

async function releaseHold() {
  if (!activeHold) return;
  btnRelease.disabled = true;
  btnConfirm.disabled = true;

  try {
    const res = await fetch(`/api/holds/${activeHold.holdId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });

    if (res.ok) {
      showNotification('Hold released. Seats are available again.', 'info');
      clearActiveHold();
      showPanel('select');
      await fetchSeats();
    } else {
      const data = await res.json();
      showNotification(data.error ?? 'Failed to release hold.', 'error');
      btnRelease.disabled = false;
      btnConfirm.disabled = false;
    }
  } catch (err) {
    console.error('releaseHold error:', err);
    showNotification('Network error. Please try again.', 'error');
    btnRelease.disabled = false;
    btnConfirm.disabled = false;
  }
}

// ── Conflict flash ────────────────────────────────────────────────────────────

function flashConflictSeats(seatIds) {
  for (const id of seatIds) {
    const el = seatMapEl.querySelector(`[data-id="${id}"]`);
    if (!el) continue;
    el.classList.add('conflict');
    setTimeout(() => el.classList.remove('conflict'), 2000);
  }
}

// ── SSE – live seat updates ───────────────────────────────────────────────────

function connectSSE() {
  const es = new EventSource('/api/stream');

  es.addEventListener('connected', (e) => {
    const data = JSON.parse(e.data);
    console.log('[SSE] Connected. Clients:', data.clients);
  });

  es.addEventListener('seat-update', (e) => {
    const update = JSON.parse(e.data);
    console.log('[SSE] seat-update:', update);
    applySeatUpdate(update);
  });

  es.onerror = () => {
    console.warn('[SSE] Connection lost. Reconnecting…');
    // EventSource reconnects automatically; we just log.
  };
}

/**
 * Apply a seat-update event from SSE to the local seat map.
 */
function applySeatUpdate(update) {
  const { type, seatIds, holdId, sessionId: updSessionId, expiresAt } = update;

  for (const id of seatIds ?? []) {
    const seat = seats.get(id);
    if (!seat) continue;

    switch (type) {
      case 'held':
        seat.status = 'held';
        seat.hold_id = holdId;
        seat.hold_expires_at = expiresAt;
        break;
      case 'booked':
        seat.status = 'booked';
        seat.hold_id = holdId;
        seat.hold_expires_at = null;
        seat.booked_by = updSessionId;
        break;
      case 'released':
        seat.status = 'available';
        seat.hold_id = null;
        seat.hold_expires_at = null;
        break;
    }

    // If this update affects our active hold's seats (e.g. server released them),
    // we need to handle that.
    if (
      activeHold &&
      activeHold.seatIds.includes(id) &&
      type === 'released' &&
      updSessionId !== SESSION_ID
    ) {
      // Our hold was released by the server (expired).
      // The countdown will handle this locally, but update the UI.
    }

    updateSeatElement(id);
  }

  // If the SSE event is for our own hold being confirmed, update panel.
  if (type === 'booked' && holdId === activeHold?.holdId) {
    // Already handled by the confirm API response; no double-action needed.
  }

  // If our active hold's seats were released by someone else (shouldn't happen
  // in normal flow, but guard anyway).
  if (
    type === 'released' &&
    activeHold &&
    seatIds?.some((id) => activeHold.seatIds.includes(id))
  ) {
    // Check if this release was triggered by our own session (we released it).
    // If not, the server expired our hold.
    if (updSessionId !== SESSION_ID) {
      stopCountdown();
      clearActiveHold();
      showPanel('select');
      showNotification('Your hold was released by the server (expired).', 'warning', 6000);
    }
  }

  updateInventory();
}

// ── Button event listeners ────────────────────────────────────────────────────

btnHold.addEventListener('click', requestHold);
btnConfirm.addEventListener('click', confirmHold);
btnRelease.addEventListener('click', releaseHold);
btnNewBooking.addEventListener('click', () => {
  notificationEl.className = 'notification hidden';
  showPanel('select');
  updateSelectionUI();
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────

(async () => {
  showPanel('select');
  updateSelectionUI();
  await fetchSeats();
  connectSSE();
})();
