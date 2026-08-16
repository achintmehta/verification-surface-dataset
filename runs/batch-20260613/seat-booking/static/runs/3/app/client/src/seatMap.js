/**
 * Seat-map renderer and state manager.
 *
 * Maintains a local `seats` Map (id → seat object) and re-renders only the
 * seats that changed, keeping DOM mutations minimal.
 */

/** @type {Map<string, object>} */
const seats = new Map();

/** @type {Set<string>} currently selected (pre-hold) seat ids */
const selected = new Set();

/** The active hold object (or null). */
let activeHold = null;

/** Callback invoked whenever the selection changes. */
let onSelectionChange = () => {};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialise the seat map with a full list of seat objects.
 *
 * @param {object[]} seatList
 * @param {string} sessionId
 * @param {object|null} hold  – current active hold (if any)
 * @param {(sel: Set<string>) => void} selectionChangeCb
 */
export function initSeatMap(seatList, sessionId, hold, selectionChangeCb) {
  seats.clear();
  selected.clear();
  activeHold = hold;
  onSelectionChange = selectionChangeCb;

  for (const s of seatList) {
    seats.set(s.id, s);
  }

  renderAll(sessionId);
}

/**
 * Apply a partial update to the seat map (e.g. from an SSE event).
 *
 * @param {string[]} seatIds
 * @param {Partial<object>} patch
 * @param {string} sessionId
 */
export function patchSeats(seatIds, patch, sessionId) {
  for (const id of seatIds) {
    const existing = seats.get(id);
    if (existing) {
      seats.set(id, { ...existing, ...patch });
    }
  }
  for (const id of seatIds) {
    renderSeat(id, sessionId);
  }
  updateInventory();
}

/**
 * Set the active hold (used after a hold is created or released).
 *
 * @param {object|null} hold
 * @param {string} sessionId
 */
export function setActiveHold(hold, sessionId) {
  activeHold = hold;
  // Re-render all seats so held-mine / held-other states update.
  renderAll(sessionId);
}

/**
 * Clear the current selection.
 */
export function clearSelection(sessionId) {
  const prev = [...selected];
  selected.clear();
  for (const id of prev) renderSeat(id, sessionId);
  onSelectionChange(selected);
}

/**
 * Return a copy of the current selection.
 * @returns {string[]}
 */
export function getSelection() {
  return [...selected];
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const mapEl = () => document.getElementById('seat-map');

function renderAll(sessionId) {
  const container = mapEl();
  if (!container) return;

  // Group seats by row.
  /** @type {Map<string, object[]>} */
  const rows = new Map();
  for (const seat of seats.values()) {
    if (!rows.has(seat.row_label)) rows.set(seat.row_label, []);
    rows.get(seat.row_label).push(seat);
  }

  // Sort rows alphabetically.
  const sortedRows = [...rows.entries()].sort(([a], [b]) => a.localeCompare(b));

  container.innerHTML = '';

  for (const [rowLabel, rowSeats] of sortedRows) {
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';
    rowEl.dataset.row = rowLabel;

    const labelEl = document.createElement('span');
    labelEl.className = 'row-label';
    labelEl.textContent = rowLabel;
    rowEl.appendChild(labelEl);

    rowSeats.sort((a, b) => a.seat_number - b.seat_number);
    for (const seat of rowSeats) {
      rowEl.appendChild(buildSeatEl(seat, sessionId));
    }

    container.appendChild(rowEl);
  }

  updateInventory();
}

/**
 * Re-render a single seat button in place.
 *
 * @param {string} seatId
 * @param {string} sessionId
 */
function renderSeat(seatId, sessionId) {
  const seat = seats.get(seatId);
  if (!seat) return;

  const existing = document.querySelector(`[data-seat-id="${seatId}"]`);
  if (!existing) return;

  const newEl = buildSeatEl(seat, sessionId);
  existing.replaceWith(newEl);
}

/**
 * Build a seat `<button>` element.
 *
 * @param {object} seat
 * @param {string} sessionId
 * @returns {HTMLButtonElement}
 */
function buildSeatEl(seat, sessionId) {
  const btn = document.createElement('button');
  btn.className = 'seat';
  btn.dataset.seatId = seat.id;
  btn.textContent = seat.seat_number;
  btn.setAttribute('aria-label', `Row ${seat.row_label} seat ${seat.seat_number}`);

  const effectiveStatus = getEffectiveStatus(seat);
  const isMyHold =
    activeHold &&
    seat.hold_id === activeHold.id &&
    effectiveStatus === 'held';
  const isSelected = selected.has(seat.id);

  if (isSelected) {
    btn.classList.add('selected');
    btn.setAttribute('aria-pressed', 'true');
  } else if (effectiveStatus === 'available') {
    btn.classList.add('available');
    btn.setAttribute('aria-pressed', 'false');
  } else if (effectiveStatus === 'held') {
    btn.classList.add(isMyHold ? 'held-mine' : 'held-other');
    btn.disabled = !isMyHold;
  } else if (effectiveStatus === 'booked') {
    btn.classList.add('booked');
    btn.disabled = true;
    btn.setAttribute('aria-disabled', 'true');
  }

  // Only available seats (and not during an active hold) are clickable.
  if (effectiveStatus === 'available' && !activeHold) {
    btn.addEventListener('click', () => handleSeatClick(seat.id, sessionId));
  }

  return btn;
}

/**
 * Determine the effective status of a seat, treating expired holds as
 * available (client-side optimistic expiry).
 *
 * @param {object} seat
 * @returns {'available'|'held'|'booked'}
 */
function getEffectiveStatus(seat) {
  if (seat.status === 'held' && seat.hold_expires_at) {
    const expires = new Date(seat.hold_expires_at);
    if (expires < new Date()) return 'available';
  }
  return seat.status;
}

function handleSeatClick(seatId, sessionId) {
  if (selected.has(seatId)) {
    selected.delete(seatId);
  } else {
    selected.add(seatId);
  }
  renderSeat(seatId, sessionId);
  onSelectionChange(selected);
}

// ---------------------------------------------------------------------------
// Conflict highlight
// ---------------------------------------------------------------------------

/**
 * Briefly flash the conflict CSS class on the given seat ids.
 *
 * @param {string[]} seatIds
 */
export function flashConflict(seatIds) {
  for (const id of seatIds) {
    const el = document.querySelector(`[data-seat-id="${id}"]`);
    if (!el) continue;
    el.classList.add('conflict');
    setTimeout(() => el.classList.remove('conflict'), 2500);
  }
}

// ---------------------------------------------------------------------------
// Inventory summary
// ---------------------------------------------------------------------------

function updateInventory() {
  let available = 0, held = 0, booked = 0;
  for (const seat of seats.values()) {
    const s = getEffectiveStatus(seat);
    if (s === 'available') available++;
    else if (s === 'held') held++;
    else if (s === 'booked') booked++;
  }
  const total = available + held + booked;

  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };
  set('inv-available', available);
  set('inv-held', held);
  set('inv-booked', booked);
  set('inv-total', total);
}
