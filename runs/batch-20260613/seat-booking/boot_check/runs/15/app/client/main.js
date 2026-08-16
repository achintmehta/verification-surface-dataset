// Seat-booking SPA frontend.

const API = '/api';

// Stable per-tab session id.
function getSessionId() {
  let id = localStorage.getItem('seatSessionId');
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) ||
      's-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('seatSessionId', id);
  }
  return id;
}

const sessionId = getSessionId();

const state = {
  seats: new Map(), // id -> seat object
  selected: new Set(),
  hold: null, // { id, seatIds, expiresAt }
  booking: null,
  ttlMs: 60000,
};

const els = {
  seatmap: document.getElementById('seatmap'),
  selection: document.getElementById('selection'),
  holdBtn: document.getElementById('holdBtn'),
  confirmBtn: document.getElementById('confirmBtn'),
  releaseBtn: document.getElementById('releaseBtn'),
  countdown: document.getElementById('countdown'),
  message: document.getElementById('message'),
  inventory: document.getElementById('inventory'),
  status: document.getElementById('status'),
  sessionId: document.getElementById('sessionId'),
};

els.sessionId.textContent = sessionId;

// ---- Helpers ----

function setMessage(text, kind = '') {
  els.message.textContent = text || '';
  els.message.className = 'message' + (kind ? ' ' + kind : '');
}

function effectiveStatus(seat) {
  // A held seat whose hold has expired is effectively available.
  if (
    seat.status === 'held' &&
    seat.holdExpiresAt &&
    new Date(seat.holdExpiresAt).getTime() <= Date.now()
  ) {
    return 'available';
  }
  return seat.status;
}

function isMine(seat) {
  return state.hold && seat.holdId === state.hold.id;
}

// ---- Rendering ----

function render() {
  const rows = new Map();
  for (const seat of state.seats.values()) {
    if (!rows.has(seat.rowLabel)) rows.set(seat.rowLabel, []);
    rows.get(seat.rowLabel).push(seat);
  }

  els.seatmap.innerHTML = '';
  const sortedRows = [...rows.keys()].sort();
  for (const label of sortedRows) {
    const rowEl = document.createElement('div');
    rowEl.className = 'row';

    const lbl = document.createElement('span');
    lbl.className = 'row-label';
    lbl.textContent = label;
    rowEl.appendChild(lbl);

    const seats = rows.get(label).sort((a, b) => a.seatNumber - b.seatNumber);
    for (const seat of seats) {
      const btn = document.createElement('button');
      btn.className = 'seat';
      btn.textContent = seat.seatNumber;
      btn.dataset.id = seat.id;
      btn.title = seat.id;

      const status = effectiveStatus(seat);
      if (status === 'booked') {
        btn.classList.add('booked');
        btn.disabled = true;
      } else if (status === 'held') {
        if (isMine(seat)) {
          btn.classList.add('mine');
        } else {
          btn.classList.add('held');
          btn.disabled = true;
        }
      } else {
        // available
        if (state.selected.has(seat.id)) {
          btn.classList.add('selected');
        }
      }

      btn.addEventListener('click', () => onSeatClick(seat.id));
      rowEl.appendChild(btn);
    }
    els.seatmap.appendChild(rowEl);
  }

  renderSelection();
  renderButtons();
  renderInventory();
}

function renderSelection() {
  if (state.hold) {
    els.selection.textContent =
      'Holding: ' + state.hold.seatIds.join(', ');
  } else if (state.booking) {
    els.selection.textContent =
      'Booked: ' + state.booking.seatIds.join(', ');
  } else if (state.selected.size > 0) {
    els.selection.textContent = 'Selected: ' + [...state.selected].sort().join(', ');
  } else {
    els.selection.textContent = 'No seats selected.';
  }
}

function renderButtons() {
  els.holdBtn.disabled = state.selected.size === 0 || !!state.hold;
  els.confirmBtn.disabled = !state.hold;
  els.releaseBtn.disabled = !state.hold;
}

function renderInventory() {
  let available = 0, held = 0, booked = 0;
  for (const seat of state.seats.values()) {
    const s = effectiveStatus(seat);
    if (s === 'available') available++;
    else if (s === 'held') held++;
    else booked++;
  }
  const total = available + held + booked;
  els.inventory.innerHTML =
    `Available: <b>${available}</b><br>` +
    `Held: <b>${held}</b><br>` +
    `Booked: <b>${booked}</b><br>` +
    `Total: <b>${total}</b>`;
}

// ---- Countdown ----

let countdownTimer = null;
function startCountdown() {
  stopCountdown();
  els.countdown.classList.remove('hidden');
  const tick = () => {
    if (!state.hold) {
      stopCountdown();
      return;
    }
    const remaining = new Date(state.hold.expiresAt).getTime() - Date.now();
    if (remaining <= 0) {
      els.countdown.textContent = 'Hold expired';
      els.countdown.classList.add('urgent');
      onHoldExpired();
      return;
    }
    const secs = Math.ceil(remaining / 1000);
    els.countdown.textContent = `Hold expires in ${secs}s`;
    els.countdown.classList.toggle('urgent', secs <= 10);
  };
  tick();
  countdownTimer = setInterval(tick, 250);
}
function stopCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = null;
  els.countdown.classList.add('hidden');
  els.countdown.classList.remove('urgent');
}

function onHoldExpired() {
  state.hold = null;
  setMessage('Your hold expired and the seats were released.', 'error');
  stopCountdown();
  loadSeats();
}

// ---- Interactions ----

function onSeatClick(id) {
  if (state.hold) {
    setMessage('Release or confirm your current hold first.', 'error');
    return;
  }
  const seat = state.seats.get(id);
  if (!seat || effectiveStatus(seat) !== 'available') return;

  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  setMessage('');
  render();
}

async function doHold() {
  if (state.selected.size === 0) return;
  const seatIds = [...state.selected].sort();
  setMessage('Placing hold…');
  try {
    const res = await fetch(`${API}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId }),
    });

    if (res.status === 409) {
      const data = await res.json();
      const conflicts = data.conflicts || [];
      setMessage(
        `These seats were just taken: ${conflicts.join(', ')}. Map refreshed.`,
        'error'
      );
      highlightConflicts(conflicts);
      // Drop conflicting seats from selection, refresh.
      for (const c of conflicts) state.selected.delete(c);
      await loadSeats();
      return;
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setMessage('Hold failed: ' + (data.error || res.status), 'error');
      return;
    }

    const hold = await res.json();
    state.hold = hold;
    state.selected.clear();
    setMessage('Seats held. Confirm before the timer runs out.', 'success');
    startCountdown();
    await loadSeats();
  } catch (e) {
    setMessage('Network error placing hold.', 'error');
  }
}

function highlightConflicts(ids) {
  for (const id of ids) {
    const btn = els.seatmap.querySelector(`.seat[data-id="${id}"]`);
    if (btn) {
      btn.classList.add('conflict');
      setTimeout(() => btn.classList.remove('conflict'), 1500);
    }
  }
}

async function doConfirm() {
  if (!state.hold) return;
  const holdId = state.hold.id;
  setMessage('Confirming…');
  try {
    const res = await fetch(`${API}/holds/${holdId}/confirm`, {
      method: 'POST',
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const reason = data.error || res.status;
      setMessage(
        reason === 'expired'
          ? 'Hold expired before confirmation; nothing booked.'
          : 'Confirm failed: ' + reason,
        'error'
      );
      state.hold = null;
      stopCountdown();
      await loadSeats();
      return;
    }
    const booking = await res.json();
    state.booking = booking;
    state.hold = null;
    stopCountdown();
    setMessage(`Booked: ${booking.seatIds.join(', ')} 🎉`, 'success');
    await loadSeats();
  } catch (e) {
    setMessage('Network error confirming.', 'error');
  }
}

async function doRelease() {
  if (!state.hold) return;
  const holdId = state.hold.id;
  setMessage('Releasing…');
  try {
    await fetch(`${API}/holds/${holdId}`, { method: 'DELETE' });
    state.hold = null;
    stopCountdown();
    setMessage('Hold released.', '');
    await loadSeats();
  } catch (e) {
    setMessage('Network error releasing.', 'error');
  }
}

// ---- Data loading ----

async function loadSeats() {
  try {
    const res = await fetch(`${API}/seats`);
    const data = await res.json();
    if (data.ttlMs) state.ttlMs = data.ttlMs;
    applySeats(data.seats);
  } catch (e) {
    setMessage('Failed to load seats.', 'error');
  }
}

function applySeats(seatList) {
  for (const seat of seatList) {
    state.seats.set(seat.id, seat);
  }
  // If our hold's seats are no longer held by us, clear hold.
  if (state.hold) {
    const stillHeld = state.hold.seatIds.every((id) => {
      const seat = state.seats.get(id);
      return seat && seat.status === 'held' && seat.holdId === state.hold.id;
    });
    if (!stillHeld) {
      // Could have been confirmed (booked) — leave booking detection elsewhere.
      const allBooked = state.hold.seatIds.every((id) => {
        const seat = state.seats.get(id);
        return seat && seat.status === 'booked';
      });
      if (!allBooked) {
        state.hold = null;
        stopCountdown();
      }
    }
  }
  render();
}

// ---- SSE ----

function connectStream() {
  const es = new EventSource(`${API}/stream`);

  es.addEventListener('open', () => {
    els.status.textContent = 'live';
    els.status.className = 'conn live';
  });

  es.addEventListener('hello', () => {
    els.status.textContent = 'live';
    els.status.className = 'conn live';
  });

  es.addEventListener('seats', (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data.seats) applySeats(data.seats);
    } catch {}
  });

  es.onerror = () => {
    els.status.textContent = 'reconnecting…';
    els.status.className = 'conn down';
  };
}

// ---- Init ----

els.holdBtn.addEventListener('click', doHold);
els.confirmBtn.addEventListener('click', doConfirm);
els.releaseBtn.addEventListener('click', doRelease);

loadSeats();
connectStream();
