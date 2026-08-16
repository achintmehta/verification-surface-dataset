/**
 * Seat-map rendering and interaction.
 *
 * Exports:
 *  renderSeatMap(seats, state)  – full re-render
 *  updateSeat(seatData, state)  – patch a single seat element
 *  getSeatElement(id)           – return the DOM element for a seat id
 */

/**
 * Determine the CSS class for a seat given the current app state.
 *
 * @param {{id:string, status:string, holdId:string|null}} seat
 * @param {{
 *   selectedIds: Set<string>,
 *   activeHold: {holdId:string, seatIds:string[]} | null,
 *   bookedIds: Set<string>,
 *   sessionId: string
 * }} state
 */
export function seatClass(seat, state) {
  const { selectedIds, activeHold, bookedIds } = state;

  if (selectedIds.has(seat.id)) return 'selected';

  if (seat.status === 'booked') {
    return bookedIds.has(seat.id) ? 'booked-own' : 'booked';
  }

  if (seat.status === 'held') {
    if (activeHold && activeHold.seatIds.includes(seat.id)) return 'held-own';
    return 'held-other';
  }

  return 'available';
}

/**
 * Return true if the seat is clickable (can be selected/deselected).
 */
function isClickable(seat, state) {
  const cls = seatClass(seat, state);
  return cls === 'available' || cls === 'selected';
}

/**
 * Full render of the seat map.
 *
 * @param {Array} seats
 * @param {object} state
 * @param {function} onSeatClick
 */
export function renderSeatMap(seats, state, onSeatClick) {
  const container = document.getElementById('seat-map');
  container.innerHTML = '';

  // Group by row
  const rows = new Map();
  for (const seat of seats) {
    if (!rows.has(seat.rowLabel)) rows.set(seat.rowLabel, []);
    rows.get(seat.rowLabel).push(seat);
  }

  for (const [rowLabel, rowSeats] of rows) {
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';
    rowEl.dataset.row = rowLabel;

    const labelEl = document.createElement('div');
    labelEl.className = 'row-label';
    labelEl.textContent = rowLabel;
    rowEl.appendChild(labelEl);

    for (const seat of rowSeats) {
      rowEl.appendChild(buildSeatEl(seat, state, onSeatClick));
    }

    container.appendChild(rowEl);
  }
}

function buildSeatEl(seat, state, onSeatClick) {
  const el = document.createElement('button');
  el.className = `seat ${seatClass(seat, state)}`;
  el.id = `seat-${seat.id}`;
  el.dataset.seatId = seat.id;
  el.textContent = seat.seatNumber;
  el.setAttribute('aria-label', `Row ${seat.rowLabel} Seat ${seat.seatNumber}`);

  if (!isClickable(seat, state)) {
    el.disabled = true;
  }

  el.addEventListener('click', () => onSeatClick(seat.id));
  return el;
}

/**
 * Update a single seat element in place (no full re-render).
 *
 * @param {{id:string, status:string, holdId:string|null}} seat
 * @param {object} state
 * @param {function} onSeatClick
 */
export function updateSeat(seat, state, onSeatClick) {
  const el = document.getElementById(`seat-${seat.id}`);
  if (!el) return;

  const newClass = seatClass(seat, state);
  el.className = `seat ${newClass}`;
  el.disabled = !isClickable(seat, state);

  // Re-attach click listener by replacing the element clone
  const clone = el.cloneNode(true);
  clone.addEventListener('click', () => onSeatClick(seat.id));
  el.replaceWith(clone);

  // Pulse animation
  requestAnimationFrame(() => {
    const fresh = document.getElementById(`seat-${seat.id}`);
    if (fresh) {
      fresh.classList.add('pulse');
      fresh.addEventListener('animationend', () => fresh.classList.remove('pulse'), { once: true });
    }
  });
}

export function getSeatElement(id) {
  return document.getElementById(`seat-${id}`);
}
