// --- Session identity (client-supplied; no auth) ---
function getSessionId() {
  let id = localStorage.getItem('seat-session-id');
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) ||
      's-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('seat-session-id', id);
  }
  return id;
}
const SESSION_ID = getSessionId();
document.getElementById('session-id').textContent = SESSION_ID;

// --- State ---
const state = {
  seats: new Map(), // id -> seat object
  selected: new Set(),
  hold: null, // { id, seatIds, expiresAt }
  ttlMs: 60000,
};

let countdownTimer = null;

// --- DOM refs ---
const seatmapEl = document.getElementById('seatmap');
const selectionListEl = document.getElementById('selection-list');
const holdBtn = document.getElementById('hold-btn');
const holdBox = document.getElementById('hold-box');
const holdSeatsEl = document.getElementById('hold-seats');
const countdownEl = document.getElementById('countdown');
const confirmBtn = document.getElementById('confirm-btn');
const releaseBtn = document.getElementById('release-btn');
const messageEl = document.getElementById('message');
const connDot = document.getElementById('conn-dot');
const connText = document.getElementById('conn-text');
const invAvailable = document.getElementById('inv-available');
const invHeld = document.getElementById('inv-held');
const invBooked = document.getElementById('inv-booked');

// --- API helpers ---
async function api(path, opts) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  let body = null;
  try { body = await res.json(); } catch { /* empty */ }
  return { ok: res.ok, status: res.status, body };
}

function showMessage(text, kind = 'error') {
  messageEl.textContent = text;
  messageEl.className = `message ${kind}`;
  messageEl.classList.remove('hidden');
}
function clearMessage() {
  messageEl.classList.add('hidden');
}

// --- Rendering ---
function seatClass(seat) {
  if (seat.status === 'booked') return 'booked';
  if (seat.status === 'held') {
    return state.hold && seat.hold_id === state.hold.id ? 'mine' : 'held';
  }
  // available
  return state.selected.has(seat.id) ? 'available selected' : 'available';
}

function renderSeatMap() {
  const byRow = new Map();
  for (const seat of state.seats.values()) {
    if (!byRow.has(seat.row_label)) byRow.set(seat.row_label, []);
    byRow.get(seat.row_label).push(seat);
  }
  const rows = [...byRow.keys()].sort();

  seatmapEl.innerHTML = '';
  for (const row of rows) {
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';

    const label = document.createElement('span');
    label.className = 'row-label';
    label.textContent = row;
    rowEl.appendChild(label);

    const seats = byRow.get(row).sort((a, b) => a.seat_number - b.seat_number);
    for (const seat of seats) {
      const btn = document.createElement('button');
      btn.className = `seat ${seatClass(seat)}`;
      btn.textContent = seat.seat_number;
      btn.title = seat.id;
      btn.dataset.id = seat.id;
      const selectable = seat.status === 'available' && !state.hold;
      btn.disabled = !selectable;
      btn.addEventListener('click', () => toggleSelect(seat.id));
      rowEl.appendChild(btn);
    }
    seatmapEl.appendChild(rowEl);
  }

  renderInventory();
  renderSelection();
}

function renderInventory() {
  let a = 0, h = 0, b = 0;
  for (const s of state.seats.values()) {
    if (s.status === 'available') a++;
    else if (s.status === 'held') h++;
    else if (s.status === 'booked') b++;
  }
  invAvailable.textContent = a;
  invHeld.textContent = h;
  invBooked.textContent = b;
}

function renderSelection() {
  const ids = [...state.selected].sort();
  if (ids.length === 0) {
    selectionListEl.textContent = 'No seats selected.';
    selectionListEl.classList.add('muted');
  } else {
    selectionListEl.textContent = ids.join(', ');
    selectionListEl.classList.remove('muted');
  }
  holdBtn.disabled = ids.length === 0 || !!state.hold;
}

function toggleSelect(id) {
  if (state.hold) return;
  const seat = state.seats.get(id);
  if (!seat || seat.status !== 'available') return;
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  renderSeatMap();
}

// --- Hold lifecycle ---
function startCountdown() {
  stopCountdown();
  const tick = () => {
    if (!state.hold) return stopCountdown();
    const remaining = new Date(state.hold.expiresAt).getTime() - Date.now();
    if (remaining <= 0) {
      countdownEl.textContent = '0s';
      onHoldExpired();
      return;
    }
    const secs = Math.ceil(remaining / 1000);
    countdownEl.textContent = `${secs}s`;
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
  showMessage('Your hold expired and the seats were released.', 'error');
  state.hold = null;
  holdBox.classList.add('hidden');
  refreshSeats();
}

function showHold() {
  holdSeatsEl.textContent = 'Seats: ' + state.hold.seatIds.slice().sort().join(', ');
  holdBox.classList.remove('hidden');
  startCountdown();
}

async function requestHold() {
  clearMessage();
  const seatIds = [...state.selected];
  if (seatIds.length === 0) return;
  holdBtn.disabled = true;

  const { ok, status, body } = await api('/api/holds', {
    method: 'POST',
    body: JSON.stringify({ seatIds, sessionId: SESSION_ID }),
  });

  if (ok) {
    state.hold = {
      id: body.hold.id,
      seatIds: body.hold.seatIds,
      expiresAt: body.hold.expiresAt,
    };
    state.selected.clear();
    showMessage('Seats held! Confirm before the timer runs out.', 'success');
    showHold();
    await refreshSeats();
  } else if (status === 409) {
    const conflicts = (body && body.conflicts) || [];
    showMessage(
      `Could not hold — already taken: ${conflicts.join(', ')}. Map refreshed.`,
      'error'
    );
    // Drop conflicting seats from selection and refresh.
    for (const id of conflicts) state.selected.delete(id);
    await refreshSeats();
  } else {
    showMessage((body && body.error) || 'Failed to create hold.', 'error');
    await refreshSeats();
  }
}

async function confirmHold() {
  if (!state.hold) return;
  clearMessage();
  confirmBtn.disabled = true;

  const { ok, body } = await api(`/api/holds/${state.hold.id}/confirm`, {
    method: 'POST',
  });

  if (ok) {
    const seats = body.booking.seatIds.slice().sort().join(', ');
    showMessage(`Booked! Seats ${seats} are now yours.`, 'success');
    state.hold = null;
    holdBox.classList.add('hidden');
    stopCountdown();
  } else {
    showMessage((body && body.error) || 'Could not confirm hold.', 'error');
    state.hold = null;
    holdBox.classList.add('hidden');
    stopCountdown();
  }
  confirmBtn.disabled = false;
  await refreshSeats();
}

async function releaseHold() {
  if (!state.hold) return;
  clearMessage();
  const holdId = state.hold.id;
  state.hold = null;
  holdBox.classList.add('hidden');
  stopCountdown();
  await api(`/api/holds/${holdId}`, { method: 'DELETE' });
  showMessage('Hold released.', 'success');
  await refreshSeats();
}

// --- Data load ---
function applySeats(seatArray) {
  for (const s of seatArray) state.seats.set(s.id, s);
}

async function refreshSeats() {
  const { ok, body } = await api('/api/seats');
  if (ok && body) {
    state.seats.clear();
    applySeats(body.seats);
    if (body.ttlMs) state.ttlMs = body.ttlMs;
    renderSeatMap();
  }
}

// --- SSE live updates ---
function connectStream() {
  const es = new EventSource('/api/stream');

  es.addEventListener('connected', () => {
    connDot.className = 'dot online';
    connText.textContent = 'live';
  });

  const handleSeatEvent = (e) => {
    try {
      const msg = JSON.parse(e.data);
      const seats = (msg.payload && msg.payload.seats) || [];
      for (const s of seats) state.seats.set(s.id, s);
      // If one of our held seats was released by expiry elsewhere, drop hold.
      if (state.hold && msg.type === 'released') {
        const releasedIds = new Set((msg.payload && msg.payload.seatIds) || []);
        if (state.hold.seatIds.some((id) => releasedIds.has(id))) {
          state.hold = null;
          holdBox.classList.add('hidden');
          stopCountdown();
        }
      }
      renderSeatMap();
    } catch { /* ignore */ }
  };

  es.addEventListener('held', handleSeatEvent);
  es.addEventListener('booked', handleSeatEvent);
  es.addEventListener('released', handleSeatEvent);

  es.onerror = () => {
    connDot.className = 'dot offline';
    connText.textContent = 'reconnecting…';
  };
}

// --- Wire up ---
holdBtn.addEventListener('click', requestHold);
confirmBtn.addEventListener('click', confirmHold);
releaseBtn.addEventListener('click', releaseHold);

(async function init() {
  await refreshSeats();
  // Allow disabling the live stream (e.g. for static rendering/screenshots)
  // via ?nostream — normal usage always connects.
  if (!new URLSearchParams(location.search).has('nostream')) {
    connectStream();
  } else {
    connDot.className = 'dot online';
    connText.textContent = 'live';
  }
})();
