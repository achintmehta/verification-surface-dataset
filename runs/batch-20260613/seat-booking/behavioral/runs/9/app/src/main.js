import './styles.css';

const API_BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '');
const app = document.querySelector('#app');
const sessionId = getSessionId();

let seats = [];
let selected = new Set();
let currentHold = null;
let countdownTimer = null;
let lastConflictIds = new Set();

app.innerHTML = `
  <main class="shell">
    <header class="hero">
      <div>
        <p class="eyebrow">Single event</p>
        <h1>Live Seat Booking</h1>
        <p class="subtle">Select available seats, place a temporary hold, then confirm before the timer expires.</p>
      </div>
      <div class="session">Session <code>${sessionId.slice(0, 8)}</code></div>
    </header>

    <section class="status-bar">
      <div><strong id="availableCount">0</strong><span>Available</span></div>
      <div><strong id="heldCount">0</strong><span>Held</span></div>
      <div><strong id="bookedCount">0</strong><span>Booked</span></div>
      <div><strong id="selectedCount">0</strong><span>Selected</span></div>
    </section>

    <section class="panel controls">
      <button id="holdBtn">Hold selected seats</button>
      <button id="confirmBtn" disabled>Confirm current hold</button>
      <button id="releaseBtn" disabled>Release hold</button>
      <button id="refreshBtn" class="secondary">Refresh</button>
      <span id="holdInfo" class="hold-info">No active hold</span>
    </section>

    <section class="screen">SCREEN</section>
    <section id="seatGrid" class="seat-grid" aria-live="polite"></section>

    <section class="panel log-panel">
      <h2>Activity</h2>
      <ul id="messages"></ul>
    </section>
  </main>
`;

const grid = document.querySelector('#seatGrid');
const holdBtn = document.querySelector('#holdBtn');
const confirmBtn = document.querySelector('#confirmBtn');
const releaseBtn = document.querySelector('#releaseBtn');
const refreshBtn = document.querySelector('#refreshBtn');
const holdInfo = document.querySelector('#holdInfo');
const messages = document.querySelector('#messages');

holdBtn.addEventListener('click', createHold);
confirmBtn.addEventListener('click', confirmHold);
releaseBtn.addEventListener('click', releaseHold);
refreshBtn.addEventListener('click', loadSeats);

loadSeats();
connectStream();

function getSessionId() {
  const key = 'seat-booking-session-id';
  let value = localStorage.getItem(key);
  if (!value) {
    value = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    localStorage.setItem(key, value);
  }
  return value;
}

async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

async function loadSeats() {
  try {
    const data = await api('/api/seats');
    seats = data.seats;
    selected = new Set([...selected].filter((id) => seatById(id)?.status === 'available'));
    render();
    log('Seat map refreshed.');
  } catch (err) {
    log(`Failed to load seats: ${err.message}`, true);
  }
}

function connectStream() {
  const source = new EventSource(`${API_BASE}/api/stream`);
  source.addEventListener('connected', () => log('Connected to live updates.'));
  source.addEventListener('seats', (event) => {
    const data = JSON.parse(event.data);
    mergeSeats(data.seats || []);
    log(`Live update: ${data.reason || 'status change'} (${(data.seatIds || []).join(', ')}).`);
  });
  source.onerror = () => log('Live update connection interrupted; browser will retry.', true);
}

function mergeSeats(changedSeats) {
  const byId = new Map(seats.map((seat) => [seat.id, seat]));
  for (const seat of changedSeats) {
    byId.set(seat.id, seat);
    if (seat.status !== 'available') selected.delete(seat.id);
    if (currentHold && currentHold.seatIds.includes(seat.id) && seat.status === 'available') {
      // Our hold may have expired or been released by another tab.
      currentHold = null;
      stopCountdown();
    }
  }
  seats = [...byId.values()].sort((a, b) => a.rowLabel.localeCompare(b.rowLabel) || a.seatNumber - b.seatNumber);
  render();
}

function render() {
  renderCounts();
  renderControls();
  renderGrid();
}

function renderCounts() {
  const totals = { available: 0, held: 0, booked: 0 };
  for (const seat of seats) totals[seat.status] += 1;
  document.querySelector('#availableCount').textContent = totals.available;
  document.querySelector('#heldCount').textContent = totals.held;
  document.querySelector('#bookedCount').textContent = totals.booked;
  document.querySelector('#selectedCount').textContent = selected.size;
}

function renderControls() {
  holdBtn.disabled = selected.size === 0 || Boolean(currentHold);
  confirmBtn.disabled = !currentHold;
  releaseBtn.disabled = !currentHold;
  if (!currentHold) holdInfo.textContent = 'No active hold';
}

function renderGrid() {
  const rows = groupBy(seats, (seat) => seat.rowLabel);
  grid.innerHTML = '';
  for (const [rowLabel, rowSeats] of rows) {
    const row = document.createElement('div');
    row.className = 'seat-row';
    const label = document.createElement('div');
    label.className = 'row-label';
    label.textContent = rowLabel;
    row.append(label);

    for (const seat of rowSeats) {
      const button = document.createElement('button');
      const isSelected = selected.has(seat.id);
      const isMine = currentHold?.seatIds.includes(seat.id);
      const isConflict = lastConflictIds.has(seat.id);
      button.className = `seat ${seat.status}${isSelected ? ' selected' : ''}${isMine ? ' mine' : ''}${isConflict ? ' conflict' : ''}`;
      button.type = 'button';
      button.textContent = seat.seatNumber;
      button.title = `${seat.rowLabel}${seat.seatNumber}: ${seat.status}`;
      button.disabled = seat.status !== 'available' && !isSelected;
      button.addEventListener('click', () => toggleSeat(seat));
      row.append(button);
    }
    grid.append(row);
  }
}

function toggleSeat(seat) {
  if (seat.status !== 'available') return;
  lastConflictIds.clear();
  if (selected.has(seat.id)) selected.delete(seat.id);
  else selected.add(seat.id);
  render();
}

async function createHold() {
  const seatIds = [...selected];
  if (!seatIds.length) return;
  try {
    const data = await api('/api/holds', {
      method: 'POST',
      body: JSON.stringify({ seatIds, sessionId }),
    });
    currentHold = data.hold;
    selected.clear();
    lastConflictIds.clear();
    mergeSeats(data.seats);
    startCountdown();
    log(`Hold ${currentHold.id.slice(0, 8)} created for seats ${seatIds.join(', ')}.`);
  } catch (err) {
    if (err.status === 409) {
      lastConflictIds = new Set(err.body.conflictSeatIds || []);
      selected.clear();
      log(`Hold failed; seats already taken: ${[...lastConflictIds].join(', ')}`, true);
      await loadSeats();
      render();
    } else {
      log(`Hold failed: ${err.message}`, true);
    }
  }
}

async function confirmHold() {
  if (!currentHold) return;
  try {
    const data = await api(`/api/holds/${currentHold.id}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    });
    mergeSeats(data.seats);
    log(`${data.idempotent ? 'Repeated confirm returned existing' : 'Confirmed'} booking ${data.booking.id.slice(0, 8)}.`);
    currentHold = null;
    stopCountdown();
    render();
  } catch (err) {
    log(`Confirm failed: ${err.message}`, true);
    currentHold = null;
    stopCountdown();
    await loadSeats();
  }
}

async function releaseHold() {
  if (!currentHold) return;
  const holdId = currentHold.id;
  try {
    const data = await api(`/api/holds/${holdId}`, {
      method: 'DELETE',
      body: JSON.stringify({ sessionId }),
    });
    mergeSeats(data.released || []);
    currentHold = null;
    stopCountdown();
    log(`Released hold ${holdId.slice(0, 8)}.`);
    render();
  } catch (err) {
    log(`Release failed: ${err.message}`, true);
  }
}

function startCountdown() {
  stopCountdown();
  updateCountdown();
  countdownTimer = setInterval(updateCountdown, 250);
}

function stopCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = null;
  holdInfo.textContent = 'No active hold';
}

function updateCountdown() {
  if (!currentHold) return stopCountdown();
  const remainingMs = new Date(currentHold.expiresAt).getTime() - Date.now();
  if (remainingMs <= 0) {
    holdInfo.textContent = 'Hold expired; refreshing…';
    currentHold = null;
    stopCountdown();
    loadSeats();
    return;
  }
  holdInfo.textContent = `Hold expires in ${(remainingMs / 1000).toFixed(0)}s`;
}

function groupBy(items, fn) {
  const map = new Map();
  for (const item of items) {
    const key = fn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function seatById(id) {
  return seats.find((seat) => seat.id === id);
}

function log(message, isError = false) {
  const item = document.createElement('li');
  item.className = isError ? 'error' : '';
  item.textContent = `${new Date().toLocaleTimeString()} · ${message}`;
  messages.prepend(item);
  while (messages.children.length > 8) messages.lastElementChild.remove();
}
