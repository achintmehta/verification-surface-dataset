import './styles.css';

const app = document.querySelector('#app');
const SESSION_KEY = 'seat-booking-session-id';
let sessionId = localStorage.getItem(SESSION_KEY);
if (!sessionId) {
  sessionId = crypto.randomUUID();
  localStorage.setItem(SESSION_KEY, sessionId);
}

const state = {
  seats: [],
  inventory: { total: 0, available: 0, held: 0, booked: 0 },
  selected: new Set(),
  currentHold: loadHold(),
  message: 'Loading seats…',
  conflicts: new Set(),
};

function loadHold() {
  try {
    const raw = localStorage.getItem('seat-booking-current-hold');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveHold(hold) {
  state.currentHold = hold;
  if (hold) localStorage.setItem('seat-booking-current-hold', JSON.stringify(hold));
  else localStorage.removeItem('seat-booking-current-hold');
}

function api(path, options = {}) {
  return fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
}

function formatSeat(seat) {
  return `${seat.rowLabel}${seat.seatNumber}`;
}

function computeInventory() {
  const inventory = { total: state.seats.length, available: 0, held: 0, booked: 0 };
  for (const seat of state.seats) inventory[seat.status] += 1;
  state.inventory = inventory;
}

function mergeSeatUpdates(updates) {
  const byId = new Map(state.seats.map((seat) => [seat.id, seat]));
  for (const update of updates) {
    const existing = byId.get(update.id);
    if (!existing) continue;
    Object.assign(existing, {
      status: update.status,
      holdId: update.holdId,
      holdExpiresAt: update.holdExpiresAt,
      bookedBy: update.bookedBy,
    });
    if (update.status !== 'available') state.selected.delete(update.id);
  }
  computeInventory();
  render();
}

async function refreshSeats(silent = false) {
  const response = await api('/api/seats');
  if (!response.ok) throw new Error('Failed to load seats');
  const data = await response.json();
  state.seats = data.seats;
  state.inventory = data.inventory;
  for (const id of [...state.selected]) {
    const seat = state.seats.find((candidate) => candidate.id === id);
    if (!seat || seat.status !== 'available') state.selected.delete(id);
  }
  if (!silent) state.message = 'Select available seats, then place a temporary hold.';
  render();
}

async function createHold() {
  const seatIds = [...state.selected];
  if (seatIds.length === 0) {
    state.message = 'Select at least one available seat first.';
    render();
    return;
  }

  state.message = 'Requesting hold…';
  state.conflicts.clear();
  render();

  const response = await api('/api/holds', {
    method: 'POST',
    body: JSON.stringify({ seatIds, sessionId }),
  });

  if (response.status === 409) {
    const data = await response.json();
    state.conflicts = new Set(data.conflictingSeatIds || []);
    state.message = `Hold failed: ${state.conflicts.size ? 'highlighted seats are unavailable.' : data.error}`;
    state.selected.clear();
    await refreshSeats(true);
    return;
  }

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    state.message = data.error || 'Hold failed.';
    render();
    return;
  }

  const data = await response.json();
  saveHold(data.hold);
  state.selected.clear();
  state.message = `Hold placed for ${data.hold.seats.length} seat(s). Confirm before the timer expires.`;
  mergeSeatUpdates(data.hold.seats.map((seat) => ({
    id: seat.id,
    status: seat.status,
    holdId: seat.holdId,
    holdExpiresAt: seat.holdExpiresAt,
    bookedBy: seat.bookedBy,
  })));
}

async function confirmHold() {
  if (!state.currentHold) return;
  state.message = 'Confirming booking…';
  render();

  const response = await api(`/api/holds/${state.currentHold.id}/confirm`, {
    method: 'POST',
    body: JSON.stringify({ sessionId }),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    state.message = data.error || 'Confirmation failed.';
    saveHold(null);
    await refreshSeats(true);
    return;
  }

  const data = await response.json();
  saveHold(null);
  state.message = `Booking confirmed (${data.booking.bookingId}).`;
  await refreshSeats(true);
}

async function releaseHold() {
  if (!state.currentHold) return;
  const holdId = state.currentHold.id;
  saveHold(null);
  await api(`/api/holds/${holdId}`, {
    method: 'DELETE',
    body: JSON.stringify({ sessionId }),
  }).catch(() => {});
  state.message = 'Hold released.';
  await refreshSeats(true);
}

function holdRemainingSeconds() {
  if (!state.currentHold?.expiresAt) return 0;
  return Math.max(0, Math.ceil((new Date(state.currentHold.expiresAt).getTime() - Date.now()) / 1000));
}

function render() {
  const rows = new Map();
  for (const seat of state.seats) {
    if (!rows.has(seat.rowLabel)) rows.set(seat.rowLabel, []);
    rows.get(seat.rowLabel).push(seat);
  }

  const activeHold = state.currentHold && holdRemainingSeconds() > 0;
  const heldSeatIds = new Set(state.currentHold?.seats?.map((seat) => seat.id) || []);
  const selectedLabels = [...state.selected]
    .map((id) => state.seats.find((seat) => seat.id === id))
    .filter(Boolean)
    .map(formatSeat)
    .join(', ');

  app.innerHTML = `
    <main class="shell">
      <header class="hero">
        <div>
          <p class="eyebrow">Live single-event ticketing</p>
          <h1>Seat Booking</h1>
          <p class="muted">Session: <code>${sessionId.slice(0, 8)}</code></p>
        </div>
        <div class="inventory" aria-label="Inventory">
          <span class="pill available">Available ${state.inventory.available}</span>
          <span class="pill held">Held ${state.inventory.held}</span>
          <span class="pill booked">Booked ${state.inventory.booked}</span>
          <span class="pill">Total ${state.inventory.total}</span>
        </div>
      </header>

      <section class="panel controls">
        <div>
          <strong>Status</strong>
          <p>${state.message}</p>
          <p class="muted">Selected: ${selectedLabels || 'none'}</p>
        </div>
        <div class="actions">
          <button id="holdBtn" ${state.selected.size === 0 || activeHold ? 'disabled' : ''}>Hold selected</button>
          <button id="confirmBtn" ${!activeHold ? 'disabled' : ''}>Confirm hold</button>
          <button id="releaseBtn" ${!activeHold ? 'disabled' : ''}>Release hold</button>
        </div>
        ${state.currentHold ? `<div class="timer ${activeHold ? '' : 'expired'}">
          Hold ${state.currentHold.id.slice(0, 8)}: ${activeHold ? `${holdRemainingSeconds()}s remaining` : 'expired'}
        </div>` : ''}
      </section>

      <section class="panel map" aria-label="Seat map">
        ${[...rows.entries()].map(([rowLabel, seats]) => `
          <div class="row">
            <div class="row-label">${rowLabel}</div>
            <div class="seat-row">
              ${seats.map((seat) => {
                const mine = heldSeatIds.has(seat.id) && seat.status === 'held';
                const classes = ['seat', seat.status];
                if (state.selected.has(seat.id)) classes.push('selected');
                if (state.conflicts.has(seat.id)) classes.push('conflict');
                if (mine) classes.push('mine');
                return `<button class="${classes.join(' ')}" data-seat-id="${seat.id}" ${seat.status !== 'available' ? 'disabled' : ''} title="${formatSeat(seat)} ${seat.status}">${seat.seatNumber}</button>`;
              }).join('')}
            </div>
          </div>`).join('')}
      </section>

      <footer class="legend">
        <span><i class="swatch available"></i>Available</span>
        <span><i class="swatch selected"></i>Selected</span>
        <span><i class="swatch held"></i>Held</span>
        <span><i class="swatch booked"></i>Booked</span>
      </footer>
    </main>
  `;

  document.querySelector('#holdBtn')?.addEventListener('click', createHold);
  document.querySelector('#confirmBtn')?.addEventListener('click', confirmHold);
  document.querySelector('#releaseBtn')?.addEventListener('click', releaseHold);
  document.querySelectorAll('[data-seat-id]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset.seatId;
      const seat = state.seats.find((candidate) => candidate.id === id);
      if (!seat || seat.status !== 'available') return;
      state.conflicts.clear();
      if (state.selected.has(id)) state.selected.delete(id);
      else state.selected.add(id);
      render();
    });
  });
}

function connectStream() {
  const events = new EventSource('/api/stream');
  events.addEventListener('seats', (event) => {
    const data = JSON.parse(event.data);
    mergeSeatUpdates(data.seats || []);
  });
  events.onerror = () => {
    state.message = 'Live connection interrupted; retrying automatically…';
    render();
  };
}

setInterval(() => {
  if (state.currentHold && holdRemainingSeconds() <= 0) {
    saveHold(null);
    state.message = 'Your hold expired; those seats may be selected again if still available.';
    refreshSeats(true).catch(() => render());
  } else if (state.currentHold) {
    render();
  }
}, 1000);

refreshSeats().catch((error) => {
  state.message = error.message;
  render();
});
connectStream();
