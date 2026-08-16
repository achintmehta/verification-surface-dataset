// Seat-booking SPA frontend.

const API = '/api';

// Stable per-tab session id identifying this holder.
function getSessionId() {
  let id = sessionStorage.getItem('seat-session-id');
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem('seat-session-id', id);
  }
  return id;
}
const sessionId = getSessionId();

// --- App state ---
const seats = new Map(); // id -> seat object from server
const selected = new Set(); // seat ids the user has selected (pre-hold)
let currentHold = null; // { id, expiresAt, seatIds: Set }
let countdownTimer = null;

// --- DOM refs ---
const seatmapEl = document.getElementById('seatmap');
const messageEl = document.getElementById('message');
const countdownEl = document.getElementById('countdown');
const holdBtn = document.getElementById('holdBtn');
const confirmBtn = document.getElementById('confirmBtn');
const releaseBtn = document.getElementById('releaseBtn');
const connectionEl = document.getElementById('connection');
const inventoryEl = document.getElementById('inventory');

function setMessage(text, kind = 'info') {
  messageEl.textContent = text;
  messageEl.className = `message ${kind}`;
}

// --- Rendering ---
function buildSeatmap() {
  seatmapEl.innerHTML = '';
  const byRow = new Map();
  for (const seat of seats.values()) {
    if (!byRow.has(seat.row)) byRow.set(seat.row, []);
    byRow.get(seat.row).push(seat);
  }
  const rowLabels = [...byRow.keys()].sort();
  for (const label of rowLabels) {
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';
    const labelEl = document.createElement('span');
    labelEl.className = 'row-label';
    labelEl.textContent = label;
    rowEl.appendChild(labelEl);

    const rowSeats = byRow.get(label).sort((a, b) => a.number - b.number);
    for (const seat of rowSeats) {
      const btn = document.createElement('button');
      btn.className = 'seat';
      btn.dataset.id = seat.id;
      btn.textContent = seat.number;
      btn.title = seat.id;
      btn.addEventListener('click', () => onSeatClick(seat.id));
      rowEl.appendChild(btn);
    }
    seatmapEl.appendChild(rowEl);
  }
  refreshSeatClasses();
}

function refreshSeatClasses() {
  let available = 0;
  let held = 0;
  let booked = 0;
  for (const seat of seats.values()) {
    if (seat.status === 'available') available++;
    else if (seat.status === 'held') held++;
    else if (seat.status === 'booked') booked++;

    const btn = seatmapEl.querySelector(`.seat[data-id="${seat.id}"]`);
    if (!btn) continue;

    const isMine = currentHold && currentHold.seatIds.has(seat.id);
    let cls = 'seat ';
    if (seat.status === 'booked') {
      cls += 'booked';
    } else if (seat.status === 'held') {
      cls += isMine ? 'mine' : 'held';
    } else {
      // available
      cls += selected.has(seat.id) ? 'selected' : 'available';
    }
    btn.className = cls;
    btn.disabled = seat.status === 'booked' || (seat.status === 'held' && !isMine);
  }
  inventoryEl.textContent = `Available ${available} · Held ${held} · Booked ${booked}`;
  updateButtons();
}

function updateButtons() {
  holdBtn.disabled = currentHold !== null || selected.size === 0;
  confirmBtn.disabled = currentHold === null;
  releaseBtn.disabled = currentHold === null;
}

// --- Interaction ---
function onSeatClick(id) {
  const seat = seats.get(id);
  if (!seat) return;
  // While holding, ignore selection changes.
  if (currentHold) return;
  if (seat.status !== 'available') return;

  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  refreshSeatClasses();
}

async function requestHold() {
  if (selected.size === 0) return;
  const seatIds = [...selected];
  setMessage('Requesting hold…', 'info');
  try {
    const res = await fetch(`${API}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId }),
    });
    const data = await res.json();
    if (res.status === 409) {
      // Conflict: indicate which seats were taken and refresh.
      const taken = data.conflictingSeatIds || [];
      setMessage(
        `Some seats were just taken: ${taken.join(', ')}. Refreshing…`,
        'error'
      );
      // Flash the conflicting seats then refresh.
      for (const id of taken) {
        const btn = seatmapEl.querySelector(`.seat[data-id="${id}"]`);
        if (btn) btn.classList.add('held');
      }
      selected.clear();
      await loadSeats();
      return;
    }
    if (!res.ok) {
      setMessage(data.message || 'Hold failed', 'error');
      return;
    }
    // Success.
    currentHold = {
      id: data.hold.id,
      expiresAt: new Date(data.hold.expiresAt).getTime(),
      seatIds: new Set(data.seats.map((s) => s.id)),
    };
    selected.clear();
    applySeatUpdates(data.seats);
    setMessage(`Held ${data.seats.length} seat(s). Confirm before time runs out!`, 'success');
    startCountdown();
  } catch (err) {
    setMessage(`Network error: ${err.message}`, 'error');
  }
}

async function confirmBooking() {
  if (!currentHold) return;
  setMessage('Confirming…', 'info');
  try {
    const res = await fetch(`${API}/holds/${currentHold.id}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await res.json();
    if (!res.ok) {
      setMessage(data.message || 'Confirmation failed', 'error');
      // Hold likely expired/invalid; clear and refresh.
      clearHold();
      await loadSeats();
      return;
    }
    applySeatUpdates(data.seats);
    setMessage(`Booked ${data.seats.length} seat(s). Enjoy the show!`, 'success');
    clearHold();
  } catch (err) {
    setMessage(`Network error: ${err.message}`, 'error');
  }
}

async function releaseCurrentHold() {
  if (!currentHold) return;
  const holdId = currentHold.id;
  setMessage('Releasing hold…', 'info');
  try {
    const res = await fetch(`${API}/holds/${holdId}`, { method: 'DELETE' });
    const data = await res.json();
    if (res.ok && data.seats) applySeatUpdates(data.seats);
    setMessage('Hold released.', 'info');
  } catch (err) {
    setMessage(`Network error: ${err.message}`, 'error');
  } finally {
    clearHold();
    await loadSeats();
  }
}

function clearHold() {
  currentHold = null;
  stopCountdown();
  countdownEl.textContent = '';
  refreshSeatClasses();
}

// --- Countdown ---
function startCountdown() {
  stopCountdown();
  tickCountdown();
  countdownTimer = setInterval(tickCountdown, 250);
}
function stopCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = null;
}
function tickCountdown() {
  if (!currentHold) return stopCountdown();
  const remaining = currentHold.expiresAt - Date.now();
  if (remaining <= 0) {
    countdownEl.textContent = 'Hold expired';
    setMessage('Your hold expired. The seats were released.', 'error');
    clearHold();
    loadSeats();
    return;
  }
  const secs = Math.ceil(remaining / 1000);
  countdownEl.textContent = `Hold expires in ${secs}s`;
}

// --- Data loading & live updates ---
function applySeatUpdates(updatedSeats) {
  for (const s of updatedSeats) {
    seats.set(s.id, s);
    // If a seat we hold got booked/released by us elsewhere, keep state sane.
  }
  // If our held seats changed away from held without our action, drop the hold.
  if (currentHold) {
    let stillHeld = false;
    for (const id of currentHold.seatIds) {
      const seat = seats.get(id);
      if (seat && seat.status === 'held') stillHeld = true;
    }
    const allBooked = [...currentHold.seatIds].every(
      (id) => seats.get(id)?.status === 'booked'
    );
    if (!stillHeld && !allBooked) {
      // Released or expired externally.
      // (Booked-by-us is handled in confirmBooking via clearHold.)
    }
  }
  refreshSeatClasses();
}

async function loadSeats() {
  try {
    const res = await fetch(`${API}/seats`);
    const data = await res.json();
    seats.clear();
    for (const s of data.seats) seats.set(s.id, s);
    if (seatmapEl.childElementCount === 0) buildSeatmap();
    else refreshSeatClasses();
  } catch (err) {
    setMessage(`Failed to load seats: ${err.message}`, 'error');
  }
}

function connectSSE() {
  const es = new EventSource(`${API}/stream`);
  es.onopen = () => {
    connectionEl.textContent = 'live';
    connectionEl.className = 'conn connected';
  };
  es.onerror = () => {
    connectionEl.textContent = 'reconnecting…';
    connectionEl.className = 'conn disconnected';
  };
  es.addEventListener('seats', (ev) => {
    try {
      const payload = JSON.parse(ev.data);
      if (payload.seats) applySeatUpdates(payload.seats);
    } catch {
      /* ignore */
    }
  });
}

// --- Wire up ---
holdBtn.addEventListener('click', requestHold);
confirmBtn.addEventListener('click', confirmBooking);
releaseBtn.addEventListener('click', releaseCurrentHold);

window.addEventListener('beforeunload', () => {
  // Best-effort: release an unconfirmed hold when leaving.
  if (currentHold) {
    navigator.sendBeacon?.(`${API}/holds/${currentHold.id}`);
    // sendBeacon can't issue DELETE; rely on TTL expiry as the guarantee.
  }
});

(async function init() {
  await loadSeats();
  connectSSE();
})();
