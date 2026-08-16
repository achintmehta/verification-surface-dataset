import './styles.css';

const API = '';
const SESSION_KEY = 'seat-booking-session-id';
let sessionId = localStorage.getItem(SESSION_KEY);
if (!sessionId) {
  sessionId = `session_${crypto.randomUUID()}`;
  localStorage.setItem(SESSION_KEY, sessionId);
}

const state = {
  seats: new Map(),
  selected: new Set(),
  currentHold: null,
  ttlTimer: null,
  lastConflictIds: new Set()
};

const app = document.querySelector('#app');
app.innerHTML = `
  <header class="topbar">
    <div>
      <h1>Seat Booking</h1>
      <p>Session: <code id="session-id"></code></p>
    </div>
    <div id="inventory" class="inventory"></div>
  </header>

  <main class="layout">
    <section class="panel map-panel">
      <div class="screen">STAGE</div>
      <div id="seat-map" class="seat-map" aria-live="polite"></div>
      <div class="legend">
        <span><i class="swatch available"></i>Available</span>
        <span><i class="swatch selected"></i>Selected</span>
        <span><i class="swatch held"></i>Held</span>
        <span><i class="swatch mine"></i>Your hold</span>
        <span><i class="swatch booked"></i>Booked</span>
      </div>
    </section>

    <aside class="panel controls">
      <h2>Actions</h2>
      <p id="message" class="message">Select one or more available seats.</p>
      <div class="selection-box">
        <strong>Selected seats</strong>
        <div id="selected-list" class="selected-list">None</div>
      </div>
      <button id="hold-btn" class="primary">Place hold</button>
      <button id="confirm-btn" disabled>Confirm current hold</button>
      <button id="release-btn" disabled>Release current hold</button>
      <div id="hold-info" class="hold-info hidden"></div>
      <hr />
      <button id="refresh-btn">Refresh seat map</button>
    </aside>
  </main>
`;

const els = {
  sessionId: document.querySelector('#session-id'),
  inventory: document.querySelector('#inventory'),
  seatMap: document.querySelector('#seat-map'),
  message: document.querySelector('#message'),
  selectedList: document.querySelector('#selected-list'),
  holdBtn: document.querySelector('#hold-btn'),
  confirmBtn: document.querySelector('#confirm-btn'),
  releaseBtn: document.querySelector('#release-btn'),
  holdInfo: document.querySelector('#hold-info'),
  refreshBtn: document.querySelector('#refresh-btn')
};
els.sessionId.textContent = sessionId;

function setMessage(text, kind = '') {
  els.message.textContent = text;
  els.message.className = `message ${kind}`.trim();
}

function seatLabel(seat) {
  return `${seat.rowLabel}${seat.seatNumber}`;
}

function sortedSeats(seats) {
  return [...seats].sort((a, b) => a.rowLabel.localeCompare(b.rowLabel) || a.seatNumber - b.seatNumber);
}

function groupedSeats() {
  const groups = new Map();
  for (const seat of sortedSeats(state.seats.values())) {
    if (!groups.has(seat.rowLabel)) groups.set(seat.rowLabel, []);
    groups.get(seat.rowLabel).push(seat);
  }
  return groups;
}

function isMine(seat) {
  return state.currentHold && seat.holdId === state.currentHold.id && seat.status === 'held';
}

function render() {
  const groups = groupedSeats();
  els.seatMap.innerHTML = '';
  for (const [row, seats] of groups) {
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';
    const label = document.createElement('div');
    label.className = 'row-label';
    label.textContent = row;
    rowEl.appendChild(label);

    for (const seat of seats) {
      const btn = document.createElement('button');
      const selected = state.selected.has(seat.id);
      const mine = isMine(seat);
      btn.className = `seat ${seat.status}${selected ? ' selected' : ''}${mine ? ' mine' : ''}${state.lastConflictIds.has(seat.id) ? ' conflict' : ''}`;
      btn.textContent = String(seat.seatNumber);
      btn.title = `${seatLabel(seat)} — ${mine ? 'your hold' : seat.status}`;
      btn.disabled = seat.status !== 'available' && !selected;
      btn.addEventListener('click', () => toggleSeat(seat.id));
      rowEl.appendChild(btn);
    }
    els.seatMap.appendChild(rowEl);
  }

  const counts = { available: 0, held: 0, booked: 0, total: state.seats.size };
  for (const seat of state.seats.values()) counts[seat.status] += 1;
  els.inventory.innerHTML = `
    <span>Total <strong>${counts.total}</strong></span>
    <span>Available <strong>${counts.available}</strong></span>
    <span>Held <strong>${counts.held}</strong></span>
    <span>Booked <strong>${counts.booked}</strong></span>
  `;

  const selectedLabels = [...state.selected].map((id) => state.seats.get(id)).filter(Boolean).map(seatLabel).join(', ');
  els.selectedList.textContent = selectedLabels || 'None';
  els.holdBtn.disabled = state.selected.size === 0 || Boolean(state.currentHold);
  els.confirmBtn.disabled = !state.currentHold;
  els.releaseBtn.disabled = !state.currentHold;
}

function toggleSeat(id) {
  const seat = state.seats.get(id);
  if (!seat || seat.status !== 'available') return;
  state.lastConflictIds.clear();
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  render();
}

async function fetchJson(url, options = {}) {
  const res = await fetch(`${API}${url}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(payload?.error?.message || `Request failed: ${res.status}`);
    error.status = res.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function loadSeats() {
  const data = await fetchJson('/api/seats');
  state.seats = new Map(data.seats.map((seat) => [seat.id, seat]));
  pruneSelection();
  render();
}

function pruneSelection() {
  for (const id of [...state.selected]) {
    const seat = state.seats.get(id);
    if (!seat || seat.status !== 'available') state.selected.delete(id);
  }
}

function applySeatChanges(seats) {
  for (const seat of seats) {
    state.seats.set(seat.id, seat);
    if (seat.status !== 'available') state.selected.delete(seat.id);
  }

  if (state.currentHold) {
    const stillHeldByMe = [...state.seats.values()].some((seat) => seat.holdId === state.currentHold.id && seat.status === 'held');
    const bookedByMe = [...state.seats.values()].some((seat) => seat.holdId === state.currentHold.id && seat.status === 'booked');
    if (!stillHeldByMe && !bookedByMe) {
      clearCurrentHold('Your hold is no longer active.');
    }
  }
  render();
}

async function placeHold() {
  const seatIds = [...state.selected];
  if (seatIds.length === 0) return;
  setMessage('Placing hold...');
  try {
    const data = await fetchJson('/api/holds', {
      method: 'POST',
      body: JSON.stringify({ seatIds, sessionId })
    });
    state.currentHold = data.hold;
    state.selected.clear();
    state.lastConflictIds.clear();
    for (const seat of data.hold.seats) state.seats.set(seat.id, seat);
    startHoldCountdown();
    setMessage('Hold placed. Confirm before the countdown expires.', 'success');
    render();
  } catch (err) {
    const conflicts = err.payload?.error?.conflictingSeatIds || [];
    state.lastConflictIds = new Set(conflicts);
    setMessage(conflicts.length ? `Hold failed. Already taken: ${conflicts.join(', ')}` : err.message, 'error');
    await loadSeats().catch(() => {});
  }
}

async function confirmHold() {
  if (!state.currentHold) return;
  setMessage('Confirming hold...');
  try {
    const data = await fetchJson(`/api/holds/${encodeURIComponent(state.currentHold.id)}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ sessionId })
    });
    for (const seat of data.booking.seats) state.seats.set(seat.id, seat);
    stopHoldCountdown();
    state.currentHold = null;
    els.holdInfo.classList.add('hidden');
    setMessage(data.idempotent ? 'Booking was already confirmed.' : 'Booking confirmed!', 'success');
    render();
  } catch (err) {
    clearCurrentHold(err.message);
    await loadSeats().catch(() => {});
    setMessage(err.message, 'error');
  }
}

async function releaseHold() {
  if (!state.currentHold) return;
  setMessage('Releasing hold...');
  try {
    const holdId = state.currentHold.id;
    const data = await fetchJson(`/api/holds/${encodeURIComponent(holdId)}`, {
      method: 'DELETE',
      body: JSON.stringify({ sessionId })
    });
    for (const seat of data.hold.seats || []) state.seats.set(seat.id, seat);
    clearCurrentHold('Hold released.');
    setMessage('Hold released.', 'success');
    await loadSeats();
  } catch (err) {
    clearCurrentHold(err.message);
    await loadSeats().catch(() => {});
    setMessage(err.message, 'error');
  }
}

function startHoldCountdown() {
  stopHoldCountdown();
  els.holdInfo.classList.remove('hidden');
  const tick = () => {
    if (!state.currentHold) return;
    const remainingMs = new Date(state.currentHold.expiresAt).getTime() - Date.now();
    if (remainingMs <= 0) {
      els.holdInfo.textContent = 'Hold expired. Refreshing...';
      clearCurrentHold('Hold expired.');
      loadSeats().catch(() => {});
      return;
    }
    els.holdInfo.textContent = `Current hold: ${state.currentHold.seatIds.join(', ')} — expires in ${Math.ceil(remainingMs / 1000)}s`;
  };
  tick();
  state.ttlTimer = setInterval(tick, 250);
}

function stopHoldCountdown() {
  if (state.ttlTimer) clearInterval(state.ttlTimer);
  state.ttlTimer = null;
}

function clearCurrentHold(message) {
  stopHoldCountdown();
  state.currentHold = null;
  els.holdInfo.classList.add('hidden');
  if (message) setMessage(message);
  render();
}

function connectStream() {
  const source = new EventSource('/api/stream');
  source.addEventListener('connected', () => setMessage('Live updates connected.'));
  source.addEventListener('seat-changes', (event) => {
    const data = JSON.parse(event.data);
    applySeatChanges(data.seats || []);
  });
  source.onerror = () => {
    setMessage('Live updates disconnected; retrying automatically...', 'error');
  };
}

els.holdBtn.addEventListener('click', placeHold);
els.confirmBtn.addEventListener('click', confirmHold);
els.releaseBtn.addEventListener('click', releaseHold);
els.refreshBtn.addEventListener('click', () => loadSeats().then(() => setMessage('Seat map refreshed.')).catch((err) => setMessage(err.message, 'error')));

loadSeats().then(() => {
  setMessage('Select one or more available seats.');
  connectStream();
}).catch((err) => setMessage(err.message, 'error'));
