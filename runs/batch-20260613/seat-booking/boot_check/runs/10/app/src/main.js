import './styles.css';

const API = '';
const app = document.querySelector('#app');
const sessionId = localStorage.getItem('seatBookingSessionId') || crypto.randomUUID();
localStorage.setItem('seatBookingSessionId', sessionId);

const state = {
  seats: [],
  inventory: null,
  selected: new Set(),
  currentHold: JSON.parse(localStorage.getItem('currentHold') || 'null'),
  countdownTimer: null,
};

app.innerHTML = `
  <header>
    <div>
      <h1>Seat Booking</h1>
      <p class="subtitle">Session <code>${sessionId.slice(0, 8)}</code>. Holds are temporary and inventory updates live.</p>
    </div>
    <div id="inventory" class="inventory"></div>
  </header>

  <main>
    <section class="panel controls">
      <div id="message" class="message">Loading seats…</div>
      <div class="actions">
        <button id="holdBtn" disabled>Hold selected seats</button>
        <button id="confirmBtn" disabled>Confirm current hold</button>
        <button id="releaseBtn" disabled>Release hold</button>
      </div>
      <div id="holdInfo" class="hold-info"></div>
      <div class="legend">
        <span><b class="swatch available"></b>Available</span>
        <span><b class="swatch selected"></b>Selected</span>
        <span><b class="swatch held"></b>Held</span>
        <span><b class="swatch mine"></b>Your hold</span>
        <span><b class="swatch booked"></b>Booked</span>
      </div>
    </section>

    <section class="panel map-wrap">
      <div id="seatMap" class="seat-map"></div>
    </section>
  </main>
`;

const els = {
  inventory: document.querySelector('#inventory'),
  message: document.querySelector('#message'),
  holdBtn: document.querySelector('#holdBtn'),
  confirmBtn: document.querySelector('#confirmBtn'),
  releaseBtn: document.querySelector('#releaseBtn'),
  holdInfo: document.querySelector('#holdInfo'),
  seatMap: document.querySelector('#seatMap'),
};

function setMessage(text, type = '') {
  els.message.textContent = text;
  els.message.className = `message ${type}`.trim();
}

function saveHold() {
  if (state.currentHold) localStorage.setItem('currentHold', JSON.stringify(state.currentHold));
  else localStorage.removeItem('currentHold');
}

function secondsRemaining(expiresAt) {
  return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1000));
}

function updateInventory() {
  const inv = state.inventory || state.seats.reduce((acc, seat) => {
    acc.total += 1;
    acc[seat.status] += 1;
    return acc;
  }, { total: 0, available: 0, held: 0, booked: 0 });
  els.inventory.innerHTML = `
    <span>Total <strong>${inv.total}</strong></span>
    <span>Available <strong>${inv.available}</strong></span>
    <span>Held <strong>${inv.held}</strong></span>
    <span>Booked <strong>${inv.booked}</strong></span>
  `;
}

function seatClass(seat) {
  const classes = ['seat', seat.status];
  if (state.selected.has(seat.id)) classes.push('selected');
  if (state.currentHold?.id && seat.holdId === state.currentHold.id && seat.status === 'held') classes.push('mine');
  return classes.join(' ');
}

function renderSeats() {
  const rows = new Map();
  for (const seat of state.seats) {
    if (!rows.has(seat.rowLabel)) rows.set(seat.rowLabel, []);
    rows.get(seat.rowLabel).push(seat);
  }

  els.seatMap.innerHTML = [...rows.entries()].map(([rowLabel, seats]) => `
    <div class="row">
      <div class="row-label">${rowLabel}</div>
      <div class="row-seats">
        ${seats.map((seat) => `
          <button
            class="${seatClass(seat)}"
            data-seat-id="${seat.id}"
            title="${seat.id}: ${seat.status}"
            ${seat.status !== 'available' && !state.selected.has(seat.id) ? 'disabled' : ''}
          >${seat.seatNumber}</button>
        `).join('')}
      </div>
    </div>
  `).join('');

  updateButtons();
  updateInventory();
}

function updateButtons() {
  els.holdBtn.disabled = state.selected.size === 0 || Boolean(state.currentHold);
  els.confirmBtn.disabled = !state.currentHold;
  els.releaseBtn.disabled = !state.currentHold;
}

function updateHoldInfo() {
  if (state.countdownTimer) clearInterval(state.countdownTimer);
  if (!state.currentHold) {
    els.holdInfo.textContent = 'No active hold.';
    updateButtons();
    return;
  }

  const tick = () => {
    const remaining = secondsRemaining(state.currentHold.expiresAt);
    const seats = state.currentHold.seatIds.join(', ');
    els.holdInfo.textContent = remaining > 0
      ? `Hold ${state.currentHold.id.slice(0, 8)} for ${seats} expires in ${remaining}s.`
      : `Hold ${state.currentHold.id.slice(0, 8)} has expired; refreshing…`;
    if (remaining <= 0) {
      state.currentHold = null;
      saveHold();
      updateButtons();
      loadSeats();
    }
  };
  tick();
  state.countdownTimer = setInterval(tick, 1000);
  updateButtons();
}

async function requestJson(url, options = {}) {
  const response = await fetch(`${API}${url}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data.error || response.statusText);
    err.status = response.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function loadSeats() {
  const data = await requestJson('/api/seats');
  state.seats = data.seats;
  state.inventory = data.inventory;
  for (const id of [...state.selected]) {
    const seat = state.seats.find((s) => s.id === id);
    if (!seat || seat.status !== 'available') state.selected.delete(id);
  }
  if (state.currentHold) {
    const stillHeld = state.currentHold.seatIds.some((id) => {
      const seat = state.seats.find((s) => s.id === id);
      return seat?.holdId === state.currentHold.id && seat?.status === 'held';
    });
    const booked = state.currentHold.seatIds.every((id) => state.seats.find((s) => s.id === id)?.status === 'booked');
    if (!stillHeld && !booked) {
      state.currentHold = null;
      saveHold();
    }
  }
  renderSeats();
  updateHoldInfo();
  setMessage('Choose available seats, then hold them before confirming.', '');
}

els.seatMap.addEventListener('click', (event) => {
  const button = event.target.closest('[data-seat-id]');
  if (!button) return;
  const seat = state.seats.find((s) => s.id === button.dataset.seatId);
  if (!seat || seat.status !== 'available' || state.currentHold) return;
  if (state.selected.has(seat.id)) state.selected.delete(seat.id);
  else state.selected.add(seat.id);
  renderSeats();
});

els.holdBtn.addEventListener('click', async () => {
  try {
    const seatIds = [...state.selected];
    const data = await requestJson('/api/holds', {
      method: 'POST',
      body: JSON.stringify({ seatIds, sessionId }),
    });
    state.currentHold = data.hold;
    state.selected.clear();
    for (const seat of data.seats) upsertSeat(seat);
    state.inventory = data.inventory;
    saveHold();
    renderSeats();
    updateHoldInfo();
    setMessage(`Held ${seatIds.length} seat(s). Confirm before the timer expires.`, 'success');
  } catch (error) {
    if (error.status === 409) {
      const conflicts = error.data.conflictingSeatIds || [];
      setMessage(`Hold failed. Already unavailable: ${conflicts.join(', ') || 'selected seats'}.`, 'error');
      state.selected.clear();
      await loadSeats();
    } else {
      setMessage(error.message, 'error');
    }
  }
});

els.confirmBtn.addEventListener('click', async () => {
  if (!state.currentHold) return;
  try {
    const data = await requestJson(`/api/holds/${state.currentHold.id}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    });
    for (const seat of data.seats) upsertSeat(seat);
    state.inventory = data.inventory;
    setMessage(data.booking.idempotent ? 'Booking was already confirmed.' : 'Booking confirmed!', 'success');
    state.currentHold = null;
    saveHold();
    renderSeats();
    updateHoldInfo();
  } catch (error) {
    setMessage(`Confirm failed: ${error.message}`, 'error');
    state.currentHold = null;
    saveHold();
    await loadSeats();
  }
});

els.releaseBtn.addEventListener('click', async () => {
  if (!state.currentHold) return;
  try {
    const holdId = state.currentHold.id;
    const data = await requestJson(`/api/holds/${holdId}`, {
      method: 'DELETE',
      body: JSON.stringify({ sessionId }),
    });
    for (const seat of data.seats || []) upsertSeat(seat);
    state.inventory = data.inventory;
    state.currentHold = null;
    saveHold();
    renderSeats();
    updateHoldInfo();
    setMessage('Hold released.', 'success');
  } catch (error) {
    setMessage(`Release failed: ${error.message}`, 'error');
  }
});

function upsertSeat(seat) {
  const index = state.seats.findIndex((candidate) => candidate.id === seat.id);
  if (index >= 0) state.seats[index] = seat;
  else state.seats.push(seat);
}

function connectStream() {
  const stream = new EventSource('/api/stream');
  stream.addEventListener('seat-update', (event) => {
    const data = JSON.parse(event.data);
    for (const seat of data.seats) {
      upsertSeat(seat);
      if (seat.status !== 'available') state.selected.delete(seat.id);
    }
    if (data.inventory) state.inventory = data.inventory;
    if (state.currentHold) {
      const anyMine = state.currentHold.seatIds.some((id) => {
        const seat = state.seats.find((s) => s.id === id);
        return seat?.holdId === state.currentHold.id && seat?.status === 'held';
      });
      const allBooked = state.currentHold.seatIds.every((id) => state.seats.find((s) => s.id === id)?.status === 'booked');
      if (!anyMine && !allBooked) {
        state.currentHold = null;
        saveHold();
        setMessage('Your hold is no longer active.', 'error');
      }
    }
    renderSeats();
    updateHoldInfo();
  });
  stream.onerror = () => setMessage('Live connection interrupted; retrying automatically…', 'error');
}

loadSeats().catch((error) => setMessage(error.message, 'error'));
connectStream();
