// Seat-booking SPA frontend.

const API = '/api';

// --- Session management (client-supplied id identifies the holder) ---
function getSessionId() {
  let id = localStorage.getItem('sb_session');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('sb_session', id);
  }
  return id;
}
let sessionId = getSessionId();

// --- Local state ---
let seats = new Map(); // id -> seat object
const selected = new Set();
let currentHold = null; // { holdId, seatIds, expiresAt }
let countdownTimer = null;

// --- DOM refs ---
const seatmapEl = document.getElementById('seatmap');
const selectionEl = document.getElementById('selection');
const holdStatusEl = document.getElementById('hold-status');
const countdownEl = document.getElementById('countdown');
const progressBar = document.getElementById('progress-bar');
const holdBtn = document.getElementById('hold-btn');
const confirmBtn = document.getElementById('confirm-btn');
const releaseBtn = document.getElementById('release-btn');
const messageEl = document.getElementById('message');
const inventoryEl = document.getElementById('inventory');
const connectionEl = document.getElementById('connection');
const sessionIdEl = document.getElementById('session-id');
const newSessionBtn = document.getElementById('new-session');

sessionIdEl.textContent = sessionId.slice(0, 8);

// --- Messaging helper ---
function setMessage(text, kind = 'info') {
  messageEl.textContent = text;
  messageEl.className = `message ${kind}`;
}

// --- Rendering ---
function renderSeatMap() {
  // Group by row.
  const rows = new Map();
  for (const seat of seats.values()) {
    if (!rows.has(seat.row)) rows.set(seat.row, []);
    rows.get(seat.row).push(seat);
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

    const rowSeats = rows.get(rowLabel).sort((a, b) => a.number - b.number);
    for (const seat of rowSeats) {
      const btn = document.createElement('button');
      btn.className = 'seat';
      btn.textContent = seat.number;
      btn.dataset.id = seat.id;
      btn.title = `${seat.id} — ${seat.status}`;

      const mine = seat.status === 'held' && seat.holdId && currentHold && seat.holdId === currentHold.holdId;
      const bookedByMe = seat.status === 'booked' && seat.bookedBy === sessionId;

      if (seat.status === 'available') {
        if (selected.has(seat.id)) btn.classList.add('selected');
      } else if (seat.status === 'held') {
        btn.classList.add(mine ? 'mine' : 'held');
        if (!mine) btn.disabled = true;
      } else if (seat.status === 'booked') {
        btn.classList.add(bookedByMe ? 'mine' : 'booked');
        btn.disabled = true;
        btn.title = `${seat.id} — booked${bookedByMe ? ' (you)' : ''}`;
      }

      btn.addEventListener('click', () => onSeatClick(seat.id));
      rowEl.appendChild(btn);
    }
    seatmapEl.appendChild(rowEl);
  }
  renderSelection();
  updateButtons();
  renderInventory();
}

function renderSelection() {
  if (selected.size === 0) {
    selectionEl.textContent = currentHold ? 'Seats on hold below.' : 'No seats selected.';
    return;
  }
  selectionEl.innerHTML = '';
  for (const id of [...selected].sort()) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = id;
    selectionEl.appendChild(chip);
  }
}

function renderInventory() {
  let available = 0, held = 0, booked = 0;
  for (const s of seats.values()) {
    if (s.status === 'available') available++;
    else if (s.status === 'held') held++;
    else if (s.status === 'booked') booked++;
  }
  inventoryEl.innerHTML =
    `<span>Available <strong>${available}</strong></span>` +
    `<span>Held <strong>${held}</strong></span>` +
    `<span>Booked <strong>${booked}</strong></span>` +
    `<span>Total <strong>${available + held + booked}</strong></span>`;
}

function updateButtons() {
  holdBtn.disabled = selected.size === 0 || !!currentHold;
  confirmBtn.classList.toggle('hidden', !currentHold);
  releaseBtn.classList.toggle('hidden', !currentHold);
}

// --- Interaction ---
function onSeatClick(id) {
  if (currentHold) return; // selection locked while holding
  const seat = seats.get(id);
  if (!seat || seat.status !== 'available') return;
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  renderSeatMap();
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
    if (!res.ok) {
      if (res.status === 409 && data.conflicts) {
        flashConflicts(data.conflicts);
        setMessage(`Already taken: ${data.conflicts.join(', ')}. Map refreshed.`, 'error');
        // Drop conflicting seats from selection and refresh.
        for (const id of data.conflicts) selected.delete(id);
        await loadSeats();
        return;
      }
      throw new Error(data.error || 'Hold failed');
    }
    currentHold = { holdId: data.holdId, seatIds: data.seatIds, expiresAt: data.expiresAt };
    selected.clear();
    for (const id of data.seatIds) selected.add(id);
    setMessage('Seats held. Confirm before the timer runs out.', 'success');
    startCountdown();
    await loadSeats();
  } catch (err) {
    setMessage(err.message, 'error');
  }
}

async function confirmBooking() {
  if (!currentHold) return;
  setMessage('Confirming…', 'info');
  try {
    const res = await fetch(`${API}/holds/${currentHold.holdId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Confirm failed');
    }
    setMessage(`Booked ${data.seatIds.join(', ')}! 🎉`, 'success');
    clearHold();
    await loadSeats();
  } catch (err) {
    setMessage(err.message, 'error');
    clearHold();
    await loadSeats();
  }
}

async function releaseCurrentHold() {
  if (!currentHold) return;
  const holdId = currentHold.holdId;
  setMessage('Releasing…', 'info');
  try {
    const res = await fetch(`${API}/holds/${holdId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Release failed');
    }
    setMessage('Hold released.', 'info');
  } catch (err) {
    setMessage(err.message, 'error');
  } finally {
    clearHold();
    await loadSeats();
  }
}

function flashConflicts(ids) {
  for (const id of ids) {
    const el = seatmapEl.querySelector(`[data-id="${id}"]`);
    if (el) {
      el.classList.add('conflict');
      setTimeout(() => el.classList.remove('conflict'), 2000);
    }
  }
}

// --- Countdown ---
function startCountdown() {
  clearInterval(countdownTimer);
  holdStatusEl.classList.remove('hidden');
  const expires = new Date(currentHold.expiresAt).getTime();
  const total = expires - Date.now();
  const tick = () => {
    const remaining = expires - Date.now();
    if (remaining <= 0) {
      countdownEl.textContent = 'expired';
      progressBar.style.width = '0%';
      clearInterval(countdownTimer);
      setMessage('Hold expired — seats released.', 'error');
      clearHold();
      loadSeats();
      return;
    }
    const secs = Math.ceil(remaining / 1000);
    countdownEl.textContent = `${secs}s remaining`;
    progressBar.style.width = `${Math.max(0, (remaining / total) * 100)}%`;
  };
  tick();
  countdownTimer = setInterval(tick, 500);
}

function clearHold() {
  clearInterval(countdownTimer);
  countdownTimer = null;
  currentHold = null;
  selected.clear();
  holdStatusEl.classList.add('hidden');
  updateButtons();
}

// --- Data loading ---
async function loadSeats() {
  try {
    const res = await fetch(`${API}/seats`);
    const data = await res.json();
    seats = new Map(data.seats.map((s) => [s.id, s]));

    // If our hold's seats are no longer held by us, clear hold.
    if (currentHold) {
      const stillMine = currentHold.seatIds.some((id) => {
        const s = seats.get(id);
        return s && ((s.status === 'held' && s.holdId === currentHold.holdId) ||
          (s.status === 'booked' && s.bookedBy === sessionId));
      });
      if (!stillMine) clearHold();
    }
    renderSeatMap();
  } catch (err) {
    setMessage('Failed to load seats: ' + err.message, 'error');
  }
}

// --- SSE live updates ---
function applySeatUpdates(updates) {
  for (const u of updates) {
    const existing = seats.get(u.id) || {};
    seats.set(u.id, { ...existing, ...u });
  }
}

function connectStream() {
  const es = new EventSource(`${API}/stream`);
  es.addEventListener('connected', () => {
    connectionEl.textContent = 'live';
    connectionEl.className = 'connection online';
  });
  const handler = (e) => {
    try {
      const ev = JSON.parse(e.data);
      if (ev.seats) {
        applySeatUpdates(ev.seats);
        // If one of my held seats was released by expiry, clear my hold.
        if (ev.type === 'released' && currentHold) {
          const affected = (ev.seatIds || []).some((id) => currentHold.seatIds.includes(id));
          if (affected && ev.holdId === currentHold.holdId) clearHold();
        }
        renderSeatMap();
      }
    } catch {
      /* ignore */
    }
  };
  es.addEventListener('held', handler);
  es.addEventListener('booked', handler);
  es.addEventListener('released', handler);
  es.onerror = () => {
    connectionEl.textContent = 'reconnecting…';
    connectionEl.className = 'connection offline';
  };
}

// --- Wire up ---
holdBtn.addEventListener('click', requestHold);
confirmBtn.addEventListener('click', confirmBooking);
releaseBtn.addEventListener('click', releaseCurrentHold);
newSessionBtn.addEventListener('click', () => {
  localStorage.removeItem('sb_session');
  sessionId = getSessionId();
  sessionIdEl.textContent = sessionId.slice(0, 8);
  clearHold();
  loadSeats();
  setMessage('Started a new session.', 'info');
});

// Init
loadSeats();
connectStream();
