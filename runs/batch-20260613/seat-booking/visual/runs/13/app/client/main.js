// --- Session id (client-supplied identity) ---
function getSessionId() {
  let id = localStorage.getItem('seatSessionId');
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) ||
      'sess-' + Math.random().toString(36).slice(2);
    localStorage.setItem('seatSessionId', id);
  }
  return id;
}
const sessionId = getSessionId();

// --- State ---
const seats = new Map();        // id -> seat object
const selected = new Set();     // selected seat ids (pre-hold)
let currentHold = null;         // { id, seatIds, expiresAt }
let countdownTimer = null;

// --- DOM ---
const seatmapEl = document.getElementById('seatmap');
const selectedCountEl = document.getElementById('selected-count');
const holdInfoEl = document.getElementById('hold-info');
const heldCountEl = document.getElementById('held-count');
const countdownEl = document.getElementById('countdown');
const holdBtn = document.getElementById('hold-btn');
const confirmBtn = document.getElementById('confirm-btn');
const releaseBtn = document.getElementById('release-btn');
const statusEl = document.getElementById('status');
const sessionIdEl = document.getElementById('session-id');

sessionIdEl.textContent = sessionId.slice(0, 8);

// --- Helpers ---
function setStatus(msg, type = 'info') {
  statusEl.textContent = msg;
  statusEl.className = 'status ' + type;
}

function effectiveStatus(seat) {
  // A held seat whose hold has expired is effectively available.
  if (seat.status === 'held' && seat.holdExpiresAt && seat.holdExpiresAt <= Date.now()) {
    return 'available';
  }
  return seat.status;
}

function seatClass(seat) {
  const st = effectiveStatus(seat);
  if (selected.has(seat.id) && st === 'available') return 'selected';
  if (st === 'held') {
    if (currentHold && seat.holdId === currentHold.id) return 'mine';
    return 'held';
  }
  return st; // available | booked
}

// --- Rendering ---
function render() {
  // Group seats by row.
  const rows = new Map();
  for (const seat of seats.values()) {
    if (!rows.has(seat.row)) rows.set(seat.row, []);
    rows.get(seat.row).push(seat);
  }
  const sortedRows = [...rows.keys()].sort();

  seatmapEl.innerHTML = '';
  for (const row of sortedRows) {
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';

    const label = document.createElement('span');
    label.className = 'row-label';
    label.textContent = row;
    rowEl.appendChild(label);

    const rowSeats = rows.get(row).sort((a, b) => a.number - b.number);
    for (const seat of rowSeats) {
      const btn = document.createElement('button');
      const cls = seatClass(seat);
      btn.className = 'seat ' + cls;
      btn.textContent = seat.number;
      btn.dataset.id = seat.id;
      btn.title = `${seat.id} – ${cls}`;
      const st = effectiveStatus(seat);
      const selectable = st === 'available' && !currentHold;
      btn.disabled = !selectable;
      btn.addEventListener('click', () => toggleSelect(seat.id));
      rowEl.appendChild(btn);
    }
    seatmapEl.appendChild(rowEl);
  }

  selectedCountEl.textContent = selected.size;
  holdBtn.disabled = selected.size === 0 || !!currentHold;

  updateInventory();
}

function updateInventory() {
  const counts = { available: 0, held: 0, booked: 0 };
  for (const seat of seats.values()) counts[effectiveStatus(seat)]++;
  document.getElementById('inv-available').textContent = counts.available;
  document.getElementById('inv-held').textContent = counts.held;
  document.getElementById('inv-booked').textContent = counts.booked;
}

function toggleSelect(id) {
  if (currentHold) return;
  const seat = seats.get(id);
  if (!seat || effectiveStatus(seat) !== 'available') return;
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  render();
}

// --- Data loading ---
async function loadSeats() {
  const res = await fetch('/api/seats');
  const data = await res.json();
  seats.clear();
  for (const s of data.seats) seats.set(s.id, s);
  render();
}

function applySeatUpdates(updates) {
  for (const u of updates) {
    const seat = seats.get(u.id);
    if (!seat) continue;
    seat.status = u.status;
    if (u.status === 'available') {
      seat.holdId = null;
      seat.holdExpiresAt = null;
      seat.bookedBy = null;
    }
    if (u.status === 'booked') {
      seat.holdExpiresAt = null;
    }
    // If one of our selected seats got taken by someone else, deselect it.
    if (u.status !== 'available' && selected.has(u.id)) {
      selected.delete(u.id);
    }
  }
  render();
}

// --- Actions ---
async function placeHold() {
  const seatIds = [...selected];
  if (!seatIds.length) return;
  holdBtn.disabled = true;
  try {
    const res = await fetch('/api/holds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId }),
    });
    if (res.status === 409 || res.status === 400) {
      const body = await res.json();
      handleConflict(body.conflicts || []);
      await loadSeats();
      return;
    }
    if (!res.ok) throw new Error('Hold failed');
    const hold = await res.json();
    currentHold = hold;
    selected.clear();
    // Reflect held seats locally immediately.
    for (const id of hold.seatIds) {
      const seat = seats.get(id);
      if (seat) {
        seat.status = 'held';
        seat.holdId = hold.id;
        seat.holdExpiresAt = hold.expiresAt;
      }
    }
    showHoldUI();
    setStatus(`Held ${hold.seatIds.length} seat(s). Confirm before the timer runs out!`, 'success');
    render();
  } catch (err) {
    setStatus('Could not place hold: ' + err.message, 'error');
  }
}

function handleConflict(conflicts) {
  setStatus(
    conflicts.length
      ? `Sorry — these seats were just taken: ${conflicts.join(', ')}`
      : 'Some seats were unavailable.',
    'error'
  );
  for (const id of conflicts) {
    selected.delete(id);
    const el = seatmapEl.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (el) {
      el.classList.add('conflict');
      setTimeout(() => el.classList.remove('conflict'), 1800);
    }
  }
}

async function confirmBooking() {
  if (!currentHold) return;
  confirmBtn.disabled = true;
  try {
    const res = await fetch(`/api/holds/${currentHold.id}/confirm`, { method: 'POST' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setStatus('Confirmation failed: ' + (body.error || res.status), 'error');
      clearHold();
      await loadSeats();
      return;
    }
    const booking = await res.json();
    for (const id of booking.seatIds) {
      const seat = seats.get(id);
      if (seat) { seat.status = 'booked'; seat.bookedBy = sessionId; seat.holdExpiresAt = null; }
    }
    setStatus(`Booked ${booking.seatIds.length} seat(s). Enjoy the show!`, 'success');
    clearHold();
    render();
  } catch (err) {
    setStatus('Confirmation error: ' + err.message, 'error');
    confirmBtn.disabled = false;
  }
}

async function releaseCurrentHold() {
  if (!currentHold) return;
  const holdId = currentHold.id;
  releaseBtn.disabled = true;
  try {
    await fetch(`/api/holds/${holdId}`, { method: 'DELETE' });
    setStatus('Hold released.', 'info');
  } catch {
    setStatus('Release failed (it may have already expired).', 'error');
  }
  clearHold();
  await loadSeats();
}

// --- Hold UI / countdown ---
function showHoldUI() {
  holdInfoEl.classList.remove('hidden');
  confirmBtn.classList.remove('hidden');
  releaseBtn.classList.remove('hidden');
  holdBtn.classList.add('hidden');
  confirmBtn.disabled = false;
  releaseBtn.disabled = false;
  heldCountEl.textContent = currentHold.seatIds.length;
  startCountdown();
}

function startCountdown() {
  stopCountdown();
  countdownTimer = setInterval(() => {
    if (!currentHold) return stopCountdown();
    const remaining = Math.max(0, Math.ceil((currentHold.expiresAt - Date.now()) / 1000));
    countdownEl.textContent = remaining;
    if (remaining <= 0) {
      setStatus('Your hold expired. Those seats are available again.', 'error');
      clearHold();
      loadSeats();
    }
  }, 250);
}

function stopCountdown() {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
}

function clearHold() {
  currentHold = null;
  stopCountdown();
  holdInfoEl.classList.add('hidden');
  confirmBtn.classList.add('hidden');
  releaseBtn.classList.add('hidden');
  holdBtn.classList.remove('hidden');
  render();
}

// --- SSE ---
function connectStream() {
  const es = new EventSource('/api/stream');

  es.addEventListener('snapshot', (e) => {
    const data = JSON.parse(e.data);
    seats.clear();
    for (const s of data.seats) seats.set(s.id, s);
    // If our hold's seats are no longer held by us, drop the hold view.
    if (currentHold) {
      const stillHeld = currentHold.seatIds.every((id) => {
        const seat = seats.get(id);
        return seat && seat.holdId === currentHold.id && seat.status === 'held';
      });
      const allBooked = currentHold.seatIds.every((id) => seats.get(id)?.status === 'booked');
      if (!stillHeld && !allBooked) clearHold();
    }
    render();
  });

  es.addEventListener('seats', (e) => {
    const data = JSON.parse(e.data);
    // Detect expiry / takeover of our own hold.
    if (currentHold) {
      for (const u of data.seats) {
        if (currentHold.seatIds.includes(u.id) && u.status === 'available') {
          // our hold seat was released (likely expired)
          if (Date.now() >= currentHold.expiresAt - 1000) {
            clearHold();
            setStatus('Your hold expired. Seats released.', 'error');
          }
        }
      }
    }
    applySeatUpdates(data.seats);
  });

  es.onerror = () => {
    setStatus('Live connection lost — reconnecting…', 'info');
  };
}

// --- Wire up ---
holdBtn.addEventListener('click', placeHold);
confirmBtn.addEventListener('click', confirmBooking);
releaseBtn.addEventListener('click', releaseCurrentHold);

// Connect to the live SSE stream unless explicitly disabled (e.g. for
// static screenshot capture where a long-lived connection blocks load events).
const noStream = new URLSearchParams(location.search).has('nostream');
loadSeats().then(() => { if (!noStream) connectStream(); });
