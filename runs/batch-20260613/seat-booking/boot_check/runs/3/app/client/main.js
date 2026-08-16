/**
 * Seat Booking – Vanilla JS SPA
 */

// API base URL – relative so Vite proxy (dev) and same-origin (prod) both work.
const API = '/api';

// ── Session ID ────────────────────────────────────────────────────────────────
function getSessionId() {
  let id = sessionStorage.getItem('seat_session_id');
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem('seat_session_id', id);
  }
  return id;
}

const SESSION_ID = getSessionId();
document.getElementById('session-id-display').textContent = SESSION_ID.slice(0, 8) + '…';

// ── State ─────────────────────────────────────────────────────────────────────
let seats = {};          // id → seat object
let selectedIds = new Set();
let currentHold = null;  // { holdId, seatIds, expiresAt }
let countdownTimer = null;
let bookedSeatIds = new Set(); // seats booked by this session

// ── DOM refs ──────────────────────────────────────────────────────────────────
const seatMapEl        = document.getElementById('seat-map');
const holdPanel        = document.getElementById('hold-panel');
const selectionPanel   = document.getElementById('selection-panel');
const bookedPanel      = document.getElementById('booked-panel');
const errorPanel       = document.getElementById('error-panel');
const holdSeatDisplay  = document.getElementById('hold-seats-display');
const holdCountdown    = document.getElementById('hold-countdown');
const selectedDisplay  = document.getElementById('selected-display');
const selectedList     = document.getElementById('selected-seats-list');
const selectionHint    = document.getElementById('selection-hint');
const holdBtn          = document.getElementById('hold-btn');
const clearBtn         = document.getElementById('clear-btn');
const confirmBtn       = document.getElementById('confirm-btn');
const releaseBtn       = document.getElementById('release-btn');
const bookedDisplay    = document.getElementById('booked-seats-display');
const newBookingBtn    = document.getElementById('new-booking-btn');
const errorMessage     = document.getElementById('error-message');
const conflictSeats    = document.getElementById('conflict-seats');
const conflictList     = document.getElementById('conflict-list');
const errorDismissBtn  = document.getElementById('error-dismiss-btn');
const inventoryDisplay = document.getElementById('inventory-display');
const sseStatusEl      = document.getElementById('sse-status');

// ── Fetch seats ───────────────────────────────────────────────────────────────
async function fetchSeats() {
  const res = await fetch(`${API}/seats`);
  const data = await res.json();
  return data.seats;
}

// ── Render seat map ───────────────────────────────────────────────────────────
function renderSeatMap() {
  // Group by row
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
      rowEl.appendChild(createSeatEl(seat));
    }

    seatMapEl.appendChild(rowEl);
  }

  updateInventory();
}

function createSeatEl(seat) {
  const el = document.createElement('div');
  el.className = 'seat';
  el.dataset.id = seat.id;
  el.textContent = seat.seat_number;
  el.title = `${seat.row_label}${seat.seat_number} – ${getSeatLabel(seat)}`;

  applySeatClass(el, seat);

  el.addEventListener('click', () => onSeatClick(seat.id));
  return el;
}

function getSeatLabel(seat) {
  if (seat.status === 'booked') return bookedSeatIds.has(seat.id) ? 'Booked (yours)' : 'Booked';
  if (seat.status === 'held') {
    if (currentHold && currentHold.seatIds.includes(seat.id)) return 'Your hold';
    return 'Held by other';
  }
  if (selectedIds.has(seat.id)) return 'Selected';
  return 'Available';
}

function applySeatClass(el, seat) {
  el.className = 'seat';
  if (seat.status === 'booked') {
    el.classList.add(bookedSeatIds.has(seat.id) ? 'seat--booked-own' : 'seat--booked');
  } else if (seat.status === 'held') {
    if (currentHold && currentHold.seatIds.includes(seat.id)) {
      el.classList.add('seat--held-own');
    } else {
      el.classList.add('seat--held-other');
    }
  } else if (selectedIds.has(seat.id)) {
    el.classList.add('seat--selected');
  } else {
    el.classList.add('seat--available');
  }
}

function updateSeatEl(seatId) {
  const seat = seats[seatId];
  if (!seat) return;
  const el = seatMapEl.querySelector(`[data-id="${seatId}"]`);
  if (!el) return;
  applySeatClass(el, seat);
  el.title = `${seat.row_label}${seat.seat_number} – ${getSeatLabel(seat)}`;
}

// ── Seat click ────────────────────────────────────────────────────────────────
function onSeatClick(seatId) {
  // Can't interact while holding or booked
  if (currentHold) return;

  const seat = seats[seatId];
  if (!seat) return;
  if (seat.status !== 'available') return;

  if (selectedIds.has(seatId)) {
    selectedIds.delete(seatId);
  } else {
    selectedIds.add(seatId);
  }

  updateSeatEl(seatId);
  updateSelectionPanel();
}

// ── Selection panel ───────────────────────────────────────────────────────────
function updateSelectionPanel() {
  const count = selectedIds.size;
  if (count === 0) {
    selectedDisplay.classList.add('hidden');
    selectionHint.classList.remove('hidden');
    holdBtn.disabled = true;
    clearBtn.disabled = true;
  } else {
    selectedDisplay.classList.remove('hidden');
    selectionHint.classList.add('hidden');
    selectedList.textContent = [...selectedIds].sort().join(', ');
    holdBtn.disabled = false;
    clearBtn.disabled = false;
  }
}

// ── Hold ──────────────────────────────────────────────────────────────────────
holdBtn.addEventListener('click', async () => {
  if (selectedIds.size === 0) return;
  holdBtn.disabled = true;

  try {
    const res = await fetch(`${API}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds: [...selectedIds], sessionId: SESSION_ID }),
    });

    const data = await res.json();

    if (res.status === 201) {
      currentHold = {
        holdId: data.holdId,
        seatIds: data.seatIds,
        expiresAt: new Date(data.expiresAt),
      };
      selectedIds.clear();
      showHoldPanel();
      startCountdown();
      // Update local seat state
      for (const id of currentHold.seatIds) {
        if (seats[id]) {
          seats[id].status = 'held';
          seats[id].hold_id = currentHold.holdId;
          seats[id].hold_expires_at = data.expiresAt;
          updateSeatEl(id);
        }
      }
      updateInventory();
    } else if (res.status === 409) {
      showError(
        'Some seats you selected are no longer available.',
        data.conflictingSeatIds || []
      );
      // Deselect conflicting seats
      for (const id of (data.conflictingSeatIds || [])) {
        selectedIds.delete(id);
      }
      updateSelectionPanel();
      // Refresh seat map
      await refreshSeats();
    } else {
      showError(data.error || 'Failed to place hold.', []);
    }
  } catch (err) {
    showError('Network error. Please try again.', []);
    console.error(err);
  } finally {
    holdBtn.disabled = selectedIds.size === 0;
  }
});

// ── Clear selection ───────────────────────────────────────────────────────────
clearBtn.addEventListener('click', () => {
  for (const id of selectedIds) {
    selectedIds.delete(id);
    updateSeatEl(id);
  }
  selectedIds.clear();
  updateSelectionPanel();
});

// ── Confirm ───────────────────────────────────────────────────────────────────
confirmBtn.addEventListener('click', async () => {
  if (!currentHold) return;
  confirmBtn.disabled = true;

  try {
    const res = await fetch(`${API}/holds/${currentHold.holdId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });

    const data = await res.json();

    if (res.ok) {
      const bookedIds = (data.seats || []).map((s) => s.id);
      for (const id of bookedIds) bookedSeatIds.add(id);

      stopCountdown();
      showBookedPanel(bookedIds);

      // Update local state
      for (const id of (currentHold?.seatIds || [])) {
        if (seats[id]) {
          seats[id].status = 'booked';
          seats[id].booked_by = SESSION_ID;
          seats[id].hold_id = null;
          seats[id].hold_expires_at = null;
          updateSeatEl(id);
        }
      }
      currentHold = null;
      updateInventory();
    } else if (res.status === 410) {
      // Hold expired
      showError('Your hold has expired. Please select seats again.', []);
      stopCountdown();
      currentHold = null;
      showSelectionPanel();
      await refreshSeats();
    } else {
      showError(data.error || 'Confirmation failed.', []);
      confirmBtn.disabled = false;
    }
  } catch (err) {
    showError('Network error. Please try again.', []);
    confirmBtn.disabled = false;
    console.error(err);
  }
});

// ── Release ───────────────────────────────────────────────────────────────────
releaseBtn.addEventListener('click', async () => {
  if (!currentHold) return;
  releaseBtn.disabled = true;

  try {
    const res = await fetch(`${API}/holds/${currentHold.holdId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });

    if (res.ok) {
      // Update local state
      for (const id of currentHold.seatIds) {
        if (seats[id]) {
          seats[id].status = 'available';
          seats[id].hold_id = null;
          seats[id].hold_expires_at = null;
          updateSeatEl(id);
        }
      }
      stopCountdown();
      currentHold = null;
      showSelectionPanel();
      updateInventory();
    } else {
      const data = await res.json();
      showError(data.error || 'Failed to release hold.', []);
      releaseBtn.disabled = false;
    }
  } catch (err) {
    showError('Network error. Please try again.', []);
    releaseBtn.disabled = false;
    console.error(err);
  }
});

// ── New booking ───────────────────────────────────────────────────────────────
newBookingBtn.addEventListener('click', () => {
  showSelectionPanel();
});

// ── Error dismiss ─────────────────────────────────────────────────────────────
errorDismissBtn.addEventListener('click', () => {
  showSelectionPanel();
});

// ── Panel visibility ──────────────────────────────────────────────────────────
function showHoldPanel() {
  selectionPanel.classList.add('hidden');
  holdPanel.classList.remove('hidden');
  bookedPanel.classList.add('hidden');
  errorPanel.classList.add('hidden');
  holdSeatDisplay.textContent = currentHold.seatIds.sort().join(', ');
}

function showSelectionPanel() {
  selectionPanel.classList.remove('hidden');
  holdPanel.classList.add('hidden');
  bookedPanel.classList.add('hidden');
  errorPanel.classList.add('hidden');
  updateSelectionPanel();
}

function showBookedPanel(seatIds) {
  selectionPanel.classList.add('hidden');
  holdPanel.classList.add('hidden');
  bookedPanel.classList.remove('hidden');
  errorPanel.classList.add('hidden');
  bookedDisplay.textContent = [...seatIds].sort().join(', ');
}

function showError(msg, conflicting) {
  selectionPanel.classList.add('hidden');
  holdPanel.classList.add('hidden');
  bookedPanel.classList.add('hidden');
  errorPanel.classList.remove('hidden');
  errorMessage.textContent = msg;
  if (conflicting && conflicting.length > 0) {
    conflictSeats.classList.remove('hidden');
    conflictList.textContent = conflicting.sort().join(', ');
  } else {
    conflictSeats.classList.add('hidden');
  }
}

// ── Countdown ─────────────────────────────────────────────────────────────────
function startCountdown() {
  stopCountdown();
  countdownTimer = setInterval(updateCountdown, 500);
  updateCountdown();
}

function stopCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

function updateCountdown() {
  if (!currentHold) { stopCountdown(); return; }
  const remaining = Math.max(0, currentHold.expiresAt - Date.now());
  const secs = Math.ceil(remaining / 1000);
  const mins = Math.floor(secs / 60);
  const s = secs % 60;
  holdCountdown.textContent = `${mins}:${String(s).padStart(2, '0')}`;

  if (secs <= 10) {
    holdCountdown.classList.add('countdown-urgent');
  } else {
    holdCountdown.classList.remove('countdown-urgent');
  }

  if (remaining === 0) {
    stopCountdown();
    // Hold expired client-side – show error and refresh
    showError('Your hold has expired. Please select seats again.', []);
    currentHold = null;
    refreshSeats();
  }
}

// ── Inventory display ─────────────────────────────────────────────────────────
function updateInventory() {
  const all = Object.values(seats);
  const available = all.filter((s) => s.status === 'available').length;
  const held      = all.filter((s) => s.status === 'held').length;
  const booked    = all.filter((s) => s.status === 'booked').length;
  inventoryDisplay.textContent =
    `Available: ${available} · Held: ${held} · Booked: ${booked} · Total: ${all.length}`;
}

// ── Refresh seats from server ─────────────────────────────────────────────────
async function refreshSeats() {
  try {
    const list = await fetchSeats();
    for (const seat of list) {
      seats[seat.id] = seat;
    }
    renderSeatMap();
  } catch (err) {
    console.error('[refresh] Failed to fetch seats:', err);
  }
}

// ── SSE ───────────────────────────────────────────────────────────────────────
let sseSource = null;
let sseReconnectTimer = null;

function connectSSE() {
  if (sseSource) {
    sseSource.close();
    sseSource = null;
  }

  sseStatusEl.textContent = '● Connecting…';
  sseStatusEl.className = 'sse-status reconnecting';

  const es = new EventSource(`${API}/stream`);
  sseSource = es;

  es.addEventListener('connected', () => {
    sseStatusEl.textContent = '● Live';
    sseStatusEl.className = 'sse-status connected';
    if (sseReconnectTimer) {
      clearTimeout(sseReconnectTimer);
      sseReconnectTimer = null;
    }
  });

  es.addEventListener('seats:held', (e) => {
    const { holdId, seatIds: ids, seats: heldSeats } = JSON.parse(e.data);
    // If this is our own hold, skip (we already updated locally)
    for (const s of heldSeats || []) {
      if (seats[s.id] && seats[s.id].status !== 'booked') {
        // Only update if it's not our own hold's seat
        if (!currentHold || !currentHold.seatIds.includes(s.id)) {
          seats[s.id].status = 'held';
          seats[s.id].hold_id = holdId;
          updateSeatEl(s.id);
        }
      }
    }
    updateInventory();
  });

  es.addEventListener('seats:booked', (e) => {
    const { seats: bookedSeats } = JSON.parse(e.data);
    for (const s of bookedSeats || []) {
      if (seats[s.id]) {
        seats[s.id].status = 'booked';
        seats[s.id].booked_by = s.booked_by;
        seats[s.id].hold_id = null;
        seats[s.id].hold_expires_at = null;
        updateSeatEl(s.id);
      }
    }
    updateInventory();
  });

  es.addEventListener('seats:released', (e) => {
    const { seats: releasedSeats } = JSON.parse(e.data);
    for (const s of releasedSeats || []) {
      if (seats[s.id] && seats[s.id].status !== 'booked') {
        seats[s.id].status = 'available';
        seats[s.id].hold_id = null;
        seats[s.id].hold_expires_at = null;
        updateSeatEl(s.id);
      }
    }
    updateInventory();
  });

  es.onerror = () => {
    sseStatusEl.textContent = '● Disconnected';
    sseStatusEl.className = 'sse-status disconnected';
    es.close();
    sseSource = null;
    // Reconnect after 3 seconds
    sseReconnectTimer = setTimeout(connectSSE, 3000);
  };
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  try {
    const list = await fetchSeats();
    for (const seat of list) {
      seats[seat.id] = seat;
    }
    renderSeatMap();
    showSelectionPanel();
  } catch (err) {
    seatMapEl.innerHTML = '<div class="loading">Failed to load seats. Is the server running?</div>';
    console.error('[init]', err);
  }

  connectSSE();
}

init();
