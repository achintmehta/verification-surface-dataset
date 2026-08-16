import './styles.css';

const API_BASE = import.meta.env.VITE_API_BASE || '';
const app = document.querySelector('#app');
const sessionId = localStorage.getItem('seat-booking-session') || crypto.randomUUID();
localStorage.setItem('seat-booking-session', sessionId);

let seats = [];
let inventory = null;
let selected = new Set();
let currentHold = null;
let countdownTimer = null;
let message = 'Loading seat map…';
let conflictIds = new Set();

function seatSort(a, b) {
  return a.rowLabel.localeCompare(b.rowLabel) || a.seatNumber - b.seatNumber;
}

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || response.statusText);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function upsertSeats(changedSeats) {
  const byId = new Map(seats.map((seat) => [seat.id, seat]));
  for (const seat of changedSeats) byId.set(seat.id, { ...byId.get(seat.id), ...seat });
  seats = [...byId.values()].sort(seatSort);
  for (const id of [...selected]) {
    if (byId.get(id)?.status !== 'available') selected.delete(id);
  }
}

function setMessage(text) {
  message = text;
  render();
}

async function loadSeats() {
  const data = await request('/api/seats');
  seats = data.seats.sort(seatSort);
  inventory = data.inventory;
  message = 'Select available seats, then hold them.';
  render();
}

function holdRemainingMs() {
  if (!currentHold?.expiresAt) return 0;
  return Math.max(0, new Date(currentHold.expiresAt).getTime() - Date.now());
}

function formatSeconds(ms) {
  return `${Math.ceil(ms / 1000)}s`;
}

function startCountdown() {
  clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    if (!currentHold) return;
    if (holdRemainingMs() <= 0) {
      currentHold = null;
      setMessage('Your hold expired. Those seats may now be selected again.');
      clearInterval(countdownTimer);
    }
    render();
  }, 250);
}

async function createHold() {
  if (selected.size === 0) return;
  conflictIds = new Set();
  try {
    const seatIds = [...selected];
    const data = await request('/api/holds', {
      method: 'POST',
      body: JSON.stringify({ seatIds, sessionId })
    });
    currentHold = data.hold;
    inventory = data.inventory;
    selected.clear();
    upsertSeats(data.seats);
    startCountdown();
    message = `Holding ${data.seats.length} seat(s). Confirm before the timer expires.`;
    render();
  } catch (error) {
    if (error.status === 409) {
      conflictIds = new Set(error.data.conflictingSeatIds || []);
      message = `Hold failed. Conflicting seats: ${[...conflictIds].join(', ') || 'unknown'}.`;
      await loadSeats();
      message = `Hold failed. Conflicting seats: ${[...conflictIds].join(', ') || 'unknown'}.`;
      render();
    } else {
      setMessage(error.message);
    }
  }
}

async function confirmHold() {
  if (!currentHold) return;
  try {
    const data = await request(`/api/holds/${encodeURIComponent(currentHold.id)}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ sessionId })
    });
    inventory = data.inventory;
    upsertSeats(data.seats);
    message = data.idempotent ? 'Booking was already confirmed.' : 'Booking confirmed.';
    currentHold = null;
    clearInterval(countdownTimer);
    render();
  } catch (error) {
    currentHold = null;
    clearInterval(countdownTimer);
    await loadSeats();
    setMessage(`Confirm failed: ${error.message}`);
  }
}

async function releaseHold() {
  if (!currentHold) return;
  try {
    const hold = currentHold;
    currentHold = null;
    clearInterval(countdownTimer);
    const data = await request(`/api/holds/${encodeURIComponent(hold.id)}`, {
      method: 'DELETE',
      body: JSON.stringify({ sessionId })
    });
    inventory = data.inventory;
    upsertSeats(data.seats || []);
    message = 'Hold released.';
    render();
  } catch (error) {
    setMessage(error.message);
  }
}

function toggleSeat(id) {
  const seat = seats.find((s) => s.id === id);
  if (!seat || seat.status !== 'available') return;
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  conflictIds.delete(id);
  render();
}

function renderSeat(seat) {
  const selectedClass = selected.has(seat.id) ? ' selected' : '';
  const conflictClass = conflictIds.has(seat.id) ? ' conflict' : '';
  const mineClass = currentHold?.id && seat.holdId === currentHold.id ? ' mine' : '';
  return `<button class="seat ${seat.status}${selectedClass}${conflictClass}${mineClass}" data-seat-id="${seat.id}" ${seat.status === 'available' ? '' : 'disabled'} title="${seat.id} ${seat.status}">
    <span>${seat.rowLabel}${seat.seatNumber}</span>
  </button>`;
}

function render() {
  const rows = seats.reduce((map, seat) => {
    if (!map.has(seat.rowLabel)) map.set(seat.rowLabel, []);
    map.get(seat.rowLabel).push(seat);
    return map;
  }, new Map());
  const remaining = holdRemainingMs();

  app.innerHTML = `
    <section class="panel">
      <div>
        <h1>Seat Booking</h1>
        <p class="muted">Session: <code>${sessionId.slice(0, 8)}</code></p>
      </div>
      <div class="inventory">
        <span>Available <b>${inventory?.available ?? '-'}</b></span>
        <span>Held <b>${inventory?.held ?? '-'}</b></span>
        <span>Booked <b>${inventory?.booked ?? '-'}</b></span>
        <span>Total <b>${inventory?.total ?? '-'}</b></span>
      </div>
    </section>

    <p class="message">${message}</p>

    <section class="controls">
      <button id="hold" ${selected.size === 0 || currentHold ? 'disabled' : ''}>Hold selected (${selected.size})</button>
      <button id="confirm" ${currentHold ? '' : 'disabled'}>Confirm hold${currentHold ? ` (${formatSeconds(remaining)})` : ''}</button>
      <button id="release" ${currentHold ? '' : 'disabled'}>Release hold</button>
      <button id="refresh">Refresh</button>
    </section>

    <section class="legend">
      <span><i class="swatch available"></i>Available</span>
      <span><i class="swatch held"></i>Held</span>
      <span><i class="swatch booked"></i>Booked</span>
      <span><i class="swatch selected"></i>Selected</span>
    </section>

    <section class="seat-map">
      ${[...rows.entries()].map(([row, rowSeats]) => `
        <div class="seat-row">
          <div class="row-label">${row}</div>
          <div class="row-seats">${rowSeats.map(renderSeat).join('')}</div>
        </div>
      `).join('')}
    </section>
  `;

  app.querySelectorAll('[data-seat-id]').forEach((button) => {
    button.addEventListener('click', () => toggleSeat(button.dataset.seatId));
  });
  app.querySelector('#hold')?.addEventListener('click', createHold);
  app.querySelector('#confirm')?.addEventListener('click', confirmHold);
  app.querySelector('#release')?.addEventListener('click', releaseHold);
  app.querySelector('#refresh')?.addEventListener('click', loadSeats);
}

function connectStream() {
  const streamUrl = `${API_BASE}/api/stream`;
  const events = new EventSource(streamUrl);
  events.addEventListener('snapshot', (event) => {
    const data = JSON.parse(event.data);
    seats = data.seats.sort(seatSort);
    inventory = data.inventory;
    render();
  });
  events.addEventListener('seats', (event) => {
    const data = JSON.parse(event.data);
    if (data.seats) upsertSeats(data.seats);
    if (data.inventory) inventory = data.inventory;
    render();
  });
  events.onerror = () => {
    message = 'Live connection interrupted; retrying automatically…';
    render();
  };
}

render();
loadSeats().catch((error) => setMessage(error.message));
connectStream();
