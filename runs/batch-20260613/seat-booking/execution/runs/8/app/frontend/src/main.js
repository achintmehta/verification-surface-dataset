import './styles.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3000';

const state = {
  seats: new Map(),
  selected: new Set(),
  currentHold: loadHold(),
  sessionId: loadSessionId(),
  timer: null,
};

const els = {
  seatMap: document.querySelector('#seatMap'),
  sessionId: document.querySelector('#sessionId'),
  inventory: document.querySelector('#inventory'),
  notice: document.querySelector('#notice'),
  selectedSeats: document.querySelector('#selectedSeats'),
  holdInfo: document.querySelector('#holdInfo'),
  holdButton: document.querySelector('#holdButton'),
  confirmButton: document.querySelector('#confirmButton'),
  releaseButton: document.querySelector('#releaseButton'),
  refreshButton: document.querySelector('#refreshButton'),
};

function loadSessionId() {
  let id = localStorage.getItem('seat-booking-session-id');
  if (!id) {
    id = `guest-${crypto.randomUUID().slice(0, 8)}`;
    localStorage.setItem('seat-booking-session-id', id);
  }
  return id;
}

function loadHold() {
  try {
    const raw = localStorage.getItem('seat-booking-current-hold');
    if (!raw) return null;
    const hold = JSON.parse(raw);
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
  state.currentHold = hold;
  if (hold) localStorage.setItem('seat-booking-current-hold', JSON.stringify(hold));
  else localStorage.removeItem('seat-booking-current-hold');
  renderHoldInfo();
}

async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(body.error || response.statusText);
    err.status = response.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function loadSeats() {
  const data = await api('/api/seats');
  state.seats = new Map(data.seats.map((seat) => [seat.id, seat]));
  cleanupSelection();
  render();
}

function cleanupSelection() {
  for (const id of [...state.selected]) {
    const seat = state.seats.get(id);
    if (!seat || seat.status !== 'available') state.selected.delete(id);
  }
}

function isMyHoldSeat(seat) {
  return state.currentHold?.id && seat.holdId === state.currentHold.id;
}

function render() {
  renderSeatMap();
  renderInventory();
  renderSelected();
  renderHoldInfo();
}

function renderSeatMap() {
  const seats = [...state.seats.values()];
  const rows = new Map();
  for (const seat of seats) {
    if (!rows.has(seat.rowLabel)) rows.set(seat.rowLabel, []);
    rows.get(seat.rowLabel).push(seat);
  }

  els.seatMap.innerHTML = '';
  for (const [rowLabel, rowSeats] of rows) {
    rowSeats.sort((a, b) => a.seatNumber - b.seatNumber);
    const row = document.createElement('div');
    row.className = 'seat-row';
    const label = document.createElement('div');
    label.className = 'row-label';
    label.textContent = rowLabel;
    row.append(label);

    for (const seat of rowSeats) {
      const button = document.createElement('button');
      button.className = `seat ${seat.status}`;
      if (state.selected.has(seat.id)) button.classList.add('selected');
      if (isMyHoldSeat(seat)) button.classList.add('mine');
      button.textContent = seat.seatNumber;
      button.title = `${seat.id}: ${seat.status}`;
      button.disabled = seat.status !== 'available' && !state.selected.has(seat.id);
      button.addEventListener('click', () => toggleSeat(seat.id));
      row.append(button);
    }
    els.seatMap.append(row);
  }
}

function renderInventory() {
  const inventory = { available: 0, held: 0, booked: 0, total: 0 };
  for (const seat of state.seats.values()) {
    inventory[seat.status] += 1;
    inventory.total += 1;
  }
  els.inventory.textContent = `Available ${inventory.available} · Held ${inventory.held} · Booked ${inventory.booked} · Total ${inventory.total}`;
}

function renderSelected() {
  els.selectedSeats.textContent = state.selected.size ? [...state.selected].sort().join(', ') : 'none';
  els.holdButton.disabled = state.selected.size === 0 || Boolean(state.currentHold);
}

function renderHoldInfo() {
  clearInterval(state.timer);
  if (!state.currentHold) {
    els.holdInfo.textContent = 'No active hold';
    els.confirmButton.disabled = true;
    els.releaseButton.disabled = true;
    renderSelected();
    return;
  }

  const update = () => {
    const remaining = Math.max(0, Math.ceil((new Date(state.currentHold.expiresAt).getTime() - Date.now()) / 1000));
    if (remaining <= 0) {
      showNotice('Your hold expired; seats will be released automatically.', 'warn');
      saveHold(null);
      loadSeats().catch(console.error);
      return;
    }
    els.holdInfo.textContent = `Hold ${state.currentHold.id.slice(0, 8)} on ${state.currentHold.seatIds.join(', ')} expires in ${remaining}s`;
  };
  update();
  state.timer = setInterval(update, 1000);
  els.confirmButton.disabled = false;
  els.releaseButton.disabled = false;
  els.holdButton.disabled = true;
}

function toggleSeat(id) {
  const seat = state.seats.get(id);
  if (!seat || seat.status !== 'available') return;
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  render();
}

function showNotice(message, level = 'info') {
  els.notice.textContent = message;
  els.notice.className = `notice ${level}`;
}

async function createHold() {
  try {
    const seatIds = [...state.selected];
    const data = await api('/api/holds', {
      method: 'POST',
      body: JSON.stringify({ seatIds, sessionId: state.sessionId }),
    });
    state.selected.clear();
    mergeSeats(data.seats);
    saveHold(data.hold);
    showNotice(`Held ${data.hold.seatIds.join(', ')}. Confirm before the countdown ends.`, 'success');
    render();
  } catch (error) {
    if (error.status === 409) {
      const conflicts = error.body?.conflicts?.map((c) => `${c.id} (${c.status})`).join(', ') || 'requested seats';
      showNotice(`Hold failed: ${conflicts} already unavailable.`, 'error');
      await loadSeats();
    } else {
      showNotice(error.message, 'error');
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
    showNotice(data.idempotent ? 'Booking was already confirmed.' : `Booked ${data.booking.seatIds.join(', ')}.`, 'success');
    saveHold(null);
    render();
  } catch (error) {
    showNotice(`Confirm failed: ${error.message}`, 'error');
    saveHold(null);
    await loadSeats();
  }
}

async function releaseHold() {
  if (!state.currentHold) return;
  const hold = state.currentHold;
  try {
    await api(`/api/holds/${hold.id}`, {
      method: 'DELETE',
      body: JSON.stringify({ sessionId: state.sessionId }),
    });
    showNotice(`Released hold ${hold.id.slice(0, 8)}.`, 'success');
  } catch (error) {
    showNotice(`Release failed: ${error.message}`, 'error');
  } finally {
    saveHold(null);
    await loadSeats();
  }
}

function mergeSeats(seats = []) {
  for (const seat of seats) {
    state.seats.set(seat.id, seat);
    if (seat.status !== 'available') state.selected.delete(seat.id);
  }
}

function connectStream() {
  const stream = new EventSource(`${API_BASE}/api/stream`);
  stream.addEventListener('connected', () => showNotice('Live updates connected.', 'success'));
  stream.addEventListener('seats', (event) => {
    const payload = JSON.parse(event.data);
    mergeSeats(payload.seats);
    if (state.currentHold && payload.seats.some((seat) => state.currentHold.seatIds.includes(seat.id) && seat.status === 'available')) {
      saveHold(null);
    }
    render();
  });
  stream.onerror = () => showNotice('Live update connection interrupted; browser will retry.', 'warn');
}

els.sessionId.value = state.sessionId;
els.sessionId.addEventListener('change', () => {
  const id = els.sessionId.value.trim();
  if (!id) {
    els.sessionId.value = state.sessionId;
    return;
  }
  state.sessionId = id;
  localStorage.setItem('seat-booking-session-id', id);
  saveHold(null);
  showNotice(`Session changed to ${id}.`, 'info');
});
els.holdButton.addEventListener('click', createHold);
els.confirmButton.addEventListener('click', confirmHold);
els.releaseButton.addEventListener('click', releaseHold);
els.refreshButton.addEventListener('click', () => loadSeats().catch((error) => showNotice(error.message, 'error')));

loadSeats().catch((error) => showNotice(error.message, 'error'));
connectStream();
