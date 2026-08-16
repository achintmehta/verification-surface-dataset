import './styles.css';

const API_BASE = '';
const app = document.querySelector('#app');
const sessionKey = 'seat-booking-session-id';
let sessionId = localStorage.getItem(sessionKey) || `session-${crypto.randomUUID()}`;
localStorage.setItem(sessionKey, sessionId);

let seats = [];
let selectedSeatIds = new Set();
let currentHold = null;
let countdownTimer = null;
let conflictSeatIds = new Set();

app.innerHTML = `
  <main class="app">
    <header>
      <div>
        <h1>Seat Booking</h1>
        <p>Pick available seats, place a temporary hold, then confirm before the timer expires.</p>
      </div>
      <div class="session-box">
        <label for="sessionId">Session id</label>
        <input id="sessionId" value="${sessionId}" />
      </div>
    </header>

    <section class="toolbar">
      <div class="legend">
        <span class="legend-item"><span class="swatch available"></span>Available</span>
        <span class="legend-item"><span class="swatch selected"></span>Selected</span>
        <span class="legend-item"><span class="swatch held"></span>Held</span>
        <span class="legend-item"><span class="swatch booked"></span>Booked</span>
      </div>
      <div class="actions">
        <button id="holdBtn" disabled>Hold selected</button>
        <button id="refreshBtn" class="secondary">Refresh</button>
      </div>
    </section>

    <section id="holdPanel" class="hold-panel hidden">
      <div>
        <strong>Current hold:</strong> <span id="holdSeats"></span>
        <span class="countdown" id="countdown"></span>
      </div>
      <div class="actions">
        <button id="confirmBtn">Confirm booking</button>
        <button id="releaseBtn" class="danger">Release hold</button>
      </div>
    </section>

    <div id="message" class="message hidden"></div>

    <section class="seat-map">
      <div class="stage">STAGE</div>
      <div id="seatRows"></div>
    </section>
  </main>
`;

const els = {
  sessionInput: document.querySelector('#sessionId'),
  holdBtn: document.querySelector('#holdBtn'),
  refreshBtn: document.querySelector('#refreshBtn'),
  confirmBtn: document.querySelector('#confirmBtn'),
  releaseBtn: document.querySelector('#releaseBtn'),
  holdPanel: document.querySelector('#holdPanel'),
  holdSeats: document.querySelector('#holdSeats'),
  countdown: document.querySelector('#countdown'),
  message: document.querySelector('#message'),
  seatRows: document.querySelector('#seatRows')
};

function setMessage(text, type = '') {
  els.message.textContent = text;
  els.message.className = `message ${type}`.trim();
  els.message.classList.toggle('hidden', !text);
}

function updateSessionId(value) {
  sessionId = value.trim() || `session-${crypto.randomUUID()}`;
  els.sessionInput.value = sessionId;
  localStorage.setItem(sessionKey, sessionId);
}

els.sessionInput.addEventListener('change', (event) => updateSessionId(event.target.value));

function groupSeatsByRow() {
  return seats.reduce((rows, seat) => {
    rows[seat.rowLabel] ||= [];
    rows[seat.rowLabel].push(seat);
    return rows;
  }, {});
}

function renderSeats() {
  const rows = groupSeatsByRow();
  els.seatRows.innerHTML = Object.keys(rows).sort().map((rowLabel) => {
    const rowSeats = rows[rowLabel].sort((a, b) => a.seatNumber - b.seatNumber);
    return `
      <div class="row">
        <div class="row-label">${rowLabel}</div>
        ${rowSeats.map((seat) => {
          const selected = selectedSeatIds.has(seat.id);
          const conflict = conflictSeatIds.has(seat.id);
          const unavailable = seat.status !== 'available';
          return `<button
            class="seat ${seat.status} ${selected ? 'selected' : ''} ${unavailable ? 'unavailable' : ''} ${conflict ? 'conflict' : ''}"
            data-seat-id="${seat.id}"
            ${unavailable ? 'disabled' : ''}
            title="${seat.id}: ${seat.status}"
          >${seat.seatNumber}</button>`;
        }).join('')}
      </div>`;
  }).join('');
  els.holdBtn.disabled = selectedSeatIds.size === 0 || !!currentHold;
}

function renderHoldPanel() {
  if (!currentHold) {
    els.holdPanel.classList.add('hidden');
    stopCountdown();
    return;
  }
  els.holdPanel.classList.remove('hidden');
  els.holdSeats.textContent = currentHold.seatIds.join(', ');
  startCountdown();
}

function stopCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = null;
  els.countdown.textContent = '';
}

function startCountdown() {
  stopCountdown();
  const tick = () => {
    if (!currentHold) return stopCountdown();
    const ms = new Date(currentHold.expiresAt).getTime() - Date.now();
    if (ms <= 0) {
      els.countdown.textContent = 'expired';
      currentHold = null;
      selectedSeatIds.clear();
      renderHoldPanel();
      loadSeats();
      setMessage('Your hold expired and the seats were released.', 'error');
      return;
    }
    els.countdown.textContent = ` · ${Math.ceil(ms / 1000)}s remaining`;
  };
  tick();
  countdownTimer = setInterval(tick, 250);
}

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
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

async function loadSeats() {
  const data = await request('/api/seats');
  seats = data.seats;
  const availableIds = new Set(seats.filter((seat) => seat.status === 'available').map((seat) => seat.id));
  selectedSeatIds = new Set([...selectedSeatIds].filter((id) => availableIds.has(id)));
  renderSeats();
}

els.seatRows.addEventListener('click', (event) => {
  const button = event.target.closest('[data-seat-id]');
  if (!button || button.disabled || currentHold) return;
  const seatId = button.dataset.seatId;
  conflictSeatIds.delete(seatId);
  if (selectedSeatIds.has(seatId)) selectedSeatIds.delete(seatId);
  else selectedSeatIds.add(seatId);
  renderSeats();
});

els.refreshBtn.addEventListener('click', async () => {
  try {
    await loadSeats();
    setMessage('Seat map refreshed.', 'success');
  } catch (err) {
    setMessage(err.message, 'error');
  }
});

els.holdBtn.addEventListener('click', async () => {
  try {
    conflictSeatIds.clear();
    const seatIds = [...selectedSeatIds];
    const data = await request('/api/holds', {
      method: 'POST',
      body: JSON.stringify({ seatIds, sessionId })
    });
    currentHold = data.hold;
    seats = mergeSeats(data.seats);
    selectedSeatIds.clear();
    renderSeats();
    renderHoldPanel();
    setMessage(`Held ${data.hold.seatIds.join(', ')}. Confirm before the countdown ends.`, 'success');
  } catch (err) {
    if (err.status === 409 && err.data?.conflictingSeatIds) {
      conflictSeatIds = new Set(err.data.conflictingSeatIds);
      setMessage(`Some seats are no longer available: ${err.data.conflictingSeatIds.join(', ')}`, 'error');
      await loadSeats();
      renderSeats();
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
    seats = mergeSeats(data.seats);
    const bookedIds = data.seats.map((seat) => seat.id).join(', ');
    currentHold = null;
    selectedSeatIds.clear();
    renderHoldPanel();
    renderSeats();
    setMessage(`Booked ${bookedIds}.`, 'success');
  } catch (err) {
    currentHold = null;
    renderHoldPanel();
    await loadSeats().catch(() => {});
    setMessage(err.message, 'error');
  }
});

els.releaseBtn.addEventListener('click', async () => {
  if (!currentHold) return;
  try {
    const holdId = currentHold.id;
    const data = await request(`/api/holds/${holdId}`, {
      method: 'DELETE',
      body: JSON.stringify({ sessionId })
    });
    seats = mergeSeats(data.seats);
    currentHold = null;
    selectedSeatIds.clear();
    renderHoldPanel();
    renderSeats();
    setMessage('Hold released.', 'success');
  } catch (err) {
    setMessage(err.message, 'error');
  }
});

function mergeSeats(changedSeats) {
  const byId = new Map(seats.map((seat) => [seat.id, seat]));
  for (const seat of changedSeats || []) byId.set(seat.id, seat);
  return [...byId.values()].sort((a, b) => a.rowLabel.localeCompare(b.rowLabel) || a.seatNumber - b.seatNumber);
}

function handleSeatChange(payload) {
  seats = mergeSeats(payload.seats);
  const unavailableSelected = new Set(payload.seats.filter((seat) => seat.status !== 'available').map((seat) => seat.id));
  for (const id of unavailableSelected) selectedSeatIds.delete(id);

  if (currentHold && payload.seats.some((seat) => currentHold.seatIds.includes(seat.id) && seat.status === 'available')) {
    currentHold = null;
    renderHoldPanel();
    setMessage('Your hold was released or expired.', 'error');
  }

  renderSeats();
}

function connectStream() {
  const stream = new EventSource('/api/stream');
  stream.addEventListener('seat-change', (event) => {
    try { handleSeatChange(JSON.parse(event.data)); } catch (err) { console.error(err); }
  });
  stream.onerror = () => {
    console.warn('SSE disconnected; browser will retry automatically');
  };
}

loadSeats()
  .then(() => {
    renderHoldPanel();
    connectStream();
  })
  .catch((err) => setMessage(err.message, 'error'));
