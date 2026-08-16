/**
 * Seat Booking – Frontend SPA
 *
 * State machine:
 *   IDLE        → user can select available seats
 *   HOLDING     → user has an active hold; countdown shown
 *   CONFIRMED   → seats booked; show confirmation
 */

// Use relative URL so Vite's dev proxy works; falls back to same-origin in production
const API = '/api';

// ── Session ID ────────────────────────────────────────────────────────────────
function getSessionId() {
  let id = sessionStorage.getItem('sessionId');
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem('sessionId', id);
  }
  return id;
}

const SESSION_ID = getSessionId();
document.getElementById('session-id-display').textContent = SESSION_ID.slice(0, 8) + '…';

// ── App State ─────────────────────────────────────────────────────────────────
let seats = {};          // id → seat object
let selectedIds = new Set();
let activeHold = null;   // { holdId, seatIds, expiresAt }
let countdownInterval = null;
let bookedSeatIds = [];

// ── DOM refs ──────────────────────────────────────────────────────────────────
const seatMapEl        = document.getElementById('seat-map');
const holdPanel        = document.getElementById('hold-panel');
const activeHoldPanel  = document.getElementById('active-hold-panel');
const bookedPanel      = document.getElementById('booked-panel');
const errorPanel       = document.getElementById('error-panel');
const selectedList     = document.getElementById('selected-seats-list');
const heldList         = document.getElementById('held-seats-list');
const bookedList       = document.getElementById('booked-seats-list');
const errorMsg         = document.getElementById('error-message');
const countdown        = document.getElementById('hold-countdown');
const btnHold          = document.getElementById('btn-hold');
const btnClear         = document.getElementById('btn-clear');
const btnConfirm       = document.getElementById('btn-confirm');
const btnRelease       = document.getElementById('btn-release');
const btnNewBooking    = document.getElementById('btn-new-booking');
const btnDismissError  = document.getElementById('btn-dismiss-error');
const invAvailable     = document.getElementById('inv-available');
const invHeld          = document.getElementById('inv-held');
const invBooked        = document.getElementById('inv-booked');
const invTotal         = document.getElementById('inv-total');
const sseStatusEl      = document.getElementById('sse-status');

// ── Panels ────────────────────────────────────────────────────────────────────
function showPanel(name) {
  holdPanel.classList.add('hidden');
  activeHoldPanel.classList.add('hidden');
  bookedPanel.classList.add('hidden');
  errorPanel.classList.add('hidden');
  if (name) document.getElementById(`${name}-panel`).classList.remove('hidden');
}

// ── Seat Map Rendering ────────────────────────────────────────────────────────
function seatClass(seat) {
  if (seat.status === 'booked') return 'seat--booked';
  if (seat.status === 'held') {
    if (activeHold && activeHold.seatIds.includes(seat.id)) return 'seat--held-own';
    return 'seat--held-other';
  }
  if (selectedIds.has(seat.id)) return 'seat--selected';
  return 'seat--available';
}

function renderSeatMap() {
  const rows = {};
  for (const seat of Object.values(seats)) {
    if (!rows[seat.row_label]) rows[seat.row_label] = [];
    rows[seat.row_label].push(seat);
  }

  seatMapEl.innerHTML = '';
  for (const rowLabel of Object.keys(rows).sort()) {
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';

    const labelEl = document.createElement('div');
    labelEl.className = 'row-label';
    labelEl.textContent = rowLabel;
    rowEl.appendChild(labelEl);

    for (const seat of rows[rowLabel].sort((a, b) => a.seat_number - b.seat_number)) {
      const seatEl = document.createElement('div');
      seatEl.className = `seat ${seatClass(seat)}`;
      seatEl.dataset.id = seat.id;
      seatEl.title = `${seat.id}`;
      seatEl.textContent = seat.seat_number;
      seatEl.addEventListener('click', () => onSeatClick(seat.id));
      rowEl.appendChild(seatEl);
    }

    seatMapEl.appendChild(rowEl);
  }

  updateInventory();
}

function updateSeatElement(seatId) {
  const seat = seats[seatId];
  if (!seat) return;
  const el = seatMapEl.querySelector(`[data-id="${seatId}"]`);
  if (!el) return;
  el.className = `seat ${seatClass(seat)}`;
}

function updateInventory() {
  const all = Object.values(seats);
  const now = new Date();
  let available = 0, held = 0, booked = 0;
  for (const s of all) {
    if (s.status === 'booked') booked++;
    else if (s.status === 'held' && s.hold_expires_at && new Date(s.hold_expires_at) >= now) held++;
    else available++;
  }
  invAvailable.textContent = available;
  invHeld.textContent = held;
  invBooked.textContent = booked;
  invTotal.textContent = all.length;
}

// ── Seat Click ────────────────────────────────────────────────────────────────
function onSeatClick(id) {
  const seat = seats[id];
  if (!seat) return;

  // Can't interact while a hold is active or booking confirmed
  if (activeHold || bookedSeatIds.length > 0) return;

  if (seat.status === 'booked') return;
  if (seat.status === 'held') return; // held by someone else

  if (selectedIds.has(id)) {
    selectedIds.delete(id);
  } else {
    selectedIds.add(id);
  }

  updateSeatElement(id);
  renderSelectionPanel();
}

function renderSelectionPanel() {
  if (selectedIds.size === 0) {
    showPanel(null);
    return;
  }
  selectedList.innerHTML = '';
  for (const id of selectedIds) {
    const tag = document.createElement('span');
    tag.className = 'seat-tag';
    tag.textContent = id;
    selectedList.appendChild(tag);
  }
  showPanel('hold');
}

// ── Hold Actions ──────────────────────────────────────────────────────────────
btnHold.addEventListener('click', async () => {
  if (selectedIds.size === 0) return;
  btnHold.disabled = true;
  btnHold.textContent = 'Placing hold…';

  try {
    const res = await fetch(`${API}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds: [...selectedIds], sessionId: SESSION_ID }),
    });
    const data = await res.json();

    if (res.ok) {
      activeHold = { holdId: data.holdId, seatIds: data.seatIds, expiresAt: new Date(data.expiresAt) };
      selectedIds.clear();
      // Update local seat state
      for (const id of activeHold.seatIds) {
        if (seats[id]) {
          seats[id].status = 'held';
          seats[id].hold_expires_at = data.expiresAt;
        }
      }
      renderSeatMap();
      showActiveHoldPanel();
    } else if (res.status === 409) {
      showError(
        `Some seats are no longer available.`,
        data.conflictingSeatIds || []
      );
      // Refresh seat map to reflect reality
      await loadSeats();
      selectedIds.clear();
    } else {
      showError(data.error || 'Failed to place hold');
    }
  } catch (err) {
    showError('Network error: ' + err.message);
  } finally {
    btnHold.disabled = false;
    btnHold.textContent = 'Hold Selected Seats';
  }
});

btnClear.addEventListener('click', () => {
  selectedIds.clear();
  renderSeatMap();
  showPanel(null);
});

function showActiveHoldPanel() {
  heldList.innerHTML = '';
  for (const id of activeHold.seatIds) {
    const tag = document.createElement('span');
    tag.className = 'seat-tag';
    tag.textContent = id;
    heldList.appendChild(tag);
  }
  showPanel('active-hold');
  startCountdown();
}

function startCountdown() {
  if (countdownInterval) clearInterval(countdownInterval);
  countdownInterval = setInterval(() => {
    if (!activeHold) { clearInterval(countdownInterval); return; }
    const remaining = Math.max(0, Math.floor((activeHold.expiresAt - Date.now()) / 1000));
    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    countdown.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
    countdown.classList.toggle('urgent', remaining <= 10);

    if (remaining === 0) {
      clearInterval(countdownInterval);
      handleHoldExpired();
    }
  }, 500);
}

function handleHoldExpired() {
  if (!activeHold) return;
  const expiredIds = [...activeHold.seatIds];
  activeHold = null;
  for (const id of expiredIds) {
    if (seats[id] && seats[id].status === 'held') {
      seats[id].status = 'available';
      seats[id].hold_expires_at = null;
    }
  }
  renderSeatMap();
  showError('Your hold has expired. The seats are now available again.');
}

// ── Confirm ───────────────────────────────────────────────────────────────────
btnConfirm.addEventListener('click', async () => {
  if (!activeHold) return;
  btnConfirm.disabled = true;
  btnConfirm.textContent = 'Confirming…';

  try {
    const res = await fetch(`${API}/holds/${activeHold.holdId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });
    const data = await res.json();

    if (res.ok) {
      bookedSeatIds = activeHold.seatIds;
      clearInterval(countdownInterval);
      activeHold = null;

      for (const id of bookedSeatIds) {
        if (seats[id]) {
          seats[id].status = 'booked';
          seats[id].hold_expires_at = null;
          seats[id].booked_by = SESSION_ID;
        }
      }
      renderSeatMap();
      showBookedPanel();
    } else {
      showError(data.error || 'Confirmation failed');
      if (res.status === 400 && data.error && data.error.includes('expired')) {
        handleHoldExpired();
      }
    }
  } catch (err) {
    showError('Network error: ' + err.message);
  } finally {
    btnConfirm.disabled = false;
    btnConfirm.textContent = '✓ Confirm Booking';
  }
});

// ── Release ───────────────────────────────────────────────────────────────────
btnRelease.addEventListener('click', async () => {
  if (!activeHold) return;
  btnRelease.disabled = true;
  btnRelease.textContent = 'Releasing…';

  try {
    const res = await fetch(`${API}/holds/${activeHold.holdId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });
    const data = await res.json();

    if (res.ok) {
      const releasedIds = activeHold.seatIds;
      clearInterval(countdownInterval);
      activeHold = null;
      for (const id of releasedIds) {
        if (seats[id]) {
          seats[id].status = 'available';
          seats[id].hold_expires_at = null;
        }
      }
      renderSeatMap();
      showPanel(null);
    } else {
      showError(data.error || 'Failed to release hold');
    }
  } catch (err) {
    showError('Network error: ' + err.message);
  } finally {
    btnRelease.disabled = false;
    btnRelease.textContent = '✗ Release Hold';
  }
});

// ── Booked Panel ──────────────────────────────────────────────────────────────
function showBookedPanel() {
  bookedList.innerHTML = '';
  for (const id of bookedSeatIds) {
    const tag = document.createElement('span');
    tag.className = 'seat-tag booked';
    tag.textContent = id;
    bookedList.appendChild(tag);
  }
  showPanel('booked');
}

btnNewBooking.addEventListener('click', () => {
  bookedSeatIds = [];
  showPanel(null);
  renderSeatMap();
});

// ── Error Panel ───────────────────────────────────────────────────────────────
function showError(message, conflictSeats = []) {
  let html = `<strong>Error:</strong> ${escapeHtml(message)}`;
  if (conflictSeats.length > 0) {
    html += `<div class="conflict-seats">`;
    for (const id of conflictSeats) {
      html += `<span class="conflict-seat">${escapeHtml(id)}</span>`;
    }
    html += `</div>`;
  }
  errorMsg.innerHTML = html;
  showPanel('error');
}

btnDismissError.addEventListener('click', () => {
  showPanel(null);
  renderSelectionPanel();
});

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Load Seats ────────────────────────────────────────────────────────────────
async function loadSeats() {
  try {
    const res = await fetch(`${API}/seats`);
    const data = await res.json();
    seats = {};
    for (const seat of data.seats) {
      seats[seat.id] = seat;
    }
    renderSeatMap();
  } catch (err) {
    seatMapEl.innerHTML = `<div class="loading">Failed to load seats: ${escapeHtml(err.message)}</div>`;
  }
}

// ── SSE ───────────────────────────────────────────────────────────────────────
let sseRetryTimeout = null;
let sseRetryDelay = 1000;

function connectSSE() {
  setSseStatus('reconnecting');
  const es = new EventSource(`${API}/stream`);

  es.addEventListener('connected', () => {
    setSseStatus('connected');
    sseRetryDelay = 1000;
  });

  /**
   * seats_held: { holdId, sessionId, expiresAt, seats: [{id, status}] }
   */
  es.addEventListener('seats_held', (e) => {
    const { seats: updatedSeats, expiresAt, holdId } = JSON.parse(e.data);
    for (const s of updatedSeats) {
      if (seats[s.id]) {
        // Don't overwrite our own hold's state (we already updated it)
        if (activeHold && activeHold.holdId === holdId) continue;
        seats[s.id].status = 'held';
        seats[s.id].hold_expires_at = expiresAt;
        updateSeatElement(s.id);
      }
    }
    updateInventory();
  });

  /**
   * seats_booked: { holdId, sessionId, seats: [{id, status}] }
   */
  es.addEventListener('seats_booked', (e) => {
    const { seats: updatedSeats, holdId } = JSON.parse(e.data);
    for (const s of updatedSeats) {
      if (seats[s.id]) {
        if (activeHold && activeHold.holdId === holdId) continue;
        seats[s.id].status = 'booked';
        seats[s.id].hold_expires_at = null;
        updateSeatElement(s.id);
      }
    }
    updateInventory();
  });

  /**
   * seats_released: { seats: [{id, status}] }
   */
  es.addEventListener('seats_released', (e) => {
    const { seats: updatedSeats, holdId } = JSON.parse(e.data);
    for (const s of updatedSeats) {
      if (seats[s.id]) {
        // If this is our own hold being expired server-side, handle it
        if (activeHold && activeHold.holdId === holdId) {
          handleHoldExpired();
          return;
        }
        seats[s.id].status = 'available';
        seats[s.id].hold_expires_at = null;
        updateSeatElement(s.id);
      }
    }
    updateInventory();
  });

  es.onerror = () => {
    setSseStatus('disconnected');
    es.close();
    sseRetryTimeout = setTimeout(() => {
      sseRetryDelay = Math.min(sseRetryDelay * 2, 30_000);
      connectSSE();
    }, sseRetryDelay);
  };
}

function setSseStatus(state) {
  sseStatusEl.className = `sse-status ${state}`;
  sseStatusEl.textContent =
    state === 'connected'    ? '⚡ Live'         :
    state === 'reconnecting' ? '⚡ Connecting…'  :
                               '⚡ Disconnected';
}

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  await loadSeats();
  connectSSE();
})();
