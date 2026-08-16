import './styles.css';

const app = document.querySelector('#app');
const sessionId = localStorage.getItem('seat-booking-session') || crypto.randomUUID();
localStorage.setItem('seat-booking-session', sessionId);

const state = {
  seats: new Map(),
  selected: new Set(),
  currentHold: null,
  inventory: { available: 0, held: 0, booked: 0, total: 0 },
  message: 'Loading seats...',
  conflictIds: new Set(),
  connected: false
};

let countdownTimer = null;

function api(path, options = {}) {
  return fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
}

function setMessage(text, kind = 'info') {
  state.message = text;
  render(kind);
}

function calculateInventory() {
  const inventory = { available: 0, held: 0, booked: 0, total: 0 };
  for (const seat of state.seats.values()) {
    inventory[seat.status] += 1;
    inventory.total += 1;
  }
  state.inventory = inventory;
}

function upsertSeats(seats) {
  for (const seat of seats) {
    state.seats.set(seat.id, seat);
    if (seat.status !== 'available') state.selected.delete(seat.id);
  }
  calculateInventory();
}

async function loadSeats() {
  const response = await api('/api/seats');
  if (!response.ok) throw new Error('Failed to load seats');
  const data = await response.json();
  state.seats.clear();
  upsertSeats(data.seats);
  state.inventory = data.inventory;
  state.conflictIds.clear();
  render();
}

function rowsFromSeats() {
  const rows = new Map();
  const seats = [...state.seats.values()].sort((a, b) => {
    if (a.rowLabel === b.rowLabel) return a.seatNumber - b.seatNumber;
    return a.rowLabel.localeCompare(b.rowLabel);
  });
  for (const seat of seats) {
    if (!rows.has(seat.rowLabel)) rows.set(seat.rowLabel, []);
    rows.get(seat.rowLabel).push(seat);
  }
  return rows;
}

function holdIsActive() {
  return state.currentHold && new Date(state.currentHold.expiresAt).getTime() > Date.now();
}

function formatRemaining() {
  if (!state.currentHold) return '';
  const ms = Math.max(0, new Date(state.currentHold.expiresAt).getTime() - Date.now());
  const seconds = Math.ceil(ms / 1000);
  return `${seconds}s`;
}

function startCountdown() {
  clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    if (!state.currentHold) {
      clearInterval(countdownTimer);
      return;
    }
    if (!holdIsActive()) {
      const oldHold = state.currentHold;
      state.currentHold = null;
      setMessage(`Hold ${oldHold.id.slice(0, 8)} expired. Seats are released automatically.`, 'warn');
      loadSeats().catch(() => {});
      clearInterval(countdownTimer);
      return;
    }
    render();
  }, 250);
}

function seatTitle(seat) {
  if (seat.status === 'held') {
    const mine = state.currentHold?.id === seat.holdId;
    return `${seat.id}: held${mine ? ' by your current hold' : ''}`;
  }
  if (seat.status === 'booked') return `${seat.id}: booked`;
  return `${seat.id}: available`;
}

function render(kind = 'info') {
  const selectedCount = state.selected.size;
  const rows = rowsFromSeats();
  app.innerHTML = `
    <main class="shell">
      <header class="hero">
        <div>
          <p class="eyebrow">Single event</p>
          <h1>Seat Booking</h1>
          <p class="subtle">Session <code>${sessionId.slice(0, 8)}</code>. Holds are temporary and server-enforced.</p>
        </div>
        <div class="connection ${state.connected ? 'ok' : 'bad'}">${state.connected ? 'Live' : 'Offline'}</div>
      </header>

      <section class="panel stats">
        <div><strong>${state.inventory.available}</strong><span>Available</span></div>
        <div><strong>${state.inventory.held}</strong><span>Held</span></div>
        <div><strong>${state.inventory.booked}</strong><span>Booked</span></div>
        <div><strong>${state.inventory.total}</strong><span>Total</span></div>
      </section>

      <section class="panel controls">
        <div>
          <button id="holdBtn" ${selectedCount === 0 || state.currentHold ? 'disabled' : ''}>Hold ${selectedCount || ''} selected</button>
          <button id="confirmBtn" ${!state.currentHold ? 'disabled' : ''}>Confirm hold</button>
          <button id="releaseBtn" ${!state.currentHold ? 'disabled' : ''}>Release hold</button>
          <button id="refreshBtn">Refresh</button>
        </div>
        <div class="holdInfo">
          ${state.currentHold ? `Hold <code>${state.currentHold.id.slice(0, 8)}</code> expires in <strong>${formatRemaining()}</strong>` : 'No active hold'}
        </div>
      </section>

      <p class="message ${kind}">${state.message}</p>

      <section class="stage panel">
        <div class="screen">STAGE</div>
        <div class="grid">
          ${[...rows.entries()].map(([row, seats]) => `
            <div class="row">
              <div class="rowLabel">${row}</div>
              <div class="seatRow">
                ${seats.map((seat) => {
                  const selected = state.selected.has(seat.id);
                  const conflict = state.conflictIds.has(seat.id);
                  const mine = state.currentHold?.id === seat.holdId;
                  return `<button class="seat ${seat.status} ${selected ? 'selected' : ''} ${conflict ? 'conflict' : ''} ${mine ? 'mine' : ''}"
                    data-seat-id="${seat.id}"
                    ${seat.status !== 'available' ? 'disabled' : ''}
                    title="${seatTitle(seat)}">
                    <span>${seat.seatNumber}</span>
                  </button>`;
                }).join('')}
              </div>
            </div>`).join('')}
        </div>
        <div class="legend">
          <span><i class="available"></i>Available</span>
          <span><i class="held"></i>Held</span>
          <span><i class="booked"></i>Booked</span>
          <span><i class="selected"></i>Selected</span>
        </div>
      </section>
    </main>
  `;

  document.querySelectorAll('[data-seat-id]').forEach((button) => {
    button.addEventListener('click', () => toggleSeat(button.dataset.seatId));
  });
  document.querySelector('#holdBtn').addEventListener('click', requestHold);
  document.querySelector('#confirmBtn').addEventListener('click', confirmHold);
  document.querySelector('#releaseBtn').addEventListener('click', releaseHold);
  document.querySelector('#refreshBtn').addEventListener('click', () => loadSeats().then(() => setMessage('Seat map refreshed.')));
}

function toggleSeat(seatId) {
  const seat = state.seats.get(seatId);
  if (!seat || seat.status !== 'available') return;
  state.conflictIds.clear();
  if (state.selected.has(seatId)) state.selected.delete(seatId);
  else state.selected.add(seatId);
  render();
}

async function requestHold() {
  const seatIds = [...state.selected];
  if (seatIds.length === 0) return;
  try {
    setMessage('Requesting hold...');
    const response = await api('/api/holds', {
      method: 'POST',
      body: JSON.stringify({ seatIds, sessionId })
    });
    const data = await response.json();
    if (response.status === 409) {
      state.conflictIds = new Set(data.conflicts || []);
      await loadSeats();
      state.conflictIds = new Set(data.conflicts || []);
      setMessage(`Hold failed. Taken seats: ${(data.conflicts || []).join(', ')}`, 'warn');
      return;
    }
    if (!response.ok) throw new Error(data.error || 'Hold failed');
    state.currentHold = data.hold;
    state.selected.clear();
    state.conflictIds.clear();
    upsertSeats(data.seats);
    startCountdown();
    setMessage(`Held ${data.hold.seatIds.length} seat(s). Confirm before the countdown expires.`, 'success');
  } catch (error) {
    setMessage(error.message, 'error');
  }
}

async function confirmHold() {
  if (!state.currentHold) return;
  try {
    setMessage('Confirming booking...');
    const response = await api(`/api/holds/${state.currentHold.id}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ sessionId })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Confirm failed');
    upsertSeats(data.seats);
    state.currentHold = null;
    clearInterval(countdownTimer);
    setMessage(`Booked seats: ${data.booking.seatIds.join(', ')}`, 'success');
  } catch (error) {
    state.currentHold = null;
    clearInterval(countdownTimer);
    await loadSeats().catch(() => {});
    setMessage(error.message, 'error');
  }
}

async function releaseHold() {
  if (!state.currentHold) return;
  const holdId = state.currentHold.id;
  try {
    setMessage('Releasing hold...');
    const response = await api(`/api/holds/${holdId}`, {
      method: 'DELETE',
      body: JSON.stringify({ sessionId })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Release failed');
    upsertSeats(data.seats || []);
    state.currentHold = null;
    clearInterval(countdownTimer);
    setMessage('Hold released.', 'success');
    await loadSeats();
  } catch (error) {
    setMessage(error.message, 'error');
  }
}

function connectStream() {
  const source = new EventSource('/api/stream');
  source.addEventListener('hello', () => {
    state.connected = true;
    render();
  });
  source.addEventListener('seat-change', (event) => {
    const payload = JSON.parse(event.data);
    upsertSeats(payload.seats || []);
    if (state.currentHold && payload.seats?.some((seat) => seat.holdId === null && state.currentHold.seatIds.includes(seat.id))) {
      state.currentHold = null;
      clearInterval(countdownTimer);
    }
    state.message = `Live update: ${payload.reason}.`;
    render('info');
  });
  source.onerror = () => {
    state.connected = false;
    render('warn');
  };
}

loadSeats()
  .then(() => setMessage('Select available seats, then place a hold.'))
  .catch((error) => setMessage(error.message, 'error'));
connectStream();
