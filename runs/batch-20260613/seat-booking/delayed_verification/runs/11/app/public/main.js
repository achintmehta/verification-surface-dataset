// Seat-booking SPA frontend.

const API = '/api';

// Persist a session id so this browser identifies the same holder.
function getSessionId() {
  let id = localStorage.getItem('seatSessionId');
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) ||
      's-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('seatSessionId', id);
  }
  return id;
}

const sessionId = getSessionId();

const state = {
  seats: new Map(), // id -> seat object
  selected: new Set(),
  holdTtlMs: 120000,
  hold: null, // { id, expiresAt, seatIds }
  countdownTimer: null,
};

const els = {
  map: document.getElementById('seat-map'),
  connection: document.getElementById('connection'),
  selectionInfo: document.getElementById('selection-info'),
  inventory: document.getElementById('inventory'),
  holdBtn: document.getElementById('hold-btn'),
  confirmBtn: document.getElementById('confirm-btn'),
  releaseBtn: document.getElementById('release-btn'),
  countdown: document.getElementById('countdown'),
  message: document.getElementById('message'),
};

// ---------- Rendering ----------

function effectiveStatus(seat) {
  // Treat expired holds as available defensively (server also does this).
  if (seat.status === 'held' && seat.holdExpiresAt) {
    if (new Date(seat.holdExpiresAt).getTime() <= Date.now()) return 'available';
  }
  return seat.status;
}

function seatClass(seat) {
  const status = effectiveStatus(seat);
  if (status === 'booked') return 'booked';
  if (status === 'held') {
    // Is this seat part of my active hold?
    if (state.hold && seat.holdId === state.hold.id) return 'mine';
    return 'held-other';
  }
  // available
  if (state.selected.has(seat.id)) return 'selected';
  return 'available';
}

function renderMap() {
  // Group seats by row.
  const rows = new Map();
  for (const seat of state.seats.values()) {
    if (!rows.has(seat.row)) rows.set(seat.row, []);
    rows.get(seat.row).push(seat);
  }
  const sortedRows = [...rows.keys()].sort();

  els.map.innerHTML = '';
  for (const rowLabel of sortedRows) {
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';

    const label = document.createElement('span');
    label.className = 'row-label';
    label.textContent = rowLabel;
    rowEl.appendChild(label);

    const seats = rows.get(rowLabel).sort((a, b) => a.number - b.number);
    for (const seat of seats) {
      const btn = document.createElement('button');
      const cls = seatClass(seat);
      btn.className = `seat ${cls}`;
      btn.textContent = seat.number;
      btn.title = `${seat.id} — ${effectiveStatus(seat)}`;
      btn.dataset.id = seat.id;

      const interactive = cls === 'available' || cls === 'selected';
      btn.disabled = !interactive;
      if (interactive) {
        btn.addEventListener('click', () => toggleSelect(seat.id));
      }
      rowEl.appendChild(btn);
    }
    els.map.appendChild(rowEl);
  }
  renderControls();
}

function renderControls() {
  const count = state.selected.size;
  if (state.hold) {
    const ids = state.hold.seatIds.join(', ');
    els.selectionInfo.textContent = `Holding ${state.hold.seatIds.length} seat(s): ${ids}`;
  } else if (count > 0) {
    els.selectionInfo.textContent = `Selected ${count} seat(s): ${[...state.selected].join(', ')}`;
  } else {
    els.selectionInfo.textContent = 'No seats selected.';
  }

  els.holdBtn.disabled = count === 0 || !!state.hold;
  els.confirmBtn.disabled = !state.hold;
  els.releaseBtn.disabled = !state.hold;

  updateInventory();
}

function updateInventory() {
  let available = 0, held = 0, booked = 0;
  for (const seat of state.seats.values()) {
    const s = effectiveStatus(seat);
    if (s === 'available') available++;
    else if (s === 'held') held++;
    else booked++;
  }
  els.inventory.textContent =
    `Inventory — available: ${available} · held: ${held} · booked: ${booked} · total: ${state.seats.size}`;
}

function setMessage(text, kind = 'info') {
  els.message.textContent = text;
  els.message.className = `message ${kind}`;
}

// ---------- Selection ----------

function toggleSelect(seatId) {
  if (state.hold) return; // cannot change selection while holding
  if (state.selected.has(seatId)) state.selected.delete(seatId);
  else state.selected.add(seatId);
  renderMap();
}

// ---------- API calls ----------

async function loadSeats() {
  try {
    const res = await fetch(`${API}/seats`);
    const data = await res.json();
    state.holdTtlMs = data.holdTtlMs || state.holdTtlMs;
    state.seats.clear();
    for (const seat of data.seats) state.seats.set(seat.id, seat);
    // Drop selections that are no longer available.
    for (const id of [...state.selected]) {
      const seat = state.seats.get(id);
      if (!seat || effectiveStatus(seat) !== 'available') state.selected.delete(id);
    }
    renderMap();
  } catch (err) {
    setMessage('Failed to load seats. Is the server running?', 'error');
  }
}

async function requestHold() {
  const seatIds = [...state.selected];
  if (seatIds.length === 0) return;
  setMessage('Requesting hold…', 'info');
  try {
    const res = await fetch(`${API}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId }),
    });
    if (res.status === 409) {
      const data = await res.json();
      const conflicts = data.conflicts || [];
      setMessage(
        `Sorry, these seats were just taken: ${conflicts.join(', ')}. Refreshing map…`,
        'error'
      );
      state.selected.clear();
      await loadSeats();
      return;
    }
    if (!res.ok) {
      setMessage('Could not place hold.', 'error');
      return;
    }
    const data = await res.json();
    state.hold = data.hold;
    state.selected.clear();
    setMessage(`Hold placed on ${data.hold.seatIds.length} seat(s). Confirm before it expires!`, 'success');
    startCountdown();
    await loadSeats();
  } catch (err) {
    setMessage('Network error placing hold.', 'error');
  }
}

async function confirmBooking() {
  if (!state.hold) return;
  setMessage('Confirming…', 'info');
  try {
    const res = await fetch(`${API}/holds/${state.hold.id}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (data.error === 'expired') {
        setMessage('Your hold expired before confirmation. Please select again.', 'error');
      } else if (data.error === 'unknown_hold') {
        setMessage('Hold no longer exists. Please select again.', 'error');
      } else {
        setMessage(`Could not confirm: ${data.error || 'error'}.`, 'error');
      }
      clearHold();
      await loadSeats();
      return;
    }
    const data = await res.json();
    setMessage(
      `Booked ${data.booking.seatIds.length} seat(s): ${data.booking.seatIds.join(', ')}` +
        (data.idempotent ? ' (already booked)' : ''),
      'success'
    );
    clearHold();
    await loadSeats();
  } catch (err) {
    setMessage('Network error confirming.', 'error');
  }
}

async function releaseCurrentHold() {
  if (!state.hold) return;
  const holdId = state.hold.id;
  setMessage('Releasing hold…', 'info');
  try {
    await fetch(`${API}/holds/${holdId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    clearHold();
    setMessage('Hold released.', 'info');
    await loadSeats();
  } catch (err) {
    setMessage('Network error releasing hold.', 'error');
  }
}

// ---------- Countdown ----------

function startCountdown() {
  stopCountdown();
  els.countdown.hidden = false;
  const tick = () => {
    if (!state.hold) return stopCountdown();
    const remaining = new Date(state.hold.expiresAt).getTime() - Date.now();
    if (remaining <= 0) {
      els.countdown.textContent = 'Hold expired.';
      setMessage('Your hold expired. Seats released.', 'error');
      clearHold();
      loadSeats();
      return;
    }
    const secs = Math.ceil(remaining / 1000);
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    els.countdown.textContent = `Hold expires in ${m}:${String(s).padStart(2, '0')}`;
  };
  tick();
  state.countdownTimer = setInterval(tick, 250);
}

function stopCountdown() {
  if (state.countdownTimer) clearInterval(state.countdownTimer);
  state.countdownTimer = null;
  els.countdown.hidden = true;
}

function clearHold() {
  state.hold = null;
  stopCountdown();
  renderControls();
}

// ---------- SSE ----------

function connectStream() {
  const es = new EventSource(`${API}/stream`);

  es.addEventListener('open', () => {
    els.connection.textContent = 'live';
    els.connection.className = 'status-pill connected';
  });

  es.addEventListener('connected', () => {
    els.connection.textContent = 'live';
    els.connection.className = 'status-pill connected';
  });

  es.addEventListener('seats', (e) => {
    try {
      const event = JSON.parse(e.data);
      applySeatUpdates(event.seats || []);
    } catch (_err) {
      /* ignore malformed */
    }
  });

  es.addEventListener('error', () => {
    els.connection.textContent = 'reconnecting…';
    els.connection.className = 'status-pill disconnected';
  });
}

function applySeatUpdates(seats) {
  let myHoldGone = false;
  for (const seat of seats) {
    state.seats.set(seat.id, seat);
    // If a seat that was part of my hold is no longer held by me, my hold is gone.
    if (state.hold && state.hold.seatIds.includes(seat.id)) {
      const stillMine = seat.status === 'held' && seat.holdId === state.hold.id;
      const bookedByMe = seat.status === 'booked';
      if (!stillMine && !bookedByMe) myHoldGone = true;
    }
  }
  // Remove any selected seat that just became unavailable.
  for (const id of [...state.selected]) {
    const seat = state.seats.get(id);
    if (seat && effectiveStatus(seat) !== 'available') state.selected.delete(id);
  }
  if (myHoldGone) clearHold();
  renderMap();
}

// ---------- Wire up ----------

els.holdBtn.addEventListener('click', requestHold);
els.confirmBtn.addEventListener('click', confirmBooking);
els.releaseBtn.addEventListener('click', releaseCurrentHold);

loadSeats();
connectStream();
