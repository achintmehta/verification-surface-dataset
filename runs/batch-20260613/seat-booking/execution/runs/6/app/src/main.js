import './styles.css';

const API_BASE = import.meta.env.VITE_API_BASE || '';
const STORAGE_KEY = 'seat-booking-session-id';

const state = {
  seats: [],
  inventory: null,
  selected: new Set(),
  hold: null,
  eventSource: null,
};

const els = {
  sessionId: document.querySelector('#sessionId'),
  inventory: document.querySelector('#inventory'),
  grid: document.querySelector('#seatGrid'),
  message: document.querySelector('#message'),
  holdBtn: document.querySelector('#holdBtn'),
  confirmBtn: document.querySelector('#confirmBtn'),
  releaseBtn: document.querySelector('#releaseBtn'),
  refreshBtn: document.querySelector('#refreshBtn'),
  holdPanel: document.querySelector('#holdPanel'),
  holdDetails: document.querySelector('#holdDetails'),
};

function getSessionId() {
  let id = localStorage.getItem(STORAGE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(STORAGE_KEY, id);
  }
  return id;
}

const sessionId = getSessionId();
els.sessionId.textContent = sessionId.slice(0, 8);
els.sessionId.title = sessionId;

async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status})`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function setMessage(text, type = '') {
  els.message.textContent = text || '';
  els.message.className = `message ${type}`.trim();
}

function remainingSeconds(iso) {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 1000));
}

function updateInventory() {
  if (!state.inventory) {
    els.inventory.textContent = '';
    return;
  }
  const { total, available, held, booked } = state.inventory;
  els.inventory.innerHTML = `
    <span>Total <b>${total}</b></span>
    <span>Available <b>${available}</b></span>
    <span>Held <b>${held}</b></span>
    <span>Booked <b>${booked}</b></span>
  `;
}

function seatClass(seat) {
  const classes = ['seat', seat.status];
  if (state.selected.has(seat.id)) classes.push('selected');
  if (state.hold?.holdId && seat.holdId === state.hold.holdId) classes.push('mine');
  return classes.join(' ');
}

function renderGrid() {
  const byRow = new Map();
  for (const seat of state.seats) {
    if (!byRow.has(seat.rowLabel)) byRow.set(seat.rowLabel, []);
    byRow.get(seat.rowLabel).push(seat);
  }

  els.grid.innerHTML = '';
  for (const [row, seats] of byRow.entries()) {
    const label = document.createElement('div');
    label.className = 'row-label';
    label.textContent = row;
    els.grid.append(label);

    for (const seat of seats) {
      const button = document.createElement('button');
      button.className = seatClass(seat);
      button.textContent = seat.seatNumber;
      button.title = `${seat.id}: ${seat.status}`;
      button.disabled = seat.status !== 'available' && !state.selected.has(seat.id);
      button.addEventListener('click', () => toggleSeat(seat.id));
      els.grid.append(button);
    }
  }
  updateButtons();
}

function updateHoldPanel() {
  if (!state.hold) {
    els.holdPanel.classList.add('hidden');
    els.holdDetails.textContent = '';
    return;
  }
  const secs = remainingSeconds(state.hold.expiresAt);
  els.holdPanel.classList.toggle('hidden', false);
  els.holdDetails.textContent = `${state.hold.seats.map((s) => s.id).join(', ')} — expires in ${secs}s`;
  if (secs <= 0) {
    state.hold = null;
    setMessage('Your hold expired; seats have been released.', 'warning');
    refresh();
  }
  updateButtons();
}

function updateButtons() {
  els.holdBtn.disabled = state.selected.size === 0 || Boolean(state.hold);
  els.confirmBtn.disabled = !state.hold;
  els.releaseBtn.disabled = !state.hold;
}

function toggleSeat(id) {
  const seat = state.seats.find((s) => s.id === id);
  if (!seat || seat.status !== 'available') return;
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  renderGrid();
}

function applySeats(updated) {
  const map = new Map(state.seats.map((seat) => [seat.id, seat]));
  for (const seat of updated) {
    map.set(seat.id, seat);
    if (seat.status !== 'available') state.selected.delete(seat.id);
  }
  state.seats = [...map.values()].sort((a, b) => a.rowLabel.localeCompare(b.rowLabel) || a.seatNumber - b.seatNumber);

  if (state.hold) {
    const stillHeld = state.hold.seats.every((heldSeat) => {
      const current = map.get(heldSeat.id);
      return current?.holdId === state.hold.holdId && current?.status === 'held';
    });
    const booked = state.hold.seats.every((heldSeat) => map.get(heldSeat.id)?.bookedHoldId === state.hold.holdId);
    if (!stillHeld && !booked) state.hold = null;
  }

  renderGrid();
  updateHoldPanel();
}

async function refresh() {
  const data = await api('/api/seats');
  state.seats = data.seats;
  state.inventory = data.inventory;
  for (const id of [...state.selected]) {
    if (state.seats.find((s) => s.id === id)?.status !== 'available') state.selected.delete(id);
  }
  updateInventory();
  renderGrid();
  updateHoldPanel();
}

async function holdSelected() {
  const seatIds = [...state.selected];
  try {
    const hold = await api('/api/holds', {
      method: 'POST',
      body: JSON.stringify({ seatIds, sessionId }),
    });
    state.hold = hold;
    state.selected.clear();
    state.inventory = hold.inventory;
    applySeats(hold.seats);
    updateInventory();
    setMessage(`Held ${hold.seats.length} seat(s). Confirm before the timer expires.`, 'success');
  } catch (error) {
    if (error.status === 409) {
      const ids = error.data?.conflictingSeatIds?.join(', ') || 'selected seats';
      setMessage(`Hold failed: ${ids} already unavailable.`, 'error');
      await refresh();
    } else {
      setMessage(error.message, 'error');
    }
  }
}

async function confirmCurrentHold() {
  if (!state.hold) return;
  try {
    const result = await api(`/api/holds/${state.hold.holdId}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    });
    state.hold = null;
    state.inventory = result.inventory;
    applySeats(result.seats);
    updateInventory();
    setMessage(`Booked ${result.seats.length} seat(s).`, 'success');
  } catch (error) {
    setMessage(error.message, 'error');
    state.hold = null;
    await refresh();
  }
}

async function releaseCurrentHold() {
  if (!state.hold) return;
  const holdId = state.hold.holdId;
  try {
    const result = await api(`/api/holds/${holdId}`, {
      method: 'DELETE',
      body: JSON.stringify({ sessionId }),
    });
    state.hold = null;
    state.inventory = result.inventory;
    applySeats(result.seats);
    updateInventory();
    setMessage('Hold released.', 'success');
  } catch (error) {
    setMessage(error.message, 'error');
    await refresh();
  }
}

function connectStream() {
  const source = new EventSource(`${API_BASE}/api/stream`);
  state.eventSource = source;

  source.addEventListener('snapshot', (event) => {
    const data = JSON.parse(event.data);
    state.seats = data.seats;
    state.inventory = data.inventory;
    updateInventory();
    renderGrid();
    updateHoldPanel();
  });

  source.addEventListener('seats', (event) => {
    const data = JSON.parse(event.data);
    if (data.inventory) {
      state.inventory = data.inventory;
      updateInventory();
    }
    applySeats(data.seats || []);
  });

  source.onerror = () => {
    setMessage('Live connection interrupted. Browser will retry automatically.', 'warning');
  };
}

els.holdBtn.addEventListener('click', holdSelected);
els.confirmBtn.addEventListener('click', confirmCurrentHold);
els.releaseBtn.addEventListener('click', releaseCurrentHold);
els.refreshBtn.addEventListener('click', () => refresh().catch((e) => setMessage(e.message, 'error')));

setInterval(updateHoldPanel, 1000);

refresh()
  .then(connectStream)
  .catch((error) => setMessage(error.message, 'error'));
