// ─── State ───────────────────────────────────────────────────────────────────

/** @type {string} */
const SESSION_ID = crypto.randomUUID();

/** @type {Map<number, SeatData>} */
const seatMap = new Map();

/** @type {Set<number>} */
const selectedIds = new Set();

/** @type {HoldState|null} */
let currentHold = null;

/** @type {number|null} */
let timerInterval = null;

/** @type {number} */
let holdTtlSeconds = 60;

/**
 * @typedef {Object} SeatData
 * @property {number} id
 * @property {string} row_label
 * @property {number} seat_number
 * @property {string} status
 * @property {string|null} hold_id
 * @property {string|null} hold_expires_at
 * @property {string|null} booked_by
 */

/**
 * @typedef {Object} HoldState
 * @property {string} holdId
 * @property {string} expiresAt
 * @property {number[]} seatIds
 */

// ─── DOM refs ────────────────────────────────────────────────────────────────

const seatMapEl = /** @type {HTMLElement} */ (document.getElementById('seat-map'));
const selectedSeatsEl = /** @type {HTMLElement} */ (document.getElementById('selected-seats'));
const holdInfoEl = /** @type {HTMLElement} */ (document.getElementById('hold-info'));
const holdTimerEl = /** @type {HTMLElement} */ (document.getElementById('hold-timer'));
const errorMsgEl = /** @type {HTMLElement} */ (document.getElementById('error-msg'));
const inventoryEl = /** @type {HTMLElement} */ (document.getElementById('inventory'));
const connectionEl = /** @type {HTMLElement} */ (document.getElementById('connection-status'));
const btnHold = /** @type {HTMLButtonElement} */ (document.getElementById('btn-hold'));
const btnConfirm = /** @type {HTMLButtonElement} */ (document.getElementById('btn-confirm'));
const btnRelease = /** @type {HTMLButtonElement} */ (document.getElementById('btn-release'));

// ─── API helpers ─────────────────────────────────────────────────────────────

const API = '/api';

/**
 * @param {string} url
 * @param {RequestInit} [opts]
 */
async function apiFetch(url, opts) {
  const res = await fetch(`${API}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const body = await res.json();
  if (!res.ok) {
    const err = /** @type {any} */ (new Error(body.error || 'Request failed'));
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function renderSeatMap() {
  seatMapEl.innerHTML = '';

  // Group seats by row
  /** @type {Map<string, SeatData[]>} */
  const rows = new Map();
  for (const seat of seatMap.values()) {
    if (!rows.has(seat.row_label)) rows.set(seat.row_label, []);
    rows.get(seat.row_label)?.push(seat);
  }

  // Sort rows alphabetically, seats by number
  const sortedLabels = [...rows.keys()].sort();
  for (const label of sortedLabels) {
    const seats = rows.get(label) || [];
    seats.sort((a, b) => a.seat_number - b.seat_number);

    const rowDiv = document.createElement('div');
    rowDiv.className = 'seat-row';

    const labelEl = document.createElement('div');
    labelEl.className = 'row-label';
    labelEl.textContent = label;
    rowDiv.appendChild(labelEl);

    for (const seat of seats) {
      const el = document.createElement('div');
      el.className = `seat ${getSeatClass(seat)}`;
      el.textContent = String(seat.seat_number);
      el.dataset.seatId = String(seat.id);
      el.title = `${seat.row_label}${seat.seat_number} — ${getEffectiveStatus(seat)}`;
      el.addEventListener('click', () => onSeatClick(seat));
      rowDiv.appendChild(el);
    }

    seatMapEl.appendChild(rowDiv);
  }

  updateInventoryDisplay();
}

/**
 * @param {SeatData} seat
 * @returns {string}
 */
function getEffectiveStatus(seat) {
  if (seat.status === 'booked') return 'booked';
  if (seat.status === 'held') {
    if (seat.hold_id && currentHold && seat.hold_id === currentHold.holdId) return 'held-mine';
    return 'held';
  }
  return 'available';
}

/**
 * @param {SeatData} seat
 * @returns {string}
 */
function getSeatClass(seat) {
  const effective = getEffectiveStatus(seat);
  if (effective === 'booked') {
    if (seat.booked_by === SESSION_ID) return 'booked-mine';
    return 'booked';
  }
  if (effective === 'held-mine') return 'held-mine';
  if (effective === 'held') return 'held';
  if (selectedIds.has(seat.id)) return 'selected';
  return 'available';
}

function updateSelectedDisplay() {
  if (selectedIds.size === 0) {
    selectedSeatsEl.textContent = 'No seats selected';
  } else {
    const labels = [...selectedIds]
      .map((id) => {
        const s = seatMap.get(id);
        return s ? `${s.row_label}${s.seat_number}` : `?${id}`;
      })
      .sort();
    selectedSeatsEl.textContent = labels.join(', ');
  }

  // Button states depend on current mode
  if (currentHold) {
    btnHold.style.display = 'none';
    btnHold.disabled = true;
    btnConfirm.style.display = '';
    btnConfirm.disabled = false;
    btnRelease.style.display = '';
    btnRelease.disabled = false;
  } else {
    btnHold.style.display = '';
    btnHold.disabled = selectedIds.size === 0;
    btnConfirm.style.display = 'none';
    btnConfirm.disabled = true;
    btnRelease.style.display = 'none';
    btnRelease.disabled = true;
  }
}

function updateInventoryDisplay() {
  let available = 0;
  let held = 0;
  let booked = 0;
  for (const seat of seatMap.values()) {
    if (seat.status === 'available') available++;
    else if (seat.status === 'held') held++;
    else if (seat.status === 'booked') booked++;
  }
  inventoryEl.textContent = `Available: ${available} | Held: ${held} | Booked: ${booked} | Total: ${available + held + booked} | Hold TTL: ${holdTtlSeconds}s`;
}

/**
 * @param {string} msg
 */
function showError(msg) {
  errorMsgEl.textContent = msg;
  errorMsgEl.style.display = '';
  setTimeout(() => {
    errorMsgEl.style.display = 'none';
  }, 5000);
}

function clearError() {
  errorMsgEl.style.display = 'none';
}

// ─── Seat click handling ─────────────────────────────────────────────────────

/**
 * @param {SeatData} seat
 */
function onSeatClick(seat) {
  // If we have an active hold, ignore clicks
  if (currentHold) return;

  const effective = getEffectiveStatus(seat);
  if (effective !== 'available') return;

  if (selectedIds.has(seat.id)) {
    selectedIds.delete(seat.id);
  } else {
    selectedIds.add(seat.id);
  }

  renderSeatMap();
  updateSelectedDisplay();
}

// ─── Hold countdown timer ────────────────────────────────────────────────────

function startHoldTimer() {
  stopHoldTimer();
  holdInfoEl.style.display = '';
  updateHoldTimer();
  timerInterval = window.setInterval(updateHoldTimer, 500);
}

function stopHoldTimer() {
  if (timerInterval !== null) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  holdInfoEl.style.display = 'none';
}

function updateHoldTimer() {
  if (!currentHold) {
    stopHoldTimer();
    return;
  }
  const remaining = Math.max(
    0,
    Math.ceil((new Date(currentHold.expiresAt).getTime() - Date.now()) / 1000)
  );
  holdTimerEl.textContent = String(remaining);

  if (remaining <= 0) {
    // Hold expired on client side
    handleHoldExpired();
  }
}

function handleHoldExpired() {
  stopHoldTimer();
  // Reset hold state locally; the server sweep will also release it
  if (currentHold) {
    for (const seatId of currentHold.seatIds) {
      const seat = seatMap.get(seatId);
      if (seat && seat.status === 'held' && seat.hold_id === currentHold.holdId) {
        seat.status = 'available';
        seat.hold_id = null;
        seat.hold_expires_at = null;
      }
    }
  }
  currentHold = null;
  selectedIds.clear();
  renderSeatMap();
  updateSelectedDisplay();
  showError('Your hold has expired. Please try again.');
}

// ─── Actions ─────────────────────────────────────────────────────────────────

btnHold.addEventListener('click', async () => {
  if (selectedIds.size === 0) return;
  clearError();
  btnHold.disabled = true;

  try {
    const seatIds = [...selectedIds];
    const data = await apiFetch('/holds', {
      method: 'POST',
      body: JSON.stringify({ seatIds, sessionId: SESSION_ID }),
    });

    // data: { holdId, expiresAt, seats }
    currentHold = {
      holdId: data.holdId,
      expiresAt: data.expiresAt,
      seatIds,
    };

    // Update local seat data
    for (const updatedSeat of data.seats) {
      seatMap.set(updatedSeat.id, updatedSeat);
    }

    selectedIds.clear();
    renderSeatMap();
    updateSelectedDisplay();
    startHoldTimer();
  } catch (err) {
    const e = /** @type {any} */ (err);
    if (e.status === 409 && e.body?.conflicting) {
      showError(`Seats already taken: ${e.body.conflicting.map((/** @type {number} */ id) => {
        const s = seatMap.get(id);
        return s ? `${s.row_label}${s.seat_number}` : id;
      }).join(', ')}`);
      // Remove conflicting from selection
      for (const cid of e.body.conflicting) {
        selectedIds.delete(cid);
      }
      // Refresh seat map
      await loadSeats();
    } else {
      showError(e.message || 'Failed to hold seats');
    }
    btnHold.disabled = selectedIds.size === 0;
  }
});

btnConfirm.addEventListener('click', async () => {
  if (!currentHold) return;
  clearError();
  btnConfirm.disabled = true;

  try {
    const data = await apiFetch(`/holds/${currentHold.holdId}/confirm`, {
      method: 'POST',
    });

    // data: { holdId, seats }
    for (const updatedSeat of data.seats) {
      seatMap.set(updatedSeat.id, updatedSeat);
    }

    stopHoldTimer();
    currentHold = null;
    selectedIds.clear();
    renderSeatMap();
    updateSelectedDisplay();
  } catch (err) {
    const e = /** @type {any} */ (err);
    showError(e.message || 'Failed to confirm booking');
    // If hold expired, reset
    if (e.status === 410) {
      stopHoldTimer();
      currentHold = null;
      selectedIds.clear();
      await loadSeats();
      updateSelectedDisplay();
    }
    btnConfirm.disabled = false;
  }
});

btnRelease.addEventListener('click', async () => {
  if (!currentHold) return;
  clearError();
  btnRelease.disabled = true;

  try {
    const data = await apiFetch(`/holds/${currentHold.holdId}`, {
      method: 'DELETE',
    });

    for (const updatedSeat of data.seats) {
      seatMap.set(updatedSeat.id, updatedSeat);
    }

    stopHoldTimer();
    currentHold = null;
    selectedIds.clear();
    renderSeatMap();
    updateSelectedDisplay();
  } catch (err) {
    const e = /** @type {any} */ (err);
    showError(e.message || 'Failed to release hold');
    btnRelease.disabled = false;
  }
});

// ─── SSE ─────────────────────────────────────────────────────────────────────

function connectSSE() {
  const es = new EventSource(`${API}/stream`);

  es.onopen = () => {
    connectionEl.textContent = '● Connected';
    connectionEl.className = 'connection-status connected';
  };

  es.addEventListener('seat-update', (event) => {
    try {
      const seats = JSON.parse(event.data);
      for (const seat of seats) {
        seatMap.set(seat.id, seat);
      }
      renderSeatMap();
      updateSelectedDisplay();
    } catch (err) {
      console.error('SSE parse error:', err);
    }
  });

  es.onerror = () => {
    connectionEl.textContent = '● Disconnected — reconnecting…';
    connectionEl.className = 'connection-status disconnected';
  };
}

// ─── Load seats ──────────────────────────────────────────────────────────────

async function loadSeats() {
  try {
    const data = await apiFetch('/seats');
    if (data.holdTtlSeconds) holdTtlSeconds = data.holdTtlSeconds;
    seatMap.clear();
    for (const seat of data.seats) {
      seatMap.set(seat.id, seat);
    }
    renderSeatMap();
    updateSelectedDisplay();
  } catch (err) {
    console.error('Failed to load seats:', err);
    showError('Failed to load seat map');
  }
}

// ─── Init ────────────────────────────────────────────────────────────────────

async function init() {
  await loadSeats();
  connectSSE();
}

init();
