// Seat-booking SPA frontend.
// Talks to the backend API and stays live via Server-Sent Events.

const API = '/api';

// --- Session identity (client-supplied, persisted) ------------------------
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
  seats: new Map(),     // id -> seat object
  selected: new Set(),  // seat ids selected (pending hold)
  hold: null,           // { holdId, seatIds, expiresAt }
  ttlMs: 60000,
  countdownTimer: null
};

// --- DOM refs -------------------------------------------------------------
const el = {
  seatmap: document.getElementById('seatmap'),
  connDot: document.getElementById('conn-dot'),
  connText: document.getElementById('conn-text'),
  selectionText: document.getElementById('selection-text'),
  holdBtn: document.getElementById('hold-btn'),
  holdBox: document.getElementById('hold-box'),
  holdSeats: document.getElementById('hold-seats'),
  countdown: document.getElementById('countdown'),
  confirmBtn: document.getElementById('confirm-btn'),
  releaseBtn: document.getElementById('release-btn'),
  message: document.getElementById('message'),
  sessionId: document.getElementById('session-id'),
  invAvailable: document.getElementById('inv-available'),
  invHeld: document.getElementById('inv-held'),
  invBooked: document.getElementById('inv-booked'),
  invTotal: document.getElementById('inv-total')
};

el.sessionId.textContent = sessionId.slice(0, 12);

// --- Helpers --------------------------------------------------------------
function seatName(seat) {
  return `${seat.row}${seat.number}`;
}

function showMessage(text, kind = 'info', autoHideMs = 0) {
  el.message.textContent = text;
  el.message.className = `message ${kind}`;
  el.message.classList.remove('hidden');
  if (autoHideMs) {
    setTimeout(() => el.message.classList.add('hidden'), autoHideMs);
  }
}

function clearMessage() {
  el.message.classList.add('hidden');
}

/**
 * Determine the effective rendering status of a seat for this client.
 * A held/booked seat owned by *us* is highlighted specially.
 */
function effectiveClass(seat) {
  if (seat.status === 'booked') {
    return seat.bookedBy === sessionId ? 'mine' : 'booked';
  }
  if (seat.status === 'held') {
    // If it is the seat we hold (matching our active hold), mark as mine.
    if (state.hold && state.hold.seatIds.includes(seat.id)) return 'mine';
    return 'held';
  }
  // available
  if (state.selected.has(seat.id)) return 'selected';
  return 'available';
}

// --- Rendering ------------------------------------------------------------
function render() {
  // Group seats by row in order.
  const rows = new Map();
  const sorted = [...state.seats.values()].sort((a, b) => {
    if (a.row !== b.row) return a.row < b.row ? -1 : 1;
    return a.number - b.number;
  });
  for (const seat of sorted) {
    if (!rows.has(seat.row)) rows.set(seat.row, []);
    rows.get(seat.row).push(seat);
  }

  el.seatmap.innerHTML = '';
  for (const [label, seats] of rows) {
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';

    const labelEl = document.createElement('span');
    labelEl.className = 'row-label';
    labelEl.textContent = label;
    rowEl.appendChild(labelEl);

    for (const seat of seats) {
      const cls = effectiveClass(seat);
      const btn = document.createElement('button');
      btn.className = `seat ${cls}`;
      btn.textContent = seat.number;
      btn.dataset.id = seat.id;
      btn.title = `${seatName(seat)} — ${seat.status}`;

      const selectable = (cls === 'available' || cls === 'selected') && !state.hold;
      btn.disabled = !selectable;

      btn.addEventListener('click', () => toggleSelect(seat.id));
      rowEl.appendChild(btn);
    }
    el.seatmap.appendChild(rowEl);
  }

  renderSelection();
  renderInventory();
}

function renderSelection() {
  if (state.selected.size === 0) {
    el.selectionText.textContent = 'No seats selected.';
    el.holdBtn.disabled = true;
  } else {
    const names = [...state.selected]
      .map((id) => state.seats.get(id))
      .filter(Boolean)
      .map(seatName)
      .join(', ');
    el.selectionText.textContent = `${state.selected.size} selected: ${names}`;
    el.holdBtn.disabled = !!state.hold;
  }
}

function renderInventory() {
  let available = 0, held = 0, booked = 0;
  for (const seat of state.seats.values()) {
    if (seat.status === 'available') available++;
    else if (seat.status === 'held') held++;
    else if (seat.status === 'booked') booked++;
  }
  el.invAvailable.textContent = available;
  el.invHeld.textContent = held;
  el.invBooked.textContent = booked;
  el.invTotal.textContent = state.seats.size;
}

// --- Selection ------------------------------------------------------------
function toggleSelect(id) {
  if (state.hold) return; // cannot reselect while holding
  const seat = state.seats.get(id);
  if (!seat || seat.status !== 'available') return;
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  render();
}

// --- API calls ------------------------------------------------------------
async function loadSeats() {
  const res = await fetch(`${API}/seats`);
  const data = await res.json();
  state.ttlMs = data.ttlMs || state.ttlMs;
  applySeats(data.seats, true);
}

function applySeats(seats, replaceAll = false) {
  if (replaceAll) state.seats.clear();
  for (const seat of seats) {
    state.seats.set(seat.id, seat);
    // If a seat we had selected got taken, drop it from selection.
    if (seat.status !== 'available' && state.selected.has(seat.id)) {
      // keep it selected only if it's our own hold
      if (!(state.hold && state.hold.seatIds.includes(seat.id))) {
        state.selected.delete(seat.id);
      }
    }
  }
  render();
}

async function requestHold() {
  if (state.selected.size === 0 || state.hold) return;
  const seatIds = [...state.selected];
  el.holdBtn.disabled = true;
  clearMessage();

  try {
    const res = await fetch(`${API}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId })
    });

    if (res.status === 409 || res.status === 404) {
      const data = await res.json();
      handleConflict(data.conflicts || []);
      return;
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showMessage(data.error || 'Failed to hold seats.', 'error', 5000);
      return;
    }

    const data = await res.json();
    state.hold = {
      holdId: data.hold.holdId,
      seatIds: data.hold.seatIds,
      expiresAt: data.hold.expiresAt
    };
    state.selected.clear();
    applySeats(data.seats);
    startCountdown();
    showHoldBox();
    showMessage(`Held ${data.seats.length} seat(s). Confirm before the timer runs out!`, 'success', 4000);
  } catch (err) {
    showMessage('Network error while holding seats.', 'error', 5000);
  } finally {
    renderSelection();
  }
}

function handleConflict(conflicts) {
  showMessage(
    `Some seats were just taken: ${conflicts.map((id) => {
      const s = state.seats.get(id);
      return s ? seatName(s) : `#${id}`;
    }).join(', ')}. Refreshing…`,
    'error',
    5000
  );
  // Flash the conflicting seats, then refresh the map.
  for (const id of conflicts) {
    const btn = el.seatmap.querySelector(`[data-id="${id}"]`);
    if (btn) {
      btn.classList.add('conflict');
      setTimeout(() => btn.classList.remove('conflict'), 600);
    }
    state.selected.delete(id);
  }
  loadSeats().catch(() => {});
}

async function confirmHold() {
  if (!state.hold) return;
  el.confirmBtn.disabled = true;
  try {
    const res = await fetch(`${API}/holds/${state.hold.holdId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    });

    if (res.status === 410) {
      showMessage('Your hold expired before confirmation. Please try again.', 'error', 6000);
      endHold();
      loadSeats().catch(() => {});
      return;
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showMessage(data.error || 'Confirmation failed.', 'error', 5000);
      el.confirmBtn.disabled = false;
      return;
    }

    const data = await res.json();
    applySeats(data.seats);
    const note = data.alreadyConfirmed ? ' (already booked)' : '';
    showMessage(`Booked ${data.seats.length} seat(s)!${note}`, 'success', 6000);
    endHold();
  } catch (err) {
    showMessage('Network error during confirmation.', 'error', 5000);
    el.confirmBtn.disabled = false;
  }
}

async function releaseHold() {
  if (!state.hold) return;
  const holdId = state.hold.holdId;
  el.releaseBtn.disabled = true;
  try {
    const res = await fetch(`${API}/holds/${holdId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    });
    if (res.ok) {
      const data = await res.json();
      applySeats(data.seats);
      showMessage('Hold released.', 'info', 3000);
    }
  } catch {
    // ignore; SSE / refresh will reconcile
  } finally {
    endHold();
    loadSeats().catch(() => {});
  }
}

// --- Hold UI / countdown --------------------------------------------------
function showHoldBox() {
  const names = state.hold.seatIds
    .map((id) => state.seats.get(id))
    .filter(Boolean)
    .map(seatName)
    .join(', ');
  el.holdSeats.textContent = `Seats: ${names}`;
  el.holdBox.classList.remove('hidden');
  el.confirmBtn.disabled = false;
  el.releaseBtn.disabled = false;
}

function startCountdown() {
  stopCountdown();
  const tick = () => {
    if (!state.hold) return stopCountdown();
    const remaining = new Date(state.hold.expiresAt).getTime() - Date.now();
    if (remaining <= 0) {
      el.countdown.textContent = '00:00';
      stopCountdown();
      showMessage('Your hold expired. Seats released.', 'error', 6000);
      endHold();
      loadSeats().catch(() => {});
      return;
    }
    const totalSec = Math.ceil(remaining / 1000);
    const m = String(Math.floor(totalSec / 60)).padStart(2, '0');
    const s = String(totalSec % 60).padStart(2, '0');
    el.countdown.textContent = `${m}:${s}`;
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

function endHold() {
  stopCountdown();
  state.hold = null;
  el.holdBox.classList.add('hidden');
  render();
}

// --- SSE ------------------------------------------------------------------
function connectStream() {
  const es = new EventSource(`${API}/stream`);

  es.addEventListener('open', () => {
    el.connDot.className = 'dot online';
    el.connText.textContent = 'live';
  });

  es.addEventListener('snapshot', (e) => {
    const data = JSON.parse(e.data);
    if (data.ttlMs) state.ttlMs = data.ttlMs;
    applySeats(data.seats, true);
  });

  es.addEventListener('seats', (e) => {
    const data = JSON.parse(e.data);
    applySeats(data.seats);
    // If our held seats were released by the server (expiry) and not booked
    // by us, our hold is no longer active -> tear down the hold UI.
    if (state.hold) {
      const stillHeld = state.hold.seatIds.some((id) => {
        const s = state.seats.get(id);
        return s && s.status === 'held';
      });
      const bookedByUs = state.hold.seatIds.some((id) => {
        const s = state.seats.get(id);
        return s && s.status === 'booked' && s.bookedBy === sessionId;
      });
      if (!stillHeld && !bookedByUs) {
        endHold();
      }
    }
  });

  es.addEventListener('error', () => {
    el.connDot.className = 'dot offline';
    el.connText.textContent = 'reconnecting…';
    // EventSource auto-reconnects.
  });
}

// --- Wire up --------------------------------------------------------------
el.holdBtn.addEventListener('click', requestHold);
el.confirmBtn.addEventListener('click', confirmHold);
el.releaseBtn.addEventListener('click', releaseHold);

// Initial load + live stream.
loadSeats().catch((err) => {
  showMessage('Could not load seat map. Is the server running?', 'error');
  console.error(err);
});
connectStream();
