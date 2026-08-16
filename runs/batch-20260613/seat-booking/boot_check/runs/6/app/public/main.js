const API = '';
const SESSION_KEY = 'seat-booking-session-id';
let sessionId = localStorage.getItem(SESSION_KEY);
if (!sessionId) {
  sessionId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  localStorage.setItem(SESSION_KEY, sessionId);
}

const state = {
  seats: new Map(),
  selected: new Set(),
  currentHold: null,
  inventory: { available: 0, held: 0, booked: 0, total: 0 },
  message: '',
  conflicts: new Set(),
};

const app = document.querySelector('#app');
app.innerHTML = `
  <header>
    <h1>Seat Booking</h1>
    <p class="muted">Session <code>${sessionId}</code></p>
  </header>
  <section class="panel controls">
    <button id="holdBtn">Hold selected seats</button>
    <button id="confirmBtn" disabled>Confirm hold</button>
    <button id="releaseBtn" disabled>Release hold</button>
    <span id="countdown"></span>
  </section>
  <section class="panel">
    <div id="inventory"></div>
    <div class="legend">
      <span><i class="swatch available"></i> available</span>
      <span><i class="swatch selected"></i> selected</span>
      <span><i class="swatch held"></i> held</span>
      <span><i class="swatch mine"></i> my hold</span>
      <span><i class="swatch booked"></i> booked</span>
    </div>
  </section>
  <main id="grid" class="grid"></main>
  <p id="message" role="status"></p>
`;

const grid = document.querySelector('#grid');
const messageEl = document.querySelector('#message');
const inventoryEl = document.querySelector('#inventory');
const holdBtn = document.querySelector('#holdBtn');
const confirmBtn = document.querySelector('#confirmBtn');
const releaseBtn = document.querySelector('#releaseBtn');
const countdownEl = document.querySelector('#countdown');

function seatClass(seat) {
  const classes = ['seat', seat.status];
  if (state.selected.has(seat.id)) classes.push('selected');
  if (state.currentHold?.holdId && seat.holdId === state.currentHold.holdId) classes.push('mine');
  if (state.conflicts.has(seat.id)) classes.push('conflict');
  return classes.join(' ');
}
function recomputeInventory() {
  const inv = { available: 0, held: 0, booked: 0, total: 0 };
  for (const seat of state.seats.values()) { inv[seat.status] += 1; inv.total += 1; }
  state.inventory = inv;
}
function render() {
  recomputeInventory();
  inventoryEl.textContent = `Available: ${state.inventory.available} · Held: ${state.inventory.held} · Booked: ${state.inventory.booked} · Total: ${state.inventory.total}`;
  messageEl.textContent = state.message;
  const rows = [...state.seats.values()].reduce((acc, seat) => { (acc[seat.rowLabel] ||= []).push(seat); return acc; }, {});
  grid.innerHTML = '';
  for (const row of Object.keys(rows).sort()) {
    const label = document.createElement('div');
    label.className = 'row-label';
    label.textContent = row;
    grid.append(label);
    for (const seat of rows[row].sort((a, b) => a.seatNumber - b.seatNumber)) {
      const btn = document.createElement('button');
      btn.className = seatClass(seat);
      btn.textContent = seat.seatNumber;
      btn.title = `${seat.id}: ${seat.status}`;
      btn.disabled = seat.status !== 'available' && !state.selected.has(seat.id);
      btn.addEventListener('click', () => toggleSeat(seat.id));
      grid.append(btn);
    }
  }
  holdBtn.disabled = state.selected.size === 0 || Boolean(state.currentHold);
  confirmBtn.disabled = !state.currentHold;
  releaseBtn.disabled = !state.currentHold;
}
function toggleSeat(id) {
  const seat = state.seats.get(id);
  if (!seat || seat.status !== 'available') return;
  state.conflicts.delete(id);
  if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
  render();
}
async function fetchJson(url, options) {
  const response = await fetch(`${API}${url}`, { headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data.error || response.statusText); error.status = response.status; error.data = data; throw error; }
  return data;
}
async function loadSeats() {
  const data = await fetchJson('/api/seats');
  state.seats = new Map(data.seats.map((seat) => [seat.id, seat]));
  state.inventory = data.inventory;
  for (const id of [...state.selected]) if (state.seats.get(id)?.status !== 'available') state.selected.delete(id);
  render();
}
holdBtn.addEventListener('click', async () => {
  try {
    state.message = 'Requesting hold…'; render();
    const data = await fetchJson('/api/holds', { method: 'POST', body: JSON.stringify({ seatIds: [...state.selected], sessionId }) });
    state.currentHold = data.hold; state.selected.clear(); state.conflicts.clear();
    for (const seat of data.seats) state.seats.set(seat.id, { ...(state.seats.get(seat.id) || {}), ...seat });
    state.message = `Held ${data.hold.seatIds.length} seat(s). Confirm before expiry.`; render();
  } catch (err) {
    if (err.status === 409) { state.conflicts = new Set((err.data.conflicts || []).map((c) => c.id)); state.message = `Hold failed: ${[...state.conflicts].join(', ')} unavailable.`; await loadSeats(); }
    else { state.message = err.message; render(); }
  }
});
confirmBtn.addEventListener('click', async () => {
  if (!state.currentHold) return;
  try {
    const data = await fetchJson(`/api/holds/${state.currentHold.holdId}/confirm`, { method: 'POST', body: JSON.stringify({ sessionId }) });
    for (const seat of data.seats) state.seats.set(seat.id, { ...(state.seats.get(seat.id) || {}), ...seat });
    state.message = data.idempotent ? 'Booking was already confirmed.' : 'Booked successfully!'; state.currentHold = null; render();
  } catch (err) { state.message = `Confirm failed: ${err.message}`; state.currentHold = null; await loadSeats(); }
});
releaseBtn.addEventListener('click', async () => {
  if (!state.currentHold) return;
  try { await fetchJson(`/api/holds/${state.currentHold.holdId}`, { method: 'DELETE', body: JSON.stringify({ sessionId }) }); state.message = 'Hold released.'; state.currentHold = null; await loadSeats(); }
  catch (err) { state.message = err.message; render(); }
});
function applySeatUpdates(seats) {
  for (const update of seats || []) { const prev = state.seats.get(update.id) || {}; state.seats.set(update.id, { ...prev, ...update }); if (update.status !== 'available') state.selected.delete(update.id); }
  if (state.currentHold) {
    const ours = state.currentHold.seatIds.map((id) => state.seats.get(id));
    const expires = new Date(state.currentHold.expiresAt).getTime();
    if (Date.now() > expires || ours.some((s) => !s || s.status !== 'held' || s.holdId !== state.currentHold.holdId)) { state.currentHold = null; state.message ||= 'Your hold is no longer active.'; }
  }
  render();
}
function connectStream() {
  const es = new EventSource(`${API}/api/stream`);
  es.addEventListener('snapshot', (event) => { const data = JSON.parse(event.data); state.seats = new Map(data.seats.map((seat) => [seat.id, seat])); render(); });
  es.addEventListener('seats', (event) => { const data = JSON.parse(event.data); applySeatUpdates(data.seats); });
  es.onerror = () => { state.message = 'Live connection interrupted; reconnecting automatically…'; render(); };
}
setInterval(() => {
  if (!state.currentHold) { countdownEl.textContent = ''; return; }
  const ms = new Date(state.currentHold.expiresAt).getTime() - Date.now();
  if (ms <= 0) { countdownEl.textContent = 'Hold expired'; state.currentHold = null; loadSeats().catch(() => {}); }
  else countdownEl.textContent = `Hold expires in ${Math.ceil(ms / 1000)}s`;
}, 1000);
loadSeats().catch((err) => { state.message = `Failed to load seats: ${err.message}`; render(); });
connectStream();
