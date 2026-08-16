const API = window.location.origin;
const SESSION_KEY = 'seat-booking-session-id';
const sessionId = localStorage.getItem(SESSION_KEY) || crypto.randomUUID();
localStorage.setItem(SESSION_KEY, sessionId);

document.getElementById('sessionId').textContent = sessionId;

const state = {
  seats: new Map(),
  selected: new Set(),
  currentHold: null,
  holdTimer: null,
  conflicts: new Set()
};

const grid = document.getElementById('seatGrid');
const inventoryEl = document.getElementById('inventory');
const messageEl = document.getElementById('message');
const holdInfoEl = document.getElementById('holdInfo');
const holdBtn = document.getElementById('holdBtn');
const confirmBtn = document.getElementById('confirmBtn');
const releaseBtn = document.getElementById('releaseBtn');
const refreshBtn = document.getElementById('refreshBtn');

function showMessage(text, kind = '') {
  messageEl.textContent = text;
  messageEl.className = `message ${kind}`.trim();
}

function groupByRow(seats) {
  return seats.reduce((rows, seat) => {
    const row = seat.rowLabel;
    if (!rows[row]) rows[row] = [];
    rows[row].push(seat);
    return rows;
  }, {});
}

function updateInventory() {
  const counts = { available: 0, held: 0, booked: 0, total: state.seats.size };
  for (const seat of state.seats.values()) counts[seat.status]++;
  inventoryEl.textContent = `Available ${counts.available} · Held ${counts.held} · Booked ${counts.booked} · Total ${counts.total}`;
}

function render() {
  const seats = [...state.seats.values()].sort((a, b) => a.rowLabel.localeCompare(b.rowLabel) || a.seatNumber - b.seatNumber);
  const rows = groupByRow(seats);
  grid.innerHTML = '';
  for (const rowLabel of Object.keys(rows).sort()) {
    const rowEl = document.createElement('div');
    rowEl.className = 'row';
    const label = document.createElement('div');
    label.className = 'row-label';
    label.textContent = rowLabel;
    rowEl.appendChild(label);

    for (const seat of rows[rowLabel]) {
      const button = document.createElement('button');
      const isSelected = state.selected.has(seat.id);
      button.className = `seat ${isSelected ? 'selected' : seat.status}`;
      button.textContent = seat.seatNumber;
      button.title = `${seat.id}: ${seat.status}`;
      button.disabled = seat.status !== 'available' && !isSelected;
      if (state.conflicts.has(seat.id)) button.style.outline = '3px solid #ef4444';
      button.addEventListener('click', () => toggleSeat(seat.id));
      rowEl.appendChild(button);
    }
    grid.appendChild(rowEl);
  }
  updateInventory();
  holdBtn.disabled = state.selected.size === 0 || Boolean(state.currentHold);
  confirmBtn.disabled = !state.currentHold;
  releaseBtn.disabled = !state.currentHold;
}

function toggleSeat(id) {
  const seat = state.seats.get(id);
  if (!seat || (seat.status !== 'available' && !state.selected.has(id)) || state.currentHold) return;
  state.conflicts.clear();
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  render();
}

async function loadSeats() {
  const res = await fetch(`${API}/api/seats`);
  if (!res.ok) throw new Error('Failed to load seats');
  const data = await res.json();
  state.seats.clear();
  for (const seat of data.seats) state.seats.set(seat.id, seat);
  for (const id of [...state.selected]) {
    if (state.seats.get(id)?.status !== 'available') state.selected.delete(id);
  }
  render();
}

function setCurrentHold(hold) {
  state.currentHold = hold;
  state.selected.clear();
  if (state.holdTimer) clearInterval(state.holdTimer);
  if (!hold) {
    holdInfoEl.textContent = 'No active hold.';
    render();
    return;
  }
  const tick = () => {
    const remaining = Math.max(0, new Date(hold.expiresAt).getTime() - Date.now());
    holdInfoEl.textContent = `Hold ${hold.id.slice(0, 8)} expires in ${Math.ceil(remaining / 1000)}s for seats ${hold.seats.map((s) => s.id).join(', ')}`;
    if (remaining <= 0) {
      clearInterval(state.holdTimer);
      state.holdTimer = null;
      state.currentHold = null;
      holdInfoEl.textContent = 'Hold expired.';
      loadSeats().catch(console.error);
    }
    render();
  };
  tick();
  state.holdTimer = setInterval(tick, 500);
}

holdBtn.addEventListener('click', async () => {
  try {
    showMessage('Requesting hold…');
    state.conflicts.clear();
    const res = await fetch(`${API}/api/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds: [...state.selected], sessionId })
    });
    if (res.status === 409) {
      const data = await res.json();
      state.conflicts = new Set((data.conflicts || []).map((c) => c.id));
      showMessage(`Some seats are unavailable: ${[...state.conflicts].join(', ')}`, 'error');
      await loadSeats();
      return;
    }
    if (!res.ok) throw new Error((await res.json()).error || 'Hold failed');
    const hold = await res.json();
    for (const seat of hold.seats) state.seats.set(seat.id, seat);
    setCurrentHold(hold);
    showMessage('Seats held. Confirm before the timer expires.', 'success');
  } catch (err) {
    showMessage(err.message, 'error');
  }
});

confirmBtn.addEventListener('click', async () => {
  if (!state.currentHold) return;
  try {
    showMessage('Confirming booking…');
    const res = await fetch(`${API}/api/holds/${state.currentHold.id}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Confirmation failed');
    for (const seat of data.seats) state.seats.set(seat.id, seat);
    setCurrentHold(null);
    showMessage(`Booked seats ${data.seats.map((s) => s.id).join(', ')}.`, 'success');
  } catch (err) {
    setCurrentHold(null);
    await loadSeats().catch(console.error);
    showMessage(err.message, 'error');
  }
});

releaseBtn.addEventListener('click', async () => {
  if (!state.currentHold) return;
  try {
    const holdId = state.currentHold.id;
    await fetch(`${API}/api/holds/${holdId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    });
    setCurrentHold(null);
    await loadSeats();
    showMessage('Hold released.', 'success');
  } catch (err) {
    showMessage(err.message, 'error');
  }
});

refreshBtn.addEventListener('click', () => loadSeats().catch((err) => showMessage(err.message, 'error')));

function connectStream() {
  const source = new EventSource(`${API}/api/stream`);
  source.addEventListener('seats', (event) => {
    const msg = JSON.parse(event.data);
    for (const seat of msg.seats || []) {
      const existing = state.seats.get(seat.id) || {};
      state.seats.set(seat.id, { ...existing, ...seat });
      if (seat.status !== 'available') state.selected.delete(seat.id);
    }
    if (state.currentHold && msg.type === 'released' && (msg.seats || []).some((s) => s.holdId === state.currentHold.id)) {
      setCurrentHold(null);
      showMessage('Your hold was released or expired.', 'error');
    }
    render();
  });
  source.onerror = () => showMessage('Live connection interrupted; retrying…', 'error');
}

loadSeats().then(connectStream).catch((err) => showMessage(err.message, 'error'));
