// Seat-booking SPA: renders the seat map, manages selection/hold/confirm/release,
// and stays live via SSE. All seat state of record lives on the server; the
// client mirrors it and reconciles on every event.

const API = '/api';

// --- Session identity (no auth; a client-supplied id identifies the holder) ---
function getSessionId() {
  let id = localStorage.getItem('seat-session-id');
  if (!id) {
    id =
      'sess-' +
      (crypto.randomUUID
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2) + Date.now().toString(36));
    localStorage.setItem('seat-session-id', id);
  }
  return id;
}
const SESSION_ID = getSessionId();

// --- State ---
const state = {
  seats: new Map(), // id -> seat
  selected: new Set(), // seat ids the user has selected (pre-hold)
  hold: null, // { holdId, expiresAt, seatIds }
  booked: false,
};

// --- DOM refs ---
const el = {
  seatmap: document.getElementById('seatmap'),
  inventory: document.getElementById('inventory'),
  selectionInfo: document.getElementById('selection-info'),
  holdPanel: document.getElementById('hold-panel'),
  countdown: document.getElementById('countdown'),
  btnHold: document.getElementById('btn-hold'),
  btnConfirm: document.getElementById('btn-confirm'),
  btnRelease: document.getElementById('btn-release'),
  message: document.getElementById('message'),
  connDot: document.getElementById('conn-dot'),
  connLabel: document.getElementById('conn-label'),
  sessionId: document.getElementById('session-id'),
};
el.sessionId.textContent = SESSION_ID;

// --- Helpers ---
function setMessage(text, kind = 'info') {
  el.message.textContent = text || '';
  el.message.className = 'message' + (text ? ' ' + kind : '');
}

function seatKey(seat) {
  return `${seat.row}${seat.number}`;
}

// Restore a persisted hold so a page reload keeps the current hold/countdown.
function loadPersistedHold() {
  try {
    const raw = localStorage.getItem('seat-current-hold');
    if (!raw) return;
    const h = JSON.parse(raw);
    if (h && h.expiresAt && h.expiresAt > Date.now()) {
      state.hold = h;
    } else {
      localStorage.removeItem('seat-current-hold');
    }
  } catch {
    localStorage.removeItem('seat-current-hold');
  }
}

function persistHold() {
  if (state.hold) {
    localStorage.setItem('seat-current-hold', JSON.stringify(state.hold));
  } else {
    localStorage.removeItem('seat-current-hold');
  }
}

// --- Rendering ---
function render() {
  renderSeatMap();
  renderInventory();
  renderControls();
}

function renderSeatMap() {
  // Group seats by row.
  const rows = new Map();
  for (const seat of state.seats.values()) {
    if (!rows.has(seat.row)) rows.set(seat.row, []);
    rows.get(seat.row).push(seat);
  }
  const sortedRows = [...rows.entries()].sort((a, b) =>
    a[0].localeCompare(b[0])
  );

  el.seatmap.innerHTML = '';
  for (const [rowLabel, seats] of sortedRows) {
    seats.sort((a, b) => a.number - b.number);
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';

    const label = document.createElement('span');
    label.className = 'row-label';
    label.textContent = rowLabel;
    rowEl.appendChild(label);

    for (const seat of seats) {
      rowEl.appendChild(renderSeat(seat));
    }
    el.seatmap.appendChild(rowEl);
  }
}

function renderSeat(seat) {
  const btn = document.createElement('button');
  btn.className = 'seat ' + seat.status;
  btn.textContent = seat.number;
  btn.title = `${seatKey(seat)} — ${seat.status}`;
  btn.dataset.seatId = seat.id;

  const holdSeatIds = state.hold ? new Set(state.hold.seatIds) : new Set();
  const isMineHeld = seat.status === 'held' && holdSeatIds.has(seat.id);
  const isMineBooked = seat.status === 'booked' && holdSeatIds.has(seat.id);

  if (state.selected.has(seat.id) && seat.status === 'available') {
    btn.classList.add('selected');
  }
  if (isMineHeld || isMineBooked) {
    btn.classList.add('mine');
  }

  // Interaction: only available seats are selectable, and only when not in a
  // hold/booked flow.
  const interactive =
    seat.status === 'available' && !state.hold && !state.booked;
  btn.disabled = !interactive;

  if (interactive) {
    btn.addEventListener('click', () => toggleSelect(seat.id));
  }
  return btn;
}

function renderInventory() {
  const counts = { available: 0, held: 0, booked: 0 };
  for (const s of state.seats.values()) counts[s.status]++;
  const total = state.seats.size;
  el.inventory.innerHTML =
    `<span>Available: <b>${counts.available}</b></span>` +
    `<span>Held: <b>${counts.held}</b></span>` +
    `<span>Booked: <b>${counts.booked}</b></span>` +
    `<span>Total: <b>${total}</b></span>`;
}

function renderControls() {
  const hasHold = !!state.hold;

  // Hold button.
  el.btnHold.classList.toggle('hidden', hasHold || state.booked);
  el.btnHold.disabled = state.selected.size === 0;

  // Confirm + release buttons.
  el.btnConfirm.classList.toggle('hidden', !hasHold);
  el.btnRelease.classList.toggle('hidden', !hasHold);

  // Hold panel / countdown.
  el.holdPanel.classList.toggle('hidden', !hasHold);

  if (state.booked) {
    el.selectionInfo.textContent = 'Your seats are booked. 🎉';
  } else if (hasHold) {
    const names = state.hold.seatIds
      .map((id) => state.seats.get(id))
      .filter(Boolean)
      .map(seatKey)
      .join(', ');
    el.selectionInfo.textContent = `Holding ${names}. Confirm to book.`;
  } else if (state.selected.size > 0) {
    const names = [...state.selected]
      .map((id) => state.seats.get(id))
      .filter(Boolean)
      .map(seatKey)
      .join(', ');
    el.selectionInfo.textContent = `Selected: ${names}`;
  } else {
    el.selectionInfo.textContent = 'Select one or more available seats.';
  }
}

// --- Selection ---
function toggleSelect(seatId) {
  if (state.selected.has(seatId)) state.selected.delete(seatId);
  else state.selected.add(seatId);
  render();
}

// --- Countdown ---
let countdownTimer = null;
function startCountdown() {
  stopCountdown();
  const tick = () => {
    if (!state.hold) return stopCountdown();
    const remaining = state.hold.expiresAt - Date.now();
    if (remaining <= 0) {
      el.countdown.textContent = '0:00';
      onHoldExpired();
      return;
    }
    const totalSec = Math.ceil(remaining / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    el.countdown.textContent = `${m}:${String(s).padStart(2, '0')}`;
  };
  tick();
  countdownTimer = setInterval(tick, 250);
}
function stopCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = null;
}

function onHoldExpired() {
  stopCountdown();
  setMessage('Your hold expired and the seats were released.', 'info');
  state.hold = null;
  state.selected.clear();
  persistHold();
  render();
  // Re-sync to reflect server truth.
  loadSeats();
}

// --- API actions ---
async function loadSeats() {
  try {
    const res = await fetch(`${API}/seats`);
    const data = await res.json();
    applySeats(data.seats);
    render();
  } catch (err) {
    setMessage('Failed to load seats: ' + err.message, 'error');
  }
}

function applySeats(seats) {
  for (const seat of seats) {
    state.seats.set(seat.id, seat);
  }
}

// Apply a partial update (from SSE) for a subset of seats.
function applySeatChanges(seats) {
  let touchedHold = false;
  for (const seat of seats) {
    state.seats.set(seat.id, seat);
    // If a seat belonging to our hold changed away from our hold, note it.
    if (state.hold && state.hold.seatIds.includes(seat.id)) {
      if (seat.status === 'available') touchedHold = true;
    }
    // Drop any selected seat that is no longer available.
    if (state.selected.has(seat.id) && seat.status !== 'available') {
      state.selected.delete(seat.id);
    }
  }
  // If our hold's seats were released by the server (expiry), clear local hold.
  if (touchedHold && state.hold) {
    const stillHeld = state.hold.seatIds.some((id) => {
      const s = state.seats.get(id);
      return s && s.status === 'held' && s.holdId === state.hold.holdId;
    });
    if (!stillHeld && !state.booked) {
      state.hold = null;
      persistHold();
      stopCountdown();
      setMessage('Your hold expired and the seats were released.', 'info');
    }
  }
}

async function requestHold() {
  const seatIds = [...state.selected];
  if (seatIds.length === 0) return;
  el.btnHold.disabled = true;
  setMessage('Requesting hold…', 'info');
  try {
    const res = await fetch(`${API}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId: SESSION_ID }),
    });

    if (res.status === 409) {
      const data = await res.json();
      handleConflict(data.conflicts || []);
      return;
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    const data = await res.json();
    state.hold = {
      holdId: data.holdId,
      expiresAt: data.expiresAt,
      seatIds: data.seats.map((s) => s.id),
    };
    applySeats(data.seats);
    state.selected.clear();
    persistHold();
    setMessage('Seats held. Confirm to book before the timer runs out.', 'success');
    startCountdown();
    render();
  } catch (err) {
    setMessage('Hold failed: ' + err.message, 'error');
    render();
  }
}

function handleConflict(conflictIds) {
  setMessage(
    'Some seats were just taken by someone else. They are highlighted; please pick others.',
    'error'
  );
  // Flash the conflicting seats.
  for (const id of conflictIds) {
    const btn = el.seatmap.querySelector(`[data-seat-id="${id}"]`);
    if (btn) {
      btn.classList.add('conflict');
      setTimeout(() => btn.classList.remove('conflict'), 1400);
    }
    state.selected.delete(id);
  }
  // Refresh the full seat map to reflect the latest server truth.
  loadSeats();
}

async function confirmBooking() {
  if (!state.hold) return;
  el.btnConfirm.disabled = true;
  setMessage('Confirming…', 'info');
  try {
    const res = await fetch(
      `${API}/holds/${encodeURIComponent(state.hold.holdId)}/confirm`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: SESSION_ID }),
      }
    );
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    applySeats(data.seats);
    state.booked = true;
    stopCountdown();
    // Keep hold.seatIds so the booked seats render as "mine".
    persistHold();
    setMessage(
      data.alreadyBooked
        ? 'Already booked — confirmation is idempotent. ✅'
        : 'Booked! 🎉',
      'success'
    );
    render();
  } catch (err) {
    setMessage('Confirm failed: ' + err.message, 'error');
    el.btnConfirm.disabled = false;
    // The hold likely expired; re-sync.
    loadSeats();
  }
}

async function releaseCurrentHold() {
  if (!state.hold) return;
  el.btnRelease.disabled = true;
  setMessage('Releasing…', 'info');
  try {
    const res = await fetch(
      `${API}/holds/${encodeURIComponent(state.hold.holdId)}`,
      { method: 'DELETE' }
    );
    if (res.ok) {
      const data = await res.json();
      applySeats(data.seats);
    }
  } catch {
    /* ignore; SSE/refresh will reconcile */
  } finally {
    state.hold = null;
    state.selected.clear();
    stopCountdown();
    persistHold();
    setMessage('Hold released.', 'info');
    el.btnRelease.disabled = false;
    render();
    loadSeats();
  }
}

// --- SSE ---
let eventSource = null;
function connectStream() {
  eventSource = new EventSource(`${API}/stream`);

  eventSource.addEventListener('open', () => {
    el.connDot.className = 'dot dot-on';
    el.connLabel.textContent = 'live';
  });

  eventSource.addEventListener('error', () => {
    el.connDot.className = 'dot dot-off';
    el.connLabel.textContent = 'reconnecting…';
    // EventSource auto-reconnects.
  });

  eventSource.addEventListener('snapshot', (e) => {
    const data = JSON.parse(e.data);
    applySeats(data.seats);
    reconcileHoldFromSnapshot();
    render();
  });

  eventSource.addEventListener('seats', (e) => {
    const data = JSON.parse(e.data);
    applySeatChanges(data.seats);
    render();
  });
}

// On (re)connection snapshot, verify our hold still exists server-side.
function reconcileHoldFromSnapshot() {
  if (!state.hold || state.booked) return;
  const stillHeld = state.hold.seatIds.every((id) => {
    const s = state.seats.get(id);
    return s && s.status === 'held' && s.holdId === state.hold.holdId;
  });
  // Maybe it was already booked under this hold.
  const allBooked = state.hold.seatIds.every((id) => {
    const s = state.seats.get(id);
    return s && s.status === 'booked';
  });
  if (allBooked) {
    state.booked = true;
    stopCountdown();
  } else if (!stillHeld) {
    state.hold = null;
    persistHold();
    stopCountdown();
  }
}

// --- Wire up ---
el.btnHold.addEventListener('click', requestHold);
el.btnConfirm.addEventListener('click', confirmBooking);
el.btnRelease.addEventListener('click', releaseCurrentHold);

// --- Boot ---
async function boot() {
  loadPersistedHold();
  await loadSeats();
  reconcileHoldFromSnapshot();
  if (state.hold) startCountdown();
  render();
  connectStream();
}
boot();
