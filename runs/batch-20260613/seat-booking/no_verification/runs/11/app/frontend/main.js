// Seat-booking SPA. Renders an interactive seat map, manages a single active
// hold per session, and stays live via Server-Sent Events.

const API = '/api';

// ---- Session ---------------------------------------------------------------
function getSessionId() {
  let id = localStorage.getItem('seat-session-id');
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) ||
      'sess-' + Math.random().toString(36).slice(2);
    localStorage.setItem('seat-session-id', id);
  }
  return id;
}
let sessionId = getSessionId();

// ---- State -----------------------------------------------------------------
const state = {
  seats: new Map(),     // id -> seat object
  selected: new Set(),  // selected seat ids (pending hold)
  hold: null,           // { holdId, seatIds, expiresAt }
  countdownTimer: null,
};

// Persist active hold across reloads.
function loadHold() {
  try {
    const raw = localStorage.getItem('seat-hold');
    if (raw) state.hold = JSON.parse(raw);
  } catch { /* ignore */ }
}
function saveHold() {
  if (state.hold) localStorage.setItem('seat-hold', JSON.stringify(state.hold));
  else localStorage.removeItem('seat-hold');
}
loadHold();

// ---- DOM refs --------------------------------------------------------------
const seatMapEl = document.getElementById('seat-map');
const holdBtn = document.getElementById('hold-btn');
const confirmBtn = document.getElementById('confirm-btn');
const releaseBtn = document.getElementById('release-btn');
const messageEl = document.getElementById('message');
const selectionInfo = document.getElementById('selection-info');
const holdInfo = document.getElementById('hold-info');
const countdownEl = document.getElementById('countdown');
const inventoryEl = document.getElementById('inventory');
const sessionIdEl = document.getElementById('session-id');
const newSessionBtn = document.getElementById('new-session');
const connStatusEl = document.getElementById('conn-status');

sessionIdEl.textContent = sessionId.slice(0, 12);

// ---- Helpers ---------------------------------------------------------------
function setMessage(text, kind = 'info') {
  messageEl.textContent = text;
  messageEl.className = 'message ' + (kind || '');
}

function effectiveStatus(seat) {
  // A held seat whose hold expired in the client's view should display
  // as available; the server is the source of truth but this avoids a flash.
  if (seat.status === 'held' && seat.holdExpiresAt) {
    if (new Date(seat.holdExpiresAt).getTime() <= Date.now()) return 'available';
  }
  return seat.status;
}

function isMine(seat) {
  return state.hold && seat.holdId === state.hold.holdId;
}

// ---- Rendering -------------------------------------------------------------
function render() {
  // Group seats by row.
  const byRow = new Map();
  for (const seat of state.seats.values()) {
    if (!byRow.has(seat.row)) byRow.set(seat.row, []);
    byRow.get(seat.row).push(seat);
  }
  const rows = [...byRow.keys()].sort();

  seatMapEl.innerHTML = '';
  for (const row of rows) {
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';

    const label = document.createElement('span');
    label.className = 'row-label';
    label.textContent = row;
    rowEl.appendChild(label);

    const seats = byRow.get(row).sort((a, b) => a.number - b.number);
    for (const seat of seats) {
      const status = effectiveStatus(seat);
      const btn = document.createElement('button');
      btn.className = 'seat';
      btn.textContent = seat.number;
      btn.dataset.id = seat.id;
      btn.title = `${seat.row}${seat.number}`;

      let cls = status;
      if (isMine(seat)) cls = 'mine';
      if (state.selected.has(seat.id) && status === 'available') cls = 'selected';
      btn.classList.add(cls);

      const disabled =
        (status !== 'available' && !isMine(seat)) || !!state.hold;
      btn.disabled = disabled;

      if (status === 'available' && !state.hold) {
        btn.addEventListener('click', () => toggleSelect(seat.id));
      }
      rowEl.appendChild(btn);
    }
    seatMapEl.appendChild(rowEl);
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
  inventoryEl.innerHTML = `
    <div><span class="num">${available}</span>Available</div>
    <div><span class="num">${held}</span>Held</div>
    <div><span class="num">${booked}</span>Booked</div>
  `;
}

function renderControls() {
  if (state.hold) {
    selectionInfo.classList.add('hidden');
    holdInfo.classList.remove('hidden');
    holdBtn.classList.add('hidden');
    confirmBtn.classList.remove('hidden');
    releaseBtn.classList.remove('hidden');
  } else {
    selectionInfo.classList.remove('hidden');
    holdInfo.classList.add('hidden');
    holdBtn.classList.remove('hidden');
    confirmBtn.classList.add('hidden');
    releaseBtn.classList.add('hidden');
    holdBtn.disabled = state.selected.size === 0;
    holdBtn.textContent = state.selected.size
      ? `Hold ${state.selected.size} seat${state.selected.size > 1 ? 's' : ''}`
      : 'Hold selected seats';
  }
}

function toggleSelect(id) {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  render();
}

// ---- Countdown -------------------------------------------------------------
function startCountdown() {
  stopCountdown();
  if (!state.hold) return;
  const tick = () => {
    const remaining = new Date(state.hold.expiresAt).getTime() - Date.now();
    if (remaining <= 0) {
      countdownEl.textContent = '0:00';
      stopCountdown();
      onHoldExpiredLocally();
      return;
    }
    const sec = Math.ceil(remaining / 1000);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    countdownEl.textContent = `${m}:${String(s).padStart(2, '0')}`;
  };
  tick();
  state.countdownTimer = setInterval(tick, 250);
}
function stopCountdown() {
  if (state.countdownTimer) clearInterval(state.countdownTimer);
  state.countdownTimer = null;
}
function onHoldExpiredLocally() {
  setMessage('Your hold expired. Seats released.', 'error');
  clearHold();
  fetchSeats();
}

function clearHold() {
  state.hold = null;
  saveHold();
  render();
}

// ---- API calls -------------------------------------------------------------
async function fetchSeats() {
  try {
    const res = await fetch(`${API}/seats`);
    const data = await res.json();
    applySeats(data.seats, true);
  } catch (err) {
    setMessage('Failed to load seats: ' + err.message, 'error');
  }
}

function applySeats(seats, replaceAll = false) {
  if (replaceAll) state.seats.clear();
  for (const seat of seats) {
    state.seats.set(seat.id, seat);
  }
  // If our held seats got released/booked by someone else (or expired),
  // reconcile our local hold view.
  reconcileHold();
  render();
}

function reconcileHold() {
  if (!state.hold) return;
  const stillMine = [...state.seats.values()].some(
    (s) => s.holdId === state.hold.holdId && s.status === 'held'
  );
  const anyBookedByHold = [...state.seats.values()].some(
    (s) => s.status === 'booked' && state.hold.seatIds.includes(s.id)
  );
  if (!stillMine && !anyBookedByHold) {
    // Hold gone (expired/released) and not booked.
    if (new Date(state.hold.expiresAt).getTime() <= Date.now()) {
      // expiry handled by countdown; just clear quietly
    }
    clearHold();
  }
}

async function requestHold() {
  const seatIds = [...state.selected];
  if (seatIds.length === 0) return;
  holdBtn.disabled = true;
  setMessage('Requesting hold…', 'info');
  try {
    const res = await fetch(`${API}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId }),
    });
    if (res.status === 409) {
      const data = await res.json();
      handleConflict(data.conflicts || []);
      return;
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setMessage('Hold failed: ' + (data.error || res.status), 'error');
      return;
    }
    const hold = await res.json();
    state.hold = {
      holdId: hold.holdId,
      seatIds: hold.seatIds,
      expiresAt: hold.expiresAt,
    };
    saveHold();
    state.selected.clear();
    setMessage('Seats held! Confirm before the timer runs out.', 'success');
    await fetchSeats();
    startCountdown();
  } catch (err) {
    setMessage('Hold error: ' + err.message, 'error');
  } finally {
    renderControls();
  }
}

function handleConflict(conflicts) {
  setMessage(
    `Some seats were just taken: ${conflicts
      .map(seatLabel)
      .join(', ')}. Map refreshed.`,
    'error'
  );
  // Flash the conflicting seats.
  for (const id of conflicts) {
    const el = seatMapEl.querySelector(`.seat[data-id="${id}"]`);
    if (el) {
      el.classList.add('conflict');
      setTimeout(() => el.classList.remove('conflict'), 2000);
    }
    state.selected.delete(id);
  }
  fetchSeats();
}

function seatLabel(id) {
  const s = state.seats.get(id);
  return s ? `${s.row}${s.number}` : `#${id}`;
}

async function confirmHold() {
  if (!state.hold) return;
  confirmBtn.disabled = true;
  setMessage('Confirming…', 'info');
  try {
    const res = await fetch(`${API}/holds/${state.hold.holdId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setMessage('Confirm failed: ' + (data.error || res.status), 'error');
      // Hold likely expired; clear and refresh.
      stopCountdown();
      clearHold();
      await fetchSeats();
      return;
    }
    setMessage('Booking confirmed! 🎉', 'success');
    stopCountdown();
    clearHold();
    await fetchSeats();
  } catch (err) {
    setMessage('Confirm error: ' + err.message, 'error');
  } finally {
    confirmBtn.disabled = false;
  }
}

async function releaseHold() {
  if (!state.hold) return;
  releaseBtn.disabled = true;
  setMessage('Releasing…', 'info');
  try {
    await fetch(`${API}/holds/${state.hold.holdId}`, { method: 'DELETE' });
    setMessage('Hold released.', 'info');
  } catch (err) {
    setMessage('Release error: ' + err.message, 'error');
  } finally {
    stopCountdown();
    clearHold();
    await fetchSeats();
    releaseBtn.disabled = false;
  }
}

// ---- SSE -------------------------------------------------------------------
let eventSource = null;
function connectSSE() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`${API}/stream`);

  eventSource.addEventListener('snapshot', (e) => {
    const data = JSON.parse(e.data);
    applySeats(data.seats, true);
    connStatusEl.className = 'conn-status live';
    connStatusEl.textContent = 'Live';
    if (state.hold) startCountdown();
  });

  eventSource.addEventListener('seats', (e) => {
    const data = JSON.parse(e.data);
    applySeats(data.seats, false);
  });

  eventSource.onopen = () => {
    connStatusEl.className = 'conn-status live';
    connStatusEl.textContent = 'Live';
  };
  eventSource.onerror = () => {
    connStatusEl.className = 'conn-status down';
    connStatusEl.textContent = 'Reconnecting…';
  };
}

// ---- Wire up ---------------------------------------------------------------
holdBtn.addEventListener('click', requestHold);
confirmBtn.addEventListener('click', confirmHold);
releaseBtn.addEventListener('click', releaseHold);
newSessionBtn.addEventListener('click', () => {
  localStorage.removeItem('seat-session-id');
  localStorage.removeItem('seat-hold');
  sessionId = getSessionId();
  sessionIdEl.textContent = sessionId.slice(0, 12);
  state.hold = null;
  state.selected.clear();
  stopCountdown();
  setMessage('Started a new session.', 'info');
  fetchSeats();
});

// Initial load.
(async function init() {
  await fetchSeats();
  if (state.hold) {
    if (new Date(state.hold.expiresAt).getTime() > Date.now()) {
      startCountdown();
    } else {
      clearHold();
    }
  }
  connectSSE();
})();
