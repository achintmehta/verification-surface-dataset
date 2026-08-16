import './styles.css';
import {
  fetchSeats,
  fetchInventory,
  createHold,
  confirmHold,
  releaseHold,
} from './api.js';

// --- Session identity ----------------------------------------------------
// A client-supplied session id identifies the holder (no auth required).
function getSessionId() {
  let id = localStorage.getItem('seatSessionId');
  if (!id) {
    id =
      (crypto.randomUUID && crypto.randomUUID()) ||
      `s-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem('seatSessionId', id);
  }
  return id;
}
const SESSION_ID = getSessionId();

// --- App state -----------------------------------------------------------
const state = {
  seats: new Map(), // id -> seat { id, row, number, status, holdId, holdExpiresAt }
  selected: new Set(), // seat ids selected (not yet held)
  hold: null, // { holdId, expiresAt, seatIds }
};

let countdownTimer = null;

// --- DOM refs ------------------------------------------------------------
const seatmapEl = document.getElementById('seatmap');
const statusEl = document.getElementById('status');
const inventoryEl = document.getElementById('inventory');
const connectionEl = document.getElementById('connection');
const holdBtn = document.getElementById('hold-btn');
const confirmBtn = document.getElementById('confirm-btn');
const releaseBtn = document.getElementById('release-btn');

// --- Rendering -----------------------------------------------------------
function seatClass(seat) {
  if (state.hold && state.hold.seatIds.includes(seat.id) && seat.status === 'held') {
    return 'seat seat--mine';
  }
  if (seat.status === 'booked') return 'seat seat--booked';
  if (seat.status === 'held') return 'seat seat--held';
  if (state.selected.has(seat.id)) return 'seat seat--selected';
  return 'seat seat--available';
}

function renderSeatMap() {
  // Group seats by row.
  const byRow = new Map();
  for (const seat of state.seats.values()) {
    if (!byRow.has(seat.row)) byRow.set(seat.row, []);
    byRow.get(seat.row).push(seat);
  }
  const rows = [...byRow.keys()].sort();

  seatmapEl.innerHTML = '';
  for (const row of rows) {
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';

    const label = document.createElement('span');
    label.className = 'row-label';
    label.textContent = row;
    rowEl.appendChild(label);

    const seats = byRow.get(row).sort((a, b) => a.number - b.number);
    for (const seat of seats) {
      const btn = document.createElement('button');
      btn.className = seatClass(seat);
      btn.textContent = seat.number;
      btn.dataset.id = seat.id;
      btn.title = `${seat.id} — ${seat.status}`;
      const mine =
        state.hold && state.hold.seatIds.includes(seat.id) && seat.status === 'held';
      const selectable = seat.status === 'available' && !state.hold;
      btn.disabled = !selectable && !state.selected.has(seat.id) && !mine;
      if (selectable || state.selected.has(seat.id)) {
        btn.addEventListener('click', () => toggleSeat(seat.id));
      }
      rowEl.appendChild(btn);
    }
    seatmapEl.appendChild(rowEl);
  }
  updateButtons();
}

function updateButtons() {
  holdBtn.disabled = state.selected.size === 0 || !!state.hold;
  confirmBtn.disabled = !state.hold;
  releaseBtn.disabled = !state.hold;
  holdBtn.textContent =
    state.selected.size > 0
      ? `Hold ${state.selected.size} seat${state.selected.size > 1 ? 's' : ''}`
      : 'Hold selected';
}

async function renderInventory() {
  try {
    const inv = await fetchInventory();
    inventoryEl.textContent = `Available ${inv.available} · Held ${inv.held} · Booked ${inv.booked} / ${inv.total}`;
  } catch {
    inventoryEl.textContent = '';
  }
}

// --- Interaction ---------------------------------------------------------
function toggleSeat(seatId) {
  if (state.hold) return; // can't change selection while holding
  if (state.selected.has(seatId)) state.selected.delete(seatId);
  else state.selected.add(seatId);
  renderSeatMap();
}

function setStatus(message, kind = 'info') {
  statusEl.textContent = message;
  statusEl.className = `status status--${kind}`;
}

function applySeatUpdates(seats) {
  for (const seat of seats) {
    state.seats.set(seat.id, seat);
  }
}

// --- Hold countdown ------------------------------------------------------
function startCountdown() {
  stopCountdown();
  if (!state.hold) return;
  const tick = () => {
    const remaining = new Date(state.hold.expiresAt).getTime() - Date.now();
    if (remaining <= 0) {
      stopCountdown();
      setStatus('Your hold expired. The seats were released.', 'warn');
      state.hold = null;
      updateButtons();
      refreshSeats();
      return;
    }
    const secs = Math.ceil(remaining / 1000);
    setStatus(
      `Hold active on ${state.hold.seatIds.join(', ')} — ${secs}s remaining. Confirm to book.`,
      'hold',
    );
  };
  tick();
  countdownTimer = setInterval(tick, 250);
}

function stopCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

// --- Actions -------------------------------------------------------------
async function onHold() {
  const seatIds = [...state.selected];
  if (seatIds.length === 0) return;
  holdBtn.disabled = true;
  try {
    const hold = await createHold(seatIds, SESSION_ID);
    state.hold = { holdId: hold.holdId, expiresAt: hold.expiresAt, seatIds: hold.seatIds };
    state.selected.clear();
    applySeatUpdates(hold.seats);
    renderSeatMap();
    renderInventory();
    startCountdown();
  } catch (err) {
    if (err.status === 409) {
      const conflicts = err.body?.conflicts || [];
      setStatus(
        `Could not hold — these seats were just taken: ${conflicts.join(', ')}. Map refreshed.`,
        'error',
      );
      // Clear any conflicting selections and refresh.
      for (const id of conflicts) state.selected.delete(id);
      await refreshSeats();
    } else {
      setStatus(err.message || 'Hold failed.', 'error');
      await refreshSeats();
    }
  } finally {
    updateButtons();
  }
}

async function onConfirm() {
  if (!state.hold) return;
  confirmBtn.disabled = true;
  try {
    const result = await confirmHold(state.hold.holdId, SESSION_ID);
    applySeatUpdates(result.seats);
    stopCountdown();
    setStatus(
      `Booked ${result.seatIds.join(', ')}${result.idempotent ? ' (already confirmed)' : ''}.`,
      'success',
    );
    state.hold = null;
    renderSeatMap();
    renderInventory();
  } catch (err) {
    if (err.status === 410) {
      setStatus('Hold expired before confirmation — nothing booked.', 'error');
      state.hold = null;
      stopCountdown();
    } else {
      setStatus(err.message || 'Confirm failed.', 'error');
    }
    await refreshSeats();
  } finally {
    updateButtons();
  }
}

async function onRelease() {
  if (!state.hold) return;
  releaseBtn.disabled = true;
  const holdId = state.hold.holdId;
  try {
    await releaseHold(holdId, SESSION_ID);
    setStatus('Hold released. Seats available again.', 'info');
  } catch (err) {
    setStatus(err.message || 'Release failed.', 'error');
  } finally {
    state.hold = null;
    stopCountdown();
    await refreshSeats();
    updateButtons();
  }
}

// --- Data load -----------------------------------------------------------
async function refreshSeats() {
  const { seats } = await fetchSeats();
  state.seats = new Map(seats.map((s) => [s.id, s]));
  renderSeatMap();
  renderInventory();
}

// --- SSE -----------------------------------------------------------------
function connectStream() {
  const es = new EventSource('/api/stream');

  es.addEventListener('open', () => {
    connectionEl.textContent = 'live';
    connectionEl.className = 'conn conn--online';
  });

  es.addEventListener('seats', (ev) => {
    try {
      const data = JSON.parse(ev.data);
      applySeatUpdates(data.seats || []);
      // If one of our held seats got released/booked by expiry from server,
      // reconcile our hold state.
      if (state.hold) {
        const stillHeldByMe = state.hold.seatIds.every((id) => {
          const seat = state.seats.get(id);
          return seat && seat.status === 'held';
        });
        if (!stillHeldByMe) {
          const anyBooked = state.hold.seatIds.some(
            (id) => state.seats.get(id)?.status === 'booked',
          );
          if (!anyBooked) {
            state.hold = null;
            stopCountdown();
            setStatus('Your hold is no longer active.', 'warn');
          }
        }
      }
      renderSeatMap();
      renderInventory();
    } catch {
      /* ignore malformed */
    }
  });

  es.addEventListener('error', () => {
    connectionEl.textContent = 'reconnecting…';
    connectionEl.className = 'conn conn--offline';
  });
}

// --- Init ----------------------------------------------------------------
holdBtn.addEventListener('click', onHold);
confirmBtn.addEventListener('click', onConfirm);
releaseBtn.addEventListener('click', onRelease);

async function init() {
  await refreshSeats();
  connectStream();
  setStatus('Select available seats, then place a hold.', 'info');
}

init();
