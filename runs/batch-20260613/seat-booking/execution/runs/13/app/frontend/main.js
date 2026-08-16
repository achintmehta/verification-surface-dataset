// ---------------------------------------------------------------------------
// Seat-booking SPA
//
// Renders an interactive seat map, lets a user hold + confirm seats, and keeps
// every connected client in sync via Server-Sent Events.
// ---------------------------------------------------------------------------

const API = '/api';

// A client-supplied session id identifies the holder (no auth needed).
function getSessionId() {
  let id = localStorage.getItem('seat-session-id');
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) || `s-${Date.now()}-${Math.random()}`;
    localStorage.setItem('seat-session-id', id);
  }
  return id;
}
const sessionId = getSessionId();

// ---- App state ------------------------------------------------------------
const state = {
  seats: new Map(), // id -> seat { id, row, number, status, holdId, holdExpiresAt }
  selected: new Set(), // seat ids currently selected by the user
  currentHold: null, // { holdId, expiresAt, seatIds }
  ttlMs: 0,
};

// ---- DOM refs -------------------------------------------------------------
const els = {
  seatmap: document.getElementById('seatmap'),
  conn: document.getElementById('connection'),
  selectionText: document.getElementById('selection-text'),
  holdBtn: document.getElementById('hold-btn'),
  confirmBtn: document.getElementById('confirm-btn'),
  releaseBtn: document.getElementById('release-btn'),
  holdStatus: document.getElementById('hold-status'),
  holdCountdown: document.getElementById('hold-countdown'),
  message: document.getElementById('message'),
  sessionLabel: document.getElementById('session-label'),
  countAvailable: document.getElementById('count-available'),
  countHeld: document.getElementById('count-held'),
  countBooked: document.getElementById('count-booked'),
  countTotal: document.getElementById('count-total'),
};

els.sessionLabel.textContent = `Session: ${sessionId.slice(0, 8)}`;

// ---- Helpers --------------------------------------------------------------
function setMessage(text, kind = 'info') {
  els.message.textContent = text;
  els.message.className = `message ${kind}`;
}

// Effective status from the client's point of view: a seat held by *me* is
// "held-mine"; a held seat whose countdown elapsed is treated as available
// until the server confirms.
function effectiveStatusFor(seat) {
  if (seat.status === 'held') {
    if (seat.holdExpiresAt && seat.holdExpiresAt <= Date.now()) {
      return 'available';
    }
    if (state.currentHold && seat.holdId === state.currentHold.holdId) {
      return 'held-mine';
    }
    return 'held';
  }
  return seat.status;
}

function upsertSeats(seatList) {
  for (const seat of seatList) {
    state.seats.set(seat.id, seat);
  }
}

// ---- Rendering ------------------------------------------------------------
function render() {
  // Group seats by row.
  const rows = new Map();
  for (const seat of state.seats.values()) {
    if (!rows.has(seat.row)) rows.set(seat.row, []);
    rows.get(seat.row).push(seat);
  }
  const sortedRows = [...rows.keys()].sort();

  els.seatmap.innerHTML = '';
  const counts = { available: 0, held: 0, booked: 0, total: 0 };

  for (const rowLabel of sortedRows) {
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';

    const label = document.createElement('span');
    label.className = 'row-label';
    label.textContent = rowLabel;
    rowEl.appendChild(label);

    const seats = rows.get(rowLabel).sort((a, b) => a.number - b.number);
    for (const seat of seats) {
      const eff = effectiveStatusFor(seat);
      counts.total++;
      if (eff === 'available') counts.available++;
      else if (eff === 'booked') counts.booked++;
      else counts.held++; // held + held-mine

      const btn = document.createElement('button');
      btn.className = `seat ${eff}`;
      btn.textContent = seat.number;
      btn.dataset.id = seat.id;
      btn.title = `${seat.row}${seat.number} — ${eff}`;

      if (state.selected.has(seat.id) && eff === 'available') {
        btn.classList.add('selected');
      }

      const clickable = eff === 'available' || eff === 'held-mine';
      if (clickable && eff === 'available') {
        btn.addEventListener('click', () => toggleSelect(seat.id));
      }
      rowEl.appendChild(btn);
    }
    els.seatmap.appendChild(rowEl);
  }

  els.countAvailable.textContent = counts.available;
  els.countHeld.textContent = counts.held;
  els.countBooked.textContent = counts.booked;
  els.countTotal.textContent = counts.total;

  updateControls();
}

function toggleSelect(seatId) {
  if (state.currentHold) return; // can't reselect while holding
  if (state.selected.has(seatId)) state.selected.delete(seatId);
  else state.selected.add(seatId);
  render();
}

function updateControls() {
  const hasSelection = state.selected.size > 0;
  const hasHold = !!state.currentHold;

  els.holdBtn.disabled = hasHold || !hasSelection;
  els.confirmBtn.disabled = !hasHold;
  els.releaseBtn.disabled = !hasHold;

  if (hasHold) {
    const names = state.currentHold.seatIds
      .map((id) => labelFor(id))
      .join(', ');
    els.selectionText.textContent = `Holding: ${names}`;
  } else if (hasSelection) {
    const names = [...state.selected].map(labelFor).join(', ');
    els.selectionText.textContent = `Selected: ${names}`;
  } else {
    els.selectionText.textContent = 'No seats selected';
  }
}

function labelFor(seatId) {
  const seat = state.seats.get(seatId);
  return seat ? `${seat.row}${seat.number}` : `#${seatId}`;
}

// ---- Hold countdown -------------------------------------------------------
let countdownTimer = null;
function startCountdown() {
  stopCountdown();
  els.holdStatus.classList.remove('hidden');
  const tick = () => {
    if (!state.currentHold) {
      stopCountdown();
      return;
    }
    const remaining = state.currentHold.expiresAt - Date.now();
    if (remaining <= 0) {
      els.holdCountdown.textContent = 'Your hold has expired.';
      onHoldExpired();
      return;
    }
    const secs = Math.ceil(remaining / 1000);
    els.holdCountdown.textContent = `Hold active — ${secs}s remaining to confirm.`;
  };
  tick();
  countdownTimer = setInterval(tick, 250);
}
function stopCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = null;
}
function hideHoldStatus() {
  stopCountdown();
  els.holdStatus.classList.add('hidden');
}

function onHoldExpired() {
  setMessage('Your hold expired and the seats were released.', 'error');
  clearHold();
  refreshSeats();
}

function clearHold() {
  state.currentHold = null;
  state.selected.clear();
  hideHoldStatus();
  render();
}

// ---- API calls ------------------------------------------------------------
async function apiFetch(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* no body */
  }
  if (!res.ok) {
    const err = new Error((body && body.message) || res.statusText);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function refreshSeats() {
  const data = await apiFetch('/seats');
  state.ttlMs = data.ttlMs;
  state.seats.clear();
  upsertSeats(data.seats);
  render();
}

async function placeHold() {
  const seatIds = [...state.selected];
  if (seatIds.length === 0) return;
  setMessage('Placing hold…', 'info');
  try {
    const data = await apiFetch('/holds', {
      method: 'POST',
      body: JSON.stringify({ seatIds, sessionId }),
    });
    state.currentHold = {
      holdId: data.hold.holdId,
      expiresAt: data.hold.expiresAt,
      seatIds: data.hold.seatIds,
    };
    upsertSeats(data.seats);
    state.selected = new Set(data.hold.seatIds);
    render();
    startCountdown();
    setMessage(`Held ${data.hold.seatIds.length} seat(s). Confirm before the timer ends.`, 'success');
  } catch (err) {
    if (err.status === 409 && err.body && err.body.conflictSeatIds) {
      flashConflicts(err.body.conflictSeatIds);
      setMessage(
        `Some seats were just taken: ${err.body.conflictSeatIds.map(labelFor).join(', ')}. Refreshing…`,
        'error'
      );
      // Drop the conflicting seats from the selection and refresh.
      for (const id of err.body.conflictSeatIds) state.selected.delete(id);
      await refreshSeats();
    } else {
      setMessage(`Hold failed: ${err.message}`, 'error');
      await refreshSeats();
    }
  }
}

function flashConflicts(seatIds) {
  for (const id of seatIds) {
    const el = els.seatmap.querySelector(`[data-id="${id}"]`);
    if (el) {
      el.classList.add('conflict');
      setTimeout(() => el.classList.remove('conflict'), 600);
    }
  }
}

async function confirmBooking() {
  if (!state.currentHold) return;
  const holdId = state.currentHold.holdId;
  setMessage('Confirming…', 'info');
  try {
    const data = await apiFetch(`/holds/${holdId}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    });
    upsertSeats(data.seats);
    const n = data.booking.seatIds.length;
    setMessage(
      data.idempotent
        ? `Already booked ${n} seat(s).`
        : `Booked ${n} seat(s)! 🎉`,
      'success'
    );
    clearHold();
  } catch (err) {
    if (err.status === 410) {
      setMessage('Hold expired before confirmation — seats were released.', 'error');
    } else if (err.status === 404) {
      setMessage('Hold no longer exists.', 'error');
    } else {
      setMessage(`Confirm failed: ${err.message}`, 'error');
    }
    clearHold();
    await refreshSeats();
  }
}

async function releaseHold() {
  if (!state.currentHold) return;
  const holdId = state.currentHold.holdId;
  setMessage('Releasing hold…', 'info');
  try {
    await apiFetch(`/holds/${holdId}`, {
      method: 'DELETE',
      body: JSON.stringify({ sessionId }),
    });
    setMessage('Hold released.', 'info');
  } catch (err) {
    setMessage(`Release failed: ${err.message}`, 'error');
  }
  clearHold();
  await refreshSeats();
}

// ---- SSE ------------------------------------------------------------------
function connectStream() {
  const es = new EventSource(`${API}/stream`);

  es.addEventListener('open', () => {
    els.conn.textContent = 'live';
    els.conn.className = 'conn conn--live';
  });

  es.addEventListener('error', () => {
    els.conn.textContent = 'reconnecting…';
    els.conn.className = 'conn conn--down';
  });

  es.addEventListener('snapshot', (e) => {
    const data = JSON.parse(e.data);
    state.seats.clear();
    upsertSeats(data.seats);
    reconcileHold(data.seats);
    render();
  });

  es.addEventListener('seats', (e) => {
    const data = JSON.parse(e.data);
    upsertSeats(data.seats);
    reconcileHold(data.seats);
    render();
  });
}

// If a broadcast tells us our held seats were released/booked by someone else
// (e.g. our hold expired server-side), reconcile local hold state.
function reconcileHold(changedSeats) {
  if (!state.currentHold) return;
  const myIds = new Set(state.currentHold.seatIds);
  for (const seat of changedSeats) {
    if (myIds.has(seat.id)) {
      const stillMine = seat.status === 'held' && seat.holdId === state.currentHold.holdId;
      const bookedByMe = seat.status === 'booked';
      if (!stillMine && !bookedByMe) {
        // Our seat got released out from under us.
        setMessage('Your hold was released (expired).', 'error');
        clearHold();
        return;
      }
    }
  }
}

// ---- Wiring ---------------------------------------------------------------
els.holdBtn.addEventListener('click', placeHold);
els.confirmBtn.addEventListener('click', confirmBooking);
els.releaseBtn.addEventListener('click', releaseHold);

// Best-effort release on tab close so we don't leak the hold (TTL covers it
// anyway, but this is faster).
window.addEventListener('beforeunload', () => {
  if (state.currentHold) {
    navigator.sendBeacon?.(
      `${API}/holds/${state.currentHold.holdId}/release`,
      new Blob([JSON.stringify({ sessionId })], { type: 'application/json' })
    );
  }
});

// ---- Boot -----------------------------------------------------------------
(async function boot() {
  try {
    await refreshSeats();
    setMessage('Select available seats and place a hold.', 'info');
  } catch (err) {
    setMessage(`Failed to load seats: ${err.message}`, 'error');
  }
  connectStream();
})();
