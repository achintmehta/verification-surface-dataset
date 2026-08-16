/**
 * main.js – Seat Booking SPA
 *
 * Responsibilities:
 *  • Render the seat map from GET /api/seats
 *  • Allow selecting available seats and placing a hold
 *  • Show a live countdown for the active hold
 *  • Allow confirming or releasing the hold
 *  • Connect to GET /api/stream (SSE) and update seat statuses in real time
 *  • Handle 409 conflicts by flashing the conflicting seats and refreshing
 */

// ── Session ID ────────────────────────────────────────────────────────────────
// Persist across page reloads so the user can confirm a hold after a refresh.
let SESSION_ID = localStorage.getItem('seatBookingSession');
if (!SESSION_ID) {
  SESSION_ID = crypto.randomUUID();
  localStorage.setItem('seatBookingSession', SESSION_ID);
}
document.getElementById('session-id-display').textContent = SESSION_ID.slice(0, 18) + '…';

// ── State ─────────────────────────────────────────────────────────────────────
let seats = {};          // id → seat object
let selectedIds = new Set();
let activeHold = null;   // { id, seatIds, expiresAt }
let countdownTimer = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const seatMapEl       = document.getElementById('seat-map');
const invAvailable    = document.getElementById('inv-available');
const invHeld         = document.getElementById('inv-held');
const invBooked       = document.getElementById('inv-booked');
const invTotal        = document.getElementById('inv-total');
const selectedCount   = document.getElementById('selected-count');
const holdSeatList    = document.getElementById('hold-seat-list');
const holdCountdown   = document.getElementById('hold-countdown');
const bookedSeatList  = document.getElementById('booked-seat-list');
const errorMessage    = document.getElementById('error-message');
const sseDot          = document.getElementById('sse-dot');
const sseLabel        = document.getElementById('sse-label');

// Panel states
const panels = {
  idle:     document.getElementById('panel-idle'),
  selected: document.getElementById('panel-selected'),
  hold:     document.getElementById('panel-hold'),
  booked:   document.getElementById('panel-booked'),
  error:    document.getElementById('panel-error'),
};

// Buttons
document.getElementById('btn-hold').addEventListener('click', onHoldClick);
document.getElementById('btn-clear-selection').addEventListener('click', clearSelection);
document.getElementById('btn-confirm').addEventListener('click', onConfirmClick);
document.getElementById('btn-release').addEventListener('click', onReleaseClick);
document.getElementById('btn-new-booking').addEventListener('click', resetToIdle);
document.getElementById('btn-error-dismiss').addEventListener('click', () => showPanel('idle'));

// ── Panel management ──────────────────────────────────────────────────────────
function showPanel(name) {
  for (const [k, el] of Object.entries(panels)) {
    el.classList.toggle('active', k === name);
  }
}

// ── Seat map rendering ────────────────────────────────────────────────────────
function effectiveStatus(seat) {
  if (seat.status === 'held' && seat.hold_expires_at) {
    if (new Date(seat.hold_expires_at) <= new Date()) return 'available';
  }
  return seat.status;
}

function seatClass(seat) {
  const eff = effectiveStatus(seat);
  if (eff === 'available') {
    return selectedIds.has(seat.id) ? 'selected' : 'available';
  }
  if (eff === 'held') {
    // Is this our own hold?
    if (activeHold && activeHold.seatIds.includes(seat.id)) return 'held-own';
    return 'held-other';
  }
  if (eff === 'booked') return 'booked';
  return 'available';
}

function renderSeatMap() {
  // Group by row
  const rows = {};
  for (const seat of Object.values(seats)) {
    if (!rows[seat.row_label]) rows[seat.row_label] = [];
    rows[seat.row_label].push(seat);
  }

  seatMapEl.innerHTML = '';

  for (const rowLabel of Object.keys(rows).sort()) {
    const rowSeats = rows[rowLabel].sort((a, b) => a.seat_number - b.seat_number);

    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';

    const labelEl = document.createElement('div');
    labelEl.className = 'row-label';
    labelEl.textContent = rowLabel;
    rowEl.appendChild(labelEl);

    const seatsEl = document.createElement('div');
    seatsEl.className = 'seats-in-row';

    for (const seat of rowSeats) {
      const btn = document.createElement('button');
      btn.className = `seat ${seatClass(seat)}`;
      btn.dataset.id = seat.id;
      btn.title = `${seat.id} – ${seatClass(seat)}`;
      btn.textContent = seat.seat_number;
      btn.setAttribute('aria-label', `Seat ${seat.id}`);

      const cls = seatClass(seat);
      if (cls === 'available' || cls === 'selected') {
        btn.addEventListener('click', () => onSeatClick(seat.id));
      } else {
        btn.disabled = true;
      }

      seatsEl.appendChild(btn);
    }

    rowEl.appendChild(seatsEl);
    seatMapEl.appendChild(rowEl);
  }

  updateInventory();
}

function updateSeatElement(seatId) {
  const seat = seats[seatId];
  if (!seat) return;
  const btn = seatMapEl.querySelector(`[data-id="${seatId}"]`);
  if (!btn) return;

  const cls = seatClass(seat);
  btn.className = `seat ${cls}`;
  btn.title = `${seat.id} – ${cls}`;

  // Re-attach or remove click handler
  const newBtn = btn.cloneNode(true);
  if (cls === 'available' || cls === 'selected') {
    newBtn.addEventListener('click', () => onSeatClick(seatId));
    newBtn.disabled = false;
  } else {
    newBtn.disabled = true;
  }
  btn.replaceWith(newBtn);
}

function updateInventory() {
  let avail = 0, held = 0, booked = 0;
  for (const seat of Object.values(seats)) {
    const eff = effectiveStatus(seat);
    if (eff === 'available') avail++;
    else if (eff === 'held') held++;
    else if (eff === 'booked') booked++;
  }
  const total = avail + held + booked;
  invAvailable.textContent = `Available: ${avail}`;
  invHeld.textContent      = `Held: ${held}`;
  invBooked.textContent    = `Booked: ${booked}`;
  invTotal.textContent     = `Total: ${total}`;
}

// ── Seat click ────────────────────────────────────────────────────────────────
function onSeatClick(seatId) {
  // Ignore if we have an active hold
  if (activeHold) return;

  const seat = seats[seatId];
  if (!seat || effectiveStatus(seat) !== 'available') return;

  if (selectedIds.has(seatId)) {
    selectedIds.delete(seatId);
  } else {
    selectedIds.add(seatId);
  }

  updateSeatElement(seatId);
  updateSelectionPanel();
}

function updateSelectionPanel() {
  selectedCount.textContent = selectedIds.size;
  if (selectedIds.size > 0) {
    showPanel('selected');
  } else {
    showPanel('idle');
  }
}

function clearSelection() {
  const prev = [...selectedIds];
  selectedIds.clear();
  for (const id of prev) updateSeatElement(id);
  showPanel('idle');
}

// ── Hold ──────────────────────────────────────────────────────────────────────
async function onHoldClick() {
  if (selectedIds.size === 0) return;

  const seatIds = [...selectedIds];
  try {
    const res = await fetch('/api/holds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId: SESSION_ID }),
    });

    const data = await res.json();

    if (res.status === 409) {
      // Conflict – flash the conflicting seats
      const conflictIds = data.conflictIds ?? [];
      flashConflict(conflictIds);
      showError(
        `Seats ${conflictIds.join(', ')} are no longer available. Please choose different seats.`
      );
      // Refresh seat map
      await loadSeats();
      return;
    }

    if (!res.ok) {
      showError(data.error ?? 'Failed to place hold.');
      return;
    }

    // Success
    activeHold = {
      id: data.hold.id,
      seatIds: data.hold.seatIds,
      expiresAt: new Date(data.hold.expiresAt),
    };
    selectedIds.clear();

    // Update seat states locally (SSE will also arrive, but this is instant)
    for (const id of activeHold.seatIds) {
      if (seats[id]) {
        seats[id].status = 'held';
        seats[id].hold_id = activeHold.id;
        seats[id].hold_expires_at = data.hold.expiresAt;
      }
    }

    holdSeatList.textContent = activeHold.seatIds.join(', ');
    startCountdown();
    showPanel('hold');
    renderSeatMap();
  } catch (err) {
    showError('Network error: ' + err.message);
  }
}

// ── Countdown ─────────────────────────────────────────────────────────────────
function startCountdown() {
  stopCountdown();
  countdownTimer = setInterval(tickCountdown, 500);
  tickCountdown();
}

function stopCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

function tickCountdown() {
  if (!activeHold) { stopCountdown(); return; }
  const remaining = Math.max(0, activeHold.expiresAt - Date.now());
  const secs = Math.ceil(remaining / 1000);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  holdCountdown.textContent = `${m}:${String(s).padStart(2, '0')}`;
  holdCountdown.classList.toggle('urgent', secs <= 10);

  if (remaining <= 0) {
    stopCountdown();
    // Hold expired client-side – show error and refresh
    activeHold = null;
    showError('Your hold has expired. Please select seats again.');
    loadSeats();
  }
}

// ── Confirm ───────────────────────────────────────────────────────────────────
async function onConfirmClick() {
  if (!activeHold) return;

  try {
    const res = await fetch(`/api/holds/${activeHold.id}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });

    const data = await res.json();

    if (!res.ok) {
      const msg = data.error ?? 'Failed to confirm booking.';
      activeHold = null;
      stopCountdown();
      showError(msg);
      await loadSeats();
      return;
    }

    // Success
    const bookedIds = data.booking.seatIds;
    stopCountdown();
    activeHold = null;

    // Update local state
    for (const id of bookedIds) {
      if (seats[id]) {
        seats[id].status = 'booked';
        seats[id].hold_id = null;
        seats[id].hold_expires_at = null;
        seats[id].booked_by = SESSION_ID;
      }
    }

    bookedSeatList.textContent = bookedIds.join(', ');
    showPanel('booked');
    renderSeatMap();
  } catch (err) {
    showError('Network error: ' + err.message);
  }
}

// ── Release ───────────────────────────────────────────────────────────────────
async function onReleaseClick() {
  if (!activeHold) return;

  try {
    const res = await fetch(`/api/holds/${activeHold.id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });

    const data = await res.json();

    if (!res.ok) {
      showError(data.error ?? 'Failed to release hold.');
      return;
    }

    const releasedIds = data.seatIds ?? [];
    stopCountdown();
    activeHold = null;

    for (const id of releasedIds) {
      if (seats[id]) {
        seats[id].status = 'available';
        seats[id].hold_id = null;
        seats[id].hold_expires_at = null;
      }
    }

    showPanel('idle');
    renderSeatMap();
  } catch (err) {
    showError('Network error: ' + err.message);
  }
}

// ── Reset ─────────────────────────────────────────────────────────────────────
function resetToIdle() {
  selectedIds.clear();
  showPanel('idle');
  renderSeatMap();
}

// ── Error helpers ─────────────────────────────────────────────────────────────
function showError(msg) {
  errorMessage.textContent = msg;
  showPanel('error');
}

function flashConflict(ids) {
  for (const id of ids) {
    const btn = seatMapEl.querySelector(`[data-id="${id}"]`);
    if (btn) {
      btn.classList.add('conflict-flash');
      btn.addEventListener('animationend', () => btn.classList.remove('conflict-flash'), { once: true });
    }
  }
}

// ── Load seats ────────────────────────────────────────────────────────────────
async function loadSeats() {
  try {
    const res = await fetch('/api/seats');
    const data = await res.json();

    seats = {};
    for (const seat of data.seats) {
      seats[seat.id] = seat;
    }

    // If we had an active hold, verify it's still valid
    if (activeHold) {
      const holdSeats = activeHold.seatIds.filter(
        (id) => seats[id]?.status === 'held' && seats[id]?.hold_id === activeHold.id
      );
      if (holdSeats.length === 0) {
        // Hold is gone
        stopCountdown();
        activeHold = null;
        showPanel('idle');
      }
    }

    renderSeatMap();
  } catch (err) {
    seatMapEl.innerHTML = `<div class="loading-spinner" style="color:#ff8a8a">Failed to load seats: ${err.message}</div>`;
  }
}

// ── SSE ───────────────────────────────────────────────────────────────────────
function connectSSE() {
  const es = new EventSource('/api/stream');

  es.addEventListener('connected', () => {
    sseDot.className = 'sse-dot connected';
    sseLabel.textContent = 'Live';
  });

  es.addEventListener('seats_held', (e) => {
    const { seatIds, holdId, expiresAt } = JSON.parse(e.data);
    for (const id of seatIds) {
      if (seats[id]) {
        seats[id].status = 'held';
        seats[id].hold_id = holdId;
        seats[id].hold_expires_at = expiresAt;
        updateSeatElement(id);
      }
    }
    updateInventory();
  });

  es.addEventListener('seats_booked', (e) => {
    const { seatIds, holdId } = JSON.parse(e.data);
    for (const id of seatIds) {
      if (seats[id]) {
        seats[id].status = 'booked';
        seats[id].hold_id = null;
        seats[id].hold_expires_at = null;
        seats[id].booked_by = holdId;
        updateSeatElement(id);
      }
    }
    updateInventory();
  });

  es.addEventListener('seats_released', (e) => {
    const { seatIds } = JSON.parse(e.data);
    for (const id of seatIds) {
      if (seats[id]) {
        // Don't override our own active hold seats
        if (activeHold && activeHold.seatIds.includes(id)) continue;
        seats[id].status = 'available';
        seats[id].hold_id = null;
        seats[id].hold_expires_at = null;
        updateSeatElement(id);
      }
    }
    updateInventory();
  });

  es.onerror = () => {
    sseDot.className = 'sse-dot disconnected';
    sseLabel.textContent = 'Reconnecting…';
    // EventSource auto-reconnects; we just update the UI
  };

  es.onopen = () => {
    sseDot.className = 'sse-dot connected';
    sseLabel.textContent = 'Live';
  };
}

// ── Boot ──────────────────────────────────────────────────────────────────────
(async () => {
  await loadSeats();
  connectSSE();
})();
