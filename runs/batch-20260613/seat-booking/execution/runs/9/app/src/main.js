import './styles.css';

const API = import.meta.env.VITE_API_BASE || 'http://localhost:3000';
const SESSION_KEY = 'seat-booking-session-id';
let sessionId = localStorage.getItem(SESSION_KEY);
if (!sessionId) {
  sessionId = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  localStorage.setItem(SESSION_KEY, sessionId);
}

const state = {
  seats: [],
  selected: new Set(),
  currentHold: null,
  countdownTimer: null,
};

const app = document.querySelector('#app');
app.innerHTML = `
  <main class="shell">
    <header>
      <div>
        <h1>Seat Booking</h1>
        <p class="muted">Session: <code>${sessionId}</code></p>
      </div>
      <div id="connection" class="pill">Connecting…</div>
    </header>

    <section class="toolbar">
      <div id="inventory" class="inventory"></div>
      <div class="actions">
        <button id="holdBtn" disabled>Hold selected seats</button>
        <button id="confirmBtn" disabled>Confirm hold</button>
        <button id="releaseBtn" disabled>Release hold</button>
      </div>
    </section>

    <section id="holdPanel" class="hold-panel hidden"></section>
    <section id="message" class="message hidden"></section>
    <section id="seatGrid" class="seat-grid" aria-label="Seat map"></section>

    <footer class="legend">
      <span><i class="swatch available"></i>Available</span>
      <span><i class="swatch selected"></i>Selected</span>
      <span><i class="swatch held"></i>Held</span>
      <span><i class="swatch booked"></i>Booked</span>
    </footer>
  </main>
`;

const grid = document.querySelector('#seatGrid');
const inventoryEl = document.querySelector('#inventory');
const messageEl = document.querySelector('#message');
const holdPanel = document.querySelector('#holdPanel');
const holdBtn = document.querySelector('#holdBtn');
const confirmBtn = document.querySelector('#confirmBtn');
const releaseBtn = document.querySelector('#releaseBtn');
const connectionEl = document.querySelector('#connection');

function showMessage(text, kind = 'info') {
  messageEl.textContent = text;
  messageEl.className = `message ${kind}`;
  if (text) setTimeout(() => messageEl.classList.add('hidden'), 7000);
}

function seatClasses(seat) {
  const classes = ['seat', seat.status];
  if (state.selected.has(seat.id)) classes.push('selected');
  if (state.currentHold?.seatIds?.includes(seat.id) && seat.status === 'held') classes.push('mine');
  return classes.join(' ');
}

function render() {
  const byRow = new Map();
  for (const seat of state.seats) {
    if (!byRow.has(seat.rowLabel)) byRow.set(seat.rowLabel, []);
    byRow.get(seat.rowLabel).push(seat);
  }

  grid.innerHTML = '';
  for (const [row, seats] of byRow) {
    const label = document.createElement('div');
    label.className = 'row-label';
    label.textContent = row;
    grid.appendChild(label);
    for (const seat of seats) {
      const btn = document.createElement('button');
      btn.className = seatClasses(seat);
      btn.textContent = seat.seatNumber;
      btn.title = `${seat.id}: ${seat.status}`;
      btn.disabled = seat.status !== 'available' && !state.selected.has(seat.id);
      btn.addEventListener('click', () => toggleSeat(seat.id));
      grid.appendChild(btn);
    }
  }

  const counts = state.seats.reduce((acc, s) => {
    acc[s.status] = (acc[s.status] || 0) + 1;
    acc.total += 1;
    return acc;
  }, { available: 0, held: 0, booked: 0, total: 0 });
  inventoryEl.innerHTML = `
    <strong>${counts.total}</strong> total
    <span>${counts.available} available</span>
    <span>${counts.held} held</span>
    <span>${counts.booked} booked</span>
  `;

  holdBtn.disabled = state.selected.size === 0 || Boolean(state.currentHold);
  confirmBtn.disabled = !state.currentHold;
  releaseBtn.disabled = !state.currentHold;
}

function toggleSeat(id) {
  const seat = state.seats.find((s) => s.id === id);
  if (!seat || seat.status !== 'available') return;
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  render();
}

async function request(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
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
  state.seats = data.seats;
  state.selected.clear();
  render();
}

function startCountdown() {
  clearInterval(state.countdownTimer);
  if (!state.currentHold) {
    holdPanel.className = 'hold-panel hidden';
    return;
  }
  const tick = () => {
    if (!state.currentHold) return;
    const remaining = Math.max(0, Math.ceil((new Date(state.currentHold.expiresAt).getTime() - Date.now()) / 1000));
    holdPanel.className = 'hold-panel';
    holdPanel.innerHTML = `
      <strong>Holding ${state.currentHold.seatIds.join(', ')}</strong>
      <span>Expires in ${remaining}s</span>
    `;
    if (remaining <= 0) {
      clearInterval(state.countdownTimer);
      state.currentHold = null;
      holdPanel.className = 'hold-panel hidden';
      showMessage('Your hold expired.', 'warn');
      loadSeats().catch(console.error);
    }
    render();
  };
  tick();
  state.countdownTimer = setInterval(tick, 250);
}

holdBtn.addEventListener('click', async () => {
  try {
    const seatIds = [...state.selected];
    const data = await request('/api/holds', {
      method: 'POST',
      body: JSON.stringify({ seatIds, sessionId }),
    });
    state.currentHold = data.hold;
    state.selected.clear();
    for (const id of data.hold.seatIds) {
      const seat = state.seats.find((s) => s.id === id);
      if (seat) Object.assign(seat, { status: 'held', holdId: data.hold.id, holdExpiresAt: data.hold.expiresAt });
    }
    showMessage(`Hold created for ${data.hold.seatIds.join(', ')}`, 'success');
    startCountdown();
    render();
  } catch (err) {
    if (err.status === 409) {
      showMessage(`Hold failed. Already taken: ${(err.data.conflictingSeatIds || []).join(', ')}`, 'error');
    } else {
      showMessage(err.message, 'error');
    }
    loadSeats().catch(console.error);
  }
});

confirmBtn.addEventListener('click', async () => {
  if (!state.currentHold) return;
  try {
    const data = await request(`/api/holds/${state.currentHold.id}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    });
    for (const id of data.booking.seatIds) {
      const seat = state.seats.find((s) => s.id === id);
      if (seat) Object.assign(seat, { status: 'booked', holdId: null, holdExpiresAt: null, bookedBy: sessionId });
    }
    state.currentHold = null;
    clearInterval(state.countdownTimer);
    holdPanel.className = 'hold-panel hidden';
    showMessage(`Booking confirmed: ${data.booking.id}`, 'success');
    render();
  } catch (err) {
    showMessage(err.message, 'error');
    state.currentHold = null;
    startCountdown();
    loadSeats().catch(console.error);
  }
});

releaseBtn.addEventListener('click', async () => {
  if (!state.currentHold) return;
  try {
    const hold = state.currentHold;
    await request(`/api/holds/${hold.id}`, {
      method: 'DELETE',
      body: JSON.stringify({ sessionId }),
    });
    state.currentHold = null;
    clearInterval(state.countdownTimer);
    holdPanel.className = 'hold-panel hidden';
    showMessage('Hold released.', 'success');
    await loadSeats();
  } catch (err) {
    showMessage(err.message, 'error');
  }
});

function applySeatUpdates(seats) {
  for (const update of seats || []) {
    const seat = state.seats.find((s) => s.id === update.id);
    if (seat) {
      Object.assign(seat, {
        status: update.status,
        holdId: update.holdId ?? null,
        holdExpiresAt: update.holdExpiresAt ?? null,
        bookedBy: update.bookedBy ?? seat.bookedBy ?? null,
      });
    }
    if (update.status !== 'available') state.selected.delete(update.id);
  }
  if (state.currentHold && seats?.some((s) => state.currentHold.seatIds.includes(s.id) && s.status === 'available')) {
    state.currentHold = null;
    startCountdown();
  }
  render();
}

function connectStream() {
  const events = new EventSource(`${API}/api/stream`);
  events.addEventListener('connected', () => {
    connectionEl.textContent = 'Live';
    connectionEl.className = 'pill live';
  });
  events.addEventListener('seats', (event) => {
    const payload = JSON.parse(event.data);
    applySeatUpdates(payload.seats);
  });
  events.onerror = () => {
    connectionEl.textContent = 'Reconnecting…';
    connectionEl.className = 'pill warn';
  };
}

loadSeats().catch((err) => showMessage(err.message, 'error'));
connectStream();
