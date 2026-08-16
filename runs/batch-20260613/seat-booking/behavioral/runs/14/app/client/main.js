// Seat-booking SPA frontend.
// Renders the seat map, manages selection / hold / confirm flows, and stays
// live via Server-Sent Events.

const API = ''; // same-origin (dev uses Vite proxy)

// --- Session identity (client-supplied; no auth) ---
function getSessionId() {
  let id = localStorage.getItem('seat-session-id');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('seat-session-id', id);
  }
  return id;
}
const sessionId = getSessionId();

// --- App state ---
const state = {
  seats: new Map(), // id -> seat object
  selected: new Set(), // seat ids selected for hold
  hold: null, // { holdId, seatIds, expiresAt }
  ttlMs: 0,
};

// --- DOM refs ---
const seatmapEl = document.getElementById('seatmap');
const statusLine = document.getElementById('status-line');
const selectionInfo = document.getElementById('selection-info');
const holdBtn = document.getElementById('hold-btn');
const confirmBtn = document.getElementById('confirm-btn');
const releaseBtn = document.getElementById('release-btn');
const countdownEl = document.getElementById('countdown');
const messageEl = document.getElementById('message');

function setMessage(text, kind = '') {
  messageEl.textContent = text;
  messageEl.className = 'message' + (kind ? ' ' + kind : '');
}

// --- Rendering ---
function render() {
  // Group seats by row.
  const rows = new Map();
  for (const seat of state.seats.values()) {
    if (!rows.has(seat.row)) rows.set(seat.row, []);
    rows.get(seat.row).push(seat);
  }

  seatmapEl.innerHTML = '';
  const sortedRows = [...rows.keys()].sort();
  for (const row of sortedRows) {
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';

    const label = document.createElement('span');
    label.className = 'row-label';
    label.textContent = row;
    rowEl.appendChild(label);

    const seats = rows.get(row).sort((a, b) => a.number - b.number);
    for (const seat of seats) {
      const el = document.createElement('button');
      el.className = 'seat';
      el.textContent = seat.number;
      el.dataset.id = seat.id;
      el.title = seat.id;

      const mineHold = state.hold && state.hold.seatIds.includes(seat.id);
      if (seat.status === 'booked') {
        el.classList.add('booked');
      } else if (seat.status === 'held') {
        el.classList.add(mineHold ? 'mine' : 'held');
      } else {
        el.classList.add('available');
      }

      if (state.selected.has(seat.id)) el.classList.add('selected');

      el.addEventListener('click', () => toggleSeat(seat.id));
      rowEl.appendChild(el);
    }
    seatmapEl.appendChild(rowEl);
  }
  updateControls();
}

function toggleSeat(id) {
  // Cannot change selection while holding.
  if (state.hold) return;
  const seat = state.seats.get(id);
  if (!seat || seat.status !== 'available') return;
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  render();
}

function updateControls() {
  if (state.hold) {
    selectionInfo.textContent = `Holding: ${state.hold.seatIds.join(', ')}`;
    holdBtn.disabled = true;
    confirmBtn.disabled = false;
    releaseBtn.disabled = false;
  } else {
    const n = state.selected.size;
    selectionInfo.textContent = n
      ? `${n} seat(s) selected: ${[...state.selected].join(', ')}`
      : 'No seats selected.';
    holdBtn.disabled = n === 0;
    confirmBtn.disabled = true;
    releaseBtn.disabled = true;
    countdownEl.textContent = '';
  }
}

// --- Countdown ---
let countdownTimer = null;
function startCountdown() {
  stopCountdown();
  countdownTimer = setInterval(tickCountdown, 250);
  tickCountdown();
}
function stopCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = null;
}
function tickCountdown() {
  if (!state.hold) {
    countdownEl.textContent = '';
    return;
  }
  const remaining = new Date(state.hold.expiresAt).getTime() - Date.now();
  if (remaining <= 0) {
    countdownEl.textContent = 'Hold expired.';
    setMessage('Your hold expired and the seats were released.', 'error');
    clearHold();
    refreshSeats();
    return;
  }
  const s = Math.ceil(remaining / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  countdownEl.textContent = `Hold expires in ${mm}:${ss}`;
}

function clearHold() {
  state.hold = null;
  stopCountdown();
  updateControls();
}

// --- API calls ---
async function refreshSeats() {
  const res = await fetch(`${API}/api/seats`);
  const data = await res.json();
  state.ttlMs = data.ttlMs;
  state.seats = new Map(data.seats.map((s) => [s.id, s]));
  // Drop selections that are no longer available.
  for (const id of [...state.selected]) {
    const s = state.seats.get(id);
    if (!s || s.status !== 'available') state.selected.delete(id);
  }
  render();
}

async function requestHold() {
  const seatIds = [...state.selected];
  if (seatIds.length === 0) return;
  setMessage('');
  const res = await fetch(`${API}/api/holds`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seatIds, sessionId }),
  });

  if (res.status === 201) {
    const hold = await res.json();
    state.hold = hold;
    state.selected.clear();
    setMessage(`Held ${hold.seatIds.length} seat(s). Confirm before the timer runs out!`, 'success');
    startCountdown();
    await refreshSeats();
  } else if (res.status === 409) {
    const data = await res.json();
    const conflicts = data.conflicts || [];
    setMessage(
      `These seats were just taken: ${conflicts.join(', ')}. Map refreshed.`,
      'error'
    );
    flashConflicts(conflicts);
    // Drop conflicting seats from selection and refresh.
    for (const id of conflicts) state.selected.delete(id);
    await refreshSeats();
  } else {
    const data = await res.json().catch(() => ({}));
    setMessage(data.error || 'Could not create hold.', 'error');
    await refreshSeats();
  }
}

function flashConflicts(ids) {
  for (const id of ids) {
    const el = seatmapEl.querySelector(`.seat[data-id="${id}"]`);
    if (el) {
      el.classList.add('conflict');
      setTimeout(() => el.classList.remove('conflict'), 500);
    }
  }
}

async function confirmHold() {
  if (!state.hold) return;
  const res = await fetch(`${API}/api/holds/${state.hold.holdId}/confirm`, {
    method: 'POST',
  });
  if (res.ok) {
    const booking = await res.json();
    setMessage(`Booked ${booking.seatIds.join(', ')} ✅`, 'success');
    clearHold();
    await refreshSeats();
  } else {
    const data = await res.json().catch(() => ({}));
    setMessage(data.error || 'Could not confirm hold.', 'error');
    clearHold();
    await refreshSeats();
  }
}

async function releaseHold() {
  if (!state.hold) return;
  const holdId = state.hold.holdId;
  clearHold();
  await fetch(`${API}/api/holds/${holdId}`, { method: 'DELETE' }).catch(() => {});
  setMessage('Hold released.', '');
  await refreshSeats();
}

// --- SSE live updates ---
function applyEvents(events) {
  for (const ev of events) {
    const seat = state.seats.get(ev.seatId);
    if (!seat) continue;
    seat.status = ev.status;
    if (ev.status === 'held') {
      seat.holdId = ev.holdId;
      seat.holdExpiresAt = ev.holdExpiresAt;
    } else {
      seat.holdId = null;
      seat.holdExpiresAt = null;
    }
    // If a seat we have selected got taken, drop it.
    if (ev.status !== 'available' && state.selected.has(ev.seatId)) {
      const mine = state.hold && state.hold.seatIds.includes(ev.seatId);
      if (!mine) state.selected.delete(ev.seatId);
    }
  }
  render();
}

function connectSSE() {
  const es = new EventSource(`${API}/api/stream`);
  es.onopen = () => {
    statusLine.textContent = 'Live — seat map syncs in real time';
    statusLine.className = 'status-line live';
  };
  es.addEventListener('seats', (e) => {
    try {
      const data = JSON.parse(e.data);
      applyEvents(data.events);
    } catch {
      /* ignore malformed */
    }
  });
  es.onerror = () => {
    statusLine.textContent = 'Disconnected — retrying…';
    statusLine.className = 'status-line down';
  };
}

// --- Wire up ---
holdBtn.addEventListener('click', requestHold);
confirmBtn.addEventListener('click', confirmHold);
releaseBtn.addEventListener('click', releaseHold);

(async function init() {
  await refreshSeats();
  connectSSE();
})();
