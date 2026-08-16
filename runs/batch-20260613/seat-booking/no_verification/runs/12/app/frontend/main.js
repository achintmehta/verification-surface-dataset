// Seat-booking SPA. Renders a live seat map, supports holding, confirming and
// releasing seats, and stays in sync with other clients via SSE.

const API = '/api';

// ---- Session identity (client-supplied, persisted) -----------------------
function getSessionId() {
  let id = localStorage.getItem('seat-session-id');
  if (!id) {
    id =
      'sess-' +
      Math.random().toString(36).slice(2, 10) +
      Date.now().toString(36);
    localStorage.setItem('seat-session-id', id);
  }
  return id;
}

const sessionId = getSessionId();
document.getElementById('session-id').textContent = sessionId;

// ---- App state -----------------------------------------------------------
const state = {
  seats: new Map(), // id -> seat object {id,row,number,status,holdId,...}
  selected: new Set(), // seat ids currently selected (pre-hold)
  hold: null, // { holdId, seatIds, expiresAt }
  holdTtlMs: 60000,
  countdownTimer: null,
};

// ---- DOM refs ------------------------------------------------------------
const els = {
  seatmap: document.getElementById('seatmap'),
  counts: document.getElementById('counts'),
  selectionInfo: document.getElementById('selection-info'),
  holdBtn: document.getElementById('hold-btn'),
  confirmBtn: document.getElementById('confirm-btn'),
  releaseBtn: document.getElementById('release-btn'),
  countdown: document.getElementById('countdown'),
  message: document.getElementById('message'),
  connDot: document.getElementById('conn-dot'),
  connText: document.getElementById('conn-text'),
};

// ---- Helpers -------------------------------------------------------------
function setMessage(text, kind = 'info') {
  els.message.textContent = text || '';
  els.message.className = 'message ' + (text ? kind : '');
}

function effectiveSeatClass(seat) {
  if (state.selected.has(seat.id)) return 'selected';
  if (seat.status === 'booked') return 'booked';
  if (seat.status === 'held') {
    if (state.hold && seat.holdId === state.hold.holdId) return 'mine';
    return 'held';
  }
  return 'available';
}

function isSelectable(seat) {
  // Cannot select held (by others) or booked seats.
  if (seat.status === 'booked') return false;
  if (seat.status === 'held') {
    // Allow if it's part of my own hold? No — selection is pre-hold only.
    return false;
  }
  return true;
}

// ---- Rendering -----------------------------------------------------------
function render() {
  renderSeatMap();
  renderCounts();
  renderControls();
}

function renderSeatMap() {
  const rows = new Map();
  for (const seat of state.seats.values()) {
    if (!rows.has(seat.row)) rows.set(seat.row, []);
    rows.get(seat.row).push(seat);
  }
  const rowLabels = [...rows.keys()].sort();

  els.seatmap.innerHTML = '';
  for (const label of rowLabels) {
    const rowSeats = rows.get(label).sort((a, b) => a.number - b.number);
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';

    const lbl = document.createElement('span');
    lbl.className = 'row-label';
    lbl.textContent = label;
    rowEl.appendChild(lbl);

    for (const seat of rowSeats) {
      const btn = document.createElement('button');
      const cls = effectiveSeatClass(seat);
      btn.className = 'seat ' + cls;
      btn.textContent = seat.number;
      btn.dataset.seatId = seat.id;
      btn.title = `${seat.id} — ${seat.status}`;
      btn.disabled = !isSelectable(seat) && !state.selected.has(seat.id);
      btn.addEventListener('click', () => toggleSelect(seat.id));
      rowEl.appendChild(btn);
    }
    els.seatmap.appendChild(rowEl);
  }
}

function renderCounts() {
  let available = 0;
  let held = 0;
  let booked = 0;
  for (const s of state.seats.values()) {
    if (s.status === 'available') available++;
    else if (s.status === 'held') held++;
    else if (s.status === 'booked') booked++;
  }
  const total = state.seats.size;
  els.counts.innerHTML =
    `<span><b>${available}</b> available</span>` +
    `<span><b>${held}</b> held</span>` +
    `<span><b>${booked}</b> booked</span>` +
    `<span><b>${total}</b> total</span>`;
}

function renderControls() {
  const selectedCount = state.selected.size;
  if (state.hold) {
    els.selectionInfo.textContent =
      `Holding ${state.hold.seatIds.length} seat(s): ${state.hold.seatIds.join(', ')}`;
  } else if (selectedCount > 0) {
    els.selectionInfo.textContent =
      `${selectedCount} seat(s) selected: ${[...state.selected].sort().join(', ')}`;
  } else {
    els.selectionInfo.textContent = 'No seats selected.';
  }

  els.holdBtn.disabled = state.hold !== null || selectedCount === 0;
  els.confirmBtn.disabled = state.hold === null;
  els.releaseBtn.disabled = state.hold === null;
}

// ---- Countdown -----------------------------------------------------------
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
      els.countdown.innerHTML = 'Hold expired.';
      onHoldExpired();
      return;
    }
    const secs = Math.ceil(remaining / 1000);
    els.countdown.innerHTML = `Hold expires in <b>${secs}s</b> — confirm to book.`;
  };
  tick();
  state.countdownTimer = setInterval(tick, 250);
}

function stopCountdown() {
  if (state.countdownTimer) {
    clearInterval(state.countdownTimer);
    state.countdownTimer = null;
  }
  els.countdown.classList.add('hidden');
}

function onHoldExpired() {
  setMessage('Your hold expired and the seats were released.', 'error');
  state.hold = null;
  stopCountdown();
  refreshSeats();
}

// ---- Selection -----------------------------------------------------------
function toggleSelect(seatId) {
  if (state.hold) return; // cannot change selection while holding
  const seat = state.seats.get(seatId);
  if (!seat) return;
  if (state.selected.has(seatId)) {
    state.selected.delete(seatId);
  } else {
    if (!isSelectable(seat)) {
      setMessage(`Seat ${seatId} is not available.`, 'error');
      return;
    }
    state.selected.add(seatId);
  }
  setMessage('');
  render();
}

// ---- API calls -----------------------------------------------------------
async function refreshSeats() {
  try {
    const res = await fetch(`${API}/seats`);
    const data = await res.json();
    state.holdTtlMs = data.holdTtlMs;
    applySeats(data.seats);
    render();
  } catch (err) {
    setMessage('Failed to load seats: ' + err.message, 'error');
  }
}

function applySeats(seats) {
  state.seats.clear();
  for (const s of seats) state.seats.set(s.id, s);
  // Prune selections that are no longer available.
  for (const id of [...state.selected]) {
    const s = state.seats.get(id);
    if (!s || s.status !== 'available') state.selected.delete(id);
  }
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
      body: JSON.stringify({ seatIds, sessionId }),
    });
    const data = await res.json();
    if (res.status === 409) {
      // Some seats already taken.
      const conflicts = data.conflicts || [];
      setMessage(
        `Could not hold — already taken: ${conflicts.join(', ')}. Map refreshed.`,
        'error'
      );
      flashSeats(conflicts);
      state.selected.clear();
      await refreshSeats();
      return;
    }
    if (!res.ok) {
      setMessage(data.error || 'Hold failed.', 'error');
      await refreshSeats();
      return;
    }
    state.hold = {
      holdId: data.holdId,
      seatIds: data.seatIds,
      expiresAt: data.expiresAt,
    };
    state.selected.clear();
    setMessage(`Held ${data.seatIds.length} seat(s). Confirm to book.`, 'success');
    await refreshSeats();
    startCountdown();
  } catch (err) {
    setMessage('Hold request failed: ' + err.message, 'error');
  } finally {
    renderControls();
  }
}

async function confirmBooking() {
  if (!state.hold) return;
  els.confirmBtn.disabled = true;
  setMessage('Confirming…', 'info');
  try {
    const res = await fetch(
      `${API}/holds/${encodeURIComponent(state.hold.holdId)}/confirm`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      }
    );
    const data = await res.json();
    if (!res.ok) {
      setMessage(data.error || 'Confirmation failed.', 'error');
      state.hold = null;
      stopCountdown();
      await refreshSeats();
      return;
    }
    setMessage(
      `Booked ${data.bookedSeatIds.length} seat(s): ${data.bookedSeatIds.join(', ')}.`,
      'success'
    );
    state.hold = null;
    stopCountdown();
    await refreshSeats();
  } catch (err) {
    setMessage('Confirm request failed: ' + err.message, 'error');
  } finally {
    renderControls();
  }
}

async function releaseCurrentHold() {
  if (!state.hold) return;
  els.releaseBtn.disabled = true;
  const holdId = state.hold.holdId;
  setMessage('Releasing hold…', 'info');
  try {
    await fetch(`${API}/holds/${encodeURIComponent(holdId)}`, {
      method: 'DELETE',
    });
    state.hold = null;
    stopCountdown();
    setMessage('Hold released.', 'info');
    await refreshSeats();
  } catch (err) {
    setMessage('Release failed: ' + err.message, 'error');
  } finally {
    renderControls();
  }
}

// ---- Visual flash for conflicting seats ----------------------------------
function flashSeats(ids) {
  for (const id of ids) {
    const btn = els.seatmap.querySelector(`[data-seat-id="${id}"]`);
    if (btn) {
      btn.classList.add('flash');
      setTimeout(() => btn.classList.remove('flash'), 800);
    }
  }
}

// ---- SSE -----------------------------------------------------------------
function connectSSE() {
  const es = new EventSource(`${API}/stream`);

  es.addEventListener('connected', () => {
    els.connDot.className = 'dot live';
    els.connText.textContent = 'live';
  });

  es.addEventListener('seats-changed', (e) => {
    try {
      const data = JSON.parse(e.data);
      applySeatChanges(data.changes);
      render();
    } catch (_) {
      /* ignore malformed */
    }
  });

  es.onerror = () => {
    els.connDot.className = 'dot down';
    els.connText.textContent = 'reconnecting…';
    // EventSource auto-reconnects; refresh on recovery.
  };

  es.onopen = () => {
    els.connDot.className = 'dot live';
    els.connText.textContent = 'live';
    refreshSeats();
  };
}

function applySeatChanges(changes) {
  for (const ch of changes) {
    const seat = ch.seat;
    state.seats.set(seat.id, seat);

    // If one of my held seats was released by the server (expiry), drop my hold.
    if (
      state.hold &&
      ch.transition === 'released' &&
      state.hold.seatIds.includes(seat.id)
    ) {
      state.hold = null;
      stopCountdown();
      setMessage('Your hold expired and the seats were released.', 'error');
    }
    // If a seat I selected became unavailable, deselect it.
    if (seat.status !== 'available' && state.selected.has(seat.id)) {
      // keep selected only if it's still available
      state.selected.delete(seat.id);
    }
  }
}

// ---- Wire up -------------------------------------------------------------
els.holdBtn.addEventListener('click', placeHold);
els.confirmBtn.addEventListener('click', confirmBooking);
els.releaseBtn.addEventListener('click', releaseCurrentHold);

// Release hold when leaving the page (best-effort).
window.addEventListener('beforeunload', () => {
  if (state.hold) {
    navigator.sendBeacon?.(
      `${API}/holds/${encodeURIComponent(state.hold.holdId)}`
    );
    // sendBeacon uses POST; DELETE not possible. Fallback: keepalive fetch.
    try {
      fetch(`${API}/holds/${encodeURIComponent(state.hold.holdId)}`, {
        method: 'DELETE',
        keepalive: true,
      });
    } catch (_) {
      /* ignore */
    }
  }
});

// Initial load + live connection.
refreshSeats().then(connectSSE);
