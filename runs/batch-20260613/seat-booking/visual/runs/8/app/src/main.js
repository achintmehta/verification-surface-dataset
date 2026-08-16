import './styles.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3000';
const SESSION_KEY = 'seat-booking-session-id';
let sessionId = localStorage.getItem(SESSION_KEY);
if (!sessionId) {
  sessionId = crypto.randomUUID();
  localStorage.setItem(SESSION_KEY, sessionId);
}

const state = {
  seats: [],
  selected: new Set(),
  currentHold: null,
  holdTimer: null,
  message: 'Loading seats…',
  conflictIds: new Set(),
  connected: false
};

const app = document.querySelector('#app');
app.innerHTML = `
  <main class="shell">
    <header class="hero">
      <div>
        <p class="eyebrow">Single Event</p>
        <h1>Seat Booking</h1>
        <p class="subtitle">Pick available seats, place a temporary hold, then confirm before the timer expires.</p>
      </div>
      <div class="session-card">
        <span>Session</span>
        <code>${sessionId.slice(0, 8)}</code>
        <strong id="connectionStatus">Connecting…</strong>
      </div>
    </header>

    <section class="panel controls">
      <div class="legend" aria-label="Seat legend">
        <span><i class="swatch available"></i>Available</span>
        <span><i class="swatch selected"></i>Selected</span>
        <span><i class="swatch held"></i>Held</span>
        <span><i class="swatch mine"></i>Your hold</span>
        <span><i class="swatch booked"></i>Booked</span>
      </div>
      <div class="actions">
        <button id="holdButton">Hold selected</button>
        <button id="confirmButton" disabled>Confirm hold</button>
        <button id="releaseButton" disabled>Release hold</button>
        <button id="refreshButton" class="secondary">Refresh</button>
      </div>
      <div class="status-line">
        <span id="message"></span>
        <span id="countdown"></span>
      </div>
      <div id="inventory" class="inventory"></div>
    </section>

    <section class="stage panel">
      <div class="screen">STAGE</div>
      <div id="seatMap" class="seat-map"></div>
    </section>
  </main>
`;

const seatMap = document.querySelector('#seatMap');
const message = document.querySelector('#message');
const countdown = document.querySelector('#countdown');
const inventory = document.querySelector('#inventory');
const holdButton = document.querySelector('#holdButton');
const confirmButton = document.querySelector('#confirmButton');
const releaseButton = document.querySelector('#releaseButton');
const refreshButton = document.querySelector('#refreshButton');
const connectionStatus = document.querySelector('#connectionStatus');

function setMessage(text, kind = '') {
  state.message = text;
  message.textContent = text;
  message.className = kind;
}

function groupRows(seats) {
  return seats.reduce((acc, seat) => {
    acc[seat.rowLabel] ||= [];
    acc[seat.rowLabel].push(seat);
    return acc;
  }, {});
}

function isMine(seat) {
  return state.currentHold && seat.holdId === state.currentHold.id;
}

function render() {
  const rows = groupRows(state.seats);
  seatMap.innerHTML = '';
  Object.keys(rows).sort().forEach((rowLabel) => {
    const row = document.createElement('div');
    row.className = 'seat-row';
    const label = document.createElement('div');
    label.className = 'row-label';
    label.textContent = rowLabel;
    row.append(label);

    rows[rowLabel].sort((a, b) => a.seatNumber - b.seatNumber).forEach((seat) => {
      const button = document.createElement('button');
      const selected = state.selected.has(seat.id);
      const mine = isMine(seat);
      button.className = `seat ${seat.status}${selected ? ' selected' : ''}${mine ? ' mine' : ''}${state.conflictIds.has(seat.id) ? ' conflict' : ''}`;
      button.textContent = seat.seatNumber;
      button.title = `${seat.rowLabel}${seat.seatNumber} — ${mine ? 'your hold' : seat.status}`;
      button.disabled = seat.status !== 'available' && !selected;
      button.addEventListener('click', () => toggleSeat(seat));
      row.append(button);
    });

    seatMap.append(row);
  });

  const counts = state.seats.reduce((acc, seat) => {
    acc[seat.status] = (acc[seat.status] || 0) + 1;
    acc.total += 1;
    return acc;
  }, { available: 0, held: 0, booked: 0, total: 0 });
  inventory.innerHTML = `
    <span>Available <strong>${counts.available}</strong></span>
    <span>Held <strong>${counts.held}</strong></span>
    <span>Booked <strong>${counts.booked}</strong></span>
    <span>Total <strong>${counts.total}</strong></span>
  `;

  holdButton.disabled = state.selected.size === 0 || Boolean(state.currentHold);
  confirmButton.disabled = !state.currentHold;
  releaseButton.disabled = !state.currentHold;
  updateCountdown();
}

function toggleSeat(seat) {
  if (seat.status !== 'available') return;
  state.conflictIds.clear();
  if (state.selected.has(seat.id)) state.selected.delete(seat.id);
  else state.selected.add(seat.id);
  setMessage(`${state.selected.size} seat${state.selected.size === 1 ? '' : 's'} selected.`);
  render();
}

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
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

async function loadSeats(silent = false) {
  if (!silent) setMessage('Refreshing seat map…');
  const data = await request('/api/seats');
  state.seats = data.seats;
  if (state.currentHold && !state.seats.some((seat) => seat.holdId === state.currentHold.id && seat.status === 'held')) {
    clearCurrentHold('Your hold is no longer active.');
  }
  if (!silent) setMessage('Seat map is up to date.');
  render();
}

async function holdSelected() {
  const seatIds = [...state.selected];
  if (!seatIds.length) return;
  try {
    setMessage('Requesting hold…');
    const data = await request('/api/holds', {
      method: 'POST',
      body: JSON.stringify({ seatIds, sessionId })
    });
    state.currentHold = data.hold;
    state.selected.clear();
    state.conflictIds.clear();
    for (const seat of state.seats) {
      if (seatIds.includes(seat.id)) {
        seat.status = 'held';
        seat.holdId = data.hold.id;
        seat.holdExpiresAt = data.hold.expiresAt;
      }
    }
    startHoldTimer();
    setMessage(`Held ${seatIds.length} seat${seatIds.length === 1 ? '' : 's'}. Confirm before the timer expires.`, 'success');
    render();
  } catch (error) {
    if (error.status === 409) {
      const conflicts = error.data.conflictingSeatIds || [];
      state.conflictIds = new Set(conflicts);
      setMessage(`Hold failed. Seats already unavailable: ${conflicts.join(', ')}`, 'error');
      await loadSeats(true);
    } else {
      setMessage(error.message, 'error');
    }
    render();
  }
}

async function confirmHold() {
  if (!state.currentHold) return;
  try {
    setMessage('Confirming hold…');
    const holdId = state.currentHold.id;
    const data = await request(`/api/holds/${holdId}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ sessionId })
    });
    const bookedIds = new Set(data.booking.seatIds);
    for (const seat of state.seats) {
      if (bookedIds.has(seat.id)) {
        seat.status = 'booked';
        seat.bookedBy = sessionId;
        seat.holdExpiresAt = null;
      }
    }
    clearCurrentHold(`Booked seats: ${data.booking.seatIds.join(', ')}.`, 'success');
    render();
  } catch (error) {
    clearCurrentHold(error.message, 'error');
    await loadSeats(true);
  }
}

async function releaseHold() {
  if (!state.currentHold) return;
  try {
    const holdId = state.currentHold.id;
    await request(`/api/holds/${holdId}`, {
      method: 'DELETE',
      body: JSON.stringify({ sessionId })
    });
    clearCurrentHold('Hold released.');
    await loadSeats(true);
  } catch (error) {
    setMessage(error.message, 'error');
  }
}

function clearCurrentHold(text, kind = '') {
  state.currentHold = null;
  if (state.holdTimer) clearInterval(state.holdTimer);
  state.holdTimer = null;
  countdown.textContent = '';
  if (text) setMessage(text, kind);
}

function startHoldTimer() {
  if (state.holdTimer) clearInterval(state.holdTimer);
  state.holdTimer = setInterval(updateCountdown, 250);
  updateCountdown();
}

function updateCountdown() {
  if (!state.currentHold) {
    countdown.textContent = '';
    return;
  }
  const ms = new Date(state.currentHold.expiresAt).getTime() - Date.now();
  if (ms <= 0) {
    clearCurrentHold('Hold expired; seats are being released.', 'error');
    loadSeats(true).catch(() => {});
    render();
    return;
  }
  countdown.textContent = `Hold expires in ${Math.ceil(ms / 1000)}s`;
}

function applySeatChange(event) {
  if (!event.seats) return;
  const byId = new Map(state.seats.map((seat) => [seat.id, seat]));
  for (const changed of event.seats) {
    const seat = byId.get(changed.id);
    if (!seat) continue;
    seat.status = changed.status;
    seat.holdId = changed.holdId ?? null;
    seat.holdExpiresAt = changed.holdExpiresAt ?? null;
    seat.bookedBy = changed.bookedBy ?? null;
    if (changed.status !== 'available') state.selected.delete(changed.id);
  }
  if (state.currentHold && event.seats.some((seat) => seat.holdId === state.currentHold.id || (event.holdId === state.currentHold.id && seat.status !== 'held'))) {
    const stillHeld = state.seats.some((seat) => seat.holdId === state.currentHold.id && seat.status === 'held');
    if (!stillHeld && event.status !== 'booked') clearCurrentHold('Your hold ended.', event.reason === 'expired' ? 'error' : '');
  }
  render();
}

function connectSse() {
  const source = new EventSource(`${API_BASE}/api/stream`);
  source.onopen = () => {
    state.connected = true;
    connectionStatus.textContent = 'Live';
    connectionStatus.className = 'live';
  };
  source.onmessage = (messageEvent) => {
    const event = JSON.parse(messageEvent.data);
    if (event.type === 'seatsChanged') applySeatChange(event);
  };
  source.onerror = () => {
    state.connected = false;
    connectionStatus.textContent = 'Reconnecting…';
    connectionStatus.className = 'offline';
  };
}

holdButton.addEventListener('click', holdSelected);
confirmButton.addEventListener('click', confirmHold);
releaseButton.addEventListener('click', releaseHold);
refreshButton.addEventListener('click', () => loadSeats());

connectSse();
loadSeats().catch((error) => setMessage(error.message, 'error'));
