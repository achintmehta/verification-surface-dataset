// ---------------------------------------------------------------------------
// Seat-booking SPA (Vanilla JS)
//
// Renders the seat map, lets the user select available seats, place an
// all-or-nothing hold with a live TTL countdown, confirm the hold to book,
// and release it. Subscribes to SSE so other users' actions appear live.
// ---------------------------------------------------------------------------

const API = '/api';

// A stable per-tab session id identifies this holder. Persisted so a reload
// keeps ownership of any active hold.
function getSessionId() {
  let id = localStorage.getItem('seatSessionId');
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) ||
      'sess-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('seatSessionId', id);
  }
  return id;
}

const sessionId = getSessionId();

// ---- App state -------------------------------------------------------------
const state = {
  seats: new Map(),       // id -> seat object
  selected: new Set(),    // currently-selected available seat ids
  hold: null,             // { id, seatIds, expiresAt }
  holdTtlMs: 60000,
  booking: null,          // { holdId, seatIds }
  countdownTimer: null
};

// Restore any in-progress hold from localStorage (survives reload).
function loadStoredHold() {
  try {
    const raw = localStorage.getItem('currentHold');
    if (!raw) return;
    const h = JSON.parse(raw);
    if (h && h.expiresAt && new Date(h.expiresAt).getTime() > Date.now()) {
      state.hold = h;
    } else {
      localStorage.removeItem('currentHold');
    }
  } catch {
    localStorage.removeItem('currentHold');
  }
}

function storeHold() {
  if (state.hold) {
    localStorage.setItem('currentHold', JSON.stringify(state.hold));
  } else {
    localStorage.removeItem('currentHold');
  }
}

// ---- DOM refs --------------------------------------------------------------
const els = {
  seatmap: document.getElementById('seatmap'),
  inventory: document.getElementById('inventory'),
  selectionInfo: document.getElementById('selection-info'),
  holdBtn: document.getElementById('hold-btn'),
  holdPanel: document.getElementById('hold-panel'),
  confirmBtn: document.getElementById('confirm-btn'),
  releaseBtn: document.getElementById('release-btn'),
  countdown: document.getElementById('countdown'),
  message: document.getElementById('message'),
  connection: document.getElementById('connection'),
  sessionId: document.getElementById('session-id')
};

els.sessionId.textContent = sessionId;

// ---- Helpers ---------------------------------------------------------------
function setMessage(text, kind = 'info') {
  els.message.textContent = text;
  els.message.className = 'message ' + kind;
}

// Effective status of a seat from this client's perspective.
function effectiveClass(seat) {
  if (seat.status === 'booked') {
    return seat.bookedBy === sessionId ? 'booked-mine' : 'booked';
  }
  if (seat.status === 'held') {
    // Is this seat held by us (our active hold)?
    if (state.hold && seat.holdId === state.hold.id) return 'held-mine';
    return 'held';
  }
  // available
  if (state.selected.has(seat.id)) return 'selected';
  return 'available';
}

// ---- Rendering -------------------------------------------------------------
function render() {
  // Group seats by row.
  const rows = new Map();
  for (const seat of state.seats.values()) {
    if (!rows.has(seat.rowLabel)) rows.set(seat.rowLabel, []);
    rows.get(seat.rowLabel).push(seat);
  }

  const rowLabels = [...rows.keys()].sort();
  els.seatmap.innerHTML = '';
  for (const label of rowLabels) {
    const seats = rows.get(label).sort((a, b) => a.seatNumber - b.seatNumber);
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';

    const labelEl = document.createElement('span');
    labelEl.className = 'row-label';
    labelEl.textContent = label;
    rowEl.appendChild(labelEl);

    for (const seat of seats) {
      const btn = document.createElement('button');
      const cls = effectiveClass(seat);
      btn.className = 'seat ' + cls;
      btn.textContent = seat.seatNumber;
      btn.dataset.id = seat.id;
      btn.title = `${seat.id} — ${seat.status}`;
      // Disable seats that cannot be interacted with.
      if (cls === 'held' || cls === 'booked' || cls === 'booked-mine') {
        btn.disabled = true;
      }
      btn.addEventListener('click', () => onSeatClick(seat.id));
      rowEl.appendChild(btn);
    }
    els.seatmap.appendChild(rowEl);
  }

  renderInventory();
  renderControls();
}

function renderInventory() {
  let available = 0, held = 0, booked = 0;
  for (const seat of state.seats.values()) {
    if (seat.status === 'available') available++;
    else if (seat.status === 'held') held++;
    else if (seat.status === 'booked') booked++;
  }
  const total = available + held + booked;
  els.inventory.innerHTML =
    `<span>Available <b>${available}</b></span>` +
    `<span>Held <b>${held}</b></span>` +
    `<span>Booked <b>${booked}</b></span>` +
    `<span>Total <b>${total}</b></span>`;
}

function renderControls() {
  // Selection info.
  const sel = [...state.selected].sort();
  els.selectionInfo.textContent = sel.length
    ? `Selected: ${sel.join(', ')}`
    : 'No seats selected.';

  // Hold button enabled only when we have a selection and no active hold.
  els.holdBtn.disabled = sel.length === 0 || !!state.hold;
  els.holdBtn.classList.toggle('hidden', !!state.hold);

  // Hold panel visibility.
  els.holdPanel.classList.toggle('hidden', !state.hold);
}

// ---- Countdown -------------------------------------------------------------
function startCountdown() {
  stopCountdown();
  if (!state.hold) return;
  const tick = () => {
    if (!state.hold) {
      stopCountdown();
      return;
    }
    const remainingMs = new Date(state.hold.expiresAt).getTime() - Date.now();
    const remaining = Math.max(0, Math.ceil(remainingMs / 1000));
    els.countdown.textContent = remaining;
    if (remainingMs <= 0) {
      // Hold expired locally; clear it and refresh from server.
      setMessage('Your hold expired and the seats were released.', 'info');
      clearHold();
      refreshSeats();
    }
  };
  tick();
  state.countdownTimer = setInterval(tick, 250);
}

function stopCountdown() {
  if (state.countdownTimer) {
    clearInterval(state.countdownTimer);
    state.countdownTimer = null;
  }
}

function clearHold() {
  state.hold = null;
  storeHold();
  stopCountdown();
  render();
}

// ---- Seat interaction ------------------------------------------------------
function onSeatClick(id) {
  const seat = state.seats.get(id);
  if (!seat) return;

  // If we have an active hold, clicking is disabled (release first).
  if (state.hold) {
    setMessage('Release or confirm your current hold before selecting more seats.', 'info');
    return;
  }

  if (seat.status !== 'available') return;

  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  render();
}

// ---- API calls -------------------------------------------------------------
async function refreshSeats() {
  try {
    const res = await fetch(`${API}/seats`);
    const data = await res.json();
    state.holdTtlMs = data.holdTtlMs || state.holdTtlMs;
    applySeats(data.seats, true);
  } catch (e) {
    setMessage('Failed to load seats.', 'error');
  }
}

// Replace (full) or patch (partial) the seat map.
function applySeats(seats, full = false) {
  if (full) {
    state.seats = new Map();
  }
  for (const seat of seats) {
    state.seats.set(seat.id, seat);
    // Clean selection if a selected seat is no longer available to us.
    if (state.selected.has(seat.id) && seat.status !== 'available') {
      state.selected.delete(seat.id);
    }
  }
  // If our hold's seats are no longer held by us, the hold is gone.
  if (state.hold) {
    const stillHeld = state.hold.seatIds.some((id) => {
      const s = state.seats.get(id);
      return s && s.status === 'held' && s.holdId === state.hold.id;
    });
    const allBooked = state.hold.seatIds.every((id) => {
      const s = state.seats.get(id);
      return s && s.status === 'booked' && s.bookedBy === sessionId;
    });
    if (!stillHeld && !allBooked) {
      // Hold released/expired elsewhere.
      clearHold();
    }
  }
  render();
}

async function placeHold() {
  const seatIds = [...state.selected];
  if (seatIds.length === 0) return;
  els.holdBtn.disabled = true;
  setMessage('Placing hold…', 'info');
  try {
    const res = await fetch(`${API}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId })
    });
    if (res.status === 409) {
      const data = await res.json();
      handleConflict(data.conflicts || []);
      return;
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setMessage(data.error || 'Failed to place hold.', 'error');
      await refreshSeats();
      return;
    }
    const { hold } = await res.json();
    state.hold = {
      id: hold.id,
      seatIds: hold.seatIds,
      expiresAt: hold.expiresAt
    };
    storeHold();
    state.selected.clear();
    setMessage(`Held ${hold.seatIds.join(', ')}. Confirm before it expires!`, 'success');
    await refreshSeats();
    startCountdown();
  } catch (e) {
    setMessage('Network error placing hold.', 'error');
  } finally {
    renderControls();
  }
}

function handleConflict(conflicts) {
  setMessage(
    `These seats were just taken: ${conflicts.join(', ')}. Selection refreshed.`,
    'error'
  );
  // Flash the conflicting seats.
  for (const id of conflicts) {
    const el = els.seatmap.querySelector(`.seat[data-id="${id}"]`);
    if (el) {
      el.classList.add('conflict');
      setTimeout(() => el.classList.remove('conflict'), 2000);
    }
  }
  state.selected.clear();
  refreshSeats();
}

async function confirmHold() {
  if (!state.hold) return;
  els.confirmBtn.disabled = true;
  setMessage('Confirming…', 'info');
  try {
    const res = await fetch(`${API}/holds/${state.hold.id}/confirm`, {
      method: 'POST'
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setMessage(data.error || 'Could not confirm hold.', 'error');
      clearHold();
      await refreshSeats();
      return;
    }
    const { booking } = await res.json();
    state.booking = booking;
    setMessage(`Booked: ${booking.seatIds.join(', ')}. Enjoy the show!`, 'success');
    clearHold();
    await refreshSeats();
  } catch (e) {
    setMessage('Network error confirming hold.', 'error');
  } finally {
    els.confirmBtn.disabled = false;
  }
}

async function releaseHold() {
  if (!state.hold) return;
  els.releaseBtn.disabled = true;
  setMessage('Releasing hold…', 'info');
  try {
    const res = await fetch(`${API}/holds/${state.hold.id}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) {
      const data = await res.json().catch(() => ({}));
      setMessage(data.error || 'Could not release hold.', 'error');
    } else {
      setMessage('Hold released. Seats are available again.', 'info');
    }
  } catch (e) {
    setMessage('Network error releasing hold.', 'error');
  } finally {
    clearHold();
    await refreshSeats();
    els.releaseBtn.disabled = false;
  }
}

// ---- SSE -------------------------------------------------------------------
function connectStream() {
  const es = new EventSource(`${API}/stream`);

  es.addEventListener('hello', () => {
    els.connection.classList.remove('offline');
    els.connection.classList.add('online');
    els.connection.title = 'Live';
  });

  es.addEventListener('seats', (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.seats) applySeats(data.seats, false);
    } catch {
      /* ignore malformed */
    }
  });

  es.onerror = () => {
    els.connection.classList.remove('online');
    els.connection.classList.add('offline');
    els.connection.title = 'Reconnecting…';
    // EventSource auto-reconnects; we resync on each (re)connect via hello +
    // a defensive full refresh.
  };

  es.onopen = () => {
    els.connection.classList.remove('offline');
    els.connection.classList.add('online');
    refreshSeats(); // resync state after (re)connect
  };
}

// ---- Wire up ---------------------------------------------------------------
els.holdBtn.addEventListener('click', placeHold);
els.confirmBtn.addEventListener('click', confirmHold);
els.releaseBtn.addEventListener('click', releaseHold);

// ---- Init ------------------------------------------------------------------
async function init() {
  loadStoredHold();
  await refreshSeats();
  if (state.hold) startCountdown();
  connectStream();
}

init();
