import './styles.css';

const API_BASE = import.meta.env.VITE_API_BASE || (location.port === '5173' ? 'http://localhost:3000' : location.origin);
const app = document.querySelector('#app');
const sessionId = getSessionId();

let seats = [];
let inventory = null;
let selectedSeatIds = new Set();
let currentHold = loadHold();
let countdownTimer = null;
let lastConflicts = new Set();

app.innerHTML = `
  <header class="hero">
    <div>
      <p class="eyebrow">Single Event</p>
      <h1>Live Seat Booking</h1>
      <p>Choose available seats, place a temporary hold, then confirm before the timer expires.</p>
    </div>
    <div class="session-card">
      <span>Session</span>
      <code id="sessionId"></code>
    </div>
  </header>

  <main class="layout">
    <section class="panel map-panel">
      <div class="panel-heading">
        <div>
          <h2>Seat Map</h2>
          <p id="statusLine">Loading seats…</p>
        </div>
        <button id="refreshBtn" class="button secondary">Refresh</button>
      </div>
      <div class="stage">Stage</div>
      <div id="seatMap" class="seat-map" aria-live="polite"></div>
      <div class="legend">
        <span><i class="swatch available"></i>Available</span>
        <span><i class="swatch selected"></i>Selected</span>
        <span><i class="swatch held"></i>Held</span>
        <span><i class="swatch mine"></i>Your hold</span>
        <span><i class="swatch booked"></i>Booked</span>
      </div>
    </section>

    <aside class="panel controls">
      <h2>Your booking</h2>
      <dl class="inventory" id="inventory"></dl>

      <div class="selection-box">
        <strong>Selected seats</strong>
        <p id="selectionText">None</p>
      </div>

      <div id="holdBox" class="hold-box hidden">
        <div class="hold-topline">
          <strong>Current hold</strong>
          <span id="countdown" class="pill">--</span>
        </div>
        <p id="holdSeats"></p>
        <small>Held seats are unavailable to everyone else until this expires, is released, or is confirmed.</small>
      </div>

      <div class="button-row">
        <button id="holdBtn" class="button primary">Hold selected seats</button>
        <button id="confirmBtn" class="button success" disabled>Confirm hold</button>
      </div>
      <button id="releaseBtn" class="button danger wide" disabled>Release current hold</button>

      <div id="message" class="message"></div>
    </aside>
  </main>
`;

document.querySelector('#sessionId').textContent = sessionId;
document.querySelector('#refreshBtn').addEventListener('click', refreshSeats);
document.querySelector('#holdBtn').addEventListener('click', placeHold);
document.querySelector('#confirmBtn').addEventListener('click', confirmHold);
document.querySelector('#releaseBtn').addEventListener('click', releaseHold);

refreshSeats();
startCountdown();
// Delay the long-lived EventSource briefly so page-load tooling can observe an idle initial render.
setTimeout(connectStream, 1200);

function getSessionId() {
  let id = localStorage.getItem('seat-booking-session-id');
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    localStorage.setItem('seat-booking-session-id', id);
  }
  return id;
}

function loadHold() {
  try {
    const hold = JSON.parse(localStorage.getItem('seat-booking-current-hold') || 'null');
    if (!hold || hold.sessionId !== sessionId) return null;
    if (new Date(hold.expiresAt).getTime() <= Date.now()) {
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
  render();
}

async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(data?.error || `Request failed (${response.status})`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

async function refreshSeats({ keepConflicts = false } = {}) {
  try {
    const data = await api('/api/seats');
    seats = data.seats.map(normalizeSeat);
    inventory = data.inventory;
    if (!keepConflicts) lastConflicts.clear();
    reconcileCurrentHold();
    render();
  } catch (error) {
    setMessage(error.message, 'error');
  }
}

function normalizeSeat(seat) {
  return {
    ...seat,
    id: Number(seat.id),
    seat_number: Number(seat.seat_number),
  };
}

function reconcileCurrentHold() {
  if (!currentHold) return;
  const stillHeldByMe = currentHold.seatIds.every((id) => {
    const seat = seats.find((s) => s.id === id);
    return seat && seat.status === 'held' && seat.hold_id === currentHold.id;
  });
  const bookedByMe = currentHold.seatIds.every((id) => {
    const seat = seats.find((s) => s.id === id);
    return seat && seat.status === 'booked' && seat.hold_id === currentHold.id;
  });
  if (!stillHeldByMe && !bookedByMe) saveHold(null);
}

function render() {
  renderInventory();
  renderSeatMap();
  renderControls();
}

function renderInventory() {
  const el = document.querySelector('#inventory');
  if (!inventory) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = `
    <div><dt>Total</dt><dd>${inventory.total}</dd></div>
    <div><dt>Available</dt><dd>${inventory.available}</dd></div>
    <div><dt>Held active</dt><dd>${inventory.held}</dd></div>
    <div><dt>Booked</dt><dd>${inventory.booked}</dd></div>
  `;
}

function renderSeatMap() {
  const map = document.querySelector('#seatMap');
  const grouped = groupByRow(seats);
  map.innerHTML = '';
  for (const [row, rowSeats] of grouped) {
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';
    const label = document.createElement('div');
    label.className = 'row-label';
    label.textContent = row;
    rowEl.append(label);

    for (const seat of rowSeats) {
      const button = document.createElement('button');
      button.className = seatClass(seat);
      button.type = 'button';
      button.textContent = seat.seat_number;
      button.title = `${seat.row_label}${seat.seat_number} — ${seat.status}`;
      button.disabled = !isSelectable(seat);
      button.addEventListener('click', () => toggleSeat(seat.id));
      rowEl.append(button);
    }
    map.append(rowEl);
  }
  document.querySelector('#statusLine').textContent = seats.length
    ? `${seats.length} seats loaded. Updates arrive live through SSE.`
    : 'No seats loaded.';
}

function groupByRow(list) {
  const map = new Map();
  for (const seat of list) {
    if (!map.has(seat.row_label)) map.set(seat.row_label, []);
    map.get(seat.row_label).push(seat);
  }
  for (const rowSeats of map.values()) rowSeats.sort((a, b) => a.seat_number - b.seat_number);
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function seatClass(seat) {
  const classes = ['seat', seat.status];
  if (selectedSeatIds.has(seat.id)) classes.push('selected');
  if (currentHold?.seatIds?.includes(seat.id) && seat.status === 'held' && seat.hold_id === currentHold.id) classes.push('mine');
  if (lastConflicts.has(seat.id)) classes.push('conflict');
  return classes.join(' ');
}

function isSelectable(seat) {
  if (currentHold) return false;
  return seat.status === 'available' || selectedSeatIds.has(seat.id);
}

function toggleSeat(id) {
  if (selectedSeatIds.has(id)) selectedSeatIds.delete(id);
  else selectedSeatIds.add(id);
  lastConflicts.clear();
  render();
}

function renderControls() {
  const selected = seats.filter((seat) => selectedSeatIds.has(seat.id));
  document.querySelector('#selectionText').textContent = selected.length ? selected.map(labelSeat).join(', ') : 'None';

  const holdBtn = document.querySelector('#holdBtn');
  const confirmBtn = document.querySelector('#confirmBtn');
  const releaseBtn = document.querySelector('#releaseBtn');
  holdBtn.disabled = selectedSeatIds.size === 0 || Boolean(currentHold);
  confirmBtn.disabled = !currentHold;
  releaseBtn.disabled = !currentHold;

  const holdBox = document.querySelector('#holdBox');
  if (currentHold) {
    holdBox.classList.remove('hidden');
    document.querySelector('#holdSeats').textContent = currentHold.seatIds.map((id) => labelSeat(seats.find((s) => s.id === id), id)).join(', ');
  } else {
    holdBox.classList.add('hidden');
  }
}

function labelSeat(seat, fallbackId) {
  return seat ? `${seat.row_label}${seat.seat_number}` : `#${fallbackId}`;
}

function setMessage(text, type = 'info') {
  const el = document.querySelector('#message');
  el.textContent = text || '';
  el.className = `message ${type}`;
}

async function placeHold() {
  const seatIds = [...selectedSeatIds];
  if (!seatIds.length) return;
  try {
    setMessage('Requesting hold…');
    const data = await api('/api/holds', {
      method: 'POST',
      body: JSON.stringify({ seatIds, sessionId }),
    });
    selectedSeatIds.clear();
    const hold = { ...data.hold, seatIds: data.hold.seatIds.map(Number) };
    saveHold(hold);
    mergeSeatUpdates(data.seats);
    setMessage(`Hold placed. Confirm before it expires.`, 'success');
  } catch (error) {
    if (error.status === 409) {
      const ids = (error.data?.conflicts || []).map((item) => Number(item.id ?? item));
      lastConflicts = new Set(ids);
      setMessage(`Hold failed: ${ids.length ? `seat(s) ${ids.join(', ')} unavailable` : 'some seats unavailable'}.`, 'error');
      await refreshSeats({ keepConflicts: true });
    } else {
      setMessage(error.message, 'error');
    }
  }
}

async function confirmHold() {
  if (!currentHold) return;
  try {
    setMessage('Confirming hold…');
    const data = await api(`/api/holds/${currentHold.id}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    });
    mergeSeatUpdates(data.seats);
    saveHold(null);
    selectedSeatIds.clear();
    setMessage(`Booking confirmed. Booking id: ${data.booking.id}`, 'success');
    await refreshSeats();
  } catch (error) {
    saveHold(null);
    await refreshSeats();
    setMessage(`Confirm failed: ${error.message}`, 'error');
  }
}

async function releaseHold() {
  if (!currentHold) return;
  try {
    setMessage('Releasing hold…');
    await api(`/api/holds/${currentHold.id}`, {
      method: 'DELETE',
      body: JSON.stringify({ sessionId }),
    });
    saveHold(null);
    setMessage('Hold released.', 'success');
    await refreshSeats();
  } catch (error) {
    saveHold(null);
    await refreshSeats();
    setMessage(error.message, 'error');
  }
}

function mergeSeatUpdates(updatedSeats) {
  if (!updatedSeats?.length) return;
  const byId = new Map(seats.map((seat) => [seat.id, seat]));
  for (const rawSeat of updatedSeats) {
    const seat = normalizeSeat(rawSeat);
    byId.set(seat.id, { ...(byId.get(seat.id) || {}), ...seat });
  }
  seats = [...byId.values()].sort((a, b) => a.id - b.id);
  recomputeInventory();
  reconcileCurrentHold();
  render();
}

function recomputeInventory() {
  inventory = {
    total: seats.length,
    available: seats.filter((s) => s.status === 'available').length,
    held: seats.filter((s) => s.status === 'held').length,
    booked: seats.filter((s) => s.status === 'booked').length,
  };
}

function startCountdown() {
  clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    const el = document.querySelector('#countdown');
    if (!currentHold) {
      el.textContent = '--';
      return;
    }
    const ms = new Date(currentHold.expiresAt).getTime() - Date.now();
    if (ms <= 0) {
      el.textContent = 'expired';
      setMessage('Your hold expired and was released by the server.', 'error');
      saveHold(null);
      refreshSeats();
      return;
    }
    el.textContent = `${Math.ceil(ms / 1000)}s`;
  }, 250);
}

function connectStream() {
  const stream = new EventSource(`${API_BASE}/api/stream`);
  stream.addEventListener('connected', () => setMessage('Connected to live updates.', 'success'));
  stream.addEventListener('seat-update', (event) => {
    const data = JSON.parse(event.data);
    mergeSeatUpdates(data.seats);
    if (currentHold && data.seats.some((seat) => currentHold.seatIds.includes(Number(seat.id)) && seat.status === 'available')) {
      saveHold(null);
      setMessage('Your hold is no longer active.', 'error');
    }
  });
  stream.onerror = () => setMessage('Live update connection interrupted; browser will retry.', 'error');
}
