import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || (location.port === '5173' ? 'http://localhost:3001' : '');
const SESSION_KEY = 'seat-booking-session-id';
let sessionId = localStorage.getItem(SESSION_KEY);
if (!sessionId) {
  sessionId = crypto.randomUUID();
  localStorage.setItem(SESSION_KEY, sessionId);
}

const state = {
  seats: new Map(),
  selected: new Set(),
  currentHold: JSON.parse(localStorage.getItem('seat-booking-current-hold') || 'null'),
  holdTtlMs: 30000,
};

const app = document.querySelector('#app');
app.innerHTML = `
  <main>
    <header>
      <h1>Seat Booking</h1>
      <p class="subtitle">Select available seats, hold them temporarily, then confirm.</p>
    </header>
    <section class="panel">
      <div class="actions">
        <button id="holdBtn">Hold selected seats</button>
        <button id="confirmBtn">Confirm current hold</button>
        <button id="releaseBtn">Release hold</button>
        <button id="refreshBtn">Refresh</button>
      </div>
      <div id="message" class="message">Loading seats…</div>
      <div id="countdown" class="countdown"></div>
      <div id="inventory" class="inventory"></div>
    </section>
    <section class="legend">
      <span><b class="swatch available"></b> Available</span>
      <span><b class="swatch selected"></b> Selected</span>
      <span><b class="swatch held"></b> Held</span>
      <span><b class="swatch mine"></b> Your hold</span>
      <span><b class="swatch booked"></b> Booked</span>
    </section>
    <section id="seatMap" class="seat-map" aria-label="Seat map"></section>
  </main>
`;

const seatMap = document.querySelector('#seatMap');
const message = document.querySelector('#message');
const countdown = document.querySelector('#countdown');
const inventory = document.querySelector('#inventory');

function api(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
}

function setMessage(text, kind = '') {
  message.textContent = text;
  message.className = `message ${kind}`;
}

function isMine(seat) {
  return state.currentHold && seat.holdId === state.currentHold.id && seat.status === 'held';
}

function applySeats(seats) {
  for (const seat of seats) {
    const prev = state.seats.get(seat.id) || {};
    state.seats.set(seat.id, { ...prev, ...seat });
    if (seat.status !== 'available') state.selected.delete(seat.id);
  }
  render();
}

function render() {
  const seats = [...state.seats.values()].sort((a, b) => a.rowLabel.localeCompare(b.rowLabel) || a.seatNumber - b.seatNumber);
  const counts = { available: 0, held: 0, booked: 0, total: seats.length };
  for (const seat of seats) counts[seat.status]++;
  inventory.textContent = `Available ${counts.available} · Held ${counts.held} · Booked ${counts.booked} · Total ${counts.total}`;

  const rows = Map.groupBy ? Map.groupBy(seats, (s) => s.rowLabel) : groupBy(seats, (s) => s.rowLabel);
  seatMap.innerHTML = '';
  for (const [rowLabel, rowSeats] of rows) {
    const row = document.createElement('div');
    row.className = 'seat-row';
    row.innerHTML = `<div class="row-label">${rowLabel}</div>`;
    for (const seat of rowSeats) {
      const btn = document.createElement('button');
      btn.className = `seat ${seat.status}`;
      if (state.selected.has(seat.id)) btn.classList.add('selected');
      if (isMine(seat)) btn.classList.add('mine');
      btn.textContent = seat.seatNumber;
      btn.title = `${seat.id}: ${seat.status}`;
      btn.disabled = seat.status !== 'available' && !state.selected.has(seat.id);
      btn.addEventListener('click', () => toggleSeat(seat));
      row.appendChild(btn);
    }
    seatMap.appendChild(row);
  }

  document.querySelector('#holdBtn').disabled = state.selected.size === 0 || Boolean(state.currentHold);
  document.querySelector('#confirmBtn').disabled = !state.currentHold;
  document.querySelector('#releaseBtn').disabled = !state.currentHold;
}

function groupBy(items, fn) {
  const m = new Map();
  for (const item of items) {
    const key = fn(item);
    if (!m.has(key)) m.set(key, []);
    m.get(key).push(item);
  }
  return m;
}

function toggleSeat(seat) {
  if (seat.status !== 'available') return;
  state.selected.has(seat.id) ? state.selected.delete(seat.id) : state.selected.add(seat.id);
  render();
}

async function loadSeats() {
  const res = await api('/api/seats');
  if (!res.ok) throw new Error('Failed to load seats');
  const data = await res.json();
  state.holdTtlMs = data.holdTtlMs;
  state.seats = new Map(data.seats.map((s) => [s.id, s]));
  if (state.currentHold && !data.seats.some((s) => s.holdId === state.currentHold.id && s.status === 'held')) {
    clearCurrentHold();
  }
  render();
  setMessage('Seat map is live.');
}

function saveCurrentHold(hold) {
  state.currentHold = hold;
  localStorage.setItem('seat-booking-current-hold', JSON.stringify(hold));
  render();
}

function clearCurrentHold() {
  state.currentHold = null;
  localStorage.removeItem('seat-booking-current-hold');
  countdown.textContent = '';
  render();
}

async function holdSelected() {
  const seatIds = [...state.selected];
  const res = await api('/api/holds', { method: 'POST', body: JSON.stringify({ seatIds, sessionId }) });
  const data = await res.json();
  if (res.status === 409) {
    setMessage(`Hold failed. Conflicting seats: ${data.conflictingSeatIds.join(', ')}`, 'error');
    await loadSeats();
    return;
  }
  if (!res.ok) throw new Error(data.error || 'Hold failed');
  state.selected.clear();
  saveCurrentHold(data.hold);
  applySeats(data.seats);
  setMessage(`Held ${data.seats.length} seat(s). Confirm before the countdown ends.`, 'success');
}

async function confirmHold() {
  if (!state.currentHold) return;
  const res = await api(`/api/holds/${state.currentHold.id}/confirm`, { method: 'POST', body: JSON.stringify({ sessionId }) });
  const data = await res.json();
  if (!res.ok) {
    setMessage(data.error || 'Confirmation failed', 'error');
    clearCurrentHold();
    await loadSeats();
    return;
  }
  applySeats(data.seats);
  clearCurrentHold();
  setMessage(data.idempotent ? 'Booking was already confirmed.' : 'Booking confirmed!', 'success');
}

async function releaseHold() {
  if (!state.currentHold) return;
  const id = state.currentHold.id;
  const res = await api(`/api/holds/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Release failed');
  clearCurrentHold();
  await loadSeats();
  setMessage('Hold released.', 'success');
}

function tickCountdown() {
  if (!state.currentHold?.expiresAt) return;
  const ms = new Date(state.currentHold.expiresAt).getTime() - Date.now();
  if (ms <= 0) {
    countdown.textContent = 'Hold expired.';
    clearCurrentHold();
    loadSeats().catch(console.error);
  } else {
    countdown.textContent = `Hold expires in ${Math.ceil(ms / 1000)}s`;
  }
}

function connectSse() {
  const es = new EventSource(`${API_BASE}/api/stream`);
  es.addEventListener('seats', (event) => {
    const data = JSON.parse(event.data);
    applySeats(data.seats || []);
    if (state.currentHold && data.seats?.some((s) => s.holdId === state.currentHold.id || (s.status === 'available' && state.currentHold.seatIds?.includes(s.id)))) {
      const stillHeld = [...state.seats.values()].some((s) => s.holdId === state.currentHold.id && s.status === 'held');
      if (!stillHeld && data.type !== 'booked') clearCurrentHold();
    }
  });
  es.onerror = () => setMessage('Live connection interrupted; retrying automatically…', 'error');
}

document.querySelector('#holdBtn').addEventListener('click', () => holdSelected().catch((e) => setMessage(e.message, 'error')));
document.querySelector('#confirmBtn').addEventListener('click', () => confirmHold().catch((e) => setMessage(e.message, 'error')));
document.querySelector('#releaseBtn').addEventListener('click', () => releaseHold().catch((e) => setMessage(e.message, 'error')));
document.querySelector('#refreshBtn').addEventListener('click', () => loadSeats().catch((e) => setMessage(e.message, 'error')));

setInterval(tickCountdown, 250);
connectSse();
loadSeats().catch((e) => setMessage(e.message, 'error'));
