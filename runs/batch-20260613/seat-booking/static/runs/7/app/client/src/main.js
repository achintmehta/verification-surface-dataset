import './styles.css';

const API_BASE = import.meta.env.VITE_API_BASE || '';
const SESSION_KEY = 'seat-booking-session-id';

const state = {
  seats: new Map(),
  inventory: { available: 0, held: 0, booked: 0, total: 0 },
  selected: new Set(),
  currentHold: null,
  holdTtlSeconds: 30,
  message: 'Loading seats…',
  conflictSeatIds: new Set(),
  connected: false,
};

const sessionId = getOrCreateSessionId();

const app = document.querySelector('#app');
app.innerHTML = `
  <main class="shell">
    <header class="hero">
      <div>
        <p class="eyebrow">Single event</p>
        <h1>Seat Booking</h1>
        <p class="muted">Hold seats temporarily, then confirm them. Updates are pushed live to every viewer.</p>
      </div>
      <div class="session-card">
        <span>Your session</span>
        <code id="sessionId"></code>
        <small id="streamState">Connecting…</small>
      </div>
    </header>

    <section class="toolbar">
      <div class="inventory" id="inventory"></div>
      <div class="actions">
        <button id="holdButton" disabled>Hold selected</button>
        <button id="confirmButton" disabled>Confirm hold</button>
        <button id="releaseButton" disabled>Release hold</button>
      </div>
    </section>

    <section class="status-panel">
      <div id="message" class="message"></div>
      <div id="holdPanel" class="hold-panel hidden"></div>
    </section>

    <section class="legend" aria-label="Legend">
      <span><i class="swatch available"></i> Available</span>
      <span><i class="swatch selected"></i> Selected</span>
      <span><i class="swatch held"></i> Held</span>
      <span><i class="swatch booked"></i> Booked</span>
      <span><i class="swatch conflict"></i> Conflict</span>
    </section>

    <section class="seat-map" id="seatMap" aria-label="Seat map"></section>
  </main>
`;

const els = {
  sessionId: document.querySelector('#sessionId'),
  streamState: document.querySelector('#streamState'),
  inventory: document.querySelector('#inventory'),
  holdButton: document.querySelector('#holdButton'),
  confirmButton: document.querySelector('#confirmButton'),
  releaseButton: document.querySelector('#releaseButton'),
  message: document.querySelector('#message'),
  holdPanel: document.querySelector('#holdPanel'),
  seatMap: document.querySelector('#seatMap'),
};

els.sessionId.textContent = sessionId;
els.holdButton.addEventListener('click', requestHold);
els.confirmButton.addEventListener('click', confirmHold);
els.releaseButton.addEventListener('click', releaseHold);

loadSeats();
connectStream();
setInterval(updateCountdown, 250);

function getOrCreateSessionId() {
  const existing = localStorage.getItem(SESSION_KEY);
  if (existing) return existing;
  const id = crypto.randomUUID ? crypto.randomUUID() : `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  localStorage.setItem(SESSION_KEY, id);
  return id;
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
    const error = new Error(data.message || 'Request failed');
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

async function loadSeats() {
  try {
    const data = await api('/api/seats');
    state.seats = new Map(data.seats.map((seat) => [seat.id, seat]));
    state.inventory = data.inventory;
    state.holdTtlSeconds = data.holdTtlSeconds || 30;
    state.conflictSeatIds.clear();
    state.message = 'Choose available seats to begin.';
    pruneInvalidSelection();
    render();
  } catch (error) {
    state.message = `Unable to load seats: ${error.message}`;
    render();
  }
}

function connectStream() {
  const source = new EventSource(`${API_BASE}/api/stream`);
  source.addEventListener('connected', () => {
    state.connected = true;
    renderConnection();
  });
  source.addEventListener('heartbeat', () => {
    state.connected = true;
    renderConnection();
  });
  source.addEventListener('seat-changes', (event) => {
    const payload = JSON.parse(event.data);
    for (const change of payload.changes || []) {
      const existing = state.seats.get(change.id) || { id: change.id };
      state.seats.set(change.id, { ...existing, ...change });
      if (change.status !== 'available') state.selected.delete(change.id);
    }
    if (state.currentHold) {
      const holdSeats = state.currentHold.seatIds || [];
      const anyReleased = holdSeats.some((id) => state.seats.get(id)?.status === 'available');
      const allBooked = holdSeats.every((id) => state.seats.get(id)?.status === 'booked');
      if (anyReleased && state.currentHold.status === 'active') {
        state.currentHold = null;
        state.message = 'Your hold expired or was released.';
      } else if (allBooked) {
        state.currentHold.status = 'confirmed';
      }
    }
    recomputeInventory();
    render();
  });
  source.onerror = () => {
    state.connected = false;
    renderConnection();
  };
}

function render() {
  renderConnection();
  renderInventory();
  renderButtons();
  renderMessage();
  renderHoldPanel();
  renderSeatMap();
}

function renderConnection() {
  els.streamState.textContent = state.connected ? 'Live updates connected' : 'Live updates disconnected';
  els.streamState.className = state.connected ? 'online' : 'offline';
}

function renderInventory() {
  els.inventory.innerHTML = `
    <b>${state.inventory.total}</b> total
    <b class="ok">${state.inventory.available}</b> available
    <b class="warn">${state.inventory.held}</b> held
    <b class="bad">${state.inventory.booked}</b> booked
  `;
}

function renderButtons() {
  els.holdButton.disabled = state.selected.size === 0 || Boolean(state.currentHold?.status === 'active');
  els.confirmButton.disabled = !(state.currentHold?.status === 'active');
  els.releaseButton.disabled = !(state.currentHold?.status === 'active');
  els.holdButton.textContent = state.selected.size > 0 ? `Hold ${state.selected.size} selected` : 'Hold selected';
}

function renderMessage() {
  els.message.textContent = state.message;
}

function renderHoldPanel() {
  if (!state.currentHold) {
    els.holdPanel.classList.add('hidden');
    els.holdPanel.innerHTML = '';
    return;
  }
  const remaining = remainingSeconds(state.currentHold.expiresAt);
  els.holdPanel.classList.remove('hidden');
  els.holdPanel.innerHTML = `
    <strong>Current hold</strong>
    <span>${state.currentHold.seatIds.join(', ')}</span>
    <span>${state.currentHold.status === 'active' ? `${remaining}s remaining` : state.currentHold.status}</span>
  `;
}

function renderSeatMap() {
  const seats = [...state.seats.values()].sort((a, b) => a.rowLabel.localeCompare(b.rowLabel) || a.seatNumber - b.seatNumber);
  const rows = groupBy(seats, (seat) => seat.rowLabel);
  els.seatMap.innerHTML = '';

  for (const [rowLabel, rowSeats] of rows) {
    const row = document.createElement('div');
    row.className = 'seat-row';
    const label = document.createElement('div');
    label.className = 'row-label';
    label.textContent = rowLabel;
    row.append(label);

    for (const seat of rowSeats) {
      const button = document.createElement('button');
      const isSelected = state.selected.has(seat.id);
      const isConflict = state.conflictSeatIds.has(seat.id);
      button.className = `seat ${seat.status} ${isSelected ? 'selected' : ''} ${isConflict ? 'conflict' : ''}`;
      button.textContent = seat.seatNumber;
      button.title = `${seat.id}: ${seat.status}`;
      button.disabled = seat.status !== 'available' || Boolean(state.currentHold?.status === 'active');
      button.addEventListener('click', () => toggleSeat(seat.id));
      row.append(button);
    }

    els.seatMap.append(row);
  }
}

function groupBy(values, keyFn) {
  const result = new Map();
  for (const value of values) {
    const key = keyFn(value);
    if (!result.has(key)) result.set(key, []);
    result.get(key).push(value);
  }
  return result;
}

function toggleSeat(id) {
  const seat = state.seats.get(id);
  if (!seat || seat.status !== 'available') return;
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  state.conflictSeatIds.delete(id);
  state.message = state.selected.size ? `${state.selected.size} seat(s) selected.` : 'Choose available seats to begin.';
  render();
}

async function requestHold() {
  const seatIds = [...state.selected];
  if (seatIds.length === 0) return;
  try {
    const data = await api('/api/holds', {
      method: 'POST',
      body: JSON.stringify({ seatIds, sessionId }),
    });
    state.currentHold = data.hold;
    state.selected.clear();
    state.conflictSeatIds.clear();
    for (const id of data.hold.seatIds) {
      const existing = state.seats.get(id);
      if (existing) state.seats.set(id, { ...existing, status: 'held', holdId: data.hold.id, holdExpiresAt: data.hold.expiresAt });
    }
    recomputeInventory();
    state.message = 'Seats held. Confirm before the countdown expires.';
    render();
  } catch (error) {
    if (error.status === 409) {
      state.conflictSeatIds = new Set(error.data.conflictSeatIds || []);
      state.message = `Hold failed. Already taken: ${[...state.conflictSeatIds].join(', ') || 'requested seats'}.`;
      await loadSeats();
      state.conflictSeatIds = new Set(error.data.conflictSeatIds || []);
      render();
    } else {
      state.message = `Hold failed: ${error.message}`;
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
    for (const id of data.booking.seatIds) {
      const existing = state.seats.get(id);
      if (existing) state.seats.set(id, { ...existing, status: 'booked', bookedBy: sessionId, holdExpiresAt: null });
    }
    state.currentHold = { ...state.currentHold, status: 'confirmed', bookingId: data.booking.bookingId };
    recomputeInventory();
    state.message = data.idempotent ? 'Booking was already confirmed.' : 'Booking confirmed.';
    render();
  } catch (error) {
    state.message = `Confirm failed: ${error.message}`;
    state.currentHold = null;
    await loadSeats();
  }
}

async function releaseHold() {
  if (!state.currentHold) return;
  try {
    const holdId = state.currentHold.id;
    await api(`/api/holds/${holdId}`, {
      method: 'DELETE',
      body: JSON.stringify({ sessionId }),
    });
    for (const id of state.currentHold.seatIds) {
      const existing = state.seats.get(id);
      if (existing && existing.status === 'held') state.seats.set(id, { ...existing, status: 'available', holdId: null, holdExpiresAt: null });
    }
    state.currentHold = null;
    recomputeInventory();
    state.message = 'Hold released.';
    render();
  } catch (error) {
    state.message = `Release failed: ${error.message}`;
    render();
  }
}

function remainingSeconds(expiresAt) {
  if (!expiresAt) return 0;
  return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1000));
}

function updateCountdown() {
  if (!state.currentHold?.expiresAt || state.currentHold.status !== 'active') return;
  if (remainingSeconds(state.currentHold.expiresAt) <= 0) {
    state.message = 'Hold countdown elapsed. Waiting for server expiry…';
  }
  renderHoldPanel();
}

function pruneInvalidSelection() {
  for (const id of [...state.selected]) {
    if (state.seats.get(id)?.status !== 'available') state.selected.delete(id);
  }
}

function recomputeInventory() {
  state.inventory = { available: 0, held: 0, booked: 0, total: 0 };
  for (const seat of state.seats.values()) {
    state.inventory.total += 1;
    if (seat.status === 'available') state.inventory.available += 1;
    if (seat.status === 'held') state.inventory.held += 1;
    if (seat.status === 'booked') state.inventory.booked += 1;
  }
}
