// Seat-booking SPA. Renders a live seat map, lets the user hold and confirm
// seats, and stays in sync with all other clients via Server-Sent Events.

const API = '/api';

// --- Session ---------------------------------------------------------------
function getSessionId() {
  let id = localStorage.getItem('seat-session-id');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('seat-session-id', id);
  }
  return id;
}
const sessionId = getSessionId();

// --- State -----------------------------------------------------------------
const state = {
  seats: new Map(),       // id -> seat object (effective)
  selected: new Set(),    // seat ids selected but not yet held
  hold: null,             // { holdId, seatIds, expiresAt }
  countdownTimer: null
};

// --- DOM refs --------------------------------------------------------------
const el = {
  seatmap: document.getElementById('seatmap'),
  conn: document.getElementById('conn'),
  inventory: document.getElementById('inventory'),
  selectionInfo: document.getElementById('selectionInfo'),
  holdPanel: document.getElementById('holdPanel'),
  selectPanel: document.getElementById('selectPanel'),
  holdSeats: document.getElementById('holdSeats'),
  countdown: document.getElementById('countdown'),
  confirmBtn: document.getElementById('confirmBtn'),
  releaseBtn: document.getElementById('releaseBtn'),
  holdBtn: document.getElementById('holdBtn'),
  clearBtn: document.getElementById('clearBtn'),
  message: document.getElementById('message'),
  sessionId: document.getElementById('sessionId')
};
el.sessionId.textContent = sessionId;

// --- Messaging -------------------------------------------------------------
function setMessage(text, kind = 'info') {
  el.message.textContent = text || '';
  el.message.className = 'message' + (text ? ' ' + kind : '');
}

// --- Rendering -------------------------------------------------------------
function effectiveClass(seat) {
  if (state.selected.has(seat.id)) return 'selected';
  if (seat.status === 'booked') return 'booked';
  if (seat.status === 'held') {
    if (state.hold && seat.holdId === state.hold.holdId) return 'mine';
    return 'held';
  }
  return 'available';
}

function renderSeatMap() {
  const seats = [...state.seats.values()];
  // Group by row.
  const rows = new Map();
  for (const s of seats) {
    if (!rows.has(s.row)) rows.set(s.row, []);
    rows.get(s.row).push(s);
  }

  const frag = document.createDocumentFragment();
  for (const [rowLabel, rowSeats] of rows) {
    rowSeats.sort((a, b) => a.number - b.number);
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';

    const label = document.createElement('span');
    label.className = 'row-label';
    label.textContent = rowLabel;
    rowEl.appendChild(label);

    for (const seat of rowSeats) {
      const btn = document.createElement('button');
      const cls = effectiveClass(seat);
      btn.className = 'seat ' + cls;
      btn.textContent = seat.number;
      btn.dataset.id = seat.id;
      btn.title = `${seat.id} — ${cls}`;
      const interactable = cls === 'available' || cls === 'selected';
      btn.disabled = !interactable || !!state.hold;
      btn.addEventListener('click', () => toggleSeat(seat.id));
      rowEl.appendChild(btn);
    }
    frag.appendChild(rowEl);
  }

  el.seatmap.replaceChildren(frag);
  updateInventory();
  updateControls();
}

function updateInventory() {
  let available = 0, held = 0, booked = 0;
  for (const s of state.seats.values()) {
    if (s.status === 'available') available++;
    else if (s.status === 'held') held++;
    else booked++;
  }
  el.inventory.textContent =
    `${available} available · ${held} held · ${booked} booked`;
}

function updateControls() {
  const count = state.selected.size;
  if (state.hold) {
    el.selectPanel.classList.add('hidden');
    el.holdPanel.classList.remove('hidden');
    el.holdSeats.textContent = `Holding: ${state.hold.seatIds.join(', ')}`;
  } else {
    el.holdPanel.classList.add('hidden');
    el.selectPanel.classList.remove('hidden');
    el.holdBtn.disabled = count === 0;
    el.clearBtn.disabled = count === 0;
    el.selectionInfo.textContent = count
      ? `${count} seat${count > 1 ? 's' : ''} selected: ${[...state.selected].join(', ')}`
      : 'No seats selected.';
  }
}

// --- Selection -------------------------------------------------------------
function toggleSeat(id) {
  if (state.hold) return;
  const seat = state.seats.get(id);
  if (!seat) return;
  if (state.selected.has(id)) {
    state.selected.delete(id);
  } else {
    if (seat.status !== 'available') {
      flashSeat(id);
      setMessage(`Seat ${id} is no longer available.`, 'error');
      return;
    }
    state.selected.add(id);
  }
  renderSeatMap();
}

function flashSeat(id) {
  const node = el.seatmap.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (node) {
    node.classList.remove('flash');
    void node.offsetWidth;
    node.classList.add('flash');
  }
}

// --- API calls -------------------------------------------------------------
async function loadSeats() {
  const res = await fetch(`${API}/seats`);
  const data = await res.json();
  state.seats = new Map(data.seats.map((s) => [s.id, s]));
  // Drop selections that are no longer available.
  for (const id of [...state.selected]) {
    const s = state.seats.get(id);
    if (!s || s.status !== 'available') state.selected.delete(id);
  }
  renderSeatMap();
}

async function requestHold() {
  const seatIds = [...state.selected];
  if (seatIds.length === 0) return;
  el.holdBtn.disabled = true;
  setMessage('Requesting hold…', 'info');
  try {
    const res = await fetch(`${API}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId })
    });
    const data = await res.json();

    if (res.status === 201) {
      state.hold = {
        holdId: data.hold.holdId,
        seatIds: data.hold.seatIds,
        expiresAt: new Date(data.hold.expiresAt).getTime()
      };
      state.selected.clear();
      setMessage('Seats held! Confirm before the timer runs out.', 'success');
      startCountdown();
      await loadSeats();
    } else if (res.status === 409) {
      const taken = data.conflictSeatIds || [];
      setMessage(
        `These seats were just taken: ${taken.join(', ')}. Map refreshed.`,
        'error'
      );
      taken.forEach(flashSeat);
      taken.forEach((id) => state.selected.delete(id));
      await loadSeats();
    } else {
      setMessage(data.error || 'Could not hold seats.', 'error');
      await loadSeats();
    }
  } catch (err) {
    setMessage('Network error placing hold.', 'error');
  } finally {
    updateControls();
  }
}

async function confirmCurrentHold() {
  if (!state.hold) return;
  el.confirmBtn.disabled = true;
  setMessage('Confirming…', 'info');
  try {
    const res = await fetch(`${API}/holds/${state.hold.holdId}/confirm`, {
      method: 'POST'
    });
    const data = await res.json();
    if (res.ok) {
      const seats = data.booking ? data.booking.seatIds.join(', ') : '';
      setMessage(`Booked ${seats}! 🎉`, 'success');
      clearHold();
      await loadSeats();
    } else {
      setMessage(data.error || 'Confirmation failed; the hold may have expired.', 'error');
      clearHold();
      await loadSeats();
    }
  } catch (err) {
    setMessage('Network error confirming hold.', 'error');
  } finally {
    el.confirmBtn.disabled = false;
  }
}

async function releaseCurrentHold() {
  if (!state.hold) return;
  const holdId = state.hold.holdId;
  clearHold();
  setMessage('Hold released.', 'info');
  try {
    await fetch(`${API}/holds/${holdId}`, { method: 'DELETE' });
  } catch {
    /* SSE / reload will reconcile */
  }
  await loadSeats();
}

// --- Hold countdown --------------------------------------------------------
function startCountdown() {
  stopCountdown();
  state.countdownTimer = setInterval(tickCountdown, 250);
  tickCountdown();
}
function stopCountdown() {
  if (state.countdownTimer) clearInterval(state.countdownTimer);
  state.countdownTimer = null;
}
function tickCountdown() {
  if (!state.hold) { stopCountdown(); return; }
  const remaining = state.hold.expiresAt - Date.now();
  if (remaining <= 0) {
    el.countdown.textContent = '0s';
    setMessage('Your hold expired. Those seats are available again.', 'error');
    clearHold();
    loadSeats();
    return;
  }
  el.countdown.textContent = `${Math.ceil(remaining / 1000)}s`;
}
function clearHold() {
  state.hold = null;
  stopCountdown();
  updateControls();
}

// --- SSE -------------------------------------------------------------------
function applySeatUpdates(seats) {
  if (!Array.isArray(seats)) return;
  for (const s of seats) {
    state.seats.set(s.id, s);
    // If a seat we selected got taken by someone else, drop it.
    if (state.selected.has(s.id) && s.status !== 'available') {
      state.selected.delete(s.id);
    }
  }
  // If our held seats got released/booked by the server, reflect that.
  if (state.hold) {
    const stillMine = state.hold.seatIds.some((id) => {
      const seat = state.seats.get(id);
      return seat && seat.status === 'held' && seat.holdId === state.hold.holdId;
    });
    const becameBooked = state.hold.seatIds.every((id) => {
      const seat = state.seats.get(id);
      return seat && seat.status === 'booked' && seat.bookedBy === state.hold.holdId;
    });
    if (becameBooked) {
      clearHold();
    } else if (!stillMine) {
      // Released or expired elsewhere.
      clearHold();
    }
  }
  renderSeatMap();
}

function connectSSE() {
  const es = new EventSource(`${API}/stream`);

  es.onopen = () => {
    el.conn.textContent = 'live';
    el.conn.className = 'conn online';
  };
  es.onerror = () => {
    el.conn.textContent = 'reconnecting…';
    el.conn.className = 'conn offline';
  };

  const handler = (e) => {
    try {
      const payload = JSON.parse(e.data);
      applySeatUpdates(payload.seats);
    } catch {
      /* ignore malformed */
    }
  };
  es.addEventListener('held', handler);
  es.addEventListener('booked', handler);
  es.addEventListener('released', handler);
}

// --- Wire up ---------------------------------------------------------------
el.holdBtn.addEventListener('click', requestHold);
el.clearBtn.addEventListener('click', () => {
  state.selected.clear();
  renderSeatMap();
  setMessage('');
});
el.confirmBtn.addEventListener('click', confirmCurrentHold);
el.releaseBtn.addEventListener('click', releaseCurrentHold);

// Release the hold if the user closes the tab (best effort).
window.addEventListener('beforeunload', () => {
  if (state.hold) {
    navigator.sendBeacon?.(`${API}/holds/${state.hold.holdId}`);
    // Fallback DELETE via keepalive fetch.
    fetch(`${API}/holds/${state.hold.holdId}`, { method: 'DELETE', keepalive: true });
  }
});

// --- Boot ------------------------------------------------------------------
(async function init() {
  await loadSeats();
  // Defer opening the persistent SSE connection briefly so the initial page
  // load can settle (otherwise the always-open stream keeps the network busy).
  setTimeout(connectSSE, 800);
})();
