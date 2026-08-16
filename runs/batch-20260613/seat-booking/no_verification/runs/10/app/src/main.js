import './styles.css';

const API = '';
const HOLD_WARNING_MS = 10_000;
let seats = [];
let selectedSeatIds = new Set();
let currentHold = null;
let countdownTimer = null;
let sessionId = localStorage.getItem('seat-booking-session-id');
if (!sessionId) {
  sessionId = crypto.randomUUID();
  localStorage.setItem('seat-booking-session-id', sessionId);
}

const app = document.querySelector('#app');
app.innerHTML = `
  <header class="topbar">
    <div>
      <h1>Seat Booking</h1>
      <p>Session <code>${sessionId.slice(0, 8)}</code>. Select available seats, hold them temporarily, then confirm.</p>
    </div>
    <div class="inventory" id="inventory"></div>
  </header>

  <main class="layout">
    <section class="panel map-panel">
      <div class="legend">
        <span><i class="swatch available"></i>Available</span>
        <span><i class="swatch selected"></i>Selected</span>
        <span><i class="swatch held"></i>Held</span>
        <span><i class="swatch mine"></i>Your hold</span>
        <span><i class="swatch booked"></i>Booked</span>
      </div>
      <div id="seat-map" class="seat-map" aria-live="polite"></div>
    </section>

    <aside class="panel controls">
      <h2>Actions</h2>
      <div id="message" class="message">Loading seats…</div>
      <div class="selection">
        <strong>Selected:</strong>
        <span id="selected-list">None</span>
      </div>
      <button id="hold-btn" disabled>Hold selected seats</button>
      <div id="hold-card" class="hold-card hidden">
        <h3>Current hold</h3>
        <p><strong>Seats:</strong> <span id="hold-seats"></span></p>
        <p><strong>Expires in:</strong> <span id="countdown"></span></p>
        <button id="confirm-btn">Confirm booking</button>
        <button id="release-btn" class="secondary">Release hold</button>
      </div>
      <button id="refresh-btn" class="secondary">Refresh seat map</button>
    </aside>
  </main>
`;

const mapEl = document.querySelector('#seat-map');
const inventoryEl = document.querySelector('#inventory');
const selectedListEl = document.querySelector('#selected-list');
const holdBtn = document.querySelector('#hold-btn');
const confirmBtn = document.querySelector('#confirm-btn');
const releaseBtn = document.querySelector('#release-btn');
const refreshBtn = document.querySelector('#refresh-btn');
const holdCard = document.querySelector('#hold-card');
const holdSeatsEl = document.querySelector('#hold-seats');
const countdownEl = document.querySelector('#countdown');
const messageEl = document.querySelector('#message');

function setMessage(text, kind = '') {
  messageEl.textContent = text;
  messageEl.className = `message ${kind}`.trim();
}

function seatSort(a, b) {
  return a.rowLabel.localeCompare(b.rowLabel) || a.seatNumber - b.seatNumber;
}

function statusForSeat(seat) {
  if (seat.status === 'held' && currentHold?.id === seat.holdId) return 'mine';
  if (selectedSeatIds.has(seat.id)) return 'selected';
  return seat.status;
}

function reconcileSelection() {
  const availableIds = new Set(seats.filter((s) => s.status === 'available').map((s) => s.id));
  selectedSeatIds = new Set([...selectedSeatIds].filter((id) => availableIds.has(id)));
}

function render() {
  reconcileSelection();
  const inventory = seats.reduce((acc, seat) => {
    acc[seat.status] += 1;
    acc.total += 1;
    return acc;
  }, { available: 0, held: 0, booked: 0, total: 0 });
  inventoryEl.innerHTML = `
    <span>Available <b>${inventory.available}</b></span>
    <span>Held <b>${inventory.held}</b></span>
    <span>Booked <b>${inventory.booked}</b></span>
    <span>Total <b>${inventory.total}</b></span>
  `;

  const sortedSeats = [...seats].sort(seatSort);
  const rows = typeof Map.groupBy === 'function' ? Map.groupBy(sortedSeats, (s) => s.rowLabel) : groupByRows(sortedSeats);
  mapEl.innerHTML = '';
  for (const [rowLabel, rowSeats] of rows.entries()) {
    const row = document.createElement('div');
    row.className = 'seat-row';
    const label = document.createElement('div');
    label.className = 'row-label';
    label.textContent = rowLabel;
    row.appendChild(label);
    for (const seat of [...rowSeats].sort(seatSort)) {
      const button = document.createElement('button');
      const visual = statusForSeat(seat);
      button.className = `seat ${visual}`;
      button.textContent = seat.seatNumber;
      button.title = `${seat.id}: ${visual}`;
      button.disabled = seat.status !== 'available' && !selectedSeatIds.has(seat.id);
      button.onclick = () => toggleSeat(seat.id);
      row.appendChild(button);
    }
    mapEl.appendChild(row);
  }

  const selected = [...selectedSeatIds].sort();
  selectedListEl.textContent = selected.length ? selected.join(', ') : 'None';
  holdBtn.disabled = selected.length === 0 || !!currentHold;
  holdCard.classList.toggle('hidden', !currentHold);
  if (currentHold) {
    holdSeatsEl.textContent = currentHold.seatIds.join(', ');
    updateCountdown();
  }
}

function groupByRows(items) {
  const map = new Map();
  for (const seat of [...items].sort(seatSort)) {
    if (!map.has(seat.rowLabel)) map.set(seat.rowLabel, []);
    map.get(seat.rowLabel).push(seat);
  }
  return map;
}

function toggleSeat(id) {
  const seat = seats.find((s) => s.id === id);
  if (!seat || seat.status !== 'available') return;
  if (selectedSeatIds.has(id)) selectedSeatIds.delete(id);
  else selectedSeatIds.add(id);
  render();
}

async function request(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || response.statusText);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

async function loadSeats() {
  const data = await request('/api/seats');
  seats = data.seats;
  render();
  setMessage('Seat map is up to date.', 'success');
}

function mergeSeats(changedSeats) {
  const byId = new Map(seats.map((s) => [s.id, s]));
  for (const changed of changedSeats) byId.set(changed.id, changed);
  seats = [...byId.values()].sort(seatSort);
  if (currentHold && !seats.some((s) => s.status === 'held' && s.holdId === currentHold.id)) {
    clearCurrentHold(Date.parse(currentHold.expiresAt) <= Date.now() ? 'Your hold expired.' : undefined);
  }
  render();
}

async function holdSelected() {
  const seatIds = [...selectedSeatIds];
  try {
    const data = await request('/api/holds', {
      method: 'POST',
      body: JSON.stringify({ seatIds, sessionId })
    });
    currentHold = data.hold;
    selectedSeatIds.clear();
    mergeSeats(data.seats);
    startCountdown();
    setMessage(`Held ${data.hold.seatIds.length} seat(s). Confirm before the timer expires.`, 'success');
  } catch (error) {
    if (error.status === 409) {
      const conflicts = error.data.conflictingSeatIds || [];
      setMessage(`Hold failed. Already unavailable: ${conflicts.join(', ') || 'selected seats'}.`, 'error');
      await loadSeats();
    } else {
      setMessage(error.message, 'error');
    }
  }
}

async function confirmHold() {
  if (!currentHold) return;
  try {
    const data = await request(`/api/holds/${currentHold.id}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ sessionId })
    });
    mergeSeats(data.seats);
    clearCurrentHold();
    setMessage(`Booking confirmed: ${data.seats.map((s) => s.id).join(', ')}`, 'success');
  } catch (error) {
    clearCurrentHold(error.message || 'Could not confirm hold.');
    await loadSeats();
    setMessage(error.message, 'error');
  }
}

async function releaseHold() {
  if (!currentHold) return;
  try {
    const id = currentHold.id;
    const data = await request(`/api/holds/${id}`, {
      method: 'DELETE',
      body: JSON.stringify({ sessionId })
    });
    mergeSeats(data.seats || []);
    clearCurrentHold();
    setMessage('Hold released.', 'success');
  } catch (error) {
    setMessage(error.message, 'error');
  }
}

function startCountdown() {
  clearInterval(countdownTimer);
  updateCountdown();
  countdownTimer = setInterval(updateCountdown, 250);
}

function updateCountdown() {
  if (!currentHold) return;
  const remaining = Date.parse(currentHold.expiresAt) - Date.now();
  if (remaining <= 0) {
    countdownEl.textContent = 'expired';
    clearCurrentHold('Your hold expired.');
    loadSeats().catch(() => {});
    return;
  }
  const seconds = Math.ceil(remaining / 1000);
  countdownEl.textContent = `${seconds}s`;
  countdownEl.classList.toggle('warning', remaining < HOLD_WARNING_MS);
}

function clearCurrentHold(message) {
  clearInterval(countdownTimer);
  countdownTimer = null;
  currentHold = null;
  holdCard.classList.add('hidden');
  if (message) setMessage(message, 'error');
  if (seats.length) render();
}

function connectStream() {
  const source = new EventSource('/api/stream');
  source.addEventListener('seats', (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.seats) mergeSeats(payload.seats);
      if (payload.type === 'booked') setMessage('Live update: seats were booked.', 'success');
      if (payload.type === 'held') setMessage('Live update: seats were held.', '');
      if (payload.type === 'released') setMessage('Live update: seats were released.', '');
    } catch (error) {
      console.warn('Bad SSE payload', error);
    }
  });
  source.onerror = () => setMessage('Live connection interrupted; retrying automatically…', 'error');
}

holdBtn.addEventListener('click', holdSelected);
confirmBtn.addEventListener('click', confirmHold);
releaseBtn.addEventListener('click', releaseHold);
refreshBtn.addEventListener('click', () => loadSeats().catch((e) => setMessage(e.message, 'error')));

loadSeats().catch((error) => setMessage(error.message, 'error'));
connectStream();
