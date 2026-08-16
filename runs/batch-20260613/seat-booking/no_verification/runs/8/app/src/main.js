import './styles.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3000';
const SESSION_KEY = 'seat-booking-session-id';
const sessionId = localStorage.getItem(SESSION_KEY) || crypto.randomUUID();
localStorage.setItem(SESSION_KEY, sessionId);

const state = {
  seats: new Map(),
  selected: new Set(),
  currentHold: null,
  inventory: null,
  countdownTimer: null,
};

const app = document.querySelector('#app');
app.innerHTML = `
  <header class="hero">
    <div>
      <p class="eyebrow">Single event</p>
      <h1>Live Seat Booking</h1>
      <p class="subtitle">Pick available seats, place a temporary hold, then confirm before the hold expires.</p>
    </div>
    <div class="session-card">
      <span>Session</span>
      <code id="sessionId"></code>
    </div>
  </header>

  <main class="layout">
    <section class="panel seat-panel">
      <div class="panel-title">
        <h2>Seat map</h2>
        <button id="refreshBtn" class="secondary">Refresh</button>
      </div>
      <div class="legend">
        <span><i class="seat available"></i> Available</span>
        <span><i class="seat selected"></i> Selected</span>
        <span><i class="seat held"></i> Held</span>
        <span><i class="seat booked"></i> Booked</span>
      </div>
      <div id="seatGrid" class="seat-grid" aria-live="polite"></div>
    </section>

    <aside class="panel controls">
      <h2>Your booking</h2>
      <div class="inventory" id="inventory"></div>
      <div class="selected-box">
        <strong>Selected seats</strong>
        <div id="selectedSeats" class="muted">None</div>
      </div>
      <button id="holdBtn" disabled>Hold selected seats</button>
      <button id="confirmBtn" disabled>Confirm hold</button>
      <button id="releaseBtn" class="secondary" disabled>Release hold</button>
      <div id="holdInfo" class="hold-info muted">No active hold.</div>
      <div id="messages" class="messages" aria-live="assertive"></div>
    </aside>
  </main>
`;

document.querySelector('#sessionId').textContent = sessionId.slice(0, 8);
const seatGrid = document.querySelector('#seatGrid');
const selectedSeatsEl = document.querySelector('#selectedSeats');
const holdBtn = document.querySelector('#holdBtn');
const confirmBtn = document.querySelector('#confirmBtn');
const releaseBtn = document.querySelector('#releaseBtn');
const holdInfo = document.querySelector('#holdInfo');
const messages = document.querySelector('#messages');
const inventoryEl = document.querySelector('#inventory');

function seatLabel(seat) {
  return `${seat.rowLabel}${seat.seatNumber}`;
}

function setMessage(text, type = 'info') {
  messages.innerHTML = text ? `<div class="message ${type}">${text}</div>` : '';
}

function updateInventory(inventory) {
  if (inventory) state.inventory = inventory;
  const inv = state.inventory || { available: 0, held: 0, booked: 0, total: state.seats.size };
  inventoryEl.innerHTML = `
    <div><strong>${inv.available}</strong><span>Available</span></div>
    <div><strong>${inv.held}</strong><span>Held</span></div>
    <div><strong>${inv.booked}</strong><span>Booked</span></div>
    <div><strong>${inv.total}</strong><span>Total</span></div>
  `;
}

function recomputeInventoryFromSeats() {
  const inv = { available: 0, held: 0, booked: 0, total: state.seats.size };
  for (const seat of state.seats.values()) {
    inv[seat.status] = (inv[seat.status] || 0) + 1;
  }
  updateInventory(inv);
}

function updateControls() {
  const selectedSeats = [...state.selected].map((id) => state.seats.get(id)).filter(Boolean);
  selectedSeatsEl.textContent = selectedSeats.length ? selectedSeats.map(seatLabel).join(', ') : 'None';
  holdBtn.disabled = selectedSeats.length === 0 || Boolean(state.currentHold);
  confirmBtn.disabled = !state.currentHold;
  releaseBtn.disabled = !state.currentHold;
}

function renderSeats() {
  const rows = new Map();
  for (const seat of [...state.seats.values()].sort((a, b) => a.rowLabel.localeCompare(b.rowLabel) || a.seatNumber - b.seatNumber)) {
    if (!rows.has(seat.rowLabel)) rows.set(seat.rowLabel, []);
    rows.get(seat.rowLabel).push(seat);
  }

  seatGrid.innerHTML = '';
  for (const [row, seats] of rows) {
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';
    const label = document.createElement('div');
    label.className = 'row-label';
    label.textContent = row;
    rowEl.append(label);

    for (const seat of seats) {
      const btn = document.createElement('button');
      const isSelected = state.selected.has(seat.id);
      const isMine = state.currentHold?.seatIds?.includes(seat.id) && seat.holdId === state.currentHold.id;
      btn.className = `seat ${seat.status}${isSelected ? ' selected' : ''}${isMine ? ' mine' : ''}`;
      btn.textContent = seat.seatNumber;
      btn.title = `${seatLabel(seat)} - ${isMine ? 'your hold' : seat.status}`;
      btn.disabled = seat.status !== 'available' && !isSelected;
      btn.addEventListener('click', () => toggleSeat(seat.id));
      rowEl.append(btn);
    }
    seatGrid.append(rowEl);
  }
  updateControls();
}

function toggleSeat(id) {
  const seat = state.seats.get(id);
  if (!seat || seat.status !== 'available') return;
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  renderSeats();
}

async function request(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function loadSeats() {
  const data = await request('/api/seats');
  state.seats = new Map(data.seats.map((seat) => [seat.id, seat]));
  for (const id of [...state.selected]) {
    if (state.seats.get(id)?.status !== 'available') state.selected.delete(id);
  }
  updateInventory(data.inventory);
  renderSeats();
}

function startCountdown() {
  clearInterval(state.countdownTimer);
  if (!state.currentHold) {
    holdInfo.textContent = 'No active hold.';
    return;
  }

  const tick = () => {
    if (!state.currentHold) {
      holdInfo.textContent = 'No active hold.';
      clearInterval(state.countdownTimer);
      return;
    }
    const ms = new Date(state.currentHold.expiresAt).getTime() - Date.now();
    if (ms <= 0) {
      holdInfo.innerHTML = '<strong>Hold expired.</strong> Refreshing availability...';
      clearInterval(state.countdownTimer);
      state.currentHold = null;
      updateControls();
      loadSeats().catch(() => {});
      return;
    }
    holdInfo.innerHTML = `Hold <code>${state.currentHold.id.slice(0, 8)}</code> expires in <strong>${Math.ceil(ms / 1000)}s</strong>.`;
  };
  tick();
  state.countdownTimer = setInterval(tick, 250);
}

async function holdSelected() {
  const seatIds = [...state.selected];
  if (!seatIds.length) return;
  setMessage('');
  holdBtn.disabled = true;
  try {
    const data = await request('/api/holds', {
      method: 'POST',
      body: JSON.stringify({ seatIds, sessionId }),
    });
    state.currentHold = data.hold;
    state.selected.clear();
    for (const seat of data.seats) state.seats.set(seat.id, seat);
    updateInventory(data.inventory);
    renderSeats();
    startCountdown();
    setMessage('Seats held. Confirm before the timer expires.', 'success');
  } catch (err) {
    if (err.status === 409) {
      const conflicts = (err.data.conflicts || []).join(', ');
      setMessage(`Hold failed. Already unavailable: ${conflicts || 'selected seats'}.`, 'error');
      await loadSeats();
    } else {
      setMessage(err.message, 'error');
    }
  } finally {
    updateControls();
  }
}

async function confirmHold() {
  if (!state.currentHold) return;
  setMessage('');
  confirmBtn.disabled = true;
  try {
    const data = await request(`/api/holds/${state.currentHold.id}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    });
    for (const seat of data.seats) state.seats.set(seat.id, seat);
    updateInventory(data.inventory);
    state.currentHold = null;
    clearInterval(state.countdownTimer);
    holdInfo.textContent = 'No active hold.';
    renderSeats();
    setMessage(`Booking confirmed (${data.booking.id.slice(0, 8)}).`, 'success');
  } catch (err) {
    setMessage(err.message, 'error');
    state.currentHold = null;
    startCountdown();
    await loadSeats().catch(() => {});
  } finally {
    updateControls();
  }
}

async function releaseHold() {
  if (!state.currentHold) return;
  const holdId = state.currentHold.id;
  state.currentHold = null;
  startCountdown();
  updateControls();
  try {
    const data = await request(`/api/holds/${holdId}`, {
      method: 'DELETE',
      body: JSON.stringify({ sessionId }),
    });
    for (const seat of data.released || []) state.seats.set(seat.id, seat);
    updateInventory(data.inventory);
    renderSeats();
    setMessage('Hold released.', 'success');
  } catch (err) {
    setMessage(err.message, 'error');
    await loadSeats().catch(() => {});
  }
}

function applySeatUpdates(data) {
  for (const seat of data.seats || []) {
    const existing = state.seats.get(seat.id) || {};
    state.seats.set(seat.id, { ...existing, ...seat });
    if (seat.status !== 'available') state.selected.delete(seat.id);
  }

  if (state.currentHold) {
    const stillHeld = state.currentHold.seatIds.every((id) => {
      const seat = state.seats.get(id);
      return seat?.status === 'held' && seat.holdId === state.currentHold.id;
    });
    const bookedByMe = state.currentHold.seatIds.every((id) => {
      const seat = state.seats.get(id);
      return seat?.status === 'booked' && seat.holdId === state.currentHold.id;
    });
    if (!stillHeld && !bookedByMe) {
      state.currentHold = null;
      startCountdown();
      setMessage('Your hold is no longer active.', 'info');
    }
  }

  if (data.inventory) updateInventory(data.inventory);
  else recomputeInventoryFromSeats();
  renderSeats();
}

function connectStream() {
  const source = new EventSource(`${API_BASE}/api/stream`);
  source.addEventListener('seat-update', (event) => {
    try {
      applySeatUpdates(JSON.parse(event.data));
    } catch (_) {
      // Ignore malformed stream events.
    }
  });
  source.onerror = () => {
    setMessage('Live connection interrupted; the browser will retry automatically.', 'info');
  };
}

holdBtn.addEventListener('click', holdSelected);
confirmBtn.addEventListener('click', confirmHold);
releaseBtn.addEventListener('click', releaseHold);
document.querySelector('#refreshBtn').addEventListener('click', loadSeats);

loadSeats().then(connectStream).catch((err) => setMessage(err.message, 'error'));
