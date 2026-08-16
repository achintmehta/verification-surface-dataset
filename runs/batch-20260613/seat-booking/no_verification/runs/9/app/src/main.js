import './styles.css';

const API_BASE = '';
const HOLD_WARNING_MS = 10_000;
const SESSION_KEY = 'seat-booking-session-id';

let sessionId = localStorage.getItem(SESSION_KEY);
if (!sessionId) {
  sessionId = crypto.randomUUID();
  localStorage.setItem(SESSION_KEY, sessionId);
}

const state = {
  seats: new Map(),
  selected: new Set(),
  currentHold: null,
  inventory: null,
  timer: null
};

const app = document.querySelector('#app');
app.innerHTML = `
  <header class="hero">
    <div>
      <h1>Seat Booking</h1>
      <p>Temporary holds, transactional confirmation, automatic expiry, and live updates.</p>
    </div>
    <div class="session-card">
      <span>Session</span>
      <code id="sessionId"></code>
    </div>
  </header>

  <main class="layout">
    <section class="panel map-panel">
      <div class="toolbar">
        <div>
          <h2>Seat Map</h2>
          <p id="inventory" class="muted">Loading inventory…</p>
        </div>
        <button id="refreshBtn" class="secondary">Refresh</button>
      </div>
      <div class="legend">
        <span><i class="swatch available"></i>Available</span>
        <span><i class="swatch selected"></i>Selected</span>
        <span><i class="swatch held"></i>Held</span>
        <span><i class="swatch booked"></i>Booked</span>
      </div>
      <div id="seatGrid" class="seat-grid" aria-live="polite"></div>
    </section>

    <aside class="panel controls">
      <h2>Your booking</h2>
      <div id="notice" class="notice">Choose one or more available seats.</div>
      <div class="selected-box">
        <strong>Selected seats</strong>
        <div id="selectedSeats" class="pill-list">None</div>
      </div>
      <div id="holdBox" class="hold-box hidden">
        <strong>Current hold</strong>
        <div id="heldSeats" class="pill-list"></div>
        <div id="countdown" class="countdown"></div>
      </div>
      <div class="actions">
        <button id="holdBtn">Hold selected seats</button>
        <button id="confirmBtn" disabled>Confirm hold</button>
        <button id="releaseBtn" class="secondary" disabled>Release hold</button>
      </div>
      <p class="muted small">Holds expire on the server. If the countdown reaches zero, the seats become available to everyone.</p>
    </aside>
  </main>
`;

const els = {
  sessionId: document.querySelector('#sessionId'),
  inventory: document.querySelector('#inventory'),
  grid: document.querySelector('#seatGrid'),
  refreshBtn: document.querySelector('#refreshBtn'),
  notice: document.querySelector('#notice'),
  selectedSeats: document.querySelector('#selectedSeats'),
  holdBox: document.querySelector('#holdBox'),
  heldSeats: document.querySelector('#heldSeats'),
  countdown: document.querySelector('#countdown'),
  holdBtn: document.querySelector('#holdBtn'),
  confirmBtn: document.querySelector('#confirmBtn'),
  releaseBtn: document.querySelector('#releaseBtn')
};

els.sessionId.textContent = sessionId.slice(0, 8);

function setNotice(message, type = 'info') {
  els.notice.textContent = message;
  els.notice.className = `notice ${type}`;
}

function api(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  }).then(async (response) => {
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const error = new Error(data?.error?.message || response.statusText);
      error.status = response.status;
      error.payload = data;
      throw error;
    }
    return data;
  });
}

function updateInventory(inventory) {
  if (!inventory) {
    const seats = [...state.seats.values()];
    inventory = seats.reduce((acc, seat) => {
      acc.total += 1;
      acc[seat.status] += 1;
      return acc;
    }, { total: 0, available: 0, held: 0, booked: 0 });
  }
  state.inventory = inventory;
  els.inventory.textContent = `${inventory.available} available · ${inventory.held} held · ${inventory.booked} booked · ${inventory.total} total`;
}

function seatSort(a, b) {
  return a.rowLabel.localeCompare(b.rowLabel) || a.seatNumber - b.seatNumber;
}

function seatPills(ids) {
  if (!ids || ids.length === 0) return 'None';
  return ids.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((id) => `<span class="pill">${id}</span>`).join('');
}

function renderSelected() {
  els.selectedSeats.innerHTML = seatPills([...state.selected]);
  els.holdBtn.disabled = state.selected.size === 0 || Boolean(state.currentHold);
}

function renderHold() {
  if (!state.currentHold) {
    els.holdBox.classList.add('hidden');
    els.confirmBtn.disabled = true;
    els.releaseBtn.disabled = true;
    return;
  }
  els.holdBox.classList.remove('hidden');
  els.heldSeats.innerHTML = seatPills(state.currentHold.seatIds);
  els.confirmBtn.disabled = false;
  els.releaseBtn.disabled = false;
  updateCountdown();
}

function renderGrid() {
  const seats = [...state.seats.values()].sort(seatSort);
  const rows = new Map();
  for (const seat of seats) {
    if (!rows.has(seat.rowLabel)) rows.set(seat.rowLabel, []);
    rows.get(seat.rowLabel).push(seat);
  }

  els.grid.innerHTML = '';
  for (const [rowLabel, rowSeats] of rows) {
    const label = document.createElement('div');
    label.className = 'row-label';
    label.textContent = rowLabel;
    els.grid.appendChild(label);

    const row = document.createElement('div');
    row.className = 'seat-row';
    for (const seat of rowSeats) {
      const button = document.createElement('button');
      const isSelected = state.selected.has(seat.id);
      const ownHold = state.currentHold?.seatIds?.includes(seat.id) && seat.status === 'held';
      button.className = `seat ${seat.status}${isSelected ? ' selected' : ''}${ownHold ? ' own-hold' : ''}`;
      button.textContent = seat.seatNumber;
      button.title = `${seat.id}: ${seat.status}`;
      button.disabled = seat.status !== 'available' && !isSelected;
      button.addEventListener('click', () => toggleSeat(seat.id));
      row.appendChild(button);
    }
    els.grid.appendChild(row);
  }
  renderSelected();
  renderHold();
  updateInventory();
}

function toggleSeat(seatId) {
  const seat = state.seats.get(seatId);
  if (!seat || seat.status !== 'available') return;
  if (state.selected.has(seatId)) state.selected.delete(seatId);
  else state.selected.add(seatId);
  renderGrid();
}

async function loadSeats(message) {
  const data = await api('/api/seats');
  state.seats = new Map(data.seats.map((seat) => [seat.id, seat]));
  state.inventory = data.inventory;
  for (const selected of [...state.selected]) {
    if (state.seats.get(selected)?.status !== 'available') state.selected.delete(selected);
  }
  if (state.currentHold) {
    const stillHeld = state.currentHold.seatIds.every((id) => {
      const seat = state.seats.get(id);
      return seat?.status === 'held' && seat.holdId === state.currentHold.id;
    });
    if (!stillHeld) clearCurrentHold('Your hold is no longer active.', 'warn');
  }
  renderGrid();
  if (message) setNotice(message);
}

async function requestHold() {
  const seatIds = [...state.selected];
  if (seatIds.length === 0) return;
  try {
    els.holdBtn.disabled = true;
    const data = await api('/api/holds', {
      method: 'POST',
      body: JSON.stringify({ seatIds, sessionId })
    });
    for (const seat of data.seats) state.seats.set(seat.id, seat);
    state.currentHold = data.hold;
    state.selected.clear();
    setNotice(`Holding ${data.hold.seatIds.length} seat(s). Confirm before the timer expires.`, 'success');
    startTimer();
    renderGrid();
  } catch (error) {
    const conflicts = error.payload?.error?.conflicts || [];
    const ids = conflicts.map((seat) => seat.id).join(', ');
    setNotice(ids ? `Hold failed. Already taken: ${ids}` : `Hold failed: ${error.message}`, 'error');
    await loadSeats();
  } finally {
    renderSelected();
  }
}

async function confirmHold() {
  if (!state.currentHold) return;
  try {
    els.confirmBtn.disabled = true;
    const data = await api(`/api/holds/${state.currentHold.id}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ sessionId })
    });
    for (const seat of data.seats) state.seats.set(seat.id, seat);
    const count = data.booking.seatIds.length;
    clearCurrentHold(`Confirmed ${count} seat(s). Booking ${data.booking.id.slice(0, 8)}.`, 'success');
    renderGrid();
  } catch (error) {
    clearCurrentHold(`Confirm failed: ${error.message}`, 'error');
    await loadSeats();
  }
}

async function releaseHold() {
  if (!state.currentHold) return;
  const holdId = state.currentHold.id;
  try {
    els.releaseBtn.disabled = true;
    const data = await api(`/api/holds/${holdId}`, {
      method: 'DELETE',
      body: JSON.stringify({ sessionId })
    });
    for (const seat of data.seats) state.seats.set(seat.id, seat);
    clearCurrentHold('Hold released.', 'info');
    renderGrid();
  } catch (error) {
    clearCurrentHold(`Release failed: ${error.message}`, 'error');
    await loadSeats();
  }
}

function startTimer() {
  clearInterval(state.timer);
  state.timer = setInterval(updateCountdown, 250);
  updateCountdown();
}

function clearCurrentHold(message, type = 'info') {
  clearInterval(state.timer);
  state.timer = null;
  state.currentHold = null;
  renderHold();
  renderSelected();
  if (message) setNotice(message, type);
}

function updateCountdown() {
  if (!state.currentHold) return;
  const remaining = new Date(state.currentHold.expiresAt).getTime() - Date.now();
  if (remaining <= 0) {
    els.countdown.textContent = 'Expired — releasing on server…';
    clearCurrentHold('Hold expired. Refreshing seat map…', 'warn');
    loadSeats().catch(() => {});
    return;
  }
  const seconds = Math.ceil(remaining / 1000);
  els.countdown.textContent = `${seconds}s remaining`;
  els.countdown.classList.toggle('warning', remaining <= HOLD_WARNING_MS);
}

function applySeatChanges(changes) {
  for (const seat of changes || []) {
    state.seats.set(seat.id, seat);
    if (seat.status !== 'available') state.selected.delete(seat.id);
  }
  if (state.currentHold) {
    const stillOwnHold = state.currentHold.seatIds.every((id) => {
      const seat = state.seats.get(id);
      return (seat?.status === 'held' && seat.holdId === state.currentHold.id) || seat?.status === 'booked';
    });
    if (!stillOwnHold) clearCurrentHold('Your hold ended or expired.', 'warn');
  }
  renderGrid();
}

function connectStream() {
  const source = new EventSource('/api/stream');
  source.addEventListener('seats', (event) => {
    const payload = JSON.parse(event.data);
    applySeatChanges(payload.changes);
  });
  source.onerror = () => {
    setNotice('Live connection interrupted. Browser will retry automatically.', 'warn');
  };
}

els.refreshBtn.addEventListener('click', () => loadSeats('Seat map refreshed.').catch((error) => setNotice(error.message, 'error')));
els.holdBtn.addEventListener('click', requestHold);
els.confirmBtn.addEventListener('click', confirmHold);
els.releaseBtn.addEventListener('click', releaseHold);

loadSeats().catch((error) => setNotice(`Could not load seats: ${error.message}`, 'error'));
connectStream();
