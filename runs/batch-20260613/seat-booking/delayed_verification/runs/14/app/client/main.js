// Seat-booking SPA: renders the seat map, manages hold/confirm/release flows,
// and stays live via SSE.

const API = '/api';

// --- Session id (client-supplied holder identity) -------------------------
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

// --- App state ------------------------------------------------------------
const state = {
  seats: new Map(),      // id -> seat object (effective)
  selected: new Set(),   // ids selected (not yet held)
  hold: null,            // { id, seatIds, expiresAt }
};

// Restore an in-flight hold across reloads.
try {
  const saved = JSON.parse(localStorage.getItem('seat-active-hold') || 'null');
  if (saved && saved.expiresAt && new Date(saved.expiresAt).getTime() > Date.now()) {
    state.hold = saved;
  } else {
    localStorage.removeItem('seat-active-hold');
  }
} catch (_e) {
  localStorage.removeItem('seat-active-hold');
}

// --- DOM refs -------------------------------------------------------------
const $seatmap = document.getElementById('seatmap');
const $conn = document.getElementById('connection');
const $selectionInfo = document.getElementById('selection-info');
const $holdInfo = document.getElementById('hold-info');
const $holdSeats = document.getElementById('hold-seats');
const $countdown = document.getElementById('countdown');
const $btnHold = document.getElementById('btn-hold');
const $btnConfirm = document.getElementById('btn-confirm');
const $btnRelease = document.getElementById('btn-release');
const $message = document.getElementById('message');
const $counts = {
  available: document.getElementById('c-available'),
  held: document.getElementById('c-held'),
  booked: document.getElementById('c-booked'),
};
document.getElementById('session-id').textContent = sessionId.slice(0, 12) + '…';

// --- Helpers --------------------------------------------------------------
function setMessage(text, kind = 'info') {
  $message.textContent = text;
  $message.className = 'message ' + kind;
}

function holdSeatIds() {
  return state.hold ? state.hold.seatIds : [];
}

// Effective visual status for a seat from the current viewer's perspective.
function visualStatus(seat) {
  const myHeld = holdSeatIds();
  if (seat.status === 'held' && myHeld.includes(seat.id)) return 'held-mine';
  return seat.status;
}

// --- Rendering ------------------------------------------------------------
function renderAll() {
  // Group seats by row preserving order.
  const rows = new Map();
  for (const seat of state.seats.values()) {
    if (!rows.has(seat.row)) rows.set(seat.row, []);
    rows.get(seat.row).push(seat);
  }

  $seatmap.innerHTML = '';
  const sortedRows = [...rows.keys()].sort();
  for (const rowLabel of sortedRows) {
    const seats = rows.get(rowLabel).sort((a, b) => a.number - b.number);
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';

    const label = document.createElement('span');
    label.className = 'row-label';
    label.textContent = rowLabel;
    rowEl.appendChild(label);

    for (const seat of seats) {
      rowEl.appendChild(renderSeat(seat));
    }
    $seatmap.appendChild(rowEl);
  }

  updateCounts();
  updatePanel();
}

function renderSeat(seat) {
  const btn = document.createElement('button');
  const vs = visualStatus(seat);
  btn.className = 'seat ' + vs;
  btn.textContent = seat.number;
  btn.dataset.id = seat.id;
  btn.title = `${seat.id} — ${vs}`;

  if (state.selected.has(seat.id)) btn.classList.add('selected');

  // Booked or held-by-others are not interactive.
  if (seat.status === 'booked') {
    btn.disabled = true;
  } else if (vs === 'held') {
    btn.disabled = true;
  } else {
    btn.addEventListener('click', () => onSeatClick(seat.id));
  }
  return btn;
}

function rerenderSeat(id) {
  const seat = state.seats.get(id);
  if (!seat) return;
  const existing = $seatmap.querySelector(`button[data-id="${CSS.escape(id)}"]`);
  if (existing) existing.replaceWith(renderSeat(seat));
}

function updateCounts() {
  const c = { available: 0, held: 0, booked: 0 };
  for (const s of state.seats.values()) c[s.status]++;
  $counts.available.textContent = c.available;
  $counts.held.textContent = c.held;
  $counts.booked.textContent = c.booked;
}

function updatePanel() {
  if (state.hold) {
    // We have an active hold.
    $holdInfo.classList.remove('hidden');
    $selectionInfo.classList.add('hidden');
    $holdSeats.textContent = state.hold.seatIds.join(', ');
    $btnHold.classList.add('hidden');
    $btnConfirm.classList.remove('hidden');
    $btnRelease.classList.remove('hidden');
  } else {
    $holdInfo.classList.add('hidden');
    $selectionInfo.classList.remove('hidden');
    $btnHold.classList.remove('hidden');
    $btnConfirm.classList.add('hidden');
    $btnRelease.classList.add('hidden');

    const n = state.selected.size;
    $selectionInfo.textContent = n === 0
      ? 'No seats selected. Click available seats to select them.'
      : `Selected ${n} seat${n > 1 ? 's' : ''}: ${[...state.selected].sort().join(', ')}`;
    $btnHold.disabled = n === 0;
  }
}

// --- Interaction ----------------------------------------------------------
function onSeatClick(id) {
  if (state.hold) return; // cannot change selection while holding
  const seat = state.seats.get(id);
  if (!seat || seat.status !== 'available') return;

  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);

  rerenderSeat(id);
  updatePanel();
}

async function requestHold() {
  if (state.selected.size === 0) return;
  const seatIds = [...state.selected];
  $btnHold.disabled = true;
  setMessage('Requesting hold…', 'info');

  try {
    const res = await fetch(`${API}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId }),
    });

    if (res.status === 409) {
      const data = await res.json();
      handleConflict(data.conflicts || seatIds);
      return;
    }
    if (!res.ok) {
      setMessage('Could not create hold. Please try again.', 'error');
      $btnHold.disabled = false;
      return;
    }

    const data = await res.json();
    state.hold = {
      id: data.hold.id,
      seatIds: data.hold.seatIds,
      expiresAt: data.hold.expiresAt,
    };
    localStorage.setItem('seat-active-hold', JSON.stringify(state.hold));
    state.selected.clear();
    setMessage('Seats held! Confirm before the timer runs out.', 'success');
    renderAll();
    startCountdown();
  } catch (e) {
    setMessage('Network error creating hold.', 'error');
    $btnHold.disabled = false;
  }
}

function handleConflict(conflicts) {
  setMessage(
    `These seats were just taken: ${conflicts.join(', ')}. The map has been refreshed.`,
    'error'
  );
  // Drop conflicting seats from selection and flash them.
  for (const id of conflicts) {
    state.selected.delete(id);
    const el = $seatmap.querySelector(`button[data-id="${CSS.escape(id)}"]`);
    if (el) {
      el.classList.add('conflict');
      setTimeout(() => el.classList.remove('conflict'), 600);
    }
  }
  refreshSeats();
  $btnHold.disabled = state.selected.size === 0;
}

async function confirmHold() {
  if (!state.hold) return;
  $btnConfirm.disabled = true;
  setMessage('Confirming…', 'info');

  try {
    const res = await fetch(`${API}/holds/${state.hold.id}/confirm`, { method: 'POST' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const msg = {
        hold_expired: 'Your hold expired before confirmation. Those seats were released.',
        hold_released: 'This hold is no longer active.',
        unknown_hold: 'Hold not found.',
      }[data.error] || 'Confirmation failed.';
      setMessage(msg, 'error');
      clearHold();
      refreshSeats();
      return;
    }
    const data = await res.json();
    setMessage(
      `Booked seats: ${data.booking.seatIds.join(', ')}.` +
        (data.idempotent ? ' (already booked)' : ''),
      'success'
    );
    clearHold();
    refreshSeats();
  } catch (e) {
    setMessage('Network error during confirmation.', 'error');
    $btnConfirm.disabled = false;
  }
}

async function releaseHold() {
  if (!state.hold) return;
  const holdId = state.hold.id;
  setMessage('Releasing hold…', 'info');
  try {
    await fetch(`${API}/holds/${holdId}`, { method: 'DELETE' });
  } catch (_e) {
    /* ignore — expiry will reclaim anyway */
  }
  clearHold();
  setMessage('Hold released.', 'info');
  refreshSeats();
}

function clearHold() {
  state.hold = null;
  localStorage.removeItem('seat-active-hold');
  stopCountdown();
  updatePanel();
}

// --- Countdown ------------------------------------------------------------
let countdownTimer = null;
function startCountdown() {
  stopCountdown();
  tickCountdown();
  countdownTimer = setInterval(tickCountdown, 1000);
}
function stopCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = null;
}
function tickCountdown() {
  if (!state.hold) return stopCountdown();
  const remaining = new Date(state.hold.expiresAt).getTime() - Date.now();
  if (remaining <= 0) {
    $countdown.textContent = '00:00';
    setMessage('Your hold has expired. The seats were released.', 'error');
    clearHold();
    refreshSeats();
    return;
  }
  const total = Math.ceil(remaining / 1000);
  const m = String(Math.floor(total / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  $countdown.textContent = `${m}:${s}`;
}

// --- Data sync ------------------------------------------------------------
function applySeats(seatList) {
  for (const seat of seatList) {
    state.seats.set(seat.id, seat);
  }
}

// Reconcile our active hold against the latest server view: if any of our
// held seats are no longer held by us, the hold is gone.
function reconcileHold() {
  if (!state.hold) return;
  const mine = state.hold.seatIds;
  let stillHeld = 0;
  let bookedByUs = 0;
  for (const id of mine) {
    const seat = state.seats.get(id);
    if (!seat) continue;
    if (seat.status === 'held' && seat.holdId === state.hold.id) stillHeld++;
    if (seat.status === 'booked' && seat.bookedBy === state.hold.id) bookedByUs++;
  }
  if (bookedByUs === mine.length) {
    // Confirmed elsewhere / already booked.
    clearHold();
  } else if (stillHeld === 0 && bookedByUs === 0) {
    // Hold vanished (expired or released).
    clearHold();
  }
}

async function refreshSeats() {
  try {
    const res = await fetch(`${API}/seats`);
    const data = await res.json();
    state.seats.clear();
    applySeats(data.seats);
    reconcileHold();
    renderAll();
    if (state.hold) startCountdown();
  } catch (e) {
    setMessage('Could not load seats.', 'error');
  }
}

// --- SSE ------------------------------------------------------------------
function connectStream() {
  const es = new EventSource(`${API}/stream`);

  es.addEventListener('open', () => {
    $conn.textContent = 'live';
    $conn.className = 'conn connected';
  });

  es.addEventListener('snapshot', (ev) => {
    const data = JSON.parse(ev.data);
    state.seats.clear();
    applySeats(data.seats);
    reconcileHold();
    renderAll();
    if (state.hold) startCountdown();
  });

  es.addEventListener('seats-updated', (ev) => {
    const data = JSON.parse(ev.data);
    applySeats(data.seats);
    reconcileHold();
    // Targeted re-render of changed seats keeps it smooth.
    for (const seat of data.seats) rerenderSeat(seat.id);
    updateCounts();
    updatePanel();
  });

  es.addEventListener('error', () => {
    $conn.textContent = 'reconnecting…';
    $conn.className = 'conn disconnected';
    // EventSource auto-reconnects; nothing else to do.
  });
}

// --- Wire up --------------------------------------------------------------
$btnHold.addEventListener('click', requestHold);
$btnConfirm.addEventListener('click', confirmHold);
$btnRelease.addEventListener('click', releaseHold);

// Initial load: fetch seats then open the live stream.
(async function init() {
  await refreshSeats();
  if (state.hold) startCountdown();
  connectStream();
})();
