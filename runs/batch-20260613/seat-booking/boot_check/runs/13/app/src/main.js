// Seat-booking SPA

const API = '';

// Persistent session id for this browser tab/user.
function getSessionId() {
  let id = localStorage.getItem('seatSessionId');
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) || `s-${Date.now()}-${Math.random()}`;
    localStorage.setItem('seatSessionId', id);
  }
  return id;
}
const SESSION_ID = getSessionId();

// State
let seats = []; // array of {id,rowLabel,seatNumber,status,holdId,holdExpiresAt}
let selected = new Set(); // seat ids selected by user (before hold)
let currentHold = null; // { holdId, seatIds, expiresAt }
let countdownTimer = null;

const seatmapEl = document.getElementById('seatmap');
const countsEl = document.getElementById('counts');
const selectionInfoEl = document.getElementById('selection-info');
const holdBtn = document.getElementById('hold-btn');
const confirmBtn = document.getElementById('confirm-btn');
const releaseBtn = document.getElementById('release-btn');
const countdownEl = document.getElementById('countdown');
const messageEl = document.getElementById('message');

function setMessage(text, type = '') {
  messageEl.textContent = text;
  messageEl.className = `message ${type}`;
}

// --- API helpers ---
async function fetchSeats() {
  const res = await fetch(`${API}/api/seats`);
  const data = await res.json();
  seats = data.seats;
  render();
}

async function postHold() {
  const seatIds = [...selected];
  if (seatIds.length === 0) return;
  setMessage('Placing hold…');
  try {
    const res = await fetch(`${API}/api/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId: SESSION_ID }),
    });
    const data = await res.json();
    if (!res.ok) {
      if (res.status === 409 && data.conflictingSeatIds) {
        setMessage(
          `These seats were just taken: ${data.conflictingSeatIds.join(', ')}. Refreshing…`,
          'error'
        );
      } else {
        setMessage(data.error || 'Hold failed', 'error');
      }
      selected.clear();
      await fetchSeats();
      return;
    }
    currentHold = data;
    selected.clear();
    setMessage('Seats held! Confirm before the timer runs out.', 'success');
    startCountdown();
    await fetchSeats();
  } catch (e) {
    setMessage('Network error placing hold', 'error');
  }
}

async function confirmCurrentHold() {
  if (!currentHold) return;
  setMessage('Confirming…');
  try {
    const res = await fetch(`${API}/api/holds/${currentHold.holdId}/confirm`, {
      method: 'POST',
    });
    const data = await res.json();
    if (!res.ok) {
      setMessage(data.error || 'Confirm failed — your hold may have expired.', 'error');
      clearHold();
      await fetchSeats();
      return;
    }
    setMessage(`Booked ${data.seatIds.length} seat(s)! 🎉`, 'success');
    clearHold();
    await fetchSeats();
  } catch (e) {
    setMessage('Network error confirming', 'error');
  }
}

async function releaseCurrentHold() {
  if (!currentHold) return;
  setMessage('Releasing…');
  try {
    await fetch(`${API}/api/holds/${currentHold.holdId}`, { method: 'DELETE' });
    setMessage('Hold released.', '');
    clearHold();
    await fetchSeats();
  } catch (e) {
    setMessage('Network error releasing', 'error');
  }
}

// --- Hold / countdown management ---
function clearHold() {
  currentHold = null;
  stopCountdown();
}

function startCountdown() {
  stopCountdown();
  countdownTimer = setInterval(updateCountdown, 250);
  updateCountdown();
}

function stopCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = null;
  countdownEl.textContent = '';
}

function updateCountdown() {
  if (!currentHold) return stopCountdown();
  const remaining = new Date(currentHold.expiresAt).getTime() - Date.now();
  if (remaining <= 0) {
    countdownEl.textContent = '';
    setMessage('Your hold expired. The seats were released.', 'error');
    clearHold();
    fetchSeats();
    return;
  }
  const secs = Math.ceil(remaining / 1000);
  countdownEl.textContent = `⏳ Hold expires in ${secs}s`;
  updateButtons();
}

// --- Rendering ---
function isMine(seat) {
  if (currentHold && seat.holdId === currentHold.holdId) return true;
  return false;
}

function render() {
  // group by row
  const rows = {};
  for (const s of seats) {
    (rows[s.rowLabel] = rows[s.rowLabel] || []).push(s);
  }

  seatmapEl.innerHTML = '';
  Object.keys(rows)
    .sort()
    .forEach((label) => {
      const rowEl = document.createElement('div');
      rowEl.className = 'seat-row';
      const lab = document.createElement('span');
      lab.className = 'row-label';
      lab.textContent = label;
      rowEl.appendChild(lab);

      rows[label]
        .sort((a, b) => a.seatNumber - b.seatNumber)
        .forEach((seat) => {
          const btn = document.createElement('button');
          let cls = 'seat ';
          const mine = isMine(seat);
          if (seat.status === 'booked') cls += 'booked';
          else if (seat.status === 'held' && mine) cls += 'mine';
          else if (seat.status === 'held') cls += 'held';
          else cls += 'available';
          if (selected.has(seat.id)) cls += ' selected';
          btn.className = cls;
          btn.textContent = seat.seatNumber;
          btn.title = `${seat.id} — ${seat.status}`;

          const selectable = seat.status === 'available' && !currentHold;
          btn.disabled = !selectable && !selected.has(seat.id);
          if (seat.status === 'available' && !currentHold) {
            btn.disabled = false;
            btn.onclick = () => toggleSelect(seat.id);
          }
          rowEl.appendChild(btn);
        });
      seatmapEl.appendChild(rowEl);
    });

  renderCounts();
  updateButtons();
  renderSelectionInfo();
}

function renderCounts() {
  const counts = { available: 0, held: 0, booked: 0 };
  for (const s of seats) counts[s.status] = (counts[s.status] || 0) + 1;
  countsEl.innerHTML = `
    <span>Available: ${counts.available}</span>
    <span>Held: ${counts.held}</span>
    <span>Booked: ${counts.booked}</span>
    <span>Total: ${seats.length}</span>`;
}

function renderSelectionInfo() {
  if (currentHold) {
    selectionInfoEl.textContent = `Holding: ${currentHold.seatIds.join(', ')}`;
  } else if (selected.size) {
    selectionInfoEl.textContent = `Selected: ${[...selected].join(', ')}`;
  } else {
    selectionInfoEl.textContent = 'Select available seats to hold.';
  }
}

function updateButtons() {
  holdBtn.disabled = currentHold !== null || selected.size === 0;
  confirmBtn.disabled = currentHold === null;
  releaseBtn.disabled = currentHold === null;
}

function toggleSelect(id) {
  if (currentHold) return;
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  render();
}

// --- SSE live updates ---
function connectSSE() {
  const es = new EventSource(`${API}/api/stream`);
  es.addEventListener('seats', (ev) => {
    try {
      const { seats: updates } = JSON.parse(ev.data);
      applySeatUpdates(updates);
    } catch (_) {}
  });
  es.onerror = () => {
    // EventSource auto-reconnects; nothing to do.
  };
}

function applySeatUpdates(updates) {
  const byId = new Map(seats.map((s) => [s.id, s]));
  let changed = false;
  for (const u of updates) {
    const existing = byId.get(u.id);
    if (existing) {
      Object.assign(existing, u);
      changed = true;
    }
  }
  // If our held seats got released/booked by server elsewhere, detect.
  if (currentHold) {
    const stillHeld = seats.some(
      (s) => s.holdId === currentHold.holdId && s.status === 'held'
    );
    const booked = seats.some(
      (s) => s.holdId === currentHold.holdId && s.status === 'booked'
    );
    if (!stillHeld && !booked) {
      // released/expired
      clearHold();
      setMessage('Your hold was released.', 'error');
    }
  }
  if (changed) render();
}

// --- Wire up ---
holdBtn.onclick = postHold;
confirmBtn.onclick = confirmCurrentHold;
releaseBtn.onclick = releaseCurrentHold;

fetchSeats();
connectSSE();
