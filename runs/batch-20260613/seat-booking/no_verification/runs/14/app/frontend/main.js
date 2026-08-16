// Seat-booking SPA frontend.

const API = '/api';

// --- Session identity (client-supplied, persisted) ---
function getSessionId() {
  let sid = localStorage.getItem('seatSessionId');
  if (!sid) {
    sid = 'sess-' + (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
    localStorage.setItem('seatSessionId', sid);
  }
  return sid;
}

const sessionId = getSessionId();

// --- App state ---
const state = {
  seats: new Map(),      // id -> seat object (effective status from server)
  selected: new Set(),   // seat ids the user has selected (pre-hold)
  hold: null,            // { holdId, expiresAt, seatIds: [] }
  countdownTimer: null,
  holdTtlMs: 60000,
};

// --- DOM refs ---
const el = {
  seatmap: document.getElementById('seatmap'),
  cntAvailable: document.getElementById('cnt-available'),
  cntHeld: document.getElementById('cnt-held'),
  cntBooked: document.getElementById('cnt-booked'),
  conn: document.getElementById('conn-status'),
  selectionInfo: document.getElementById('selection-info'),
  btnHold: document.getElementById('btn-hold'),
  btnConfirm: document.getElementById('btn-confirm'),
  btnRelease: document.getElementById('btn-release'),
  countdown: document.getElementById('countdown'),
  message: document.getElementById('message'),
  sessionId: document.getElementById('session-id'),
};

el.sessionId.textContent = sessionId;

// --- Messaging ---
function setMessage(text, kind = 'info') {
  el.message.textContent = text;
  el.message.className = 'message ' + kind;
}

// --- Effective per-seat class for the current viewer ---
function seatClass(seat) {
  if (seat.status === 'booked') return 'booked';
  if (seat.status === 'held') {
    // Is this one of the seats in our active hold?
    if (state.hold && seat.holdId === state.hold.holdId) return 'myhold';
    return 'held';
  }
  // available
  if (state.selected.has(seat.id)) return 'selected';
  return 'available';
}

function isSelectable(seat) {
  // Selectable only if available and not part of our active hold.
  return seat.status === 'available';
}

// --- Render ---
function render() {
  // Group seats by row.
  const rows = new Map();
  for (const seat of state.seats.values()) {
    if (!rows.has(seat.rowLabel)) rows.set(seat.rowLabel, []);
    rows.get(seat.rowLabel).push(seat);
  }
  const sortedRows = [...rows.keys()].sort();

  el.seatmap.innerHTML = '';
  for (const label of sortedRows) {
    const rowSeats = rows.get(label).sort((a, b) => a.seatNumber - b.seatNumber);
    const rowDiv = document.createElement('div');
    rowDiv.className = 'seat-row';

    const lbl = document.createElement('span');
    lbl.className = 'row-label';
    lbl.textContent = label;
    rowDiv.appendChild(lbl);

    for (const seat of rowSeats) {
      const btn = document.createElement('button');
      btn.className = 'seat ' + seatClass(seat);
      btn.textContent = seat.seatNumber;
      btn.title = `${seat.id} — ${seat.status}`;
      btn.dataset.seatId = seat.id;
      // Disable seats not selectable (unless they're in our hold, but those
      // shouldn't be toggled either). Always allow click to be ignored gracefully.
      if (!isSelectable(seat) && !state.selected.has(seat.id)) {
        btn.disabled = true;
      }
      // If we have an active hold, lock the whole grid for selection changes.
      if (state.hold) btn.disabled = true;

      btn.addEventListener('click', () => toggleSeat(seat.id));
      rowDiv.appendChild(btn);
    }

    el.seatmap.appendChild(rowDiv);
  }

  updateInventory();
  updateControls();
}

function updateInventory() {
  let available = 0, held = 0, booked = 0;
  for (const seat of state.seats.values()) {
    if (seat.status === 'available') available++;
    else if (seat.status === 'held') held++;
    else if (seat.status === 'booked') booked++;
  }
  el.cntAvailable.textContent = available;
  el.cntHeld.textContent = held;
  el.cntBooked.textContent = booked;
}

function updateControls() {
  const hasSelection = state.selected.size > 0;
  const hasHold = !!state.hold;

  el.btnHold.disabled = hasHold || !hasSelection;
  el.btnConfirm.disabled = !hasHold;
  el.btnRelease.disabled = !hasHold;

  if (hasHold) {
    el.selectionInfo.textContent =
      `Holding ${state.hold.seatIds.length} seat(s): ${state.hold.seatIds.join(', ')}`;
  } else if (hasSelection) {
    const ids = [...state.selected].sort();
    el.selectionInfo.textContent = `Selected ${ids.length} seat(s): ${ids.join(', ')}`;
  } else {
    el.selectionInfo.textContent = 'No seats selected.';
  }
}

// --- Selection ---
function toggleSeat(seatId) {
  if (state.hold) return; // locked during a hold
  const seat = state.seats.get(seatId);
  if (!seat || seat.status !== 'available') return;

  if (state.selected.has(seatId)) state.selected.delete(seatId);
  else state.selected.add(seatId);
  render();
}

// --- API helpers ---
async function apiGet(path) {
  const res = await fetch(API + path);
  if (!res.ok) throw await toError(res);
  return res.json();
}
async function apiSend(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || res.statusText);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}
async function toError(res) {
  const data = await res.json().catch(() => ({}));
  const err = new Error(data.message || res.statusText);
  err.status = res.status;
  err.data = data;
  return err;
}

// --- Load seats ---
async function loadSeats() {
  const { seats } = await apiGet('/seats');
  state.seats = new Map(seats.map((s) => [s.id, s]));
  // Drop any selections that are no longer available.
  for (const id of [...state.selected]) {
    const s = state.seats.get(id);
    if (!s || s.status !== 'available') state.selected.delete(id);
  }
  render();
}

// --- Hold ---
async function doHold() {
  const seatIds = [...state.selected];
  if (seatIds.length === 0) return;
  el.btnHold.disabled = true;
  setMessage('Placing hold...', 'info');

  try {
    const hold = await apiSend('POST', '/holds', { seatIds, sessionId });
    state.hold = {
      holdId: hold.holdId,
      expiresAt: new Date(hold.expiresAt).getTime(),
      seatIds: hold.seats.map((s) => s.id),
    };
    state.selected.clear();
    // Merge held seats into local state so they render as our hold immediately.
    for (const s of hold.seats) state.seats.set(s.id, s);
    setMessage(`Held ${hold.seats.length} seat(s). Confirm before the timer runs out!`, 'success');
    startCountdown();
    render();
  } catch (err) {
    if (err.status === 409 && err.data && err.data.conflicts) {
      const conflicts = err.data.conflicts;
      setMessage(
        `Could not hold — seat(s) ${conflicts.join(', ')} were just taken. Refreshing...`,
        'error'
      );
      // Clear conflicting selections and refresh.
      for (const id of conflicts) state.selected.delete(id);
      await loadSeats();
    } else {
      setMessage('Hold failed: ' + err.message, 'error');
      await loadSeats();
    }
  }
}

// --- Confirm ---
async function doConfirm() {
  if (!state.hold) return;
  el.btnConfirm.disabled = true;
  setMessage('Confirming...', 'info');
  try {
    const result = await apiSend('POST', `/holds/${state.hold.holdId}/confirm`, { sessionId });
    for (const s of result.seats) state.seats.set(s.id, s);
    stopCountdown();
    const verb = result.idempotent ? 'already booked' : 'booked';
    setMessage(`Confirmed! ${result.seats.length} seat(s) ${verb}: ${result.seats.map((s) => s.id).join(', ')}`, 'success');
    state.hold = null;
    render();
  } catch (err) {
    stopCountdown();
    setMessage('Confirm failed: ' + err.message, 'error');
    state.hold = null;
    await loadSeats();
  }
}

// --- Release ---
async function doRelease() {
  if (!state.hold) return;
  el.btnRelease.disabled = true;
  setMessage('Releasing hold...', 'info');
  const holdId = state.hold.holdId;
  try {
    await apiSend('DELETE', `/holds/${holdId}`, { sessionId });
    setMessage('Hold released.', 'info');
  } catch (err) {
    setMessage('Release failed: ' + err.message, 'error');
  } finally {
    stopCountdown();
    state.hold = null;
    await loadSeats();
  }
}

// --- Countdown ---
function startCountdown() {
  stopCountdown();
  el.countdown.classList.remove('hidden');
  tickCountdown();
  state.countdownTimer = setInterval(tickCountdown, 250);
}
function tickCountdown() {
  if (!state.hold) return stopCountdown();
  const remaining = state.hold.expiresAt - Date.now();
  if (remaining <= 0) {
    // Hold expired locally; reflect it.
    setMessage('Your hold expired. Seats released.', 'error');
    stopCountdown();
    state.hold = null;
    loadSeats();
    return;
  }
  const secs = Math.ceil(remaining / 1000);
  el.countdown.textContent = `⏳ Hold expires in ${secs}s`;
  el.countdown.classList.toggle('urgent', secs <= 10);
}
function stopCountdown() {
  if (state.countdownTimer) {
    clearInterval(state.countdownTimer);
    state.countdownTimer = null;
  }
  el.countdown.classList.add('hidden');
  el.countdown.classList.remove('urgent');
}

// --- SSE live updates ---
function connectStream() {
  const es = new EventSource(API + '/stream');

  es.addEventListener('open', () => {
    el.conn.classList.add('online');
    el.conn.title = 'Live';
  });

  es.addEventListener('seats', (ev) => {
    try {
      const { seats } = JSON.parse(ev.data);
      let touchedMyHold = false;
      for (const s of seats) {
        state.seats.set(s.id, s);
        // If a seat in our hold got released/booked elsewhere, note it.
        if (state.hold && state.hold.seatIds.includes(s.id)) {
          if (s.status !== 'held' || s.holdId !== state.hold.holdId) {
            touchedMyHold = true;
          }
        }
      }
      // If our hold's seats are no longer held by us, our hold is gone.
      if (touchedMyHold && state.hold) {
        const stillOurs = state.hold.seatIds.every((id) => {
          const seat = state.seats.get(id);
          return seat && seat.status === 'held' && seat.holdId === state.hold.holdId;
        });
        const nowBooked = state.hold.seatIds.every((id) => {
          const seat = state.seats.get(id);
          return seat && seat.status === 'booked';
        });
        if (!stillOurs && !nowBooked) {
          stopCountdown();
          state.hold = null;
          setMessage('Your hold was released.', 'info');
        }
      }
      render();
    } catch (e) {
      console.error('Bad SSE payload', e);
    }
  });

  es.onerror = () => {
    el.conn.classList.remove('online');
    el.conn.title = 'Reconnecting...';
    // EventSource auto-reconnects.
  };
}

// --- Wire up ---
el.btnHold.addEventListener('click', doHold);
el.btnConfirm.addEventListener('click', doConfirm);
el.btnRelease.addEventListener('click', doRelease);

// Release hold on tab close (best-effort).
window.addEventListener('beforeunload', () => {
  if (state.hold) {
    navigator.sendBeacon &&
      navigator.sendBeacon(
        API + `/holds/${state.hold.holdId}`,
        new Blob([JSON.stringify({ sessionId })], { type: 'application/json' })
      );
  }
});

// --- Init ---
async function init() {
  try {
    const cfg = await apiGet('/config');
    state.holdTtlMs = cfg.holdTtlMs;
  } catch { /* defaults are fine */ }
  await loadSeats();
  connectStream();
}

init().catch((err) => setMessage('Failed to load: ' + err.message, 'error'));
