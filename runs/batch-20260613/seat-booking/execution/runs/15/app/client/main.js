// Seat-booking SPA. Renders the seat map, manages selection / hold / confirm,
// and keeps everything live via SSE.

const API = '/api';

// Stable per-browser session id.
function getSessionId() {
  let id = localStorage.getItem('seat-session-id');
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) ||
      's-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('seat-session-id', id);
  }
  return id;
}

const sessionId = getSessionId();

const state = {
  seats: new Map(),       // id -> seat object (effective status from server)
  selected: new Set(),    // seat ids selected for holding
  hold: null,             // { id, seatIds, expiresAt }
  booking: null           // { holdId, seatIds }
};

const els = {
  map: document.getElementById('seatmap'),
  conn: document.getElementById('connection'),
  inventory: document.getElementById('inventory'),
  selectionInfo: document.getElementById('selection-info'),
  holdBtn: document.getElementById('hold-btn'),
  confirmBtn: document.getElementById('confirm-btn'),
  releaseBtn: document.getElementById('release-btn'),
  countdown: document.getElementById('countdown'),
  message: document.getElementById('message'),
  sessionId: document.getElementById('session-id')
};

els.sessionId.textContent = sessionId;

// Restore an in-progress hold across reloads.
const savedHold = localStorage.getItem('seat-active-hold');
if (savedHold) {
  try { state.hold = JSON.parse(savedHold); } catch (_) {}
}

function persistHold() {
  if (state.hold) localStorage.setItem('seat-active-hold', JSON.stringify(state.hold));
  else localStorage.removeItem('seat-active-hold');
}

function setMessage(text, kind = 'info') {
  els.message.textContent = text || '';
  els.message.className = 'message' + (text ? ' ' + kind : '');
}

// --- Rendering ------------------------------------------------------------
function seatClass(seat) {
  const id = seat.id;
  if (state.booking && state.booking.seatIds.includes(id)) return 'booked';
  if (state.hold && state.hold.seatIds.includes(id) && seat.status !== 'booked') {
    return 'mine';
  }
  if (state.selected.has(id)) return 'selected';
  return seat.status; // available | held | booked
}

function renderMap() {
  const rows = new Map();
  for (const seat of state.seats.values()) {
    if (!rows.has(seat.row)) rows.set(seat.row, []);
    rows.get(seat.row).push(seat);
  }
  const rowLabels = [...rows.keys()].sort();

  els.map.innerHTML = '';
  for (const label of rowLabels) {
    const rowEl = document.createElement('div');
    rowEl.className = 'row';
    const lab = document.createElement('span');
    lab.className = 'row-label';
    lab.textContent = label;
    rowEl.appendChild(lab);

    const seats = rows.get(label).sort((a, b) => a.number - b.number);
    for (const seat of seats) {
      const b = document.createElement('button');
      const cls = seatClass(seat);
      b.className = 'seat ' + cls;
      b.textContent = seat.number;
      b.title = `${seat.id} — ${cls}`;
      b.dataset.id = seat.id;
      b.addEventListener('click', () => onSeatClick(seat.id));
      rowEl.appendChild(b);
    }
    els.map.appendChild(rowEl);
  }
  updateControls();
}

function updateControls() {
  const counts = { available: 0, held: 0, booked: 0 };
  for (const s of state.seats.values()) counts[s.status]++;
  els.inventory.textContent =
    `Available ${counts.available} · Held ${counts.held} · Booked ${counts.booked} · Total ${state.seats.size}`;

  const hasSelection = state.selected.size > 0;
  const hasHold = !!state.hold;
  const booked = !!state.booking;

  els.holdBtn.disabled = !hasSelection || hasHold || booked;
  els.confirmBtn.disabled = !hasHold || booked;
  els.releaseBtn.disabled = !hasHold || booked;

  if (booked) {
    els.selectionInfo.textContent =
      `Booked seats: ${state.booking.seatIds.join(', ')}. Enjoy the show!`;
  } else if (hasHold) {
    els.selectionInfo.textContent =
      `Holding ${state.hold.seatIds.join(', ')}. Confirm before the timer runs out.`;
  } else if (hasSelection) {
    els.selectionInfo.textContent =
      `Selected: ${[...state.selected].join(', ')}`;
  } else {
    els.selectionInfo.textContent = 'Select one or more available seats to begin.';
  }
}

// --- Seat selection -------------------------------------------------------
function onSeatClick(id) {
  if (state.hold || state.booking) return; // can't reselect while holding/booked
  const seat = state.seats.get(id);
  if (!seat || seat.status !== 'available') {
    flashConflict([id]);
    return;
  }
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  renderMap();
}

function flashConflict(ids) {
  for (const id of ids) {
    const el = els.map.querySelector(`[data-id="${id}"]`);
    if (el) {
      el.classList.add('conflict');
      setTimeout(() => el.classList.remove('conflict'), 600);
    }
  }
}

// --- API actions ----------------------------------------------------------
async function loadSeats() {
  const res = await fetch(`${API}/seats`);
  const data = await res.json();
  state.seats = new Map(data.seats.map((s) => [s.id, s]));
  // Reconcile a restored hold: if our held seats no longer reference our hold,
  // assume it expired / was confirmed elsewhere.
  reconcileHold();
  renderMap();
}

function reconcileHold() {
  if (!state.hold) return;
  if (state.hold.expiresAt && Date.now() >= state.hold.expiresAt) {
    clearHold('Your hold expired. Seats released.');
    return;
  }
  const allBooked = state.hold.seatIds.every(
    (id) => state.seats.get(id)?.status === 'booked'
  );
  if (allBooked && state.seats.size) {
    // Could have been confirmed on another tab.
    state.booking = { holdId: state.hold.id, seatIds: [...state.hold.seatIds] };
    state.hold = null;
    persistHold();
  }
}

async function requestHold() {
  const seatIds = [...state.selected];
  if (seatIds.length === 0) return;
  setMessage('Placing hold…', 'info');
  try {
    const res = await fetch(`${API}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId })
    });
    if (res.status === 201) {
      const { hold } = await res.json();
      state.hold = { id: hold.id, seatIds: hold.seatIds, expiresAt: hold.expiresAt };
      state.selected.clear();
      persistHold();
      startCountdown();
      setMessage('Seats held! Confirm before the timer expires.', 'success');
      renderMap();
    } else if (res.status === 409) {
      const data = await res.json();
      const conflicts = data.conflicts || [];
      flashConflict(conflicts);
      setMessage(
        `These seats were just taken: ${conflicts.join(', ')}. Map refreshed.`,
        'error'
      );
      // Drop conflicting seats from selection and refresh.
      for (const id of conflicts) state.selected.delete(id);
      await loadSeats();
    } else {
      const data = await res.json().catch(() => ({}));
      setMessage(data.error || 'Failed to place hold.', 'error');
      await loadSeats();
    }
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
      body: JSON.stringify({ sessionId })
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      state.booking = { holdId: state.hold.id, seatIds: data.booking.seatIds };
      state.hold = null;
      persistHold();
      stopCountdown();
      setMessage(
        data.alreadyConfirmed
          ? 'Already confirmed — seats booked.'
          : 'Booking confirmed! 🎉',
        'success'
      );
      await loadSeats();
    } else {
      setMessage(data.error || 'Confirmation failed.', 'error');
      clearHold();
      await loadSeats();
    }
  } catch (err) {
    setMessage('Network error confirming.', 'error');
  }
}

async function releaseCurrentHold() {
  if (!state.hold) return;
  const holdId = state.hold.id;
  setMessage('Releasing…', 'info');
  try {
    await fetch(`${API}/holds/${holdId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    });
  } catch (_) {}
  clearHold('Hold released.');
  await loadSeats();
}

function clearHold(msg) {
  state.hold = null;
  persistHold();
  stopCountdown();
  if (msg) setMessage(msg, 'info');
  renderMap();
}

// --- Countdown ------------------------------------------------------------
let countdownTimer = null;
function startCountdown() {
  stopCountdown();
  els.countdown.classList.remove('hidden');
  tickCountdown();
  countdownTimer = setInterval(tickCountdown, 250);
}
function stopCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = null;
  els.countdown.classList.add('hidden');
}
function tickCountdown() {
  if (!state.hold) { stopCountdown(); return; }
  const remaining = state.hold.expiresAt - Date.now();
  if (remaining <= 0) {
    stopCountdown();
    clearHold('Your hold expired. Seats released.');
    loadSeats();
    return;
  }
  const secs = Math.ceil(remaining / 1000);
  els.countdown.textContent = `⏳ Hold expires in ${secs}s`;
  els.countdown.classList.toggle('expiring', secs <= 10);
}

// --- SSE ------------------------------------------------------------------
function connectStream() {
  const es = new EventSource(`${API}/stream`);
  es.addEventListener('hello', () => {
    els.conn.textContent = 'live';
    els.conn.className = 'conn online';
  });
  es.addEventListener('seat-update', (e) => {
    try {
      const data = JSON.parse(e.data);
      applyUpdates(data.seats);
    } catch (_) {}
  });
  es.onerror = () => {
    els.conn.textContent = 'reconnecting…';
    els.conn.className = 'conn offline';
  };
}

function applyUpdates(updates) {
  let changed = false;
  for (const u of updates) {
    const seat = state.seats.get(u.id);
    if (!seat) continue;
    seat.status = u.status;
    seat.holdExpiresAt = u.holdExpiresAt ?? null;
    if (u.status === 'available') {
      // a held/selected seat freed up elsewhere
    }
    changed = true;
  }
  if (changed) {
    reconcileHold();
    renderMap();
  }
}

// --- Boot -----------------------------------------------------------------
els.holdBtn.addEventListener('click', requestHold);
els.confirmBtn.addEventListener('click', confirmBooking);
els.releaseBtn.addEventListener('click', releaseCurrentHold);

(async function boot() {
  await loadSeats();
  if (state.hold && state.hold.expiresAt > Date.now()) startCountdown();
  connectStream();
})();
