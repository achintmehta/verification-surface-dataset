import './styles.css';

const API = import.meta.env.VITE_API_URL || '';
const app = document.querySelector('#app');
const sessionId = getSessionId();

let seats = [];
let selected = new Set();
let currentHold = loadHold();
let countdownTimer = null;

app.innerHTML = `
  <header class="header">
    <div>
      <h1>Seat Booking</h1>
      <p>Session <code>${sessionId}</code></p>
    </div>
    <div id="connection" class="pill">Connecting…</div>
  </header>

  <main class="layout">
    <section class="panel">
      <div class="toolbar">
        <div>
          <h2>Seat Map</h2>
          <p class="muted">Select available seats, place a temporary hold, then confirm.</p>
        </div>
        <button id="refreshBtn" class="secondary">Refresh</button>
      </div>
      <div class="stage">STAGE</div>
      <div id="seatGrid" class="seat-grid" aria-live="polite"></div>
      <div class="legend">
        <span><i class="swatch available"></i>Available</span>
        <span><i class="swatch selected"></i>Selected</span>
        <span><i class="swatch held"></i>Held</span>
        <span><i class="swatch booked"></i>Booked</span>
      </div>
    </section>

    <aside class="panel controls">
      <h2>Your Hold</h2>
      <div id="inventory" class="inventory"></div>
      <div id="selectionSummary" class="summary"></div>
      <div id="holdBox" class="hold-box"></div>
      <button id="holdBtn" class="primary">Hold selected seats</button>
      <button id="confirmBtn" class="success">Confirm hold</button>
      <button id="releaseBtn" class="secondary">Release hold</button>
      <div id="message" class="message"></div>
    </aside>
  </main>
`;

const grid = document.querySelector('#seatGrid');
const holdBtn = document.querySelector('#holdBtn');
const confirmBtn = document.querySelector('#confirmBtn');
const releaseBtn = document.querySelector('#releaseBtn');
const refreshBtn = document.querySelector('#refreshBtn');
const message = document.querySelector('#message');
const holdBox = document.querySelector('#holdBox');
const selectionSummary = document.querySelector('#selectionSummary');
const inventoryBox = document.querySelector('#inventory');
const connection = document.querySelector('#connection');

holdBtn.addEventListener('click', requestHold);
confirmBtn.addEventListener('click', confirmHold);
releaseBtn.addEventListener('click', releaseHold);
refreshBtn.addEventListener('click', loadSeats);

loadSeats();
connectStream();
startCountdown();

function getSessionId() {
  const key = 'seat-booking-session-id';
  let id = localStorage.getItem(key);
  if (!id) {
    id = (crypto.randomUUID?.() || `session-${Math.random().toString(36).slice(2)}`).slice(0, 13);
    localStorage.setItem(key, id);
  }
  return id;
}

function loadHold() {
  try {
    const raw = localStorage.getItem('seat-booking-current-hold');
    if (!raw) return null;
    const hold = JSON.parse(raw);
    if (!hold.expiresAt || new Date(hold.expiresAt).getTime() <= Date.now()) {
      localStorage.removeItem('seat-booking-current-hold');
      return null;
    }
    return hold;
  } catch {
    return null;
  }
}

function saveHold(hold) {
  currentHold = hold;
  if (hold) localStorage.setItem('seat-booking-current-hold', JSON.stringify(hold));
  else localStorage.removeItem('seat-booking-current-hold');
  startCountdown();
  renderControls();
}

async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function loadSeats() {
  try {
    const data = await api('/api/seats');
    seats = data.seats;
    reconcileHoldWithSeats();
    render();
    setMessage('Seat map refreshed.', 'ok');
  } catch (err) {
    setMessage(err.message, 'error');
  }
}

function connectStream() {
  const es = new EventSource(`${API}/api/stream`);
  es.addEventListener('open', () => {
    connection.textContent = 'Live';
    connection.className = 'pill live';
  });
  es.addEventListener('error', () => {
    connection.textContent = 'Reconnecting…';
    connection.className = 'pill warn';
  });
  es.addEventListener('seats', (event) => {
    const payload = JSON.parse(event.data);
    applySeatUpdates(payload.seats || []);
    if (payload.type === 'released' && currentHold && payload.seatIds?.some((id) => currentHold.seatIds.includes(id))) {
      saveHold(null);
      setMessage('Your hold expired or was released.', 'warn');
    }
    if (payload.type === 'booked' && currentHold && payload.booking?.holdId === currentHold.id) {
      saveHold(null);
    }
  });
}

function applySeatUpdates(updatedSeats) {
  const byId = new Map(seats.map((s) => [s.id, s]));
  for (const seat of updatedSeats) {
    byId.set(seat.id, seat);
    if (seat.status !== 'available') selected.delete(seat.id);
  }
  seats = [...byId.values()].sort((a, b) => a.rowLabel.localeCompare(b.rowLabel) || a.seatNumber - b.seatNumber);
  reconcileHoldWithSeats();
  render();
}

function reconcileHoldWithSeats() {
  if (!currentHold) return;
  if (new Date(currentHold.expiresAt).getTime() <= Date.now()) {
    saveHold(null);
    return;
  }
  const byId = new Map(seats.map((s) => [s.id, s]));
  const stillHeld = currentHold.seatIds.every((id) => {
    const seat = byId.get(id);
    return seat && seat.holdId === currentHold.id && seat.status === 'held';
  });
  const bookedByUs = currentHold.seatIds.every((id) => {
    const seat = byId.get(id);
    return seat && seat.holdId === currentHold.id && seat.status === 'booked';
  });
  if (!stillHeld && !bookedByUs) saveHold(null);
}

function render() {
  renderGrid();
  renderControls();
}

function renderGrid() {
  const rows = groupBy(seats, (s) => s.rowLabel);
  grid.innerHTML = '';
  for (const [row, rowSeats] of rows) {
    const label = document.createElement('div');
    label.className = 'row-label';
    label.textContent = row;
    grid.appendChild(label);

    for (const seat of rowSeats) {
      const btn = document.createElement('button');
      btn.className = `seat ${seat.status}`;
      if (selected.has(seat.id)) btn.classList.add('selected');
      if (currentHold?.seatIds.includes(seat.id) && seat.status === 'held') btn.classList.add('mine');
      btn.textContent = seat.seatNumber;
      btn.title = `${seat.id}: ${seat.status}`;
      btn.disabled = seat.status !== 'available' || Boolean(currentHold);
      btn.addEventListener('click', () => toggleSeat(seat.id));
      grid.appendChild(btn);
    }
  }
}

function renderControls() {
  const counts = seats.reduce((acc, seat) => {
    acc[seat.status] = (acc[seat.status] || 0) + 1;
    acc.total++;
    return acc;
  }, { available: 0, held: 0, booked: 0, total: 0 });
  inventoryBox.innerHTML = `
    <strong>Inventory</strong>
    <span>Available ${counts.available}</span>
    <span>Held ${counts.held}</span>
    <span>Booked ${counts.booked}</span>
    <span>Total ${counts.total}</span>
  `;

  selectionSummary.textContent = selected.size
    ? `Selected: ${[...selected].join(', ')}`
    : currentHold
      ? 'Selection locked while you have an active hold.'
      : 'No seats selected.';

  holdBtn.disabled = selected.size === 0 || Boolean(currentHold);
  confirmBtn.disabled = !currentHold;
  releaseBtn.disabled = !currentHold;

  if (!currentHold) {
    holdBox.innerHTML = '<p>No active hold.</p>';
  } else {
    const ms = Math.max(0, new Date(currentHold.expiresAt).getTime() - Date.now());
    holdBox.innerHTML = `
      <p><strong>Hold:</strong> ${currentHold.id.slice(0, 8)}…</p>
      <p><strong>Seats:</strong> ${currentHold.seatIds.join(', ')}</p>
      <p><strong>Expires in:</strong> <span class="countdown">${Math.ceil(ms / 1000)}s</span></p>
    `;
  }
}

function toggleSeat(id) {
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  render();
}

async function requestHold() {
  try {
    const seatIds = [...selected];
    const data = await api('/api/holds', {
      method: 'POST',
      body: JSON.stringify({ seatIds, sessionId }),
    });
    selected.clear();
    saveHold(data.hold);
    applySeatUpdates(data.seats);
    setMessage(`Held ${data.hold.seatIds.join(', ')}. Confirm before the timer expires.`, 'ok');
  } catch (err) {
    if (err.status === 409) {
      const conflicts = err.body.conflictingSeatIds || [];
      setMessage(`Hold failed. Already unavailable: ${conflicts.join(', ')}`, 'error');
      await loadSeats();
    } else {
      setMessage(err.message, 'error');
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
    applySeatUpdates(data.seats);
    saveHold(null);
    setMessage(`Booking confirmed: ${data.booking.seatIds.join(', ')}`, 'ok');
  } catch (err) {
    saveHold(null);
    setMessage(`Confirm failed: ${err.message}`, 'error');
    await loadSeats();
  }
}

async function releaseHold() {
  if (!currentHold) return;
  try {
    const data = await api(`/api/holds/${currentHold.id}?sessionId=${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
    applySeatUpdates(data.seats || []);
    saveHold(null);
    setMessage('Hold released.', 'ok');
  } catch (err) {
    saveHold(null);
    setMessage(`Release failed: ${err.message}`, 'error');
    await loadSeats();
  }
}

function startCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    if (currentHold && new Date(currentHold.expiresAt).getTime() <= Date.now()) {
      saveHold(null);
      setMessage('Hold expired. Seats will return to available shortly.', 'warn');
      loadSeats();
    } else {
      renderControls();
    }
  }, 500);
}

function setMessage(text, type = '') {
  message.textContent = text;
  message.className = `message ${type}`;
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}
