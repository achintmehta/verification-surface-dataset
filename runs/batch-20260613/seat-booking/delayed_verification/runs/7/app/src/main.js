import './styles.css';

const API = '';
const app = document.querySelector('#app');
const sessionId = localStorage.getItem('seat-booking-session') || crypto.randomUUID();
localStorage.setItem('seat-booking-session', sessionId);

let seats = [];
let inventory = null;
let selected = new Set();
let currentHold = JSON.parse(localStorage.getItem('seat-booking-hold') || 'null');
let countdownTimer = null;

app.innerHTML = `
  <main class="shell">
    <header>
      <div>
        <h1>Seat Booking</h1>
        <p>Session <code>${sessionId.slice(0, 8)}</code>. Holds expire automatically.</p>
      </div>
      <button id="refresh" class="secondary">Refresh</button>
    </header>

    <section class="toolbar">
      <div id="inventory" class="inventory">Loading inventory…</div>
      <div class="actions">
        <button id="holdBtn" disabled>Hold selected seats</button>
        <button id="confirmBtn" disabled>Confirm hold</button>
        <button id="releaseBtn" class="secondary" disabled>Release hold</button>
      </div>
      <div id="holdInfo" class="hold-info"></div>
    </section>

    <section id="messages" class="messages" aria-live="polite"></section>
    <section id="seatMap" class="seat-map" aria-label="Seat map"></section>

    <footer class="legend">
      <span><i class="seat available"></i> Available</span>
      <span><i class="seat selected"></i> Selected</span>
      <span><i class="seat held"></i> Held</span>
      <span><i class="seat own-hold"></i> Your hold</span>
      <span><i class="seat booked"></i> Booked</span>
    </footer>
  </main>
`;

const seatMap = document.querySelector('#seatMap');
const inventoryEl = document.querySelector('#inventory');
const messages = document.querySelector('#messages');
const holdInfo = document.querySelector('#holdInfo');
const holdBtn = document.querySelector('#holdBtn');
const confirmBtn = document.querySelector('#confirmBtn');
const releaseBtn = document.querySelector('#releaseBtn');
const refreshBtn = document.querySelector('#refresh');

function flash(message, kind = 'info') {
  messages.innerHTML = `<div class="message ${kind}">${message}</div>`;
  if (kind !== 'error') setTimeout(() => { if (messages.textContent === message) messages.innerHTML = ''; }, 3500);
}

async function request(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Request failed with ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function upsertSeats(updated) {
  const byId = new Map(seats.map((seat) => [seat.id, seat]));
  for (const seat of updated) byId.set(seat.id, { ...byId.get(seat.id), ...seat });
  seats = [...byId.values()].sort((a, b) => a.row.localeCompare(b.row) || a.seatNumber - b.seatNumber);
}

async function loadSeats() {
  const data = await request('/api/seats');
  seats = data.seats;
  inventory = data.inventory;
  pruneSelection();
  render();
}

function isOwnHeldSeat(seat) {
  return currentHold && seat.holdId === currentHold.id && seat.status === 'held';
}

function pruneSelection() {
  const availableIds = new Set(seats.filter((seat) => seat.status === 'available').map((seat) => seat.id));
  selected = new Set([...selected].filter((id) => availableIds.has(id)));
}

function render() {
  renderInventory();
  renderSeatMap();
  renderHoldControls();
}

function renderInventory() {
  if (!inventory) {
    inventoryEl.textContent = 'Loading inventory…';
    return;
  }
  inventoryEl.innerHTML = `
    <strong>${inventory.available}</strong> available
    <strong>${inventory.held}</strong> held
    <strong>${inventory.booked}</strong> booked
    <strong>${inventory.total}</strong> total
  `;
}

function renderSeatMap() {
  const rows = groupByRow(seats);
  seatMap.innerHTML = '';
  for (const [row, rowSeats] of rows) {
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';
    rowEl.innerHTML = `<div class="row-label">${row}</div>`;
    for (const seat of rowSeats) {
      const button = document.createElement('button');
      button.className = `seat ${seat.status}`;
      if (selected.has(seat.id)) button.classList.add('selected');
      if (isOwnHeldSeat(seat)) button.classList.add('own-hold');
      button.textContent = seat.seatNumber;
      button.title = `${seat.id}: ${seat.status}`;
      button.disabled = seat.status !== 'available' && !selected.has(seat.id);
      button.addEventListener('click', () => toggleSeat(seat));
      rowEl.appendChild(button);
    }
    seatMap.appendChild(rowEl);
  }
}

function groupByRow(items) {
  const map = new Map();
  for (const item of items) {
    if (!map.has(item.row)) map.set(item.row, []);
    map.get(item.row).push(item);
  }
  return map;
}

function renderHoldControls() {
  holdBtn.disabled = selected.size === 0 || Boolean(activeHold());
  confirmBtn.disabled = !activeHold();
  releaseBtn.disabled = !activeHold();
  if (!activeHold()) {
    holdInfo.textContent = selected.size ? `${selected.size} seat(s) selected` : 'Select available seats to create a hold.';
  }
}

function activeHold() {
  if (!currentHold) return null;
  if (new Date(currentHold.expiresAt).getTime() <= Date.now()) return null;
  return currentHold;
}

function startCountdown() {
  clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    if (!currentHold) {
      holdInfo.textContent = 'Select available seats to create a hold.';
      clearInterval(countdownTimer);
      renderHoldControls();
      return;
    }
    const ms = new Date(currentHold.expiresAt).getTime() - Date.now();
    if (ms <= 0) {
      holdInfo.textContent = 'Your hold expired. Seats will become available again.';
      currentHold = null;
      localStorage.removeItem('seat-booking-hold');
      clearInterval(countdownTimer);
      loadSeats().catch(console.error);
      renderHoldControls();
      return;
    }
    holdInfo.innerHTML = `Holding <strong>${currentHold.seatIds.join(', ')}</strong> for <strong>${Math.ceil(ms / 1000)}s</strong>`;
    renderHoldControls();
  }, 250);
}

function toggleSeat(seat) {
  if (seat.status !== 'available') return;
  if (selected.has(seat.id)) selected.delete(seat.id);
  else selected.add(seat.id);
  render();
}

holdBtn.addEventListener('click', async () => {
  const seatIds = [...selected];
  try {
    const data = await request('/api/holds', {
      method: 'POST',
      body: JSON.stringify({ seatIds, sessionId })
    });
    currentHold = data.hold;
    localStorage.setItem('seat-booking-hold', JSON.stringify(currentHold));
    selected.clear();
    upsertSeats(data.seats);
    inventory = data.inventory;
    startCountdown();
    render();
    flash('Hold created. Confirm before it expires.', 'success');
  } catch (error) {
    if (error.status === 409) {
      const conflicts = error.data.conflictingSeatIds || [];
      flash(`Those seats are no longer available: ${conflicts.join(', ')}`, 'error');
      await loadSeats();
    } else {
      flash(error.message, 'error');
    }
  }
});

confirmBtn.addEventListener('click', async () => {
  if (!currentHold) return;
  try {
    const data = await request(`/api/holds/${currentHold.id}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ sessionId })
    });
    upsertSeats(data.seats);
    inventory = data.inventory;
    currentHold = null;
    localStorage.removeItem('seat-booking-hold');
    clearInterval(countdownTimer);
    render();
    flash(`Booking confirmed: ${data.booking.id}`, 'success');
  } catch (error) {
    flash(error.message, 'error');
    currentHold = null;
    localStorage.removeItem('seat-booking-hold');
    await loadSeats();
  }
});

releaseBtn.addEventListener('click', async () => {
  if (!currentHold) return;
  try {
    const data = await request(`/api/holds/${currentHold.id}`, {
      method: 'DELETE',
      body: JSON.stringify({ sessionId })
    });
    upsertSeats(data.seats);
    inventory = data.inventory;
    currentHold = null;
    localStorage.removeItem('seat-booking-hold');
    clearInterval(countdownTimer);
    render();
    flash('Hold released.', 'success');
  } catch (error) {
    flash(error.message, 'error');
  }
});

refreshBtn.addEventListener('click', () => loadSeats().catch((error) => flash(error.message, 'error')));

function connectStream() {
  const events = new EventSource('/api/stream');
  events.addEventListener('seat-update', (event) => {
    const payload = JSON.parse(event.data);
    const updatedSeats = payload.changes.map((change) => change.seat);
    upsertSeats(updatedSeats);
    inventory = payload.inventory || inventory;
    pruneSelection();
    if (currentHold) {
      const stillHeld = seats.some((seat) => seat.holdId === currentHold.id && seat.status === 'held');
      const booked = seats.some((seat) => seat.holdId === currentHold.id && seat.status === 'booked');
      if (!stillHeld && !booked) {
        currentHold = null;
        localStorage.removeItem('seat-booking-hold');
      }
    }
    render();
  });
  events.onerror = () => {
    flash('Live connection interrupted; retrying automatically…', 'error');
  };
}

if (currentHold) startCountdown();
loadSeats().catch((error) => flash(error.message, 'error'));
connectStream();
