/**
 * seatMap.js – Renders the seat grid and handles seat-click events.
 */

import { getState, setState } from './store.js';

const mapEl = document.getElementById('seat-map');

/**
 * Full re-render of the seat map from current state.
 * Groups seats by rowLabel and renders one row per group.
 */
export function renderSeatMap() {
  const { seats, selectedIds, activeHold, booking } = getState();

  if (seats.length === 0) {
    mapEl.innerHTML = '<p style="color:var(--color-text-muted);text-align:center">Loading seats…</p>';
    return;
  }

  // Group by row.
  const rows = new Map();
  for (const seat of seats) {
    if (!rows.has(seat.rowLabel)) rows.set(seat.rowLabel, []);
    rows.get(seat.rowLabel).push(seat);
  }

  // Build DOM.
  const fragment = document.createDocumentFragment();

  for (const [rowLabel, rowSeats] of rows) {
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';

    const labelEl = document.createElement('div');
    labelEl.className = 'row-label';
    labelEl.textContent = rowLabel;
    rowEl.appendChild(labelEl);

    for (const seat of rowSeats) {
      const seatEl = document.createElement('div');
      seatEl.className = `seat ${seatClass(seat, selectedIds, activeHold, booking)}`;
      seatEl.dataset.id = seat.id;
      seatEl.textContent = seat.seatNumber;
      seatEl.setAttribute('aria-label', `Row ${rowLabel} Seat ${seat.seatNumber}`);
      seatEl.setAttribute('role', 'button');
      seatEl.setAttribute('tabindex', isClickable(seat, activeHold, booking) ? '0' : '-1');

      seatEl.addEventListener('click', () => handleSeatClick(seat.id));
      seatEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleSeatClick(seat.id);
        }
      });

      rowEl.appendChild(seatEl);
    }

    fragment.appendChild(rowEl);
  }

  mapEl.innerHTML = '';
  mapEl.appendChild(fragment);
}

/**
 * Patch only the seats that changed, without a full re-render.
 * Called after SSE updates to avoid flickering.
 */
export function patchSeatElements(changedIds) {
  const { seats, selectedIds, activeHold, booking } = getState();
  const idSet = new Set(changedIds);

  for (const seat of seats) {
    if (!idSet.has(seat.id)) continue;
    const el = mapEl.querySelector(`[data-id="${seat.id}"]`);
    if (!el) continue;

    el.className = `seat ${seatClass(seat, selectedIds, activeHold, booking)}`;
    el.setAttribute('tabindex', isClickable(seat, activeHold, booking) ? '0' : '-1');
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function seatClass(seat, selectedIds, activeHold, booking) {
  const sessionId = getState().sessionId; // set by main.js

  // Booked by this session.
  if (seat.status === 'booked' && seat.bookedBy && booking && seat.bookedBy === booking.holdId) {
    return 'booked-own';
  }
  if (seat.status === 'booked') return 'booked';

  // Held by this session's active hold.
  if (seat.status === 'held' && activeHold && activeHold.seatIds.includes(seat.id)) {
    return 'held-own';
  }
  if (seat.status === 'held') return 'held-other';

  // Available + selected.
  if (seat.status === 'available' && selectedIds.has(seat.id)) return 'selected';

  // Available.
  if (seat.status === 'available') return 'available';

  return 'available';
}

function isClickable(seat, activeHold, booking) {
  if (activeHold || booking) return false; // no selection while hold/booking active
  return seat.status === 'available';
}

function handleSeatClick(seatId) {
  const { activeHold, booking, seats, selectedIds } = getState();

  // Ignore clicks when a hold or booking is active.
  if (activeHold || booking) return;

  const seat = seats.find((s) => s.id === seatId);
  if (!seat || seat.status !== 'available') return;

  const next = new Set(selectedIds);
  if (next.has(seatId)) {
    next.delete(seatId);
  } else {
    next.add(seatId);
  }

  setState({ selectedIds: next });
}
