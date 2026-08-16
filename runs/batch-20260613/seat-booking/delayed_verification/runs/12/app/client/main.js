// Seat-booking frontend SPA.
// - Renders the seat map from GET /api/seats
// - Lets the user select available seats and request a hold
// - Confirms / releases holds
// - Subscribes to /api/stream (SSE) to stay live

const API = '/api';

// Stable per-tab session id identifying this holder.
function getSessionId() {
  let id = localStorage.getItem('seatSessionId');
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : 'sess-' + Math.random().toString(36).slice(2));
    localStorage.setItem('seatSessionId', id);
  }
  return id;
}
const sessionId = getSessionId();

// --- State --------------------------------------------------------------
const state = {
  seats: new Map(),        // id -> seat DTO
  selected: new Set(),     // ids the user has selected (pre-hold)
  hold: null,              // { id, seatIds, expiresAt }
  countdownTimer: null,
};

// --- DOM refs -----------------------------------------------------------
const el = {
  seatmap: document.getElementById('seatmap'),
  inventory: document.getElementById('inventory'),
  conn: document.getElementById('conn'),
  selection: document.getElementById('selection'),
  holdBtn: document.getElementById('holdBtn'),
  confirmBtn: document.getElementById('confirmBtn'),
  releaseBtn: document.getElementById('releaseBtn'),
  countdown: document.getElementById('countdown'),
  message: document.getElementById('message'),
};

// --- Helpers ------------------------------------------------------------
function setMessage(text, kind = 'info') {
  el.message.textContent = text || '';
  el.message.className = 'message ' + (text ? kind : '');
}

function effectiveStatus(seat) {
  // A held seat whose hold has expired is effectively available client-side too.
  if (seat.status === 'held' && seat.holdExpiresAt) {
    if (new Date(seat.holdExpiresAt).getTime() <= Date.now()) return 'available';
  }
  return seat.status;
}

function seatClass(seat) {
  const status = effectiveStatus(seat);
  if (status === 'booked') return 'booked';
  if (status === 'held') {
    return state.hold && seat.holdId === state.hold.id ? 'mine' : 'held';
  }
  // available
  return state.selected.has(seat.id) ? 'selected' : 'available';
}

// --- Rendering ----------------------------------------------------------
function render() {
  // Group seats by row.
  const rows = new Map();
  for (const seat of state.seats.values()) {
    if (!rows.has(seat.row)) rows.set(seat.row, []);
    rows.get(seat.row).push(seat);
  }
  const sortedRows = [...rows.keys()].sort();

  el.seatmap.innerHTML = '';
  for (const row of sortedRows) {
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';

    const label = document.createElement('span');
    label.className = 'row-label';
    label.textContent = row;
    rowEl.appendChild(label);

    const seats = rows.get(row).sort((a, b) => a.number - b.number);
    for (const seat of seats) {
      const btn = document.createElement('button');
      const cls = seatClass(seat);
      btn.className = 'seat ' + cls;
      btn.textContent = seat.number;
      btn.title = `${seat.id} — ${cls}`;
      const status = effectiveStatus(seat);
      const isMine = state.hold && seat.holdId === state.hold.id;
      btn.disabled = status === 'booked' || (status === 'held' && !isMine);
      btn.addEventListener('click', () => onSeatClick(seat));
      rowEl.appendChild(btn);
    }
    el.seatmap.appendChild(rowEl);
  }

  renderInventory();
  renderControls();
}

function renderInventory() {
  let available = 0, held = 0, booked = 0;
  for (const seat of state.seats.values()) {
    const s = effectiveStatus(seat);
    if (s === 'available') available++;
    else if (s === 'held') held++;
    else if (s === 'booked') booked++;
  }
  const total = available + held + booked;
  el.inventory.innerHTML =
    `<b>${available}</b> available · <b>${held}</b> held · <b>${booked}</b> booked · <b>${total}</b> total`;
}

function renderControls() {
  const hasSelection = state.selected.size > 0;
  const hasHold = !!state.hold;

  el.holdBtn.disabled = !hasSelection || hasHold;
  el.confirmBtn.disabled = !hasHold;
  el.releaseBtn.disabled = !hasHold;

  if (hasHold) {
    el.selection.textContent = `Hold on: ${state.hold.seatIds.join(', ')}`;
  } else if (hasSelection) {
    el.selection.textContent = `Selected: ${[...state.selected].sort().join(', ')}`;
  } else {
    el.selection.textContent = 'No seats selected.';
  }
}

// --- Countdown ----------------------------------------------------------
function startCountdown() {
  stopCountdown();
  if (!state.hold) return;
  const tick = () => {
    if (!state.hold) return stopCountdown();
    const remaining = new Date(state.hold.expiresAt).getTime() - Date.now();
    if (remaining <= 0) {
      el.countdown.textContent = 'Hold expired.';
      setMessage('Your hold expired. The seats were released.', 'error');
      clearHold();
      refreshSeats();
      return;
    }
    const s = Math.ceil(remaining / 1000);
    el.countdown.textContent = `⏳ Hold expires in ${s}s — confirm to book.`;
  };
  tick();
  state.countdownTimer = setInterval(tick, 250);
}

function stopCountdown() {
  if (state.countdownTimer) clearInterval(state.countdownTimer);
  state.countdownTimer = null;
  el.countdown.textContent = '';
}

function clearHold() {
  state.hold = null;
  stopCountdown();
  renderControls();
}

// --- Interactions -------------------------------------------------------
function onSeatClick(seat) {
  // Once a hold is active, ignore selection changes.
  if (state.hold) return;
  const status = effectiveStatus(seat);
  if (status !== 'available') return;

  if (state.selected.has(seat.id)) state.selected.delete(seat.id);
  else state.selected.add(seat.id);

  setMessage('');
  render();
}

async function refreshSeats() {
  try {
    const res = await fetch(`${API}/seats`);
    const data = await res.json();
    state.seats = new Map(data.seats.map((s) => [s.id, s]));
    // Drop selections that are no longer available.
    for (const id of [...state.selected]) {
      const seat = state.seats.get(id);
      if (!seat || effectiveStatus(seat) !== 'available') state.selected.delete(id);
    }
    render();
  } catch (err) {
    setMessage('Failed to load seats.', 'error');
  }
}

async function requestHold() {
  const seatIds = [...state.selected];
  if (seatIds.length === 0) return;
  el.holdBtn.disabled = true;
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
        `Could not hold — already taken: ${conflicts.join(', ')}. Seat map refreshed.`,
        'error'
      );
      state.selected.clear();
      await refreshSeats();
      return;
    }
    if (!res.ok) {
      setMessage('Hold request failed.', 'error');
      await refreshSeats();
      return;
    }
    const data = await res.json();
    state.hold = {
      id: data.hold.id,
      seatIds: data.hold.seatIds,
      expiresAt: data.hold.expiresAt,
    };
    state.selected.clear();
    setMessage('Seats held! Confirm to book before the timer runs out.', 'success');
    startCountdown();
    await refreshSeats();
  } catch (err) {
    setMessage('Network error requesting hold.', 'error');
    await refreshSeats();
  }
}

async function confirmBooking() {
  if (!state.hold) return;
  const holdId = state.hold.id;
  el.confirmBtn.disabled = true;
  setMessage('Confirming…', 'info');
  try {
    const res = await fetch(`${API}/holds/${holdId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setMessage(`Could not confirm: ${data.message || data.error || res.status}.`, 'error');
      clearHold();
      await refreshSeats();
      return;
    }
    const data = await res.json();
    const ids = data.booking.seatIds.join(', ');
    setMessage(
      data.alreadyConfirmed
        ? `Already booked: ${ids}.`
        : `Booked: ${ids}. Enjoy the show!`,
      'success'
    );
    clearHold();
    await refreshSeats();
  } catch (err) {
    setMessage('Network error confirming.', 'error');
    await refreshSeats();
  }
}

async function releaseCurrentHold() {
  if (!state.hold) return;
  const holdId = state.hold.id;
  el.releaseBtn.disabled = true;
  setMessage('Releasing hold…', 'info');
  try {
    await fetch(`${API}/holds/${holdId}?sessionId=${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    });
    setMessage('Hold released.', 'info');
    clearHold();
    await refreshSeats();
  } catch (err) {
    setMessage('Network error releasing hold.', 'error');
    await refreshSeats();
  }
}

// --- SSE ----------------------------------------------------------------
function connectStream() {
  const es = new EventSource(`${API}/stream`);

  es.addEventListener('open', () => {
    el.conn.textContent = 'live';
    el.conn.className = 'conn live';
  });

  es.addEventListener('hello', () => {
    el.conn.textContent = 'live';
    el.conn.className = 'conn live';
  });

  es.addEventListener('seats', () => {
    // Any seat transition: re-pull authoritative seat state.
    // (Cheap for a fixed 50-seat map; keeps all clients converged.)
    refreshSeats();
  });

  es.addEventListener('error', () => {
    el.conn.textContent = 'reconnecting…';
    el.conn.className = 'conn down';
    // EventSource auto-reconnects.
  });
}

// --- Wire up ------------------------------------------------------------
el.holdBtn.addEventListener('click', requestHold);
el.confirmBtn.addEventListener('click', confirmBooking);
el.releaseBtn.addEventListener('click', releaseCurrentHold);

window.addEventListener('beforeunload', () => {
  // Best-effort release of an unconfirmed hold when leaving.
  if (state.hold) {
    navigator.sendBeacon?.(
      `${API}/holds/${state.hold.id}?sessionId=${encodeURIComponent(sessionId)}`
    );
  }
});

refreshSeats();
connectStream();
