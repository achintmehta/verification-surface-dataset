// Seat-booking SPA

const API = '/api';

// --- session id (client-supplied holder identity) ---
function getSessionId() {
  let id = localStorage.getItem('seat-session');
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) ||
      'sess-' + Math.random().toString(36).slice(2);
    localStorage.setItem('seat-session', id);
  }
  return id;
}
const sessionId = getSessionId();

// --- state ---
const state = {
  seats: new Map(),        // id -> seat object
  selected: new Set(),     // seat ids selected (not yet held)
  currentHold: null,       // { id, expiresAt, seatIds }
  total: 0,
};

let countdownTimer = null;

// --- DOM ---
const seatmapEl = document.getElementById('seatmap');
const selectionEl = document.getElementById('selection');
const statusEl = document.getElementById('status');
const inventoryEl = document.getElementById('inventory');
const holdBtn = document.getElementById('holdBtn');
const confirmBtn = document.getElementById('confirmBtn');
const releaseBtn = document.getElementById('releaseBtn');

// --- helpers ---
function setStatus(msg, kind = 'info') {
  statusEl.className = 'status ' + kind;
  statusEl.innerHTML = msg;
}

function effectiveStatus(seat) {
  if (seat.status === 'held' && seat.holdExpiresAt) {
    if (new Date(seat.holdExpiresAt) <= new Date()) return 'available';
  }
  return seat.status;
}

function isMine(seat) {
  return state.currentHold && seat.holdId === state.currentHold.id;
}

// --- rendering ---
function render() {
  // group seats by row
  const rows = new Map();
  for (const seat of state.seats.values()) {
    if (!rows.has(seat.rowLabel)) rows.set(seat.rowLabel, []);
    rows.get(seat.rowLabel).push(seat);
  }
  const sortedRows = [...rows.keys()].sort();

  seatmapEl.innerHTML = '';
  for (const rowLabel of sortedRows) {
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';

    const label = document.createElement('span');
    label.className = 'row-label';
    label.textContent = rowLabel;
    rowEl.appendChild(label);

    const seats = rows.get(rowLabel).sort((a, b) => a.seatNumber - b.seatNumber);
    for (const seat of seats) {
      rowEl.appendChild(renderSeat(seat));
    }
    seatmapEl.appendChild(rowEl);
  }

  renderSelection();
  renderInventory();
  updateButtons();
}

function renderSeat(seat) {
  const btn = document.createElement('button');
  btn.className = 'seat';
  btn.textContent = seat.seatNumber;
  btn.dataset.id = seat.id;
  btn.title = seat.id;

  const eff = effectiveStatus(seat);
  let cls = eff;

  if (eff === 'booked') {
    btn.disabled = true;
  } else if (eff === 'held') {
    if (isMine(seat)) {
      cls = 'mine';
      btn.disabled = true;
    } else {
      btn.disabled = true; // held by someone else
    }
  } else {
    // available
    if (state.selected.has(seat.id)) cls = 'selected';
    btn.disabled = !!state.currentHold; // can't select while you have an active hold
  }

  btn.classList.add(cls);
  btn.onclick = () => toggleSelect(seat.id);
  return btn;
}

function renderSelection() {
  if (state.currentHold) {
    const ids = state.currentHold.seatIds.join(', ');
    selectionEl.innerHTML =
      `Holding <b>${ids}</b> &mdash; expires in ` +
      `<span class="countdown" id="cd"></span>`;
  } else if (state.selected.size > 0) {
    selectionEl.innerHTML =
      `Selected: <b>${[...state.selected].sort().join(', ')}</b>`;
  } else {
    selectionEl.textContent = 'No seats selected.';
  }
}

function renderInventory() {
  let available = 0, held = 0, booked = 0;
  for (const seat of state.seats.values()) {
    const eff = effectiveStatus(seat);
    if (eff === 'available') available++;
    else if (eff === 'held') held++;
    else if (eff === 'booked') booked++;
  }
  inventoryEl.innerHTML =
    `Available <b>${available}</b> · Held <b>${held}</b> · ` +
    `Booked <b>${booked}</b> · Total <b>${state.total}</b>`;
}

function updateButtons() {
  holdBtn.disabled = state.selected.size === 0 || !!state.currentHold;
  confirmBtn.disabled = !state.currentHold;
  releaseBtn.disabled = !state.currentHold;
}

// --- selection ---
function toggleSelect(id) {
  if (state.currentHold) return;
  const seat = state.seats.get(id);
  if (!seat || effectiveStatus(seat) !== 'available') return;
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  render();
}

// --- countdown ---
function startCountdown() {
  stopCountdown();
  countdownTimer = setInterval(() => {
    if (!state.currentHold) { stopCountdown(); return; }
    const remaining = new Date(state.currentHold.expiresAt) - Date.now();
    const cd = document.getElementById('cd');
    if (remaining <= 0) {
      // Hold expired locally; the server will broadcast release.
      handleHoldExpired();
      return;
    }
    if (cd) {
      const secs = Math.ceil(remaining / 1000);
      cd.textContent = `${secs}s`;
    }
  }, 250);
}
function stopCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = null;
}

function handleHoldExpired() {
  stopCountdown();
  state.currentHold = null;
  setStatus('Your hold expired and the seats were released.', 'error');
  render();
  loadSeats();
}

// --- API calls ---
async function loadSeats() {
  const res = await fetch(`${API}/seats`);
  const data = await res.json();
  state.total = data.total;
  state.seats = new Map(data.seats.map((s) => [s.id, s]));
  // Drop selections that are no longer available.
  for (const id of [...state.selected]) {
    const seat = state.seats.get(id);
    if (!seat || effectiveStatus(seat) !== 'available') state.selected.delete(id);
  }
  // Validate current hold still active.
  if (state.currentHold) {
    const stillHeld = state.currentHold.seatIds.some((id) => {
      const seat = state.seats.get(id);
      return seat && seat.holdId === state.currentHold.id;
    });
    if (!stillHeld) {
      state.currentHold = null;
      stopCountdown();
    }
  }
  render();
}

async function requestHold() {
  const seatIds = [...state.selected];
  if (seatIds.length === 0) return;
  holdBtn.disabled = true;
  setStatus('Requesting hold…', 'info');

  try {
    const res = await fetch(`${API}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId }),
    });

    if (res.status === 409) {
      const data = await res.json();
      const conflicts = (data.conflicts || []).join(', ');
      setStatus(
        `Some seats were just taken: <b>${conflicts}</b>. Map refreshed — please reselect.`,
        'error'
      );
      state.selected.clear();
      await loadSeats();
      return;
    }

    if (!res.ok) {
      setStatus('Could not place hold.', 'error');
      return;
    }

    const data = await res.json();
    state.currentHold = {
      id: data.hold.id,
      expiresAt: data.hold.expiresAt,
      seatIds: data.hold.seatIds,
    };
    state.selected.clear();
    setStatus('Seats held! Confirm before the timer runs out.', 'ok');
    await loadSeats();
    startCountdown();
  } catch (err) {
    setStatus('Network error placing hold.', 'error');
  }
}

async function confirmBooking() {
  if (!state.currentHold) return;
  const holdId = state.currentHold.id;
  confirmBtn.disabled = true;
  setStatus('Confirming…', 'info');

  try {
    const res = await fetch(`${API}/holds/${holdId}/confirm`, {
      method: 'POST',
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (data.error === 'expired') {
        setStatus('Hold expired — booking failed, nothing was booked.', 'error');
      } else {
        setStatus('Could not confirm booking.', 'error');
      }
      state.currentHold = null;
      stopCountdown();
      await loadSeats();
      return;
    }

    const data = await res.json();
    const seats = data.booking.seatIds.join(', ');
    setStatus(`Booked: <b>${seats}</b> 🎉`, 'ok');
    state.currentHold = null;
    stopCountdown();
    await loadSeats();
  } catch (err) {
    setStatus('Network error confirming booking.', 'error');
  }
}

async function releaseCurrentHold() {
  if (!state.currentHold) return;
  const holdId = state.currentHold.id;
  releaseBtn.disabled = true;
  setStatus('Releasing…', 'info');

  try {
    const res = await fetch(`${API}/holds/${holdId}`, { method: 'DELETE' });
    if (!res.ok) {
      setStatus('Could not release hold.', 'error');
      return;
    }
    setStatus('Hold released.', 'info');
    state.currentHold = null;
    stopCountdown();
    await loadSeats();
  } catch (err) {
    setStatus('Network error releasing hold.', 'error');
  }
}

// --- SSE ---
function connectStream() {
  const es = new EventSource(`${API}/stream`);

  es.addEventListener('seats', (e) => {
    try {
      const data = JSON.parse(e.data);
      for (const upd of data.seats) {
        const seat = state.seats.get(upd.id);
        if (seat) {
          seat.status = upd.status;
          seat.holdId = upd.holdId;
          seat.holdExpiresAt = upd.holdExpiresAt;
          seat.bookedBy = upd.bookedBy;
        }
      }
      // If our held seats got taken away (released/booked by server expiry),
      // reconcile our hold.
      if (state.currentHold) {
        const stillMine = state.currentHold.seatIds.some((id) => {
          const seat = state.seats.get(id);
          return seat && seat.holdId === state.currentHold.id && seat.status === 'held';
        });
        if (!stillMine) {
          state.currentHold = null;
          stopCountdown();
        }
      }
      render();
    } catch (err) {
      /* ignore */
    }
  });

  es.onerror = () => {
    // EventSource auto-reconnects; reload state on recovery.
  };

  es.addEventListener('hello', () => {
    loadSeats();
  });
}

// --- wire up ---
holdBtn.onclick = requestHold;
confirmBtn.onclick = confirmBooking;
releaseBtn.onclick = releaseCurrentHold;

loadSeats();
connectStream();
