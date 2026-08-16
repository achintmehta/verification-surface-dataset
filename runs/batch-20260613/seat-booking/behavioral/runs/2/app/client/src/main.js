/**
 * Seat Booking – Vanilla JS SPA
 *
 * State machine:
 *   idle      → user selects seats → hold-pending → hold-active
 *   hold-active → confirm → booked
 *   hold-active → release / expire → idle
 */

// ─── Session ID ───────────────────────────────────────────────────────────────

function getOrCreateSessionId() {
  let id = sessionStorage.getItem('seat-booking-session');
  if (!id) {
    id = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    sessionStorage.setItem('seat-booking-session', id);
  }
  return id;
}

const SESSION_ID = getOrCreateSessionId();

// ─── State ────────────────────────────────────────────────────────────────────

/** @type {Map<string, {id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by}>} */
const seatMap = new Map();

/** Currently selected seat IDs (pre-hold) */
const selectedIds = new Set();

/** Active hold info */
let activeHold = null; // { id, expiresAt: Date, seatIds: string[] }

/** Countdown timer handle */
let countdownTimer = null;

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const $loading       = document.getElementById('loading');
const $seatMap       = document.getElementById('seat-map');
const $selectionInfo = document.getElementById('selection-info');
const $holdBtn       = document.getElementById('hold-btn');
const $selectionPanel = document.getElementById('selection-panel');
const $holdPanel     = document.getElementById('hold-panel');
const $holdSeatsList = document.getElementById('hold-seats-list');
const $holdTimer     = document.getElementById('hold-timer');
const $confirmBtn    = document.getElementById('confirm-btn');
const $releaseBtn    = document.getElementById('release-btn');
const $bookingPanel  = document.getElementById('booking-panel');
const $bookedSeatsList = document.getElementById('booked-seats-list');
const $newBookingBtn = document.getElementById('new-booking-btn');
const $errorPanel    = document.getElementById('error-panel');
const $errorText     = document.getElementById('error-text');
const $errorDismiss  = document.getElementById('error-dismiss-btn');
const $sessionDisplay = document.getElementById('session-id-display');
const $invAvailable  = document.getElementById('inv-available');
const $invHeld       = document.getElementById('inv-held');
const $invBooked     = document.getElementById('inv-booked');
const $invTotal      = document.getElementById('inv-total');

// ─── Init ─────────────────────────────────────────────────────────────────────

$sessionDisplay.textContent = SESSION_ID;

// Add SSE status indicator to header
const $sseStatus = document.createElement('span');
$sseStatus.id = 'sse-status';
document.getElementById('session-info').prepend($sseStatus);

async function init() {
  await loadSeats();
  connectSSE();
}

// ─── API helpers ──────────────────────────────────────────────────────────────

const API = '/api';

async function apiFetch(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

// ─── Load seats ───────────────────────────────────────────────────────────────

async function loadSeats() {
  $loading.hidden = false;
  $seatMap.hidden = true;

  const { ok, body } = await apiFetch('/seats');
  if (!ok) {
    $loading.textContent = 'Failed to load seats. Please refresh.';
    return;
  }

  seatMap.clear();
  for (const seat of body.seats) {
    seatMap.set(seat.id, seat);
  }

  renderSeatMap();
  updateInventoryBar();

  $loading.hidden = true;
  $seatMap.hidden = false;
}

// ─── Render seat map ──────────────────────────────────────────────────────────

function renderSeatMap() {
  $seatMap.innerHTML = '';

  // Group by row
  const rows = new Map();
  for (const seat of seatMap.values()) {
    if (!rows.has(seat.row_label)) rows.set(seat.row_label, []);
    rows.get(seat.row_label).push(seat);
  }

  for (const [rowLabel, seats] of [...rows.entries()].sort()) {
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';

    const labelEl = document.createElement('div');
    labelEl.className = 'row-label';
    labelEl.textContent = rowLabel;
    rowEl.appendChild(labelEl);

    for (const seat of seats.sort((a, b) => a.seat_number - b.seat_number)) {
      rowEl.appendChild(createSeatEl(seat));
    }

    $seatMap.appendChild(rowEl);
  }
}

function createSeatEl(seat) {
  const el = document.createElement('div');
  el.className = `seat ${getSeatClass(seat)}`;
  el.dataset.id = seat.id;
  el.title = getSeatTitle(seat);
  el.textContent = seat.seat_number;

  el.addEventListener('click', () => onSeatClick(seat.id));
  return el;
}

function getSeatClass(seat) {
  if (seat.status === 'booked') return 'booked';
  if (seat.status === 'held') {
    if (activeHold && activeHold.seatIds.includes(seat.id)) return 'held-mine';
    return 'held-other';
  }
  if (selectedIds.has(seat.id)) return 'selected';
  return 'available';
}

function getSeatTitle(seat) {
  const label = `${seat.row_label}${seat.seat_number}`;
  if (seat.status === 'booked') return `${label} – Booked`;
  if (seat.status === 'held') {
    if (activeHold && activeHold.seatIds.includes(seat.id)) return `${label} – Your hold`;
    return `${label} – Held`;
  }
  if (selectedIds.has(seat.id)) return `${label} – Selected`;
  return `${label} – Available`;
}

function updateSeatEl(seatId) {
  const seat = seatMap.get(seatId);
  if (!seat) return;
  const el = $seatMap.querySelector(`[data-id="${seatId}"]`);
  if (!el) return;
  el.className = `seat ${getSeatClass(seat)}`;
  el.title = getSeatTitle(seat);
}

function updateInventoryBar() {
  let available = 0, held = 0, booked = 0;
  for (const s of seatMap.values()) {
    if (s.status === 'available') available++;
    else if (s.status === 'held') held++;
    else if (s.status === 'booked') booked++;
  }
  const total = seatMap.size;
  $invAvailable.textContent = `Available: ${available}`;
  $invHeld.textContent      = `Held: ${held}`;
  $invBooked.textContent    = `Booked: ${booked}`;
  $invTotal.textContent     = `Total: ${total}`;
}

// ─── Seat click ───────────────────────────────────────────────────────────────

function onSeatClick(seatId) {
  // Ignore clicks when a hold is active or booking is done
  if (activeHold) return;
  if ($bookingPanel && !$bookingPanel.hidden) return;

  const seat = seatMap.get(seatId);
  if (!seat || seat.status !== 'available') return;

  if (selectedIds.has(seatId)) {
    selectedIds.delete(seatId);
  } else {
    selectedIds.add(seatId);
  }

  updateSeatEl(seatId);
  updateSelectionPanel();
}

function updateSelectionPanel() {
  const count = selectedIds.size;
  if (count === 0) {
    $selectionInfo.textContent = 'Click available seats to select them.';
    $holdBtn.disabled = true;
  } else {
    const ids = [...selectedIds].join(', ');
    $selectionInfo.textContent = `Selected: ${ids}`;
    $holdBtn.disabled = false;
  }
}

// ─── Hold flow ────────────────────────────────────────────────────────────────

$holdBtn.addEventListener('click', async () => {
  if (selectedIds.size === 0) return;
  $holdBtn.disabled = true;

  const seatIds = [...selectedIds];
  const { ok, status, body } = await apiFetch('/holds', {
    method: 'POST',
    body: JSON.stringify({ seatIds, sessionId: SESSION_ID }),
  });

  if (ok) {
    // Update local seat state
    for (const seat of body.seats) {
      seatMap.set(seat.id, seat);
    }

    activeHold = {
      id: body.hold.id,
      expiresAt: new Date(body.hold.expiresAt),
      seatIds: body.hold.seatIds,
    };

    selectedIds.clear();
    renderSeatMap();
    updateInventoryBar();
    showHoldPanel();
  } else if (status === 409) {
    const conflicting = body.conflictingSeats || [];
    showError(
      `Seats already taken: ${conflicting.join(', ')}. Please choose different seats.`
    );
    // Deselect conflicting seats and refresh
    for (const id of conflicting) {
      selectedIds.delete(id);
    }
    await loadSeats();
    updateSelectionPanel();
    $holdBtn.disabled = selectedIds.size === 0;
  } else {
    showError(`Failed to place hold (${status}). Please try again.`);
    $holdBtn.disabled = false;
  }
});

function showHoldPanel() {
  $selectionPanel.hidden = true;
  $holdPanel.hidden = false;
  $bookingPanel.hidden = true;
  $errorPanel.hidden = true;

  $holdSeatsList.textContent = activeHold.seatIds.join(', ');
  startCountdown();
}

function startCountdown() {
  clearInterval(countdownTimer);
  updateCountdown();
  countdownTimer = setInterval(updateCountdown, 500);
}

function updateCountdown() {
  if (!activeHold) { clearInterval(countdownTimer); return; }
  const remaining = Math.max(0, activeHold.expiresAt - Date.now());
  const secs = Math.ceil(remaining / 1000);
  $holdTimer.textContent = `⏱ ${secs}s`;
  $holdTimer.classList.toggle('urgent', secs <= 10);

  if (remaining <= 0) {
    clearInterval(countdownTimer);
    onHoldExpiredLocally();
  }
}

function onHoldExpiredLocally() {
  // The server will have expired the hold; update UI
  if (!activeHold) return;
  const expiredSeatIds = activeHold.seatIds;
  activeHold = null;

  for (const id of expiredSeatIds) {
    const seat = seatMap.get(id);
    if (seat && seat.status === 'held') {
      seat.status = 'available';
      seat.hold_id = null;
      seat.hold_expires_at = null;
    }
  }

  renderSeatMap();
  updateInventoryBar();
  showSelectionPanel();
  showError('Your hold expired. Please select seats again.');
}

// ─── Confirm flow ─────────────────────────────────────────────────────────────

$confirmBtn.addEventListener('click', async () => {
  if (!activeHold) return;
  $confirmBtn.disabled = true;
  $releaseBtn.disabled = true;

  const { ok, status, body } = await apiFetch(`/holds/${activeHold.id}/confirm`, {
    method: 'POST',
    body: JSON.stringify({ sessionId: SESSION_ID }),
  });

  if (ok) {
    clearInterval(countdownTimer);
    const bookedIds = body.bookedSeatIds;

    for (const id of bookedIds) {
      const seat = seatMap.get(id);
      if (seat) {
        seat.status = 'booked';
        seat.booked_by = SESSION_ID;
        seat.hold_id = null;
        seat.hold_expires_at = null;
      }
    }

    activeHold = null;
    renderSeatMap();
    updateInventoryBar();
    showBookingPanel(bookedIds);
  } else if (status === 410) {
    clearInterval(countdownTimer);
    activeHold = null;
    await loadSeats();
    showSelectionPanel();
    showError('Hold expired before confirmation. Please try again.');
  } else {
    showError(`Confirmation failed (${status}): ${body.error || 'Unknown error'}`);
    $confirmBtn.disabled = false;
    $releaseBtn.disabled = false;
  }
});

// ─── Release flow ─────────────────────────────────────────────────────────────

$releaseBtn.addEventListener('click', async () => {
  if (!activeHold) return;
  $confirmBtn.disabled = true;
  $releaseBtn.disabled = true;

  const holdId = activeHold.id;
  const { ok, status, body } = await apiFetch(`/holds/${holdId}`, {
    method: 'DELETE',
    body: JSON.stringify({ sessionId: SESSION_ID }),
  });

  clearInterval(countdownTimer);

  if (ok) {
    for (const id of (body.released || [])) {
      const seat = seatMap.get(id);
      if (seat) {
        seat.status = 'available';
        seat.hold_id = null;
        seat.hold_expires_at = null;
      }
    }
    activeHold = null;
    renderSeatMap();
    updateInventoryBar();
    showSelectionPanel();
  } else {
    showError(`Release failed (${status}): ${body.error || 'Unknown error'}`);
    $confirmBtn.disabled = false;
    $releaseBtn.disabled = false;
  }
});

// ─── Panel helpers ────────────────────────────────────────────────────────────

function showSelectionPanel() {
  $selectionPanel.hidden = false;
  $holdPanel.hidden = true;
  $bookingPanel.hidden = true;
  selectedIds.clear();
  updateSelectionPanel();
}

function showBookingPanel(bookedIds) {
  $selectionPanel.hidden = true;
  $holdPanel.hidden = true;
  $bookingPanel.hidden = false;
  $bookedSeatsList.textContent = bookedIds.join(', ');
}

function showError(msg) {
  $errorText.textContent = msg;
  $errorPanel.hidden = false;
}

$errorDismiss.addEventListener('click', () => {
  $errorPanel.hidden = true;
});

$newBookingBtn.addEventListener('click', () => {
  showSelectionPanel();
  $bookingPanel.hidden = true;
});

// ─── SSE ──────────────────────────────────────────────────────────────────────

function connectSSE() {
  const es = new EventSource('/api/stream');

  es.addEventListener('open', () => {
    $sseStatus.className = 'connected';
    $sseStatus.title = 'Live updates connected';
  });

  es.addEventListener('seat-update', (e) => {
    try {
      const { type, seats } = JSON.parse(e.data);
      handleSeatUpdate(type, seats);
    } catch (err) {
      console.warn('[SSE] Failed to parse event:', err);
    }
  });

  es.addEventListener('error', () => {
    $sseStatus.className = 'disconnected';
    $sseStatus.title = 'Live updates disconnected – reconnecting…';
  });
}

function handleSeatUpdate(type, seats) {
  let changed = false;

  for (const update of seats) {
    const existing = seatMap.get(update.id);
    if (!existing) continue;

    // Don't overwrite our own held seats with SSE updates from the server
    // (we already updated them locally); but do update if it's a different hold
    if (type === 'held') {
      // If this is our own hold, we already have the data
      if (activeHold && activeHold.seatIds.includes(update.id)) continue;
      existing.status = 'held';
      existing.hold_id = update.holdId || null;
      existing.hold_expires_at = update.holdExpiresAt || null;
      // Deselect if someone else just held a seat we had selected
      if (selectedIds.has(update.id)) {
        selectedIds.delete(update.id);
      }
    } else if (type === 'booked') {
      // If we just confirmed, we already updated locally
      if (activeHold === null && existing.status === 'booked') continue;
      existing.status = 'booked';
      existing.hold_id = update.holdId || null;
      existing.hold_expires_at = null;
    } else if (type === 'released') {
      // Only update if not our own active hold
      if (activeHold && activeHold.seatIds.includes(update.id)) continue;
      existing.status = 'available';
      existing.hold_id = null;
      existing.hold_expires_at = null;
    }

    changed = true;
    updateSeatEl(update.id);
  }

  if (changed) {
    updateInventoryBar();
    updateSelectionPanel();
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

init();
