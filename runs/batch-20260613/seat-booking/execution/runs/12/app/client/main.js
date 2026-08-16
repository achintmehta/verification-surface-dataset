// Seat-booking SPA frontend.
// State machine: browse -> select -> hold (countdown) -> confirm | release.

const API = '/api';

// --- Session identity (no auth; a stable per-browser id is enough). ---
function getSessionId() {
  let id = localStorage.getItem('seat-session-id');
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) ||
      'sess-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('seat-session-id', id);
  }
  return id;
}
const sessionId = getSessionId();

// --- App state ---
const state = {
  seats: new Map(),       // id -> seat object
  selected: new Set(),    // seat ids selected (not yet held)
  hold: null,             // { id, expiresAt, seatIds }
  countdownTimer: null,
};

// --- DOM ---
const els = {
  seatmap: document.getElementById('seatmap'),
  inventory: document.getElementById('inventory'),
  selectionInfo: document.getElementById('selection-info'),
  holdBtn: document.getElementById('hold-btn'),
  confirmBtn: document.getElementById('confirm-btn'),
  releaseBtn: document.getElementById('release-btn'),
  countdown: document.getElementById('countdown'),
  message: document.getElementById('message'),
  connection: document.getElementById('connection'),
  sessionId: document.getElementById('session-id'),
};
els.sessionId.textContent = sessionId;

// --- Helpers ---
function setMessage(text, kind = '') {
  els.message.textContent = text || '';
  els.message.className = 'message' + (kind ? ' ' + kind : '');
}

function effectiveStatus(seat) {
  // Treat an expired held seat as available defensively (server also enforces).
  if (seat.status === 'held' && seat.holdExpiresAt) {
    if (new Date(seat.holdExpiresAt).getTime() <= Date.now()) return 'available';
  }
  return seat.status;
}

function seatClasses(seat) {
  const status = effectiveStatus(seat);
  const classes = ['seat'];
  if (status === 'booked') {
    classes.push('booked');
  } else if (status === 'held') {
    // Distinguish our own hold from others'.
    if (state.hold && seat.holdId === state.hold.id) classes.push('mine');
    else classes.push('held');
  } else {
    // available
    if (state.selected.has(seat.id)) classes.push('selected');
    else classes.push('available');
  }
  return classes.join(' ');
}

// --- Rendering ---
function render() {
  renderSeatMap();
  renderInventory();
  renderControls();
}

function renderSeatMap() {
  const rows = new Map();
  for (const seat of state.seats.values()) {
    if (!rows.has(seat.rowLabel)) rows.set(seat.rowLabel, []);
    rows.get(seat.rowLabel).push(seat);
  }
  const sortedRows = [...rows.keys()].sort();

  els.seatmap.innerHTML = '';
  for (const rowLabel of sortedRows) {
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';

    const label = document.createElement('div');
    label.className = 'row-label';
    label.textContent = rowLabel;
    rowEl.appendChild(label);

    const seats = rows.get(rowLabel).sort((a, b) => a.seatNumber - b.seatNumber);
    for (const seat of seats) {
      const btn = document.createElement('button');
      btn.className = seatClasses(seat);
      btn.textContent = seat.seatNumber;
      btn.title = `${seat.rowLabel}${seat.seatNumber} — ${effectiveStatus(seat)}`;
      btn.dataset.seatId = seat.id;
      btn.addEventListener('click', () => onSeatClick(seat.id));
      rowEl.appendChild(btn);
    }
    els.seatmap.appendChild(rowEl);
  }
}

function renderInventory() {
  let available = 0, held = 0, booked = 0;
  for (const seat of state.seats.values()) {
    const s = effectiveStatus(seat);
    if (s === 'available') available++;
    else if (s === 'held') held++;
    else booked++;
  }
  const total = state.seats.size;
  els.inventory.innerHTML = `
    <span class="pill">Available <b>${available}</b></span>
    <span class="pill">Held <b>${held}</b></span>
    <span class="pill">Booked <b>${booked}</b></span>
    <span class="pill">Total <b>${total}</b></span>
  `;
}

function renderControls() {
  const hasHold = !!state.hold;
  const hasSelection = state.selected.size > 0;

  els.holdBtn.disabled = hasHold || !hasSelection;
  els.confirmBtn.disabled = !hasHold;
  els.releaseBtn.disabled = !hasHold;

  if (hasHold) {
    els.selectionInfo.textContent =
      `Holding ${state.hold.seatIds.length} seat(s): ` +
      state.hold.seatIds.map(seatLabel).join(', ');
  } else if (hasSelection) {
    els.selectionInfo.textContent =
      `Selected ${state.selected.size} seat(s): ` +
      [...state.selected].map(seatLabel).join(', ');
  } else {
    els.selectionInfo.textContent = 'No seats selected.';
  }
}

function seatLabel(id) {
  const s = state.seats.get(id);
  return s ? `${s.rowLabel}${s.seatNumber}` : `#${id}`;
}

// --- Seat interaction ---
function onSeatClick(seatId) {
  if (state.hold) return; // can't change selection while holding
  const seat = state.seats.get(seatId);
  if (!seat || effectiveStatus(seat) !== 'available') return;

  if (state.selected.has(seatId)) state.selected.delete(seatId);
  else state.selected.add(seatId);
  setMessage('');
  render();
}

// --- API calls ---
async function loadSeats() {
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
  } catch (e) {
    setMessage('Failed to load seats.', 'error');
  }
}

async function holdSelected() {
  const seatIds = [...state.selected];
  if (seatIds.length === 0) return;
  els.holdBtn.disabled = true;
  setMessage('Requesting hold…');

  try {
    const res = await fetch(`${API}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId }),
    });

    if (res.status === 201) {
      const hold = await res.json();
      state.hold = hold;
      state.selected.clear();
      // Optimistically mark our seats held by us.
      for (const id of hold.seatIds) {
        const seat = state.seats.get(id);
        if (seat) {
          seat.status = 'held';
          seat.holdId = hold.id;
          seat.holdExpiresAt = hold.expiresAt;
        }
      }
      setMessage(`Held ${hold.seatIds.length} seat(s). Confirm before the timer runs out!`, 'success');
      startCountdown();
      render();
    } else if (res.status === 409) {
      const data = await res.json();
      const conflicts = data.conflicts || [];
      setMessage(
        `Could not hold — these seats were just taken: ${conflicts.map(seatLabel).join(', ')}. Refreshing…`,
        'error'
      );
      flashConflicts(conflicts);
      // Clear conflicting selections and refresh.
      for (const id of conflicts) state.selected.delete(id);
      await loadSeats();
    } else {
      const data = await res.json().catch(() => ({}));
      setMessage(data.error || 'Hold failed.', 'error');
      await loadSeats();
    }
  } catch (e) {
    setMessage('Network error during hold.', 'error');
  } finally {
    renderControls();
  }
}

async function confirmHold() {
  if (!state.hold) return;
  els.confirmBtn.disabled = true;
  setMessage('Confirming…');
  try {
    const res = await fetch(`${API}/holds/${state.hold.id}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      const seatIds = data.booking?.seatIds || state.hold.seatIds;
      for (const id of seatIds) {
        const seat = state.seats.get(id);
        if (seat) {
          seat.status = 'booked';
          seat.bookedBy = sessionId;
          seat.holdExpiresAt = null;
        }
      }
      setMessage(
        data.alreadyConfirmed
          ? 'Already confirmed — your seats are booked.'
          : `Booked ${seatIds.length} seat(s)! 🎉`,
        'success'
      );
      clearHold();
      render();
    } else {
      setMessage(data.error || 'Confirmation failed — your hold may have expired.', 'error');
      clearHold();
      await loadSeats();
    }
  } catch (e) {
    setMessage('Network error during confirmation.', 'error');
  } finally {
    renderControls();
  }
}

async function releaseHold() {
  if (!state.hold) return;
  const holdId = state.hold.id;
  els.releaseBtn.disabled = true;
  setMessage('Releasing…');
  try {
    const res = await fetch(`${API}/holds/${holdId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    if (res.ok) {
      setMessage('Hold released.', '');
    } else {
      const data = await res.json().catch(() => ({}));
      setMessage(data.error || 'Release failed.', 'error');
    }
  } catch (e) {
    setMessage('Network error during release.', 'error');
  } finally {
    clearHold();
    await loadSeats();
  }
}

// --- Countdown ---
function startCountdown() {
  stopCountdown();
  els.countdown.classList.remove('hidden');
  const tick = () => {
    if (!state.hold) return stopCountdown();
    const remaining = new Date(state.hold.expiresAt).getTime() - Date.now();
    if (remaining <= 0) {
      els.countdown.textContent = 'Hold expired!';
      onHoldExpiredLocally();
      return;
    }
    const secs = Math.ceil(remaining / 1000);
    els.countdown.textContent = `⏳ Hold expires in ${secs}s`;
  };
  tick();
  state.countdownTimer = setInterval(tick, 250);
}

function stopCountdown() {
  if (state.countdownTimer) clearInterval(state.countdownTimer);
  state.countdownTimer = null;
}

function clearHold() {
  state.hold = null;
  stopCountdown();
  els.countdown.classList.add('hidden');
}

function onHoldExpiredLocally() {
  setMessage('Your hold expired and the seats were released.', 'error');
  clearHold();
  loadSeats();
}

// --- Conflict flash ---
function flashConflicts(seatIds) {
  for (const id of seatIds) {
    const el = els.seatmap.querySelector(`[data-seat-id="${id}"]`);
    if (el) {
      el.classList.add('conflict');
      setTimeout(() => el.classList.remove('conflict'), 1400);
    }
  }
}

// --- SSE live updates ---
function connectStream() {
  const es = new EventSource(`${API}/stream`);

  es.addEventListener('hello', () => {
    els.connection.textContent = 'live';
    els.connection.className = 'conn live';
  });

  es.addEventListener('seats', (ev) => {
    try {
      const { seats } = JSON.parse(ev.data);
      applySeatUpdates(seats);
    } catch (e) {
      /* ignore malformed frame */
    }
  });

  es.onopen = () => {
    els.connection.textContent = 'live';
    els.connection.className = 'conn live';
  };

  es.onerror = () => {
    els.connection.textContent = 'reconnecting…';
    els.connection.className = 'conn down';
    // EventSource auto-reconnects; refresh state when it returns.
  };
}

function applySeatUpdates(seats) {
  let holdInvalidated = false;
  for (const seat of seats) {
    state.seats.set(seat.id, seat);

    // If a seat we have selected got taken by someone else, drop it.
    if (state.selected.has(seat.id) && effectiveStatus(seat) !== 'available') {
      state.selected.delete(seat.id);
    }

    // If our held seat was released/booked away from our hold, invalidate.
    if (state.hold && state.hold.seatIds.includes(seat.id)) {
      const stillOurs = seat.status === 'held' && seat.holdId === state.hold.id;
      const ourBooking = seat.status === 'booked' && seat.bookedBy === sessionId;
      if (!stillOurs && !ourBooking) holdInvalidated = true;
    }
  }

  if (holdInvalidated && state.hold) {
    // Our hold's seats are no longer held by us (expired elsewhere/released).
    setMessage('Your hold is no longer active (it may have expired).', 'error');
    clearHold();
  }
  render();
}

// --- Wire up buttons ---
els.holdBtn.addEventListener('click', holdSelected);
els.confirmBtn.addEventListener('click', confirmHold);
els.releaseBtn.addEventListener('click', releaseHold);

// --- Boot ---
loadSeats();
connectStream();
