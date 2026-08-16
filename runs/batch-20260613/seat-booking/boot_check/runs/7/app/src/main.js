import './styles.css';

const API_BASE = location.port === '5173' ? 'http://localhost:3000' : '';
const app = document.querySelector('#app');
const sessionId = localStorage.getItem('seat-session-id') || crypto.randomUUID();
localStorage.setItem('seat-session-id', sessionId);

let seats = [];
let selected = new Set();
let currentHold = null;
let countdownTimer = null;
let noticeTimer = null;

app.innerHTML = `
  <main>
    <header>
      <h1>Seat Booking</h1>
      <p>Session: <code>${sessionId.slice(0, 8)}</code></p>
    </header>

    <section class="toolbar">
      <button id="holdBtn" disabled>Hold selected seats</button>
      <button id="confirmBtn" disabled>Confirm hold</button>
      <button id="releaseBtn" disabled>Release hold</button>
      <span id="countdown"></span>
    </section>

    <section class="legend">
      <span><i class="available"></i> Available</span>
      <span><i class="selected"></i> Selected</span>
      <span><i class="held"></i> Held</span>
      <span><i class="booked"></i> Booked</span>
    </section>

    <div id="notice" class="notice" hidden></div>
    <div id="inventory" class="inventory"></div>
    <section id="grid" class="grid" aria-label="Seat map"></section>
  </main>
`;

const grid = document.querySelector('#grid');
const holdBtn = document.querySelector('#holdBtn');
const confirmBtn = document.querySelector('#confirmBtn');
const releaseBtn = document.querySelector('#releaseBtn');
const countdown = document.querySelector('#countdown');
const notice = document.querySelector('#notice');
const inventoryEl = document.querySelector('#inventory');

function showNotice(message, type = 'info') {
  clearTimeout(noticeTimer);
  notice.hidden = false;
  notice.textContent = message;
  notice.className = `notice ${type}`;
  noticeTimer = setTimeout(() => (notice.hidden = true), 6000);
}

async function request(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || `Request failed (${res.status})`);
    error.status = res.status;
    error.data = data;
    throw error;
  }
  return data;
}

async function loadSeats() {
  const data = await request('/api/seats');
  seats = data.seats;
  selected = new Set([...selected].filter((id) => seatById(id)?.status === 'available'));
  render();
}

function seatById(id) {
  return seats.find((seat) => seat.id === id);
}

function updateInventory() {
  const counts = seats.reduce((acc, seat) => {
    acc[seat.status] = (acc[seat.status] || 0) + 1;
    acc.total += 1;
    return acc;
  }, { available: 0, held: 0, booked: 0, total: 0 });
  inventoryEl.textContent = `Available: ${counts.available} • Held: ${counts.held} • Booked: ${counts.booked} • Total: ${counts.total}`;
}

function render() {
  const rows = Map.groupBy ? Map.groupBy(seats, (seat) => seat.rowLabel) : groupByRow(seats);
  grid.innerHTML = '';
  for (const [rowLabel, rowSeats] of rows) {
    const label = document.createElement('div');
    label.className = 'row-label';
    label.textContent = rowLabel;
    grid.append(label);
    for (const seat of rowSeats) {
      const button = document.createElement('button');
      button.className = `seat ${seat.status}${selected.has(seat.id) ? ' selected' : ''}`;
      button.textContent = seat.seatNumber;
      button.title = `${seat.id}: ${seat.status}`;
      button.disabled = seat.status !== 'available' && !selected.has(seat.id);
      button.addEventListener('click', () => toggleSeat(seat.id));
      grid.append(button);
    }
  }
  holdBtn.disabled = selected.size === 0 || Boolean(currentHold);
  confirmBtn.disabled = !currentHold;
  releaseBtn.disabled = !currentHold;
  updateCountdown();
  updateInventory();
}

function groupByRow(list) {
  const map = new Map();
  for (const seat of list) {
    if (!map.has(seat.rowLabel)) map.set(seat.rowLabel, []);
    map.get(seat.rowLabel).push(seat);
  }
  return map;
}

function toggleSeat(id) {
  const seat = seatById(id);
  if (!seat || seat.status !== 'available' || currentHold) return;
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  render();
}

function applySeatUpdates(updates) {
  const byId = new Map(seats.map((seat) => [seat.id, seat]));
  for (const update of updates) {
    const existing = byId.get(update.id);
    if (existing) Object.assign(existing, update);
    selected.delete(update.id);
  }
  if (currentHold && currentHold.seatIds?.some((id) => {
    const status = byId.get(id)?.status;
    return status === 'available' || status === 'booked';
  })) {
    if (!currentHold.confirmed) currentHold = null;
  }
  render();
}

function startCountdown() {
  clearInterval(countdownTimer);
  countdownTimer = setInterval(updateCountdown, 500);
  updateCountdown();
}

function updateCountdown() {
  if (!currentHold) {
    countdown.textContent = '';
    clearInterval(countdownTimer);
    return;
  }
  const remaining = Math.max(0, Math.ceil((new Date(currentHold.expiresAt).getTime() - Date.now()) / 1000));
  countdown.textContent = currentHold.confirmed ? 'Booked.' : `Hold expires in ${remaining}s`;
  if (remaining <= 0 && !currentHold.confirmed) {
    currentHold = null;
    showNotice('Your hold expired.', 'warn');
    loadSeats();
  }
}

holdBtn.addEventListener('click', async () => {
  try {
    const seatIds = [...selected];
    const data = await request('/api/holds', { method: 'POST', body: JSON.stringify({ seatIds, sessionId }) });
    currentHold = data.hold;
    selected.clear();
    applySeatUpdates(data.hold.seats);
    startCountdown();
    showNotice(`Holding ${seatIds.join(', ')}. Confirm before the timer expires.`, 'ok');
  } catch (error) {
    if (error.status === 409) {
      showNotice(`Some seats are unavailable: ${(error.data.conflicts || []).join(', ')}`, 'warn');
      await loadSeats();
    } else {
      showNotice(error.message, 'error');
    }
  }
});

confirmBtn.addEventListener('click', async () => {
  if (!currentHold) return;
  try {
    const data = await request(`/api/holds/${currentHold.id}/confirm`, { method: 'POST', body: JSON.stringify({ sessionId }) });
    currentHold = { ...currentHold, confirmed: true };
    applySeatUpdates(data.confirmation.seats);
    showNotice(`Booked seats ${data.confirmation.seatIds.join(', ')}.`, 'ok');
    currentHold = null;
    render();
  } catch (error) {
    currentHold = null;
    showNotice(error.message, 'error');
    await loadSeats();
  }
});

releaseBtn.addEventListener('click', async () => {
  if (!currentHold) return;
  try {
    const hold = currentHold;
    currentHold = null;
    const data = await request(`/api/holds/${hold.id}`, { method: 'DELETE', body: JSON.stringify({ sessionId }) });
    if (data.hold.seats) applySeatUpdates(data.hold.seats);
    showNotice('Hold released.', 'ok');
    await loadSeats();
  } catch (error) {
    showNotice(error.message, 'error');
    await loadSeats();
  }
});

function connectStream() {
  const es = new EventSource(`${API_BASE}/api/stream`);
  es.addEventListener('seats', (event) => {
    const data = JSON.parse(event.data);
    applySeatUpdates(data.seats || []);
  });
  es.onerror = () => showNotice('Live connection interrupted; retrying automatically.', 'warn');
}

loadSeats().catch((err) => showNotice(err.message, 'error'));
connectStream();
