import './styles.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3000';
const SESSION_KEY = 'seat-booking-session-id';

let sessionId = localStorage.getItem(SESSION_KEY);
if (!sessionId) {
  sessionId = `session-${crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`;
  localStorage.setItem(SESSION_KEY, sessionId);
}

const state = {
  seats: [],
  inventory: null,
  selected: new Set(),
  currentHold: null,
  ttlSeconds: 30,
  notice: 'Loading seats…',
  conflicts: new Set(),
};

const app = document.querySelector('#app');

app.innerHTML = `
  <main class="shell">
    <header class="hero">
      <div>
        <p class="eyebrow">Live single-event seat map</p>
        <h1>Seat Booking</h1>
        <p class="subtle">Select available seats, place a temporary hold, then confirm before the countdown expires.</p>
      </div>
      <div class="session-card">
        <span>Your session</span>
        <code id="session-id"></code>
      </div>
    </header>

    <section class="toolbar">
      <div class="inventory" id="inventory"></div>
      <div class="actions">
        <button id="hold-btn" type="button">Hold selected seats</button>
        <button id="confirm-btn" type="button" disabled>Confirm hold</button>
        <button id="release-btn" type="button" disabled>Release hold</button>
      </div>
    </section>

    <section id="hold-panel" class="hold-panel hidden"></section>
    <p id="notice" class="notice"></p>

    <section class="stage" aria-label="Seat map">
      <div class="screen">STAGE</div>
      <div id="seat-grid" class="seat-grid"></div>
    </section>

    <section class="legend" aria-label="Legend">
      <span><i class="swatch available"></i> Available</span>
      <span><i class="swatch selected"></i> Selected</span>
      <span><i class="swatch held"></i> Held</span>
      <span><i class="swatch mine"></i> Your hold</span>
      <span><i class="swatch booked"></i> Booked</span>
    </section>
  </main>
`;

document.querySelector('#session-id').textContent = sessionId;
const grid = document.querySelector('#seat-grid');
const inventoryEl = document.querySelector('#inventory');
const noticeEl = document.querySelector('#notice');
const holdPanel = document.querySelector('#hold-panel');
const holdBtn = document.querySelector('#hold-btn');
const confirmBtn = document.querySelector('#confirm-btn');
const releaseBtn = document.querySelector('#release-btn');

async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(body.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

function label(seat) {
  return `${seat.rowLabel}${seat.seatNumber}`;
}

function updateInventory(inv) {
  state.inventory = inv;
  if (!inv) return;
  inventoryEl.innerHTML = `
    <span><strong>${inv.available}</strong> available</span>
    <span><strong>${inv.held}</strong> held</span>
    <span><strong>${inv.booked}</strong> booked</span>
    <span><strong>${inv.total}</strong> total</span>
  `;
}

function seatClass(seat) {
  const classes = ['seat', seat.status];
  if (state.selected.has(seat.id)) classes.push('selected');
  if (state.conflicts.has(seat.id)) classes.push('conflict');
  if (state.currentHold?.id && seat.holdId === state.currentHold.id && seat.status === 'held') classes.push('mine');
  return classes.join(' ');
}

function renderSeats() {
  const grouped = new Map();
  for (const seat of state.seats) {
    if (!grouped.has(seat.rowLabel)) grouped.set(seat.rowLabel, []);
    grouped.get(seat.rowLabel).push(seat);
  }

  grid.innerHTML = [...grouped.entries()].map(([row, seats]) => `
    <div class="row-label">${row}</div>
    <div class="row-seats">
      ${seats.map((seat) => `
        <button class="${seatClass(seat)}" data-seat-id="${seat.id}" ${seat.status !== 'available' ? 'disabled' : ''} title="${label(seat)} ${seat.status}">
          ${seat.seatNumber}
        </button>
      `).join('')}
    </div>
  `).join('');

  holdBtn.disabled = state.selected.size === 0 || Boolean(state.currentHold);
  confirmBtn.disabled = !state.currentHold;
  releaseBtn.disabled = !state.currentHold;
}

function renderHold() {
  if (!state.currentHold) {
    holdPanel.classList.add('hidden');
    holdPanel.innerHTML = '';
    return;
  }
  const remaining = Math.max(0, Math.ceil((new Date(state.currentHold.expiresAt).getTime() - Date.now()) / 1000));
  const seats = state.currentHold.seatIds
    .map((id) => state.seats.find((seat) => seat.id === id))
    .filter(Boolean)
    .map(label)
    .join(', ');

  holdPanel.classList.remove('hidden');
  holdPanel.innerHTML = `
    <div>
      <strong>Current hold:</strong> ${seats || state.currentHold.seatIds.join(', ')}
      <span class="timer ${remaining <= 5 ? 'urgent' : ''}">${remaining}s left</span>
    </div>
    <small>Hold id ${state.currentHold.id}</small>
  `;

  if (remaining <= 0) {
    state.notice = 'Your hold expired. Those seats may be selected again if still available.';
    state.currentHold = null;
    refreshSeats();
  }
}

function render() {
  noticeEl.textContent = state.notice;
  renderSeats();
  renderHold();
}

function mergeSeats(seats) {
  const byId = new Map(state.seats.map((seat) => [seat.id, seat]));
  for (const seat of seats) byId.set(seat.id, { ...byId.get(seat.id), ...seat });
  state.seats = [...byId.values()].sort((a, b) => a.rowLabel.localeCompare(b.rowLabel) || a.seatNumber - b.seatNumber);

  for (const id of [...state.selected]) {
    const seat = byId.get(id);
    if (!seat || seat.status !== 'available') state.selected.delete(id);
  }

  if (state.currentHold) {
    const stillHeld = state.currentHold.seatIds.every((id) => {
      const seat = byId.get(id);
      return seat?.status === 'held' && seat.holdId === state.currentHold.id;
    });
    const booked = state.currentHold.seatIds.every((id) => byId.get(id)?.status === 'booked');
    if (!stillHeld && !booked) state.currentHold = null;
  }
}

async function refreshSeats() {
  const data = await api('/api/seats');
  state.seats = data.seats;
  state.ttlSeconds = data.ttlSeconds;
  updateInventory(data.inventory);
  state.selected.clear();
  state.conflicts.clear();
  state.notice = 'Seat map is live.';
  render();
}

grid.addEventListener('click', (event) => {
  const button = event.target.closest('[data-seat-id]');
  if (!button) return;
  const id = Number(button.dataset.seatId);
  const seat = state.seats.find((s) => s.id === id);
  if (!seat || seat.status !== 'available' || state.currentHold) return;
  state.conflicts.clear();
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  state.notice = `${state.selected.size} seat(s) selected.`;
  render();
});

holdBtn.addEventListener('click', async () => {
  try {
    holdBtn.disabled = true;
    const data = await api('/api/holds', {
      method: 'POST',
      body: JSON.stringify({ seatIds: [...state.selected], sessionId }),
    });
    state.currentHold = data.hold;
    state.selected.clear();
    state.conflicts.clear();
    mergeSeats(data.seats);
    updateInventory(data.inventory);
    state.notice = 'Hold placed. Confirm before the countdown reaches zero.';
    render();
  } catch (err) {
    if (err.status === 409) {
      state.conflicts = new Set((err.body.conflicts || []).map((seat) => seat.id));
      state.notice = 'Hold failed: highlighted seats were already taken. Refreshing map…';
      await refreshSeats();
    } else {
      state.notice = err.message;
      render();
    }
  }
});

confirmBtn.addEventListener('click', async () => {
  if (!state.currentHold) return;
  try {
    const holdId = state.currentHold.id;
    const data = await api(`/api/holds/${holdId}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    });
    mergeSeats(data.seats);
    updateInventory(data.inventory);
    state.currentHold = null;
    state.notice = data.booking.alreadyConfirmed ? 'Booking was already confirmed.' : 'Booking confirmed!';
    render();
  } catch (err) {
    state.currentHold = null;
    state.notice = `${err.message}. Nothing was booked.`;
    await refreshSeats();
  }
});

releaseBtn.addEventListener('click', async () => {
  if (!state.currentHold) return;
  try {
    const holdId = state.currentHold.id;
    const data = await api(`/api/holds/${holdId}`, {
      method: 'DELETE',
      body: JSON.stringify({ sessionId }),
    });
    mergeSeats(data.released);
    updateInventory(data.inventory);
    state.currentHold = null;
    state.notice = 'Hold released.';
    render();
  } catch (err) {
    state.currentHold = null;
    state.notice = err.message;
    await refreshSeats();
  }
});

function connectStream() {
  const events = new EventSource(`${API_BASE}/api/stream`);
  events.addEventListener('hello', (event) => {
    const data = JSON.parse(event.data);
    updateInventory(data.inventory);
  });
  events.addEventListener('seats', (event) => {
    const data = JSON.parse(event.data);
    mergeSeats(data.seats || []);
    updateInventory(data.inventory);
    if (data.type === 'held') state.notice = 'Live update: seats were held.';
    if (data.type === 'booked') state.notice = 'Live update: seats were booked.';
    if (data.type === 'released') state.notice = 'Live update: seats were released.';
    render();
  });
  events.onerror = () => {
    state.notice = 'Live connection interrupted; browser will retry automatically.';
    render();
  };
}

setInterval(() => {
  if (state.currentHold) renderHold();
}, 500);

refreshSeats().catch((err) => {
  state.notice = `Failed to load seats: ${err.message}`;
  render();
});
connectStream();
