import './styles.css';

const API = '';
const SESSION_KEY = 'seat-booking-session-id';
let sessionId = localStorage.getItem(SESSION_KEY);
if (!sessionId) {
  sessionId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  localStorage.setItem(SESSION_KEY, sessionId);
}

const state = {
  seats: new Map(),
  selected: new Set(),
  currentHold: null,
  inventory: null,
  holdTtlMs: 30000,
  lastConflictIds: new Set()
};

const app = document.querySelector('#app');
app.innerHTML = `
  <header class="topbar">
    <div>
      <h1>Seat Booking</h1>
      <p>Session <code>${sessionId.slice(0, 8)}</code></p>
    </div>
    <div class="inventory" id="inventory"></div>
  </header>

  <main class="layout">
    <section class="panel">
      <div class="legend">
        <span><i class="swatch available"></i>Available</span>
        <span><i class="swatch selected"></i>Selected</span>
        <span><i class="swatch held"></i>Held</span>
        <span><i class="swatch booked"></i>Booked</span>
      </div>
      <div id="seatMap" class="seat-map" aria-live="polite"></div>
    </section>

    <aside class="panel controls">
      <h2>Your hold</h2>
      <p id="statusMessage">Select available seats to begin.</p>
      <p id="countdown" class="countdown"></p>
      <div class="button-row">
        <button id="holdButton">Hold selected seats</button>
        <button id="confirmButton" disabled>Confirm booking</button>
        <button id="releaseButton" disabled>Release hold</button>
      </div>
      <button id="refreshButton" class="secondary">Refresh seat map</button>
    </aside>
  </main>
`;

const seatMap = document.querySelector('#seatMap');
const inventoryEl = document.querySelector('#inventory');
const statusMessage = document.querySelector('#statusMessage');
const countdownEl = document.querySelector('#countdown');
const holdButton = document.querySelector('#holdButton');
const confirmButton = document.querySelector('#confirmButton');
const releaseButton = document.querySelector('#releaseButton');
const refreshButton = document.querySelector('#refreshButton');

function seatLabel(seat) {
  return `${seat.rowLabel}${seat.seatNumber}`;
}

function setMessage(message, kind = '') {
  statusMessage.textContent = message;
  statusMessage.className = kind;
}

function updateInventory() {
  if (!state.inventory) {
    inventoryEl.textContent = '';
    return;
  }
  const { available, held, booked, total } = state.inventory;
  inventoryEl.innerHTML = `
    <strong>${available}</strong> available
    <strong>${held}</strong> held
    <strong>${booked}</strong> booked
    <strong>${total}</strong> total
  `;
}

function renderSeats() {
  const seats = [...state.seats.values()].sort((a, b) => a.rowLabel.localeCompare(b.rowLabel) || a.seatNumber - b.seatNumber);
  const rows = Map.groupBy ? Map.groupBy(seats, (seat) => seat.rowLabel) : groupByRow(seats);
  seatMap.innerHTML = '';

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
      const isConflict = state.lastConflictIds.has(seat.id);
      button.className = `seat ${seat.status}${isSelected ? ' selected' : ''}${isConflict ? ' conflict' : ''}`;
      button.textContent = seat.seatNumber;
      button.title = `${seatLabel(seat)} is ${seat.status}`;
      button.disabled = seat.status !== 'available' && !isSelected;
      button.addEventListener('click', () => toggleSeat(seat.id));
      row.append(button);
    }
    seatMap.append(row);
  }

  updateControls();
  updateInventory();
}

function groupByRow(seats) {
  const grouped = new Map();
  for (const seat of seats) {
    if (!grouped.has(seat.rowLabel)) grouped.set(seat.rowLabel, []);
    grouped.get(seat.rowLabel).push(seat);
  }
  return grouped;
}

function toggleSeat(id) {
  const seat = state.seats.get(id);
  if (!seat || seat.status !== 'available' || state.currentHold) return;
  state.lastConflictIds.clear();
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  renderSeats();
}

function updateControls() {
  holdButton.disabled = state.selected.size === 0 || Boolean(state.currentHold);
  confirmButton.disabled = !state.currentHold;
  releaseButton.disabled = !state.currentHold;
}

function applySeats(seats) {
  for (const seat of seats) state.seats.set(seat.id, seat);
  for (const id of [...state.selected]) {
    const seat = state.seats.get(id);
    if (!seat || seat.status !== 'available') state.selected.delete(id);
  }
  if (state.currentHold) {
    const ownedIds = new Set(state.currentHold.seatIds);
    const stillHeld = [...ownedIds].every((id) => {
      const seat = state.seats.get(id);
      return seat && seat.status === 'held' && seat.holdId === state.currentHold.id;
    });
    const booked = [...ownedIds].every((id) => state.seats.get(id)?.status === 'booked');
    if (!stillHeld && !booked) {
      state.currentHold = null;
      setMessage('Your hold has expired or was released.', 'warn');
    }
  }
}

async function loadSeats() {
  const response = await fetch(`${API}/api/seats`);
  if (!response.ok) throw new Error('Failed to load seats');
  const data = await response.json();
  state.seats = new Map(data.seats.map((seat) => [seat.id, seat]));
  state.inventory = data.inventory;
  state.holdTtlMs = data.holdTtlMs;
  renderSeats();
}

async function createHold() {
  const seatIds = [...state.selected];
  if (seatIds.length === 0) return;
  holdButton.disabled = true;
  try {
    const response = await fetch(`${API}/api/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId })
    });
    const data = await response.json();
    if (response.status === 409) {
      state.lastConflictIds = new Set(data.conflictingSeatIds || []);
      setMessage(`Those seats are no longer available: ${(data.conflictingSeatIds || []).join(', ')}`, 'error');
      await loadSeats();
      return;
    }
    if (!response.ok) throw new Error(data.error || 'Hold failed');
    state.currentHold = data.hold;
    state.selected.clear();
    state.lastConflictIds.clear();
    applySeats(data.seats);
    setMessage(`Held ${data.hold.seatIds.length} seat(s). Confirm before the timer expires.`, 'ok');
    renderSeats();
  } catch (error) {
    setMessage(error.message, 'error');
  } finally {
    updateControls();
  }
}

async function confirmHold() {
  if (!state.currentHold) return;
  confirmButton.disabled = true;
  try {
    const response = await fetch(`${API}/api/holds/${state.currentHold.id}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Confirm failed');
    applySeats(data.seats);
    setMessage(`Booked ${data.booking.seatIds.length} seat(s).`, 'ok');
    state.currentHold = null;
    renderSeats();
  } catch (error) {
    setMessage(error.message, 'error');
    await loadSeats();
  }
}

async function releaseHold() {
  if (!state.currentHold) return;
  const hold = state.currentHold;
  releaseButton.disabled = true;
  try {
    const response = await fetch(`${API}/api/holds/${hold.id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Release failed');
    state.currentHold = null;
    applySeats(data.seats || []);
    setMessage('Hold released.', 'ok');
    renderSeats();
  } catch (error) {
    setMessage(error.message, 'error');
  }
}

function tickCountdown() {
  if (!state.currentHold) {
    countdownEl.textContent = '';
    return;
  }
  const ms = new Date(state.currentHold.expiresAt).getTime() - Date.now();
  if (ms <= 0) {
    countdownEl.textContent = 'Expired; waiting for server release...';
    confirmButton.disabled = true;
    return;
  }
  countdownEl.textContent = `Time remaining: ${Math.ceil(ms / 1000)}s`;
}

function connectStream() {
  const events = new EventSource(`${API}/api/stream`);
  events.addEventListener('seat-update', (event) => {
    const data = JSON.parse(event.data);
    if (data.inventory) state.inventory = data.inventory;
    applySeats(data.seats || []);
    renderSeats();
  });
  events.onerror = () => {
    setMessage('Live connection interrupted; retrying automatically.', 'warn');
  };
}

holdButton.addEventListener('click', createHold);
confirmButton.addEventListener('click', confirmHold);
releaseButton.addEventListener('click', releaseHold);
refreshButton.addEventListener('click', () => loadSeats().catch((error) => setMessage(error.message, 'error')));
setInterval(tickCountdown, 250);

loadSeats()
  .then(connectStream)
  .catch((error) => setMessage(error.message, 'error'));
