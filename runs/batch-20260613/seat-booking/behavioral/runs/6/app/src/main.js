import './style.css';

const app = document.querySelector('#app');
const apiBase = '';
const sessionId = getSessionId();

let seats = [];
let selectedSeatIds = new Set();
let currentHold = loadCurrentHold();
let countdownTimer = null;
let inventory = null;

app.innerHTML = `
  <main class="shell">
    <header class="hero">
      <div>
        <p class="eyebrow">Single Event</p>
        <h1>Live Seat Booking</h1>
        <p class="subtitle">Select available seats, place a temporary hold, then confirm before the hold expires.</p>
      </div>
      <div class="session-card">
        <span>Session</span>
        <code id="sessionId"></code>
      </div>
    </header>

    <section class="toolbar">
      <div class="inventory" id="inventory"></div>
      <div class="actions">
        <button id="refreshBtn" type="button">Refresh</button>
        <button id="holdBtn" type="button" disabled>Hold selected</button>
        <button id="confirmBtn" type="button" disabled>Confirm hold</button>
        <button id="releaseBtn" type="button" disabled>Release hold</button>
      </div>
    </section>

    <section class="status-panel" id="statusPanel">Loading seats…</section>

    <section class="stage">
      <div class="screen">Stage / Screen</div>
      <div class="seat-grid" id="seatGrid" aria-live="polite"></div>
    </section>

    <section class="legend">
      <span><i class="swatch available"></i> Available</span>
      <span><i class="swatch selected"></i> Selected</span>
      <span><i class="swatch held"></i> Held</span>
      <span><i class="swatch mine"></i> Your hold</span>
      <span><i class="swatch booked"></i> Booked</span>
    </section>
  </main>
`;

const sessionNode = document.querySelector('#sessionId');
const inventoryNode = document.querySelector('#inventory');
const statusNode = document.querySelector('#statusPanel');
const seatGrid = document.querySelector('#seatGrid');
const refreshBtn = document.querySelector('#refreshBtn');
const holdBtn = document.querySelector('#holdBtn');
const confirmBtn = document.querySelector('#confirmBtn');
const releaseBtn = document.querySelector('#releaseBtn');

sessionNode.textContent = sessionId;
refreshBtn.addEventListener('click', refreshSeats);
holdBtn.addEventListener('click', createHold);
confirmBtn.addEventListener('click', confirmHold);
releaseBtn.addEventListener('click', releaseHold);

await refreshSeats();
connectStream();
startCountdown();

function getSessionId() {
  const key = 'seat-booking-session-id';
  let value = localStorage.getItem(key);
  if (!value) {
    value = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    localStorage.setItem(key, value);
  }
  return value;
}

function loadCurrentHold() {
  try {
    const raw = localStorage.getItem('seat-booking-current-hold');
    if (!raw) return null;
    const hold = JSON.parse(raw);
    if (!hold?.id || new Date(hold.expiresAt).getTime() <= Date.now()) {
      localStorage.removeItem('seat-booking-current-hold');
      return null;
    }
    return hold;
  } catch {
    return null;
  }
}

function saveCurrentHold(hold) {
  currentHold = hold;
  if (hold) localStorage.setItem('seat-booking-current-hold', JSON.stringify(hold));
  else localStorage.removeItem('seat-booking-current-hold');
  startCountdown();
  render();
}

async function refreshSeats() {
  try {
    const response = await fetch(`${apiBase}/api/seats`);
    if (!response.ok) throw new Error('Failed to fetch seats');
    const data = await response.json();
    seats = data.seats;
    inventory = data.inventory;
    forgetUnavailableSelections();
    render();
    setStatus('Seat map refreshed.');
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function createHold() {
  const seatIds = [...selectedSeatIds];
  if (seatIds.length === 0) return;
  try {
    holdBtn.disabled = true;
    const response = await fetch(`${apiBase}/api/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId })
    });
    const data = await response.json();
    if (response.status === 409) {
      markConflicts(data.conflictingSeatIds || []);
      setStatus(`Hold failed. Seats already taken: ${(data.conflictingSeatIds || []).join(', ')}`, true);
      await refreshSeats();
      return;
    }
    if (!response.ok) throw new Error(data.message || 'Unable to create hold');

    selectedSeatIds.clear();
    inventory = data.inventory;
    mergeSeatUpdates(data.hold.seats);
    saveCurrentHold(data.hold);
    setStatus(`Holding ${data.hold.seatCount} seat(s). Confirm before the timer expires.`);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    render();
  }
}

async function confirmHold() {
  if (!currentHold) return;
  try {
    confirmBtn.disabled = true;
    const response = await fetch(`${apiBase}/api/holds/${encodeURIComponent(currentHold.id)}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Unable to confirm hold');

    inventory = data.inventory;
    mergeSeatUpdates(data.hold.seats);
    saveCurrentHold(null);
    setStatus(data.idempotent ? 'Hold was already confirmed. Your booking is safe.' : 'Booking confirmed!');
  } catch (error) {
    setStatus(error.message, true);
    await refreshSeats();
  }
}

async function releaseHold() {
  if (!currentHold) return;
  try {
    const response = await fetch(`${apiBase}/api/holds/${encodeURIComponent(currentHold.id)}`, { method: 'DELETE' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Unable to release hold');
    inventory = data.inventory;
    mergeSeatUpdates(data.seats || []);
    saveCurrentHold(null);
    setStatus('Hold released.');
  } catch (error) {
    setStatus(error.message, true);
    await refreshSeats();
  }
}

function connectStream() {
  const stream = new EventSource(`${apiBase}/api/stream`);
  stream.addEventListener('hello', () => setStatus('Connected to live updates.'));
  stream.addEventListener('seats', (event) => {
    const data = JSON.parse(event.data);
    mergeSeatUpdates(data.seats || []);
    if (data.inventory) inventory = data.inventory;
    if (data.action === 'booked' && currentHold?.id === data.holdId) saveCurrentHold(null);
    if (data.action === 'released' && currentHold && (data.seats || []).some((seat) => seat.holdId === null && currentHold.seats?.some((held) => held.id === seat.id))) {
      saveCurrentHold(null);
      setStatus('Your hold expired or was released.', true);
    }
    forgetUnavailableSelections();
    render();
  });
  stream.onerror = () => setStatus('Live update connection interrupted; browser will retry.', true);
}

function mergeSeatUpdates(updatedSeats) {
  if (!updatedSeats.length) return;
  const byId = new Map(seats.map((seat) => [seat.id, seat]));
  for (const updated of updatedSeats) byId.set(updated.id, updated);
  seats = [...byId.values()].sort((a, b) => a.id - b.id);
}

function forgetUnavailableSelections() {
  const available = new Set(seats.filter((seat) => seat.status === 'available').map((seat) => seat.id));
  selectedSeatIds = new Set([...selectedSeatIds].filter((id) => available.has(id)));
}

function markConflicts(ids) {
  for (const id of ids) {
    const node = document.querySelector(`[data-seat-id="${id}"]`);
    node?.classList.add('conflict');
  }
}

function render() {
  renderInventory();
  renderSeats();
  updateButtons();
}

function renderInventory() {
  if (!inventory) {
    inventoryNode.textContent = '';
    return;
  }
  inventoryNode.innerHTML = `
    <strong>${inventory.available}</strong> available
    <strong>${inventory.held}</strong> held
    <strong>${inventory.booked}</strong> booked
    <strong>${inventory.total}</strong> total
  `;
}

function renderSeats() {
  const rows = groupBy(seats, (seat) => seat.rowLabel);
  seatGrid.innerHTML = '';
  for (const [rowLabel, rowSeats] of rows) {
    const row = document.createElement('div');
    row.className = 'seat-row';
    const label = document.createElement('div');
    label.className = 'row-label';
    label.textContent = rowLabel;
    row.append(label);

    for (const seat of rowSeats) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.seatId = String(seat.id);
      button.className = `seat ${seat.status}`;
      if (selectedSeatIds.has(seat.id)) button.classList.add('selected');
      if (currentHold?.id && seat.holdId === currentHold.id && seat.status === 'held') button.classList.add('mine');
      button.textContent = seat.seatNumber;
      button.title = `${seat.rowLabel}${seat.seatNumber} - ${seat.status}`;
      button.disabled = seat.status !== 'available' && !selectedSeatIds.has(seat.id);
      button.addEventListener('click', () => toggleSeat(seat));
      row.append(button);
    }
    seatGrid.append(row);
  }
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

function toggleSeat(seat) {
  if (seat.status !== 'available') return;
  if (selectedSeatIds.has(seat.id)) selectedSeatIds.delete(seat.id);
  else selectedSeatIds.add(seat.id);
  render();
}

function updateButtons() {
  holdBtn.disabled = selectedSeatIds.size === 0 || Boolean(currentHold);
  const hasLiveHold = Boolean(currentHold && new Date(currentHold.expiresAt).getTime() > Date.now());
  confirmBtn.disabled = !hasLiveHold;
  releaseBtn.disabled = !hasLiveHold;
}

function startCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    if (!currentHold) return;
    const remaining = new Date(currentHold.expiresAt).getTime() - Date.now();
    if (remaining <= 0) {
      saveCurrentHold(null);
      setStatus('Hold timer elapsed. The server will release the seats automatically.', true);
      refreshSeats();
    } else {
      setStatus(`Current hold expires in ${formatDuration(remaining)}.`);
    }
    updateButtons();
  }, 250);
}

function formatDuration(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function setStatus(message, isError = false) {
  statusNode.textContent = message;
  statusNode.classList.toggle('error', isError);
}
