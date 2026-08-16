import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || (location.port === '5173' ? 'http://localhost:3001' : '');
const app = document.querySelector('#app');
const sessionId = getSessionId();

const state = {
  seats: new Map(),
  selected: new Set(),
  currentHold: loadHold(),
  serverSkewMs: 0,
  message: '',
  error: '',
  now: Date.now(),
};

function getSessionId() {
  let id = localStorage.getItem('seat-booking-session-id');
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    localStorage.setItem('seat-booking-session-id', id);
  }
  return id;
}

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

async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Request failed with ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function rememberServerTime(serverTime) {
  if (serverTime) state.serverSkewMs = new Date(serverTime).getTime() - Date.now();
}

async function loadSeats() {
  try {
    const data = await api('/api/seats');
    rememberServerTime(data.serverTime);
    state.seats = new Map(data.seats.map((seat) => [seat.id, seat]));
    pruneSelection();
    if (state.currentHold && !holdSeatsStillHeldByUs()) saveHold(null);
    state.error = '';
    render();
  } catch (error) {
    state.error = error.message;
    render();
  }
}

function pruneSelection() {
  for (const id of [...state.selected]) {
    if (state.seats.get(id)?.status !== 'available') state.selected.delete(id);
  }
}

function holdSeatsStillHeldByUs() {
  if (!state.currentHold?.seatIds?.length) return false;
  return state.currentHold.seatIds.every((id) => {
    const seat = state.seats.get(id);
    return seat && (seat.holdId === state.currentHold.id || seat.status === 'booked');
  });
}

function applySeatUpdates(seats) {
  for (const seat of seats) {
    state.seats.set(seat.id, seat);
    if (seat.status !== 'available') state.selected.delete(seat.id);
  }

  if (state.currentHold) {
    const ownSeats = state.currentHold.seatIds || [];
    const ownSeatRows = ownSeats.map((id) => state.seats.get(id)).filter(Boolean);
    if (ownSeatRows.length && ownSeatRows.every((seat) => seat.status === 'booked')) {
      saveHold(null);
      state.message = 'Your booking is confirmed.';
    } else if (ownSeatRows.length && ownSeatRows.some((seat) => seat.holdId !== state.currentHold.id && seat.status !== 'booked')) {
      saveHold(null);
      state.message = 'Your hold has been released or expired.';
    }
  }
  render();
}

function connectStream() {
  const events = new EventSource(`${API_BASE}/api/stream`);
  events.addEventListener('seats', (event) => {
    const payload = JSON.parse(event.data);
    applySeatUpdates(payload.seats || []);
  });
  events.onerror = () => {
    state.error = 'Live updates disconnected. The browser will retry automatically.';
    render();
  };
}

async function requestHold() {
  const seatIds = [...state.selected].sort((a, b) => a - b);
  if (!seatIds.length) return;

  try {
    const data = await api('/api/holds', {
      method: 'POST',
      body: JSON.stringify({ seatIds, sessionId }),
    });
    rememberServerTime(data.serverTime);
    saveHold(data.hold);
    state.selected.clear();
    state.error = '';
    state.message = `Held ${seatIds.length} seat${seatIds.length === 1 ? '' : 's'}. Confirm before the timer ends.`;
    applySeatUpdates(data.seats || []);
  } catch (error) {
    if (error.status === 409) {
      const ids = error.data?.conflictingSeatIds || [];
      state.error = `Some selected seats were already taken: ${ids.join(', ') || 'unknown'}`;
      await loadSeats();
      state.error = `Some selected seats were already taken: ${ids.join(', ') || 'unknown'}`;
      render();
    } else {
      state.error = error.message;
      render();
    }
  }
}

async function confirmHold() {
  if (!state.currentHold) return;
  try {
    const data = await api(`/api/holds/${state.currentHold.id}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    });
    applySeatUpdates(data.seats || []);
    saveHold(null);
    state.error = '';
    state.message = data.idempotent ? 'Booking was already confirmed.' : 'Booking confirmed!';
    render();
  } catch (error) {
    state.error = error.message;
    saveHold(null);
    await loadSeats();
  }
}

async function releaseHold() {
  if (!state.currentHold) return;
  try {
    const holdId = state.currentHold.id;
    saveHold(null);
    const data = await api(`/api/holds/${holdId}`, {
      method: 'DELETE',
      body: JSON.stringify({ sessionId }),
    });
    applySeatUpdates(data.seats || []);
    state.message = 'Hold released.';
    state.error = '';
    render();
  } catch (error) {
    state.error = error.message;
    render();
  }
}

function toggleSeat(id) {
  const seat = state.seats.get(id);
  if (!seat || seat.status !== 'available' || state.currentHold) return;
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  render();
}

function timeLeftMs() {
  if (!state.currentHold?.expiresAt) return 0;
  return Math.max(0, new Date(state.currentHold.expiresAt).getTime() - (Date.now() + state.serverSkewMs));
}

function formatTime(ms) {
  const total = Math.ceil(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function groupedSeats() {
  const groups = new Map();
  for (const seat of [...state.seats.values()].sort((a, b) => a.id - b.id)) {
    if (!groups.has(seat.rowLabel)) groups.set(seat.rowLabel, []);
    groups.get(seat.rowLabel).push(seat);
  }
  return groups;
}

function totals() {
  const total = { available: 0, held: 0, booked: 0, total: 0 };
  for (const seat of state.seats.values()) {
    total[seat.status] += 1;
    total.total += 1;
  }
  return total;
}

function seatTitle(seat) {
  const label = `${seat.rowLabel}${seat.seatNumber}`;
  if (seat.status === 'held') return `${label} held until ${new Date(seat.holdExpiresAt).toLocaleTimeString()}`;
  if (seat.status === 'booked') return `${label} booked`;
  return `${label} available`;
}

function render() {
  const total = totals();
  const holdMs = timeLeftMs();
  const holdExpiredLocally = state.currentHold && holdMs <= 0;
  const selectedIds = [...state.selected].sort((a, b) => a - b);

  app.innerHTML = `
    <header class="hero">
      <div>
        <h1>Seat Booking</h1>
        <p>Atomic holds, idempotent booking confirmation, automatic expiry, and live SSE updates.</p>
      </div>
      <code title="Client supplied session id">Session ${sessionId.slice(0, 8)}</code>
    </header>

    <section class="panel stats" aria-label="Inventory totals">
      <div><strong>${total.available}</strong><span>Available</span></div>
      <div><strong>${total.held}</strong><span>Held</span></div>
      <div><strong>${total.booked}</strong><span>Booked</span></div>
      <div><strong>${total.total}</strong><span>Total</span></div>
    </section>

    ${state.error ? `<div class="notice error">${escapeHtml(state.error)}</div>` : ''}
    ${state.message ? `<div class="notice success">${escapeHtml(state.message)}</div>` : ''}

    <main class="layout">
      <section class="panel">
        <div class="screen">SCREEN</div>
        <div class="seat-map">
          ${[...groupedSeats().entries()].map(([row, seats]) => `
            <div class="seat-row">
              <div class="row-label">${row}</div>
              <div class="seats">
                ${seats.map((seat) => {
                  const selected = state.selected.has(seat.id);
                  const mine = state.currentHold?.seatIds?.includes(seat.id) && seat.status === 'held';
                  return `<button
                    class="seat ${seat.status} ${selected ? 'selected' : ''} ${mine ? 'mine' : ''}"
                    data-seat-id="${seat.id}"
                    ${seat.status !== 'available' || state.currentHold ? 'disabled' : ''}
                    title="${escapeHtml(seatTitle(seat))}"
                    aria-label="${escapeHtml(seatTitle(seat))}">
                    ${seat.seatNumber}
                  </button>`;
                }).join('')}
              </div>
            </div>
          `).join('')}
        </div>
        <div class="legend">
          <span><i class="available"></i> Available</span>
          <span><i class="held"></i> Held</span>
          <span><i class="booked"></i> Booked</span>
          <span><i class="selected"></i> Selected</span>
        </div>
      </section>

      <aside class="panel controls">
        <h2>Your selection</h2>
        <p>${selectedIds.length ? `Seat ids: ${selectedIds.join(', ')}` : 'Choose one or more available seats.'}</p>
        <button id="holdBtn" ${!selectedIds.length || state.currentHold ? 'disabled' : ''}>Place hold</button>

        <hr />
        <h2>Current hold</h2>
        ${state.currentHold ? `
          <p><strong>Hold:</strong> ${escapeHtml(state.currentHold.id.slice(0, 8))}</p>
          <p><strong>Seats:</strong> ${state.currentHold.seatIds.join(', ')}</p>
          <p class="countdown ${holdExpiredLocally ? 'expired' : ''}">${holdExpiredLocally ? 'Expired - waiting for server release' : formatTime(holdMs)}</p>
          <button id="confirmBtn" ${holdExpiredLocally ? 'disabled' : ''}>Confirm booking</button>
          <button id="releaseBtn" class="secondary">Release hold</button>
        ` : '<p>No active hold from this browser.</p>'}

        <hr />
        <button id="refreshBtn" class="secondary">Refresh seat map</button>
      </aside>
    </main>
  `;

  app.querySelectorAll('[data-seat-id]').forEach((button) => {
    button.addEventListener('click', () => toggleSeat(Number(button.dataset.seatId)));
  });
  app.querySelector('#holdBtn')?.addEventListener('click', requestHold);
  app.querySelector('#confirmBtn')?.addEventListener('click', confirmHold);
  app.querySelector('#releaseBtn')?.addEventListener('click', releaseHold);
  app.querySelector('#refreshBtn')?.addEventListener('click', loadSeats);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

setInterval(() => {
  state.now = Date.now();
  if (state.currentHold) render();
}, 1000);

render();
loadSeats();
connectStream();
