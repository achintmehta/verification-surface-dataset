// Live seat-booking SPA. Renders the seat map, lets the user hold / confirm /
// release seats, and stays live via SSE.

const API = '/api';

// A stable per-browser session id identifies this holder.
function getSessionId() {
  let id = localStorage.getItem('seat-session-id');
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) || `s-${Date.now()}-${Math.random()}`;
    localStorage.setItem('seat-session-id', id);
  }
  return id;
}

const state = {
  sessionId: getSessionId(),
  seats: new Map(), // id -> seat
  selected: new Set(), // seat ids selected but not yet held
  hold: null, // { id, expiresAt, seatIds }
  ttlMs: 120000,
  countdownTimer: null,
};

const el = {
  seatmap: document.getElementById('seatmap'),
  inventory: document.getElementById('inventory'),
  connection: document.getElementById('connection'),
  message: document.getElementById('message'),
  holdBtn: document.getElementById('hold-btn'),
  confirmBtn: document.getElementById('confirm-btn'),
  releaseBtn: document.getElementById('release-btn'),
  countdown: document.getElementById('countdown'),
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function effectiveStatus(seat) {
  // Defensive: a held seat past expiry shows as available.
  if (seat.status === 'held' && seat.hold_expires_at) {
    if (new Date(seat.hold_expires_at).getTime() <= Date.now()) return 'available';
  }
  return seat.status;
}

function renderAll() {
  const byRow = new Map();
  for (const seat of state.seats.values()) {
    if (!byRow.has(seat.row_label)) byRow.set(seat.row_label, []);
    byRow.get(seat.row_label).push(seat);
  }
  const rows = [...byRow.keys()].sort();
  el.seatmap.innerHTML = '';
  for (const row of rows) {
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';
    const label = document.createElement('span');
    label.className = 'row-label';
    label.textContent = row;
    rowEl.appendChild(label);

    const seats = byRow.get(row).sort((a, b) => a.seat_number - b.seat_number);
    for (const seat of seats) {
      rowEl.appendChild(renderSeat(seat));
    }
    el.seatmap.appendChild(rowEl);
  }
  renderInventory();
  renderControls();
}

function renderSeat(seat) {
  const btn = document.createElement('button');
  btn.className = 'seat';
  btn.dataset.id = seat.id;
  btn.textContent = seat.seat_number;
  btn.title = seat.id;

  const status = effectiveStatus(seat);
  const mine = state.hold && seat.hold_id === state.hold.id;

  if (status === 'booked') {
    btn.classList.add('is-booked');
    btn.disabled = true;
    btn.title = `${seat.id} — booked`;
  } else if (status === 'held') {
    if (mine) {
      btn.classList.add('is-mine');
      btn.title = `${seat.id} — your hold`;
    } else {
      btn.classList.add('is-held');
      btn.title = `${seat.id} — held by someone`;
    }
    btn.disabled = true;
  } else {
    // available
    if (state.selected.has(seat.id)) btn.classList.add('is-selected');
    btn.disabled = !!state.hold; // can't select new seats while holding
    btn.addEventListener('click', () => toggleSelect(seat.id));
  }
  return btn;
}

function renderInventory() {
  let available = 0;
  let held = 0;
  let booked = 0;
  for (const seat of state.seats.values()) {
    const s = effectiveStatus(seat);
    if (s === 'available') available++;
    else if (s === 'held') held++;
    else if (s === 'booked') booked++;
  }
  el.inventory.textContent = `Available ${available} · Held ${held} · Booked ${booked} · Total ${state.seats.size}`;
}

function renderControls() {
  el.holdBtn.disabled = state.hold || state.selected.size === 0;
  el.confirmBtn.disabled = !state.hold;
  el.releaseBtn.disabled = !state.hold;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

function toggleSelect(seatId) {
  if (state.hold) return;
  if (state.selected.has(seatId)) state.selected.delete(seatId);
  else state.selected.add(seatId);
  renderAll();
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

function setMessage(text, kind = '') {
  el.message.textContent = text;
  el.message.className = 'message' + (kind ? ` ${kind}` : '');
}

// ---------------------------------------------------------------------------
// API actions
// ---------------------------------------------------------------------------

async function loadSeats() {
  const res = await fetch(`${API}/seats`);
  const data = await res.json();
  state.ttlMs = data.holdTtlMs ?? state.ttlMs;
  for (const seat of data.seats) state.seats.set(seat.id, seat);
  renderAll();
}

async function createHold() {
  const seatIds = [...state.selected];
  if (seatIds.length === 0) return;
  setMessage('Placing hold…');
  try {
    const res = await fetch(`${API}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId: state.sessionId }),
    });
    const data = await res.json();
    if (!res.ok) {
      if (res.status === 409 && data.conflictingSeatIds) {
        flagConflicts(data.conflictingSeatIds);
        setMessage(
          `These seats were just taken: ${data.conflictingSeatIds.join(', ')}. Refreshing…`,
          'error'
        );
      } else {
        setMessage(data.error || 'Could not place hold', 'error');
      }
      state.selected.clear();
      await loadSeats();
      return;
    }
    state.hold = {
      id: data.hold.id,
      expiresAt: data.hold.expiresAt,
      seatIds: data.seats.map((s) => s.id),
    };
    state.selected.clear();
    for (const seat of data.seats) state.seats.set(seat.id, seat);
    setMessage(`Held ${data.seats.length} seat(s). Confirm before the timer runs out.`, 'ok');
    startCountdown();
    renderAll();
  } catch (err) {
    setMessage('Network error placing hold', 'error');
  }
}

async function confirmHold() {
  if (!state.hold) return;
  setMessage('Confirming…');
  try {
    const res = await fetch(`${API}/holds/${state.hold.id}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: state.sessionId }),
    });
    const data = await res.json();
    if (!res.ok) {
      setMessage(data.error || 'Could not confirm hold', 'error');
      clearHold();
      await loadSeats();
      return;
    }
    for (const seat of data.seats) state.seats.set(seat.id, seat);
    const n = data.seats.length;
    setMessage(
      data.alreadyConfirmed
        ? `Already booked ${n} seat(s).`
        : `Booked ${n} seat(s)! 🎉`,
      'ok'
    );
    clearHold();
    renderAll();
  } catch (err) {
    setMessage('Network error confirming hold', 'error');
  }
}

async function releaseHold() {
  if (!state.hold) return;
  const holdId = state.hold.id;
  setMessage('Releasing…');
  try {
    const res = await fetch(`${API}/holds/${holdId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: state.sessionId }),
    });
    const data = await res.json().catch(() => ({}));
    for (const seat of data.seats || []) state.seats.set(seat.id, seat);
    setMessage('Hold released.', '');
    clearHold();
    await loadSeats();
  } catch (err) {
    setMessage('Network error releasing hold', 'error');
  }
}

function flagConflicts(ids) {
  for (const id of ids) {
    const btn = el.seatmap.querySelector(`.seat[data-id="${id}"]`);
    if (btn) {
      btn.classList.add('is-conflict');
      setTimeout(() => btn.classList.remove('is-conflict'), 600);
    }
  }
}

// ---------------------------------------------------------------------------
// Countdown
// ---------------------------------------------------------------------------

function startCountdown() {
  stopCountdown();
  el.countdown.hidden = false;
  const tick = () => {
    if (!state.hold) return stopCountdown();
    const remaining = new Date(state.hold.expiresAt).getTime() - Date.now();
    if (remaining <= 0) {
      el.countdown.textContent = 'Hold expired';
      setMessage('Your hold expired and the seats were released.', 'error');
      clearHold();
      loadSeats();
      return;
    }
    const secs = Math.ceil(remaining / 1000);
    const mm = String(Math.floor(secs / 60)).padStart(2, '0');
    const ss = String(secs % 60).padStart(2, '0');
    el.countdown.textContent = `Hold expires in ${mm}:${ss}`;
  };
  tick();
  state.countdownTimer = setInterval(tick, 250);
}

function stopCountdown() {
  if (state.countdownTimer) clearInterval(state.countdownTimer);
  state.countdownTimer = null;
  el.countdown.hidden = true;
}

function clearHold() {
  state.hold = null;
  stopCountdown();
  renderControls();
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

function connectStream() {
  const es = new EventSource(`${API}/stream`);
  es.addEventListener('open', () => {
    el.connection.textContent = 'live';
    el.connection.className = 'conn conn--live';
  });
  es.addEventListener('error', () => {
    el.connection.textContent = 'reconnecting…';
    el.connection.className = 'conn conn--down';
  });
  es.addEventListener('seats', (event) => {
    try {
      const payload = JSON.parse(event.data);
      applySeatUpdates(payload.seats);
    } catch (err) {
      /* ignore malformed */
    }
  });
}

function applySeatUpdates(seats) {
  if (!Array.isArray(seats)) return;
  for (const seat of seats) {
    state.seats.set(seat.id, seat);
    // If a seat we selected got taken by someone else, drop it.
    if (state.selected.has(seat.id) && seat.status !== 'available') {
      state.selected.delete(seat.id);
    }
  }
  renderAll();
}

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------

el.holdBtn.addEventListener('click', createHold);
el.confirmBtn.addEventListener('click', confirmHold);
el.releaseBtn.addEventListener('click', releaseHold);

loadSeats()
  .then(connectStream)
  .catch(() => setMessage('Could not load seats', 'error'));
