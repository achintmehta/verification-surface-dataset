// Seat-booking SPA frontend.

// --- Session identity -------------------------------------------------------
function getSessionId() {
  let id = localStorage.getItem('seat-session-id');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('seat-session-id', id);
  }
  return id;
}
const SESSION_ID = getSessionId();

// --- State ------------------------------------------------------------------
let seats = []; // effective seats from server
const selected = new Set(); // seat ids selected for hold
let currentHold = null; // { holdId, seatIds, expiresAt }
let countdownTimer = null;

// --- DOM refs ---------------------------------------------------------------
const seatmapEl = document.getElementById('seatmap');
const inventoryEl = document.getElementById('inventory');
const statusEl = document.getElementById('status');
const connEl = document.getElementById('connection');
const countdownEl = document.getElementById('countdown');
const holdBtn = document.getElementById('holdBtn');
const confirmBtn = document.getElementById('confirmBtn');
const releaseBtn = document.getElementById('releaseBtn');

// --- Helpers ----------------------------------------------------------------
function setStatus(msg, kind = '') {
  statusEl.textContent = msg;
  statusEl.className = `status ${kind}`;
}

function seatById(id) {
  return seats.find((s) => s.id === id);
}

// Effective status of a seat considering local selection and ownership of holds.
function renderClass(seat) {
  if (selected.has(seat.id)) return 'selected';
  if (seat.status === 'held') {
    if (currentHold && currentHold.holdId === seat.holdId) return 'mine';
    return 'held';
  }
  if (seat.status === 'booked') return 'booked';
  return 'available';
}

function render() {
  // Group seats by row.
  const byRow = new Map();
  for (const s of seats) {
    if (!byRow.has(s.rowLabel)) byRow.set(s.rowLabel, []);
    byRow.get(s.rowLabel).push(s);
  }

  seatmapEl.innerHTML = '';
  for (const [label, rowSeats] of byRow) {
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';

    const labelEl = document.createElement('span');
    labelEl.className = 'row-label';
    labelEl.textContent = label;
    rowEl.appendChild(labelEl);

    rowSeats
      .sort((a, b) => a.seatNumber - b.seatNumber)
      .forEach((seat) => {
        const btn = document.createElement('button');
        btn.className = `seat ${renderClass(seat)}`;
        btn.textContent = seat.seatNumber;
        btn.title = seat.id;
        btn.dataset.id = seat.id;

        const isMine = currentHold && currentHold.holdId === seat.holdId;
        const selectable = seat.status === 'available' && !currentHold;
        btn.disabled = !selectable && !selected.has(seat.id);
        if (selected.has(seat.id)) btn.disabled = false;
        if (isMine) btn.disabled = true;

        btn.addEventListener('click', () => toggleSeat(seat.id));
        rowEl.appendChild(btn);
      });

    seatmapEl.appendChild(rowEl);
  }

  updateInventory();
  updateControls();
}

function updateInventory() {
  const now = Date.now();
  let available = 0;
  let held = 0;
  let booked = 0;
  for (const s of seats) {
    if (s.status === 'booked') booked += 1;
    else if (
      s.status === 'held' &&
      s.holdExpiresAt &&
      new Date(s.holdExpiresAt).getTime() > now
    )
      held += 1;
    else available += 1;
  }
  inventoryEl.textContent = `Available: ${available} · Held: ${held} · Booked: ${booked} · Total: ${seats.length}`;
}

function updateControls() {
  holdBtn.disabled = selected.size === 0 || !!currentHold;
  confirmBtn.disabled = !currentHold;
  releaseBtn.disabled = !currentHold;
}

// --- Selection --------------------------------------------------------------
function toggleSeat(id) {
  if (currentHold) return;
  const seat = seatById(id);
  if (!seat || seat.status !== 'available') return;
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  render();
}

function clearSelection() {
  selected.clear();
}

// --- Countdown --------------------------------------------------------------
function startCountdown() {
  stopCountdown();
  if (!currentHold) return;
  const tick = () => {
    const remaining = new Date(currentHold.expiresAt).getTime() - Date.now();
    if (remaining <= 0) {
      countdownEl.textContent = '';
      setStatus('Your hold expired. Seats released.', 'error');
      currentHold = null;
      stopCountdown();
      refreshSeats();
      return;
    }
    const secs = Math.ceil(remaining / 1000);
    countdownEl.textContent = `Hold expires in ${secs}s`;
  };
  tick();
  countdownTimer = setInterval(tick, 250);
}

function stopCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = null;
  countdownEl.textContent = '';
}

// --- API --------------------------------------------------------------------
async function refreshSeats() {
  const res = await fetch('/api/seats');
  const data = await res.json();
  seats = data.seats;
  render();
}

async function doHold() {
  const seatIds = [...selected];
  if (seatIds.length === 0) return;
  setStatus('Placing hold…');
  try {
    const res = await fetch('/api/holds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId: SESSION_ID }),
    });
    if (res.status === 409) {
      const body = await res.json();
      handleConflict(body.conflicts || []);
      return;
    }
    if (!res.ok) {
      setStatus('Could not place hold.', 'error');
      return;
    }
    const { hold } = await res.json();
    currentHold = hold;
    clearSelection();
    setStatus(`Held ${hold.seatIds.length} seat(s). Confirm before they expire.`, 'success');
    startCountdown();
    await refreshSeats();
  } catch {
    setStatus('Network error placing hold.', 'error');
  }
}

function handleConflict(conflicts) {
  setStatus(
    `These seats were just taken: ${conflicts.join(', ')}. Refreshing…`,
    'error'
  );
  // Remove conflicting seats from selection and flash them.
  conflicts.forEach((id) => selected.delete(id));
  refreshSeats().then(() => {
    conflicts.forEach((id) => {
      const btn = seatmapEl.querySelector(`[data-id="${id}"]`);
      if (btn) {
        btn.classList.add('conflict');
        setTimeout(() => btn.classList.remove('conflict'), 1500);
      }
    });
  });
}

async function doConfirm() {
  if (!currentHold) return;
  setStatus('Confirming…');
  try {
    const res = await fetch(`/api/holds/${currentHold.holdId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setStatus(`Confirmation failed: ${body.error || 'unknown'}.`, 'error');
      currentHold = null;
      stopCountdown();
      await refreshSeats();
      return;
    }
    const { booking, idempotent } = await res.json();
    setStatus(
      `Booked ${booking.seatIds.length} seat(s): ${booking.seatIds.join(', ')}${
        idempotent ? ' (already confirmed)' : ''
      }.`,
      'success'
    );
    currentHold = null;
    stopCountdown();
    await refreshSeats();
  } catch {
    setStatus('Network error confirming.', 'error');
  }
}

async function doRelease() {
  if (!currentHold) return;
  const holdId = currentHold.holdId;
  setStatus('Releasing hold…');
  try {
    await fetch(`/api/holds/${holdId}`, { method: 'DELETE' });
    currentHold = null;
    stopCountdown();
    setStatus('Hold released.', '');
    await refreshSeats();
  } catch {
    setStatus('Network error releasing.', 'error');
  }
}

// --- SSE --------------------------------------------------------------------
function applyDelta(payload) {
  const { type, seatIds } = payload;
  if (!Array.isArray(seatIds)) return;
  for (const id of seatIds) {
    const seat = seatById(id);
    if (!seat) continue;
    if (type === 'released') {
      seat.status = 'available';
      seat.holdId = null;
      seat.holdExpiresAt = null;
      seat.bookedBy = null;
    } else if (type === 'held') {
      seat.status = 'held';
      seat.holdId = payload.holdId || null;
      seat.holdExpiresAt = payload.expiresAt || null;
    } else if (type === 'booked') {
      seat.status = 'booked';
      seat.holdExpiresAt = null;
    }
  }

  // If our own hold's seats got released or booked by something else, reconcile.
  if (currentHold) {
    const stillHeldByMe = currentHold.seatIds.every((id) => {
      const s = seatById(id);
      return s && s.status === 'held' && s.holdId === currentHold.holdId;
    });
    if (type === 'released' && !stillHeldByMe) {
      // our hold may have expired
    }
  }

  render();
}

function connectSSE() {
  const es = new EventSource('/api/stream');

  es.addEventListener('open', () => {
    connEl.textContent = 'live';
    connEl.className = 'conn online';
  });

  es.addEventListener('snapshot', (e) => {
    try {
      const data = JSON.parse(e.data);
      seats = data.seats;
      render();
    } catch {
      /* ignore */
    }
  });

  es.addEventListener('seats', (e) => {
    try {
      applyDelta(JSON.parse(e.data));
    } catch {
      /* ignore */
    }
  });

  es.addEventListener('error', () => {
    connEl.textContent = 'reconnecting…';
    connEl.className = 'conn offline';
  });
}

// --- Wire up ----------------------------------------------------------------
holdBtn.addEventListener('click', doHold);
confirmBtn.addEventListener('click', doConfirm);
releaseBtn.addEventListener('click', doRelease);

refreshSeats().catch(() => setStatus('Could not load seats.', 'error'));
connectSSE();
