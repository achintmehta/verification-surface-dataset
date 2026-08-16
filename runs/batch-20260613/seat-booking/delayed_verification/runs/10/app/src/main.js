import './styles.css';

const API = '';
const SESSION_KEY = 'seat-booking-session-id';
const selected = new Set();
let seats = [];
let currentHold = null;
let countdownTimer = null;

let sessionId = localStorage.getItem(SESSION_KEY);
if (!sessionId) {
  sessionId = crypto.randomUUID();
  localStorage.setItem(SESSION_KEY, sessionId);
}

const app = document.querySelector('#app');
app.innerHTML = `
  <header>
    <div>
      <h1>Seat Booking</h1>
      <p>Session: <code id="session"></code></p>
    </div>
    <div id="inventory" class="inventory"></div>
  </header>

  <main>
    <section class="panel">
      <h2>Seat Map</h2>
      <div class="legend">
        <span><i class="swatch available"></i>Available</span>
        <span><i class="swatch selected"></i>Selected</span>
        <span><i class="swatch held"></i>Held</span>
        <span><i class="swatch booked"></i>Booked</span>
      </div>
      <div id="seat-map" class="seat-map" aria-live="polite"></div>
    </section>

    <aside class="panel controls">
      <h2>Your Hold</h2>
      <p id="message" class="message">Choose one or more available seats.</p>
      <div id="selection" class="selection">No seats selected</div>
      <button id="hold-btn">Hold selected seats</button>
      <button id="confirm-btn" disabled>Confirm hold</button>
      <button id="release-btn" disabled>Release hold</button>
      <div id="countdown" class="countdown hidden"></div>
    </aside>
  </main>
`;

const els = {
  session: document.querySelector('#session'),
  inventory: document.querySelector('#inventory'),
  seatMap: document.querySelector('#seat-map'),
  message: document.querySelector('#message'),
  selection: document.querySelector('#selection'),
  holdBtn: document.querySelector('#hold-btn'),
  confirmBtn: document.querySelector('#confirm-btn'),
  releaseBtn: document.querySelector('#release-btn'),
  countdown: document.querySelector('#countdown')
};

els.session.textContent = sessionId.slice(0, 8);

function seatName(seat) {
  return `${seat.rowLabel}${seat.seatNumber}`;
}

function setMessage(text, kind = '') {
  els.message.textContent = text;
  els.message.className = `message ${kind}`.trim();
}

async function request(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(body.error || `Request failed with ${response.status}`);
    err.status = response.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function loadSeats() {
  const data = await request('/api/seats');
  seats = data.seats;
  pruneSelection();
  render();
}

function pruneSelection() {
  const byId = new Map(seats.map((s) => [s.id, s]));
  for (const id of [...selected]) {
    if (byId.get(id)?.status !== 'available') selected.delete(id);
  }
}

function render() {
  renderInventory();
  renderSelection();
  renderSeats();
  els.holdBtn.disabled = selected.size === 0 || Boolean(currentHold);
  els.confirmBtn.disabled = !currentHold;
  els.releaseBtn.disabled = !currentHold;
}

function renderInventory() {
  const totals = seats.reduce((acc, seat) => {
    acc[seat.status] = (acc[seat.status] || 0) + 1;
    acc.total += 1;
    return acc;
  }, { total: 0, available: 0, held: 0, booked: 0 });
  els.inventory.innerHTML = `
    <strong>${totals.total}</strong> total
    <strong>${totals.available}</strong> available
    <strong>${totals.held}</strong> held
    <strong>${totals.booked}</strong> booked
  `;
}

function renderSelection() {
  if (!selected.size) {
    els.selection.textContent = currentHold ? 'Hold is active.' : 'No seats selected';
    return;
  }
  const byId = new Map(seats.map((s) => [s.id, s]));
  els.selection.textContent = `Selected: ${[...selected].map((id) => seatName(byId.get(id))).join(', ')}`;
}

function renderSeats() {
  const groups = Map.groupBy ? Map.groupBy(seats, (s) => s.rowLabel) : groupByRow(seats);
  els.seatMap.innerHTML = '';
  for (const [row, rowSeats] of groups) {
    const rowEl = document.createElement('div');
    rowEl.className = 'row';
    const label = document.createElement('span');
    label.className = 'row-label';
    label.textContent = row;
    rowEl.append(label);
    for (const seat of rowSeats) {
      const btn = document.createElement('button');
      const isSelected = selected.has(seat.id);
      const isMine = currentHold?.seatIds?.includes(seat.id) && seat.status === 'held';
      btn.className = `seat ${seat.status} ${isSelected ? 'selected' : ''} ${isMine ? 'mine' : ''}`;
      btn.textContent = seat.seatNumber;
      btn.title = `${seatName(seat)} — ${isMine ? 'your hold' : seat.status}`;
      btn.disabled = seat.status !== 'available' && !isSelected;
      btn.addEventListener('click', () => toggleSeat(seat));
      rowEl.append(btn);
    }
    els.seatMap.append(rowEl);
  }
}

function groupByRow(items) {
  const map = new Map();
  for (const item of items) {
    if (!map.has(item.rowLabel)) map.set(item.rowLabel, []);
    map.get(item.rowLabel).push(item);
  }
  return map;
}

function toggleSeat(seat) {
  if (currentHold || seat.status !== 'available') return;
  selected.has(seat.id) ? selected.delete(seat.id) : selected.add(seat.id);
  render();
}

els.holdBtn.addEventListener('click', async () => {
  try {
    const seatIds = [...selected];
    const data = await request('/api/holds', {
      method: 'POST',
      body: JSON.stringify({ seatIds, sessionId })
    });
    currentHold = data.hold;
    selected.clear();
    applySeatUpdates(data.seats);
    setMessage(`Held ${data.seats.map(seatName).join(', ')}. Confirm before the timer expires.`, 'success');
    startCountdown(currentHold.expiresAt);
    render();
  } catch (err) {
    if (err.status === 409) {
      setMessage(`Hold failed. Seats already taken: ${(err.body.conflictingSeatIds || []).join(', ')}`, 'error');
      await loadSeats();
    } else {
      setMessage(err.message, 'error');
    }
  }
});

els.confirmBtn.addEventListener('click', async () => {
  if (!currentHold) return;
  try {
    const data = await request(`/api/holds/${currentHold.id}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ sessionId })
    });
    applySeatUpdates(data.seats);
    setMessage(`Booked! Booking id: ${data.bookingId}`, 'success');
    currentHold = null;
    stopCountdown();
    render();
  } catch (err) {
    setMessage(err.message, 'error');
    currentHold = null;
    stopCountdown();
    await loadSeats();
  }
});

els.releaseBtn.addEventListener('click', async () => {
  if (!currentHold) return;
  try {
    const data = await request(`/api/holds/${currentHold.id}`, {
      method: 'DELETE',
      body: JSON.stringify({ sessionId })
    });
    applySeatUpdates(data.seats || []);
    setMessage('Hold released.', 'success');
  } catch (err) {
    setMessage(err.message, 'error');
  } finally {
    currentHold = null;
    stopCountdown();
    await loadSeats();
  }
});

function startCountdown(expiresAt) {
  stopCountdown();
  els.countdown.classList.remove('hidden');
  const tick = () => {
    const ms = new Date(expiresAt).getTime() - Date.now();
    if (ms <= 0) {
      els.countdown.textContent = 'Hold expired';
      currentHold = null;
      render();
      loadSeats().catch(() => {});
      stopCountdown(false);
      return;
    }
    els.countdown.textContent = `Time left: ${Math.ceil(ms / 1000)}s`;
  };
  tick();
  countdownTimer = setInterval(tick, 250);
}

function stopCountdown(hide = true) {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = null;
  if (hide) els.countdown.classList.add('hidden');
}

function applySeatUpdates(updatedSeats) {
  const byId = new Map(seats.map((s) => [s.id, s]));
  for (const seat of updatedSeats) byId.set(seat.id, seat);
  seats = [...byId.values()].sort((a, b) => a.rowLabel.localeCompare(b.rowLabel) || a.seatNumber - b.seatNumber);
  pruneSelection();
}

function connectStream() {
  const source = new EventSource('/api/stream');
  source.addEventListener('seats', (event) => {
    const data = JSON.parse(event.data);
    applySeatUpdates(data.seats || []);

    if (currentHold) {
      const heldIds = new Set(currentHold.seatIds);
      const changedMine = (data.seats || []).some((seat) => heldIds.has(seat.id) && seat.status !== 'held');
      if (changedMine && data.action === 'released') {
        setMessage('Your hold expired or was released.', 'error');
        currentHold = null;
        stopCountdown();
      }
    }
    render();
  });
  source.onerror = () => {
    setMessage('Live connection interrupted; retrying automatically…', 'error');
  };
}

connectStream();
loadSeats().catch((err) => setMessage(err.message, 'error'));
