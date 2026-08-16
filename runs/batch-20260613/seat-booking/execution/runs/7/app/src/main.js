import './styles.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3000';
const state = {
  seats: new Map(),
  selected: new Set(),
  currentHold: JSON.parse(localStorage.getItem('currentHold') || 'null'),
  sessionId: localStorage.getItem('sessionId') || crypto.randomUUID()
};
localStorage.setItem('sessionId', state.sessionId);

const els = {
  sessionId: document.querySelector('#sessionId'),
  inventory: document.querySelector('#inventory'),
  holdButton: document.querySelector('#holdButton'),
  confirmButton: document.querySelector('#confirmButton'),
  releaseButton: document.querySelector('#releaseButton'),
  holdPanel: document.querySelector('#holdPanel'),
  holdInfo: document.querySelector('#holdInfo'),
  countdown: document.querySelector('#countdown'),
  seatMap: document.querySelector('#seatMap'),
  message: document.querySelector('#message')
};

els.sessionId.textContent = state.sessionId.slice(0, 8);

function setMessage(text, type = '') {
  els.message.textContent = text;
  els.message.className = `message ${type}`.trim();
}

async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data.error || `Request failed (${response.status})`);
    err.status = response.status;
    err.data = data;
    throw err;
  }
  return data;
}

function upsertSeats(seats) {
  for (const seat of seats) state.seats.set(seat.id, seat);
}

function seatClass(seat) {
  const ours = state.currentHold && seat.holdId === state.currentHold.id && seat.status === 'held';
  return [
    'seat',
    seat.status,
    state.selected.has(seat.id) ? 'selected' : '',
    ours ? 'mine' : ''
  ].filter(Boolean).join(' ');
}

function render() {
  const seats = [...state.seats.values()].sort((a, b) => a.rowLabel.localeCompare(b.rowLabel) || a.seatNumber - b.seatNumber);
  const counts = seats.reduce((acc, seat) => {
    acc[seat.status] = (acc[seat.status] || 0) + 1;
    return acc;
  }, { available: 0, held: 0, booked: 0 });
  els.inventory.textContent = `Total ${seats.length} • Available ${counts.available || 0} • Held ${counts.held || 0} • Booked ${counts.booked || 0}`;

  const rows = Map.groupBy ? Map.groupBy(seats, (s) => s.rowLabel) : groupByRow(seats);
  els.seatMap.innerHTML = '';
  for (const [row, rowSeats] of rows) {
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';
    const label = document.createElement('div');
    label.className = 'row-label';
    label.textContent = row;
    rowEl.append(label);
    for (const seat of rowSeats) {
      const button = document.createElement('button');
      button.className = seatClass(seat);
      button.textContent = seat.seatNumber;
      button.title = `${seat.id}: ${seat.status}`;
      button.disabled = seat.status !== 'available' && !state.selected.has(seat.id);
      button.addEventListener('click', () => toggleSeat(seat.id));
      rowEl.append(button);
    }
    els.seatMap.append(rowEl);
  }

  const active = getActiveHold();
  els.holdButton.disabled = state.selected.size === 0 || Boolean(active);
  els.confirmButton.disabled = !active;
  els.releaseButton.disabled = !active;
  els.holdPanel.hidden = !active;
  if (active) {
    els.holdInfo.textContent = `${active.seatIds.join(', ')} `;
  }
}

function groupByRow(seats) {
  const rows = new Map();
  for (const seat of seats) {
    if (!rows.has(seat.rowLabel)) rows.set(seat.rowLabel, []);
    rows.get(seat.rowLabel).push(seat);
  }
  return rows;
}

function toggleSeat(id) {
  const seat = state.seats.get(id);
  if (!seat || seat.status !== 'available') return;
  state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id);
  render();
}

function getActiveHold() {
  if (!state.currentHold) return null;
  if (new Date(state.currentHold.expiresAt).getTime() <= Date.now()) {
    state.currentHold = null;
    localStorage.removeItem('currentHold');
    return null;
  }
  return state.currentHold;
}

async function loadSeats() {
  const data = await api('/api/seats');
  upsertSeats(data.seats);
  render();
}

async function createHold() {
  try {
    const seatIds = [...state.selected];
    const data = await api('/api/holds', {
      method: 'POST',
      body: JSON.stringify({ seatIds, sessionId: state.sessionId })
    });
    state.currentHold = data.hold;
    localStorage.setItem('currentHold', JSON.stringify(state.currentHold));
    state.selected.clear();
    upsertSeats(data.seats);
    setMessage(`Held ${data.hold.seatIds.length} seat(s). Confirm before the timer expires.`, 'success');
    render();
  } catch (err) {
    if (err.status === 409) {
      setMessage(`Hold failed. Taken seats: ${(err.data.conflictingSeatIds || []).join(', ')}`, 'error');
      state.selected.clear();
      await loadSeats();
    } else {
      setMessage(err.message, 'error');
    }
  }
}

async function confirmHold() {
  const hold = getActiveHold();
  if (!hold) return;
  try {
    const data = await api(`/api/holds/${hold.id}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ sessionId: state.sessionId })
    });
    upsertSeats(data.seats);
    state.currentHold = null;
    localStorage.removeItem('currentHold');
    setMessage(`Booking confirmed: ${data.booking.id.slice(0, 8)}`, 'success');
    render();
  } catch (err) {
    state.currentHold = null;
    localStorage.removeItem('currentHold');
    setMessage(err.message, 'error');
    await loadSeats();
  }
}

async function releaseHold() {
  const hold = state.currentHold;
  if (!hold) return;
  try {
    const data = await api(`/api/holds/${hold.id}`, {
      method: 'DELETE',
      body: JSON.stringify({ sessionId: state.sessionId })
    });
    upsertSeats(data.seats || []);
    setMessage('Hold released.', 'success');
  } catch (err) {
    setMessage(err.message, 'error');
  } finally {
    state.currentHold = null;
    localStorage.removeItem('currentHold');
    render();
  }
}

function connectStream() {
  const stream = new EventSource(`${API_BASE}/api/stream`);
  stream.addEventListener('seats', (event) => {
    const data = JSON.parse(event.data);
    upsertSeats(data.seats || []);
    for (const seat of data.seats || []) {
      if (seat.status !== 'available') state.selected.delete(seat.id);
    }
    if (state.currentHold && data.seats?.some((s) => state.currentHold.seatIds.includes(s.id) && s.holdId !== state.currentHold.id && s.status !== 'held')) {
      state.currentHold = null;
      localStorage.removeItem('currentHold');
    }
    render();
  });
  stream.onerror = () => setMessage('Live connection interrupted; retrying automatically…', 'warn');
  stream.addEventListener('hello', () => setMessage('Live seat updates connected.', 'success'));
}

function updateCountdown() {
  const hold = getActiveHold();
  if (!hold) {
    els.countdown.textContent = '';
    render();
    return;
  }
  const remaining = Math.max(0, new Date(hold.expiresAt).getTime() - Date.now());
  els.countdown.textContent = `Expires in ${Math.ceil(remaining / 1000)}s`;
  if (remaining <= 0) {
    setMessage('Your hold expired and seats will be released.', 'warn');
    loadSeats().catch(() => {});
  }
}

els.holdButton.addEventListener('click', createHold);
els.confirmButton.addEventListener('click', confirmHold);
els.releaseButton.addEventListener('click', releaseHold);

loadSeats().catch((err) => setMessage(err.message, 'error'));
connectStream();
setInterval(updateCountdown, 500);
