const API_BASE = import.meta.env.VITE_API_BASE || (location.port === '5173' ? 'http://localhost:3001' : '');

const state = {
  seats: new Map(),
  selected: new Set(),
  currentHold: null,
  countdownTimer: null,
  sessionId: getSessionId(),
};

const seatMap = document.querySelector('#seatMap');
const stats = document.querySelector('#stats');
const messages = document.querySelector('#messages');
const holdBtn = document.querySelector('#holdBtn');
const confirmBtn = document.querySelector('#confirmBtn');
const releaseBtn = document.querySelector('#releaseBtn');
const refreshBtn = document.querySelector('#refreshBtn');
const currentHold = document.querySelector('#currentHold');
document.querySelector('#sessionId').textContent = state.sessionId;

function getSessionId() {
  const key = 'seat-booking-session-id';
  let value = localStorage.getItem(key);
  if (!value) {
    value = crypto.randomUUID ? crypto.randomUUID() : `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    localStorage.setItem(key, value);
  }
  return value;
}

async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data.error || `HTTP ${response.status}`);
    err.status = response.status;
    err.data = data;
    throw err;
  }
  return data;
}

function showMessage(text, kind = 'info') {
  const div = document.createElement('div');
  div.className = `message ${kind}`;
  div.textContent = text;
  messages.prepend(div);
  setTimeout(() => div.remove(), 7000);
}

function mergeSeats(seats) {
  for (const seat of seats || []) {
    const existing = state.seats.get(seat.id) || {};
    state.seats.set(seat.id, { ...existing, ...seat });
    if (seat.status !== 'available') state.selected.delete(seat.id);
  }
  if (state.currentHold) {
    const stillHeld = state.currentHold.seatIds.every((id) => {
      const seat = state.seats.get(id);
      return seat && (seat.status === 'held' || seat.status === 'booked');
    });
    if (!stillHeld) clearCurrentHold('Your hold was released or expired.');
  }
  render();
}

function seatSort(a, b) {
  if (a.rowLabel !== b.rowLabel) return a.rowLabel.localeCompare(b.rowLabel);
  return a.seatNumber - b.seatNumber;
}

function render() {
  const seats = [...state.seats.values()].sort(seatSort);
  const inventory = seats.reduce((acc, seat) => {
    acc.total += 1;
    acc[seat.status] = (acc[seat.status] || 0) + 1;
    return acc;
  }, { total: 0, available: 0, held: 0, booked: 0 });
  stats.textContent = `Available ${inventory.available} · Held ${inventory.held} · Booked ${inventory.booked} · Total ${inventory.total}`;

  const grouped = Map.groupBy ? Map.groupBy(seats, (s) => s.rowLabel) : groupByRow(seats);
  seatMap.innerHTML = '';
  for (const [rowLabel, rowSeats] of grouped) {
    const row = document.createElement('div');
    row.className = 'seat-row';
    const label = document.createElement('div');
    label.className = 'row-label';
    label.textContent = rowLabel;
    row.append(label);
    for (const seat of rowSeats) {
      const button = document.createElement('button');
      const isOwnHold = state.currentHold?.seatIds.includes(seat.id) && seat.status === 'held';
      const isSelected = state.selected.has(seat.id);
      button.className = `seat ${seat.status}${isSelected ? ' selected' : ''}${isOwnHold ? ' own-held' : ''}`;
      button.textContent = seat.seatNumber;
      button.title = `${seat.id}: ${seat.status}`;
      button.disabled = seat.status !== 'available' && !isSelected;
      button.addEventListener('click', () => toggleSeat(seat.id));
      row.append(button);
    }
    seatMap.append(row);
  }

  holdBtn.disabled = state.selected.size === 0 || Boolean(state.currentHold);
  confirmBtn.disabled = !state.currentHold;
  releaseBtn.disabled = !state.currentHold;
  renderHoldPanel();
}

function groupByRow(seats) {
  const map = new Map();
  for (const seat of seats) {
    if (!map.has(seat.rowLabel)) map.set(seat.rowLabel, []);
    map.get(seat.rowLabel).push(seat);
  }
  return map;
}

function toggleSeat(id) {
  const seat = state.seats.get(id);
  if (!seat || seat.status !== 'available') return;
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  render();
}

function setCurrentHold(hold) {
  state.currentHold = hold;
  state.selected.clear();
  startCountdown();
  render();
}

function clearCurrentHold(message) {
  state.currentHold = null;
  if (state.countdownTimer) clearInterval(state.countdownTimer);
  state.countdownTimer = null;
  if (message) showMessage(message, 'warn');
  render();
}

function renderHoldPanel() {
  if (!state.currentHold) {
    currentHold.classList.add('hidden');
    currentHold.textContent = '';
    return;
  }
  const ms = new Date(state.currentHold.expiresAt).getTime() - Date.now();
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  currentHold.classList.remove('hidden');
  currentHold.innerHTML = `<strong>Current hold:</strong> ${state.currentHold.seatIds.join(', ')} · expires in <strong>${seconds}s</strong>`;
  if (seconds <= 0) {
    clearCurrentHold('Your hold expired.');
    loadSeats();
  }
}

function startCountdown() {
  if (state.countdownTimer) clearInterval(state.countdownTimer);
  state.countdownTimer = setInterval(renderHoldPanel, 250);
}

async function loadSeats() {
  const data = await api('/api/seats');
  state.seats.clear();
  mergeSeats(data.seats);
}

async function holdSelected() {
  try {
    const seatIds = [...state.selected];
    const data = await api('/api/holds', {
      method: 'POST',
      body: JSON.stringify({ seatIds, sessionId: state.sessionId }),
    });
    mergeSeats(data.seats);
    setCurrentHold(data.hold);
    showMessage(`Held ${data.hold.seatIds.join(', ')}. Confirm before the timer expires.`, 'success');
  } catch (err) {
    if (err.status === 409) {
      showMessage(`Hold failed. Seats taken: ${(err.data.conflictingSeatIds || []).join(', ')}`, 'error');
      state.selected.clear();
      await loadSeats();
    } else {
      showMessage(err.message, 'error');
    }
  }
}

async function confirmHold() {
  if (!state.currentHold) return;
  try {
    const data = await api(`/api/holds/${state.currentHold.id}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ sessionId: state.sessionId }),
    });
    mergeSeats(data.seats);
    const seats = data.booking?.seatIds?.join(', ') || '';
    clearCurrentHold();
    showMessage(`Booked ${seats}.`, 'success');
  } catch (err) {
    showMessage(err.message, 'error');
    clearCurrentHold();
    await loadSeats();
  }
}

async function releaseHold() {
  if (!state.currentHold) return;
  try {
    await api(`/api/holds/${state.currentHold.id}`, {
      method: 'DELETE',
      body: JSON.stringify({ sessionId: state.sessionId }),
    });
    clearCurrentHold('Hold released.');
    await loadSeats();
  } catch (err) {
    showMessage(err.message, 'error');
  }
}

function connectStream() {
  const source = new EventSource(`${API_BASE}/api/stream`);
  source.addEventListener('seats', (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'snapshot') {
      state.seats.clear();
    }
    mergeSeats(data.seats);
  });
  source.onerror = () => showMessage('Live connection interrupted; EventSource will retry.', 'warn');
}

holdBtn.addEventListener('click', holdSelected);
confirmBtn.addEventListener('click', confirmHold);
releaseBtn.addEventListener('click', releaseHold);
refreshBtn.addEventListener('click', loadSeats);

loadSeats().catch((err) => showMessage(err.message, 'error'));
connectStream();
