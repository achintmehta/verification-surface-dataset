// --- Session identity (no auth, just a stable client id) ---
function getSessionId() {
  let id = localStorage.getItem('sessionId');
  if (!id) {
    id =
      'sess-' +
      Math.random().toString(36).slice(2) +
      Date.now().toString(36);
    localStorage.setItem('sessionId', id);
  }
  return id;
}
const SESSION_ID = getSessionId();

// --- State ---
let seats = new Map(); // id -> seat object
let selected = new Set(); // seat ids selected for holding
let currentHold = null; // { id, seatIds, expiresAt }
let countdownTimer = null;
let holdTtlMs = 120000;

// --- DOM refs ---
const seatMapEl = document.getElementById('seat-map');
const selectionInfoEl = document.getElementById('selection-info');
const holdBtn = document.getElementById('hold-btn');
const confirmBtn = document.getElementById('confirm-btn');
const releaseBtn = document.getElementById('release-btn');
const countdownEl = document.getElementById('countdown');
const messageEl = document.getElementById('message');
const connectionEl = document.getElementById('connection');
const inventoryEl = document.getElementById('inventory');

// --- Rendering ---
function effectiveStatus(seat) {
  // A held seat whose hold has expired is effectively available client-side too.
  if (
    seat.status === 'held' &&
    seat.holdExpiresAt &&
    new Date(seat.holdExpiresAt).getTime() <= Date.now()
  ) {
    return 'available';
  }
  return seat.status;
}

function seatClass(seat) {
  const status = effectiveStatus(seat);
  if (status === 'booked') return 'booked';
  if (status === 'held') {
    if (currentHold && seat.holdId === currentHold.id) return 'mine';
    return 'held';
  }
  // available
  if (selected.has(seat.id)) return 'selected';
  return 'available';
}

function render() {
  // Group seats by row.
  const rows = new Map();
  for (const seat of seats.values()) {
    if (!rows.has(seat.row)) rows.set(seat.row, []);
    rows.get(seat.row).push(seat);
  }

  const rowLabels = [...rows.keys()].sort();
  seatMapEl.innerHTML = '';
  for (const label of rowLabels) {
    const rowSeats = rows.get(label).sort((a, b) => a.number - b.number);
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';

    const labelEl = document.createElement('span');
    labelEl.className = 'row-label';
    labelEl.textContent = label;
    rowEl.appendChild(labelEl);

    for (const seat of rowSeats) {
      const btn = document.createElement('button');
      const cls = seatClass(seat);
      btn.className = `seat ${cls}`;
      btn.textContent = seat.number;
      btn.title = `${seat.row}${seat.number} — ${effectiveStatus(seat)}`;
      btn.dataset.id = seat.id;

      const status = effectiveStatus(seat);
      const interactable =
        status === 'available' && !currentHold; // can't pick new seats while holding
      btn.disabled = !interactable;
      if (interactable) {
        btn.addEventListener('click', () => toggleSeat(seat.id));
      }
      rowEl.appendChild(btn);
    }
    seatMapEl.appendChild(rowEl);
  }

  updateControls();
  updateInventory();
}

function toggleSeat(id) {
  if (currentHold) return;
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  render();
}

function updateControls() {
  if (currentHold) {
    selectionInfoEl.textContent = `Holding ${currentHold.seatIds.length} seat(s): ${currentHold.seatIds
      .map(labelForSeat)
      .join(', ')}`;
    holdBtn.disabled = true;
    confirmBtn.disabled = false;
    releaseBtn.disabled = false;
  } else {
    const count = selected.size;
    selectionInfoEl.textContent = count
      ? `Selected ${count} seat(s): ${[...selected].map(labelForSeat).join(', ')}`
      : 'No seats selected.';
    holdBtn.disabled = count === 0;
    confirmBtn.disabled = true;
    releaseBtn.disabled = true;
  }
}

function labelForSeat(id) {
  const s = seats.get(Number(id));
  return s ? `${s.row}${s.number}` : `#${id}`;
}

function updateInventory() {
  let available = 0,
    held = 0,
    booked = 0;
  for (const seat of seats.values()) {
    const st = effectiveStatus(seat);
    if (st === 'available') available++;
    else if (st === 'held') held++;
    else if (st === 'booked') booked++;
  }
  inventoryEl.textContent = `Available: ${available} · Held: ${held} · Booked: ${booked} · Total: ${seats.size}`;
}

function setMessage(text, kind = 'info') {
  messageEl.textContent = text;
  messageEl.className = `message ${kind}`;
}

// --- Countdown for the active hold ---
function startCountdown() {
  stopCountdown();
  const tick = () => {
    if (!currentHold) return stopCountdown();
    const remaining = new Date(currentHold.expiresAt).getTime() - Date.now();
    if (remaining <= 0) {
      countdownEl.textContent = 'Hold expired';
      handleHoldExpired();
      return;
    }
    const secs = Math.ceil(remaining / 1000);
    const mm = String(Math.floor(secs / 60)).padStart(2, '0');
    const ss = String(secs % 60).padStart(2, '0');
    countdownEl.textContent = `Hold expires in ${mm}:${ss}`;
  };
  tick();
  countdownTimer = setInterval(tick, 250);
}

function stopCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = null;
}

function handleHoldExpired() {
  stopCountdown();
  setMessage('Your hold expired and the seats were released.', 'error');
  currentHold = null;
  countdownEl.textContent = '';
  // Refresh authoritative state.
  loadSeats();
}

// --- API calls ---
async function loadSeats() {
  try {
    const res = await fetch('/api/seats');
    const data = await res.json();
    holdTtlMs = data.holdTtlMs || holdTtlMs;
    seats = new Map(data.seats.map((s) => [s.id, s]));
    // Drop selections that are no longer available.
    for (const id of [...selected]) {
      const s = seats.get(id);
      if (!s || effectiveStatus(s) !== 'available') selected.delete(id);
    }
    render();
  } catch (err) {
    setMessage('Failed to load seats.', 'error');
  }
}

async function requestHold() {
  if (selected.size === 0) return;
  const seatIds = [...selected];
  holdBtn.disabled = true;
  setMessage('Requesting hold…', 'info');
  try {
    const res = await fetch('/api/holds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId: SESSION_ID }),
    });
    if (res.status === 409) {
      const data = await res.json();
      handleConflict(data.conflicts || []);
      return;
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setMessage(data.error || 'Hold failed.', 'error');
      return;
    }
    const data = await res.json();
    currentHold = {
      id: data.hold.id,
      seatIds: data.hold.seatIds,
      expiresAt: data.hold.expiresAt,
    };
    selected.clear();
    setMessage('Seats held. Confirm before the timer runs out!', 'success');
    // Update local seats immediately; SSE will confirm.
    for (const id of currentHold.seatIds) {
      const s = seats.get(id);
      if (s) {
        s.status = 'held';
        s.holdId = currentHold.id;
        s.holdExpiresAt = currentHold.expiresAt;
      }
    }
    render();
    startCountdown();
  } catch (err) {
    setMessage('Network error placing hold.', 'error');
  } finally {
    updateControls();
  }
}

function handleConflict(conflicts) {
  setMessage(
    `Some seats were just taken: ${conflicts.map(labelForSeat).join(', ')}. Refreshing…`,
    'error'
  );
  // Flash the conflicting seats.
  for (const id of conflicts) {
    const btn = seatMapEl.querySelector(`[data-id="${id}"]`);
    if (btn) {
      btn.classList.add('conflict');
    }
    selected.delete(id);
  }
  // Refresh after a moment so the flash is visible.
  setTimeout(loadSeats, 800);
}

async function confirmBooking() {
  if (!currentHold) return;
  confirmBtn.disabled = true;
  setMessage('Confirming…', 'info');
  try {
    const res = await fetch(`/api/holds/${currentHold.id}/confirm`, {
      method: 'POST',
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setMessage(data.error || 'Confirmation failed.', 'error');
      // Hold likely expired/invalid — reset.
      currentHold = null;
      stopCountdown();
      countdownEl.textContent = '';
      await loadSeats();
      return;
    }
    const data = await res.json();
    const seatIds = data.booking.seatIds || [];
    for (const id of seatIds) {
      const s = seats.get(id);
      if (s) {
        s.status = 'booked';
        s.bookedBy = SESSION_ID;
        s.holdExpiresAt = null;
      }
    }
    setMessage(
      data.idempotent
        ? 'Already booked (idempotent confirm).'
        : `Booked ${seatIds.length} seat(s)! 🎉`,
      'success'
    );
    currentHold = null;
    stopCountdown();
    countdownEl.textContent = '';
    render();
  } catch (err) {
    setMessage('Network error confirming.', 'error');
    confirmBtn.disabled = false;
  }
}

async function releaseCurrentHold() {
  if (!currentHold) return;
  releaseBtn.disabled = true;
  const holdId = currentHold.id;
  setMessage('Releasing hold…', 'info');
  try {
    const res = await fetch(`/api/holds/${holdId}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setMessage(data.error || 'Release failed.', 'error');
    } else {
      setMessage('Hold released.', 'info');
    }
  } catch (err) {
    setMessage('Network error releasing.', 'error');
  } finally {
    currentHold = null;
    stopCountdown();
    countdownEl.textContent = '';
    await loadSeats();
  }
}

// --- SSE live updates ---
function applySeatUpdate(update) {
  const s = seats.get(update.id);
  if (!s) return;
  s.status = update.status;
  if (update.status === 'available') {
    s.holdId = null;
    s.holdExpiresAt = null;
    s.bookedBy = null;
  } else if (update.status === 'held') {
    s.holdExpiresAt = update.holdExpiresAt || s.holdExpiresAt;
  } else if (update.status === 'booked') {
    s.holdExpiresAt = null;
  }
}

function connectSSE() {
  const es = new EventSource('/api/stream');

  es.addEventListener('open', () => {
    connectionEl.textContent = 'live';
    connectionEl.className = 'conn online';
  });

  es.addEventListener('connected', () => {
    connectionEl.textContent = 'live';
    connectionEl.className = 'conn online';
  });

  es.addEventListener('snapshot', (e) => {
    try {
      const data = JSON.parse(e.data);
      seats = new Map(data.seats.map((s) => [s.id, s]));
      render();
    } catch {}
  });

  es.addEventListener('seats', (e) => {
    try {
      const data = JSON.parse(e.data);
      for (const upd of data.seats) applySeatUpdate(upd);
      // If one of our held seats was released by expiry, reset hold.
      if (currentHold) {
        const stillHeld = currentHold.seatIds.some((id) => {
          const s = seats.get(id);
          return s && s.status === 'held' && s.holdId === currentHold.id;
        });
        if (!stillHeld) {
          // All our held seats are gone -> hold ended (expired/released/booked elsewhere is impossible for our hold).
          const anyBooked = currentHold.seatIds.every((id) => {
            const s = seats.get(id);
            return s && s.status === 'booked';
          });
          if (!anyBooked) {
            currentHold = null;
            stopCountdown();
            countdownEl.textContent = '';
            setMessage('Your hold ended.', 'info');
          }
        }
      }
      render();
    } catch {}
  });

  es.addEventListener('error', () => {
    connectionEl.textContent = 'reconnecting…';
    connectionEl.className = 'conn offline';
    // EventSource auto-reconnects.
  });
}

// --- Wire up ---
holdBtn.addEventListener('click', requestHold);
confirmBtn.addEventListener('click', confirmBooking);
releaseBtn.addEventListener('click', releaseCurrentHold);

loadSeats();
connectSSE();
