// Seat-booking SPA frontend.

const API = '/api';

// A stable per-browser session id identifies the holder.
function getSessionId() {
  let id = localStorage.getItem('seat-session-id');
  if (!id) {
    id =
      (crypto.randomUUID && crypto.randomUUID()) ||
      `s-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    localStorage.setItem('seat-session-id', id);
  }
  return id;
}
const sessionId = getSessionId();

// --- State ----------------------------------------------------------------
const state = {
  seats: new Map(), // id -> seat object
  selected: new Set(), // seat ids selected (pre-hold)
  hold: null, // { id, seatIds, expiresAt }
  ttlMs: 120000,
};

// --- DOM refs --------------------------------------------------------------
const seatmapEl = document.getElementById('seatmap');
const inventoryEl = document.getElementById('inventory');
const connectionEl = document.getElementById('connection');
const holdBtn = document.getElementById('holdBtn');
const confirmBtn = document.getElementById('confirmBtn');
const releaseBtn = document.getElementById('releaseBtn');
const countdownEl = document.getElementById('countdown');
const messageEl = document.getElementById('message');

// --- Helpers ---------------------------------------------------------------
function setMessage(text, kind = '') {
  messageEl.textContent = text;
  messageEl.className = `message ${kind}`;
}

function seatVisualClass(seat) {
  if (state.selected.has(seat.id)) return 'selected';
  if (seat.status === 'booked') return 'booked';
  if (seat.status === 'held') {
    if (state.hold && seat.holdId === state.hold.id) return 'mine';
    return 'held';
  }
  return 'available';
}

function isMyHoldSeat(seat) {
  return state.hold && seat.holdId === state.hold.id && seat.status === 'held';
}

// --- Rendering -------------------------------------------------------------
function render() {
  // Group seats by row.
  const byRow = new Map();
  for (const seat of state.seats.values()) {
    if (!byRow.has(seat.row)) byRow.set(seat.row, []);
    byRow.get(seat.row).push(seat);
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

    const seats = byRow.get(row).sort((a, b) => a.number - b.number);
    for (const seat of seats) {
      const btn = document.createElement('button');
      btn.className = `seat ${seatVisualClass(seat)}`;
      btn.textContent = seat.number;
      btn.dataset.id = seat.id;
      btn.title = `${seat.id} — ${seat.status}`;

      const blocked =
        (seat.status === 'held' && !isMyHoldSeat(seat)) ||
        seat.status === 'booked' ||
        state.hold != null; // while holding, no re-selection
      btn.disabled = blocked;

      btn.addEventListener('click', () => toggleSeat(seat.id));
      rowEl.appendChild(btn);
    }
    seatmapEl.appendChild(rowEl);
  }

  updateInventory();
  updateControls();
}

function updateInventory() {
  let available = 0;
  let held = 0;
  let booked = 0;
  for (const seat of state.seats.values()) {
    if (seat.status === 'available') available++;
    else if (seat.status === 'held') held++;
    else if (seat.status === 'booked') booked++;
  }
  inventoryEl.innerHTML =
    `<span>🟢 ${available} available</span>` +
    `<span>🟠 ${held} held</span>` +
    `<span>⚫ ${booked} booked</span>`;
}

function updateControls() {
  holdBtn.disabled = state.selected.size === 0 || state.hold != null;
  confirmBtn.disabled = state.hold == null;
  releaseBtn.disabled = state.hold == null;
}

// --- Selection -------------------------------------------------------------
function toggleSeat(id) {
  if (state.hold) return; // cannot change selection while holding
  const seat = state.seats.get(id);
  if (!seat || seat.status !== 'available') return;
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  render();
}

// --- Countdown -------------------------------------------------------------
let countdownTimer = null;
function startCountdown() {
  stopCountdown();
  const tick = () => {
    if (!state.hold) {
      stopCountdown();
      return;
    }
    const remaining = state.hold.expiresAt - Date.now();
    if (remaining <= 0) {
      countdownEl.textContent = '';
      setMessage('Your hold expired and the seats were released.', 'error');
      clearHold();
      refreshSeats();
      return;
    }
    const secs = Math.ceil(remaining / 1000);
    const mm = String(Math.floor(secs / 60)).padStart(2, '0');
    const ss = String(secs % 60).padStart(2, '0');
    countdownEl.textContent = `⏳ Hold expires in ${mm}:${ss}`;
    countdownEl.className = secs <= 15 ? 'countdown warn' : 'countdown';
  };
  tick();
  countdownTimer = setInterval(tick, 250);
}
function stopCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = null;
}

function clearHold() {
  state.hold = null;
  stopCountdown();
  countdownEl.textContent = '';
  updateControls();
}

// --- API actions -----------------------------------------------------------
async function refreshSeats() {
  try {
    const res = await fetch(`${API}/seats`);
    const data = await res.json();
    state.ttlMs = data.ttlMs;
    applySeats(data.seats);
  } catch (err) {
    setMessage('Failed to load seats. Retrying…', 'error');
  }
}

function applySeats(seatList) {
  for (const seat of seatList) {
    state.seats.set(seat.id, seat);
    // Drop selection if a seat is no longer available to us.
    if (
      state.selected.has(seat.id) &&
      seat.status !== 'available'
    ) {
      state.selected.delete(seat.id);
    }
  }
  render();
}

async function requestHold() {
  if (state.selected.size === 0) return;
  const seatIds = [...state.selected];
  holdBtn.disabled = true;
  try {
    const res = await fetch(`${API}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId }),
    });
    if (res.status === 409) {
      const data = await res.json();
      indicateConflicts(data.conflicts || []);
      setMessage(
        `Seats ${(data.conflicts || []).join(', ')} were just taken. Map refreshed.`,
        'error'
      );
      state.selected.clear();
      await refreshSeats();
      return;
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setMessage(data.error || 'Could not place hold.', 'error');
      return;
    }
    const { hold } = await res.json();
    state.hold = { id: hold.id, seatIds: hold.seatIds, expiresAt: hold.expiresAt };
    state.selected.clear();
    setMessage(`Held ${hold.seatIds.join(', ')}. Confirm before the timer runs out.`, 'success');
    startCountdown();
    await refreshSeats();
  } catch (err) {
    setMessage('Network error placing hold.', 'error');
  } finally {
    updateControls();
  }
}

function indicateConflicts(conflicts) {
  for (const id of conflicts) {
    const el = seatmapEl.querySelector(`.seat[data-id="${id}"]`);
    if (el) {
      el.classList.add('conflict');
      setTimeout(() => el.classList.remove('conflict'), 1300);
    }
  }
}

async function confirmHold() {
  if (!state.hold) return;
  confirmBtn.disabled = true;
  try {
    const res = await fetch(`${API}/holds/${state.hold.id}/confirm`, {
      method: 'POST',
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setMessage(data.error || 'Could not confirm hold.', 'error');
      clearHold();
      await refreshSeats();
      return;
    }
    const { booking } = await res.json();
    setMessage(`✅ Booked ${booking.seatIds.join(', ')}!`, 'success');
    clearHold();
    await refreshSeats();
  } catch (err) {
    setMessage('Network error confirming hold.', 'error');
  } finally {
    updateControls();
  }
}

async function releaseHold() {
  if (!state.hold) return;
  const holdId = state.hold.id;
  releaseBtn.disabled = true;
  try {
    await fetch(`${API}/holds/${holdId}`, { method: 'DELETE' });
    setMessage('Hold released.', '');
  } catch (err) {
    // even on error, drop the local hold
  } finally {
    clearHold();
    await refreshSeats();
  }
}

// --- SSE -------------------------------------------------------------------
function connectStream() {
  const es = new EventSource(`${API}/stream`);

  es.addEventListener('hello', (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.ttl) state.ttlMs = data.ttl;
    } catch {}
    connectionEl.textContent = '● live';
    connectionEl.className = 'connection live';
  });

  es.addEventListener('seats', (e) => {
    try {
      const data = JSON.parse(e.data);
      applySeats(data.seats || []);

      // If one of our held seats was released/booked by the server (expiry),
      // and it's no longer ours, drop the hold locally.
      if (state.hold) {
        const stillMine = state.hold.seatIds.some((id) => {
          const s = state.seats.get(id);
          return s && s.status === 'held' && s.holdId === state.hold.id;
        });
        if (!stillMine) {
          clearHold();
        }
      }
    } catch {}
  });

  es.onopen = () => {
    connectionEl.textContent = '● live';
    connectionEl.className = 'connection live';
  };
  es.onerror = () => {
    connectionEl.textContent = '○ reconnecting…';
    connectionEl.className = 'connection down';
    // EventSource auto-reconnects.
  };
}

// --- Wire up ---------------------------------------------------------------
holdBtn.addEventListener('click', requestHold);
confirmBtn.addEventListener('click', confirmHold);
releaseBtn.addEventListener('click', releaseHold);

refreshSeats();
connectStream();
