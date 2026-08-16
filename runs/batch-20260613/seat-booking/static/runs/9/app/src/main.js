import './styles.css';

const API = '';
const SESSION_KEY = 'seat-booking-session-id';
let sessionId = localStorage.getItem(SESSION_KEY);
if (!sessionId) {
  sessionId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  localStorage.setItem(SESSION_KEY, sessionId);
}

const state = {
  seats: [],
  selected: new Set(),
  currentHold: null,
  countdownTimer: null,
  message: '',
  messageKind: 'info',
  inventory: { available: 0, held: 0, booked: 0, total: 0 }
};

const app = document.querySelector('#app');
app.innerHTML = `
  <header class="hero">
    <div>
      <h1>Seat Booking</h1>
      <p>Live fixed-seat map with atomic holds, expiry, and booking confirmation.</p>
    </div>
    <div class="session">Session<br><code id="session-id"></code></div>
  </header>

  <main class="layout">
    <section class="panel map-panel">
      <div class="panel-title">
        <h2>Seat Map</h2>
        <button id="refresh" type="button">Refresh</button>
      </div>
      <div class="legend">
        <span><i class="swatch available"></i>Available</span>
        <span><i class="swatch selected"></i>Selected</span>
        <span><i class="swatch held"></i>Held</span>
        <span><i class="swatch booked"></i>Booked</span>
      </div>
      <div id="seat-map" class="seat-map" aria-live="polite"></div>
    </section>

    <aside class="panel controls">
      <h2>Controls</h2>
      <div id="message" class="message info">Loading seats…</div>

      <div class="inventory">
        <div><strong id="inv-available">0</strong><span>Available</span></div>
        <div><strong id="inv-held">0</strong><span>Held</span></div>
        <div><strong id="inv-booked">0</strong><span>Booked</span></div>
        <div><strong id="inv-total">0</strong><span>Total</span></div>
      </div>

      <section class="selection-box">
        <h3>Selected seats</h3>
        <p id="selected-list" class="muted">None</p>
        <button id="hold" type="button">Hold selected seats</button>
      </section>

      <section class="hold-box">
        <h3>Current hold</h3>
        <p id="hold-info" class="muted">No active hold.</p>
        <div class="button-row">
          <button id="confirm" type="button">Confirm booking</button>
          <button id="release" type="button" class="secondary">Release hold</button>
        </div>
      </section>
    </aside>
  </main>
`;

const els = {
  session: document.querySelector('#session-id'),
  map: document.querySelector('#seat-map'),
  refresh: document.querySelector('#refresh'),
  hold: document.querySelector('#hold'),
  confirm: document.querySelector('#confirm'),
  release: document.querySelector('#release'),
  message: document.querySelector('#message'),
  selectedList: document.querySelector('#selected-list'),
  holdInfo: document.querySelector('#hold-info'),
  invAvailable: document.querySelector('#inv-available'),
  invHeld: document.querySelector('#inv-held'),
  invBooked: document.querySelector('#inv-booked'),
  invTotal: document.querySelector('#inv-total')
};
els.session.textContent = sessionId.slice(0, 8);

function setMessage(text, kind = 'info') {
  state.message = text;
  state.messageKind = kind;
  els.message.textContent = text;
  els.message.className = `message ${kind}`;
}

function recomputeInventory() {
  const inventory = { available: 0, held: 0, booked: 0, total: state.seats.length };
  for (const seat of state.seats) inventory[seat.status] += 1;
  state.inventory = inventory;
  els.invAvailable.textContent = inventory.available;
  els.invHeld.textContent = inventory.held;
  els.invBooked.textContent = inventory.booked;
  els.invTotal.textContent = inventory.total;
}

function selectedSeats() {
  return state.seats.filter((seat) => state.selected.has(seat.id));
}

function renderSelected() {
  const seats = selectedSeats();
  els.selectedList.textContent = seats.length ? seats.map((seat) => seat.id).join(', ') : 'None';
  els.hold.disabled = seats.length === 0 || Boolean(activeHold());
}

function activeHold() {
  if (!state.currentHold || state.currentHold.status !== 'held') return null;
  if (new Date(state.currentHold.expiresAt).getTime() <= Date.now()) return null;
  return state.currentHold;
}

function renderHold() {
  const hold = activeHold();
  els.confirm.disabled = !hold;
  els.release.disabled = !hold;
  if (!hold) {
    els.holdInfo.textContent = state.currentHold?.status === 'booked'
      ? `Booked: ${state.currentHold.seats.map((seat) => seat.id).join(', ')}`
      : 'No active hold.';
    renderSelected();
    return;
  }
  const remainingMs = Math.max(0, new Date(hold.expiresAt).getTime() - Date.now());
  const seconds = Math.ceil(remainingMs / 1000);
  els.holdInfo.textContent = `${hold.seats.map((seat) => seat.id).join(', ')} held for ${seconds}s (hold ${hold.holdId.slice(0, 8)})`;
  renderSelected();
}

function startCountdown() {
  if (state.countdownTimer) clearInterval(state.countdownTimer);
  state.countdownTimer = setInterval(() => {
    if (state.currentHold?.status === 'held' && !activeHold()) {
      const ids = new Set(state.currentHold.seats.map((seat) => seat.id));
      for (const seat of state.seats) {
        if (ids.has(seat.id) && seat.status === 'held' && seat.holdId === state.currentHold.holdId) {
          seat.status = 'available';
          seat.holdId = null;
          seat.holdExpiresAt = null;
        }
      }
      state.currentHold = null;
      setMessage('Your hold expired and those seats are available again.', 'warn');
      render();
      loadSeats();
    } else {
      renderHold();
    }
  }, 250);
}

function seatButton(seat) {
  const selected = state.selected.has(seat.id);
  const heldByMe = state.currentHold?.holdId && seat.holdId === state.currentHold.holdId && seat.status === 'held';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `seat ${seat.status}${selected ? ' selected' : ''}${heldByMe ? ' mine' : ''}`;
  button.textContent = seat.seatNumber;
  button.title = `${seat.id}: ${seat.status}${heldByMe ? ' by you' : ''}`;
  button.disabled = seat.status !== 'available' && !selected;
  button.addEventListener('click', () => {
    if (seat.status !== 'available' && !selected) return;
    if (state.selected.has(seat.id)) state.selected.delete(seat.id);
    else state.selected.add(seat.id);
    render();
  });
  return button;
}

function renderMap() {
  els.map.innerHTML = '';
  const rows = state.seats.reduce((map, seat) => map.set(seat.rowLabel, [...(map.get(seat.rowLabel) || []), seat]), new Map());

  for (const [rowLabel, seats] of rows) {
    const row = document.createElement('div');
    row.className = 'seat-row';
    const label = document.createElement('strong');
    label.className = 'row-label';
    label.textContent = rowLabel;
    row.append(label);
    seats.sort((a, b) => a.seatNumber - b.seatNumber).forEach((seat) => row.append(seatButton(seat)));
    els.map.append(row);
  }
}

function render() {
  renderMap();
  recomputeInventory();
  renderSelected();
  renderHold();
}

function applySeatsUpdate(seats) {
  const byId = new Map(state.seats.map((seat) => [seat.id, seat]));
  for (const incoming of seats) {
    const existing = byId.get(incoming.id);
    if (existing) Object.assign(existing, incoming);
    else state.seats.push(incoming);
    if (incoming.status !== 'available') state.selected.delete(incoming.id);
  }
  state.seats.sort((a, b) => a.rowLabel.localeCompare(b.rowLabel) || a.seatNumber - b.seatNumber);
  render();
}

async function request(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status})`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

async function loadSeats() {
  try {
    const data = await request('/api/seats');
    state.seats = data.seats;
    state.selected.clear();
    render();
    setMessage('Seat map is up to date.', 'ok');
  } catch (error) {
    setMessage(error.message, 'error');
  }
}

async function createHold() {
  const seatIds = [...state.selected];
  if (!seatIds.length) return;
  try {
    const data = await request('/api/holds', {
      method: 'POST',
      body: JSON.stringify({ seatIds, sessionId })
    });
    state.currentHold = data.hold;
    state.selected.clear();
    applySeatsUpdate(data.hold.seats);
    startCountdown();
    setMessage(`Held ${data.hold.seats.length} seat(s). Confirm before the countdown ends.`, 'ok');
  } catch (error) {
    if (error.status === 409) {
      const conflicts = error.data.conflictingSeatIds || [];
      setMessage(`Hold failed. Already taken: ${conflicts.join(', ') || 'selected seats'}.`, 'warn');
      await loadSeats();
    } else {
      setMessage(error.message, 'error');
    }
  }
}

async function confirmHold() {
  const hold = activeHold();
  if (!hold) return;
  try {
    const data = await request(`/api/holds/${hold.holdId}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ sessionId })
    });
    state.currentHold = data.hold;
    applySeatsUpdate(data.hold.seats);
    setMessage(data.idempotent ? 'Booking was already confirmed.' : 'Booking confirmed!', 'ok');
  } catch (error) {
    setMessage(error.message, error.status === 409 ? 'warn' : 'error');
    await loadSeats();
  }
}

async function releaseHold() {
  const hold = activeHold();
  if (!hold) return;
  try {
    const data = await request(`/api/holds/${hold.holdId}`, {
      method: 'DELETE',
      body: JSON.stringify({ sessionId })
    });
    state.currentHold = null;
    applySeatsUpdate(data.released || []);
    setMessage('Hold released.', 'ok');
  } catch (error) {
    setMessage(error.message, 'error');
    await loadSeats();
  }
}

function connectStream() {
  const stream = new EventSource('/api/stream');
  const onSeats = (event) => {
    const data = JSON.parse(event.data);
    if (Array.isArray(data.seats)) applySeatsUpdate(data.seats);
  };
  stream.addEventListener('held', onSeats);
  stream.addEventListener('booked', onSeats);
  stream.addEventListener('released', onSeats);
  stream.addEventListener('error', () => setMessage('Live connection interrupted; retrying…', 'warn'));
}

els.refresh.addEventListener('click', loadSeats);
els.hold.addEventListener('click', createHold);
els.confirm.addEventListener('click', confirmHold);
els.release.addEventListener('click', releaseHold);

loadSeats();
startCountdown();
connectStream();
