import './styles.css';

const API = import.meta.env.VITE_API_URL || '';
const sessionId = localStorage.getItem('seat-booking-session') || crypto.randomUUID();
localStorage.setItem('seat-booking-session', sessionId);

document.querySelector('#sessionId').textContent = sessionId.slice(0, 8);

const state = {
  seats: new Map(),
  selected: new Set(),
  currentHold: null,
  holdTtlMs: 30000,
  conflictIds: new Set(),
};

const seatMap = document.querySelector('#seatMap');
const message = document.querySelector('#message');
const inventoryEl = document.querySelector('#inventory');
const holdButton = document.querySelector('#holdButton');
const confirmButton = document.querySelector('#confirmButton');
const releaseButton = document.querySelector('#releaseButton');
const countdown = document.querySelector('#countdown');

function setMessage(text, kind = '') {
  message.textContent = text;
  message.className = `message ${kind}`.trim();
}

function updateInventory() {
  const counts = { available: 0, held: 0, booked: 0 };
  for (const seat of state.seats.values()) counts[seat.status] += 1;
  inventoryEl.textContent = `Available: ${counts.available} · Held: ${counts.held} · Booked: ${counts.booked} · Total: ${state.seats.size}`;
}

function renderSeatMap() {
  const rows = [...state.seats.values()].reduce((acc, seat) => {
    (acc[seat.rowLabel] ||= []).push(seat);
    return acc;
  }, {});

  seatMap.innerHTML = '';
  for (const rowLabel of Object.keys(rows).sort()) {
    const row = document.createElement('div');
    row.className = 'seat-row';
    const label = document.createElement('div');
    label.className = 'row-label';
    label.textContent = rowLabel;
    row.append(label);

    rows[rowLabel].sort((a, b) => a.seatNumber - b.seatNumber).forEach((seat) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.id = seat.id;
      const isMine = state.currentHold?.seatIds?.includes(seat.id) && seat.status === 'held';
      const selected = state.selected.has(seat.id);
      const conflict = state.conflictIds.has(seat.id);
      button.className = `seat ${seat.status}${selected ? ' selected' : ''}${isMine ? ' mine' : ''}${conflict ? ' conflict' : ''}`;
      button.textContent = seat.seatNumber;
      button.title = `${seat.id}: ${seat.status}`;
      button.disabled = seat.status !== 'available' && !selected;
      button.addEventListener('click', () => toggleSeat(seat.id));
      row.append(button);
    });
    seatMap.append(row);
  }
  updateInventory();
  updateButtons();
}

function toggleSeat(id) {
  const seat = state.seats.get(id);
  if (!seat || seat.status !== 'available') return;
  state.conflictIds.clear();
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  renderSeatMap();
}

function updateButtons() {
  holdButton.disabled = state.selected.size === 0 || Boolean(state.currentHold);
  confirmButton.disabled = !state.currentHold;
  releaseButton.disabled = !state.currentHold;
}

async function loadSeats() {
  const res = await fetch(`${API}/api/seats`);
  if (!res.ok) throw new Error('Unable to load seat map');
  const data = await res.json();
  state.holdTtlMs = data.holdTtlMs;
  state.seats = new Map(data.seats.map((seat) => [seat.id, seat]));
  for (const id of [...state.selected]) {
    if (state.seats.get(id)?.status !== 'available') state.selected.delete(id);
  }
  renderSeatMap();
}

async function placeHold() {
  const seatIds = [...state.selected];
  if (!seatIds.length) return;
  try {
    const res = await fetch(`${API}/api/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId }),
    });
    if (res.status === 409) {
      const data = await res.json();
      state.conflictIds = new Set(data.conflictingSeatIds || seatIds);
      setMessage(`Some selected seats were taken: ${[...state.conflictIds].join(', ')}`, 'error');
      await loadSeats();
      for (const id of state.conflictIds) state.conflictIds.add(id);
      renderSeatMap();
      return;
    }
    if (!res.ok) throw new Error((await res.json()).error || 'Hold failed');
    const { hold } = await res.json();
    state.currentHold = hold;
    state.selected.clear();
    for (const seat of hold.seats) state.seats.set(seat.id, seat);
    setMessage(`Held ${hold.seatIds.length} seat(s). Confirm before the timer expires.`, 'success');
    renderSeatMap();
  } catch (err) {
    setMessage(err.message, 'error');
  }
}

async function confirmHold() {
  if (!state.currentHold) return;
  try {
    const res = await fetch(`${API}/api/holds/${state.currentHold.id}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Confirm failed');
    const { booking } = await res.json();
    for (const seat of booking.seats) state.seats.set(seat.id, seat);
    state.currentHold = null;
    setMessage(`Booked seats: ${booking.seatIds.join(', ')}`, 'success');
    renderSeatMap();
  } catch (err) {
    setMessage(err.message, 'error');
    state.currentHold = null;
    await loadSeats();
  }
}

async function releaseHold() {
  if (!state.currentHold) return;
  try {
    await fetch(`${API}/api/holds/${state.currentHold.id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
  } finally {
    state.currentHold = null;
    setMessage('Hold released.', '');
    await loadSeats();
  }
}

function applySeatChanges(seats) {
  for (const patch of seats || []) {
    const existing = state.seats.get(patch.id) || { id: patch.id };
    const updated = {
      ...existing,
      ...patch,
      rowLabel: existing.rowLabel,
      seatNumber: existing.seatNumber,
      holdId: patch.holdId ?? patch.hold_id ?? patch.holdId,
      holdExpiresAt: patch.holdExpiresAt ?? null,
    };
    state.seats.set(patch.id, updated);
    if (updated.status !== 'available') state.selected.delete(patch.id);
  }

  if (state.currentHold) {
    const held = state.currentHold.seatIds.every((id) => state.seats.get(id)?.holdId === state.currentHold.id && state.seats.get(id)?.status === 'held');
    const booked = state.currentHold.seatIds.every((id) => state.seats.get(id)?.status === 'booked');
    if (!held && !booked) {
      state.currentHold = null;
      setMessage('Your hold is no longer active.', 'error');
    }
  }
  renderSeatMap();
}

function connectStream() {
  const source = new EventSource(`${API}/api/stream`);
  source.addEventListener('seats-changed', (event) => {
    const data = JSON.parse(event.data);
    applySeatChanges(data.seats);
  });
  source.onerror = () => setMessage('Live updates disconnected; retrying…', 'error');
}

function tickCountdown() {
  if (!state.currentHold) {
    countdown.textContent = '';
    return;
  }
  const remaining = new Date(state.currentHold.expiresAt).getTime() - Date.now();
  if (remaining <= 0) {
    countdown.textContent = 'Hold expired';
    state.currentHold = null;
    loadSeats().catch(() => {});
  } else {
    countdown.textContent = `Hold expires in ${Math.ceil(remaining / 1000)}s`;
  }
  updateButtons();
}

holdButton.addEventListener('click', placeHold);
confirmButton.addEventListener('click', confirmHold);
releaseButton.addEventListener('click', releaseHold);
setInterval(tickCountdown, 250);

loadSeats().then(connectStream).catch((err) => setMessage(err.message, 'error'));
