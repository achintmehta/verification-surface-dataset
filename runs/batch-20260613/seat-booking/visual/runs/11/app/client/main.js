// ---- Session ----
function getSessionId() {
  let id = localStorage.getItem('seat_session_id');
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : 'sess-' + Math.random().toString(36).slice(2));
    localStorage.setItem('seat_session_id', id);
  }
  return id;
}
const sessionId = getSessionId();

// ---- State ----
const state = {
  seats: new Map(), // id -> seat
  selected: new Set(),
  hold: null, // { id, seatIds, expiresAt }
  countdownTimer: null,
};

// ---- DOM ----
const el = {
  seatmap: document.getElementById('seatmap'),
  conn: document.getElementById('connection'),
  invAvailable: document.getElementById('inv-available'),
  invHeld: document.getElementById('inv-held'),
  invBooked: document.getElementById('inv-booked'),
  invTotal: document.getElementById('inv-total'),
  selectionList: document.getElementById('selection-list'),
  holdBox: document.getElementById('hold-box'),
  holdSeats: document.getElementById('hold-seats'),
  countdown: document.getElementById('countdown'),
  btnHold: document.getElementById('btn-hold'),
  btnConfirm: document.getElementById('btn-confirm'),
  btnRelease: document.getElementById('btn-release'),
  message: document.getElementById('message'),
  sessionId: document.getElementById('session-id'),
};
el.sessionId.textContent = sessionId.slice(0, 8);

function setMessage(text, kind = '') {
  el.message.textContent = text;
  el.message.className = 'message' + (kind ? ' ' + kind : '');
}

// ---- Rendering ----
function effectiveStatus(seat) {
  // Defensive client-side expiry check (server is authoritative).
  if (seat.status === 'held' && seat.holdExpiresAt) {
    if (new Date(seat.holdExpiresAt).getTime() <= Date.now()) return 'available';
  }
  return seat.status;
}

function render() {
  const seats = [...state.seats.values()].sort((a, b) =>
    a.rowLabel === b.rowLabel ? a.seatNumber - b.seatNumber : a.rowLabel < b.rowLabel ? -1 : 1
  );

  // group by row
  const rows = new Map();
  for (const s of seats) {
    if (!rows.has(s.rowLabel)) rows.set(s.rowLabel, []);
    rows.get(s.rowLabel).push(s);
  }

  el.seatmap.innerHTML = '';
  let avail = 0, held = 0, booked = 0;

  for (const [label, rowSeats] of rows) {
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';
    const lab = document.createElement('span');
    lab.className = 'row-label';
    lab.textContent = label;
    rowEl.appendChild(lab);

    for (const seat of rowSeats) {
      const status = effectiveStatus(seat);
      if (status === 'available') avail++;
      else if (status === 'held') held++;
      else if (status === 'booked') booked++;

      const btn = document.createElement('button');
      btn.className = 'seat';
      btn.textContent = seat.seatNumber;
      btn.dataset.id = seat.id;
      btn.title = seat.id;

      const isMine = seat.status === 'held' && state.hold && seat.holdId === state.hold.id;

      if (status === 'booked') {
        btn.classList.add('booked');
        btn.disabled = true;
      } else if (status === 'held') {
        if (isMine) {
          btn.classList.add('mine');
        } else {
          btn.classList.add('held');
          btn.disabled = true;
        }
      } else if (state.selected.has(seat.id)) {
        btn.classList.add('selected');
      } else {
        btn.classList.add('available');
      }

      btn.addEventListener('click', () => onSeatClick(seat.id));
      rowEl.appendChild(btn);
    }
    el.seatmap.appendChild(rowEl);
  }

  el.invAvailable.textContent = avail;
  el.invHeld.textContent = held;
  el.invBooked.textContent = booked;
  el.invTotal.textContent = seats.length;

  renderSelection();
  renderControls();
}

function renderSelection() {
  if (state.selected.size === 0) {
    el.selectionList.textContent = 'No seats selected.';
    el.selectionList.classList.add('muted');
  } else {
    el.selectionList.textContent = [...state.selected].sort().join(', ');
    el.selectionList.classList.remove('muted');
  }
}

function renderControls() {
  const hasHold = !!state.hold;
  el.btnHold.disabled = state.selected.size === 0 || hasHold;
  el.btnHold.classList.toggle('hidden', hasHold);
  el.btnConfirm.classList.toggle('hidden', !hasHold);
  el.btnRelease.classList.toggle('hidden', !hasHold);

  if (hasHold) {
    el.holdBox.classList.remove('hidden');
    el.holdSeats.textContent = state.hold.seatIds.slice().sort().join(', ');
  } else {
    el.holdBox.classList.add('hidden');
  }
}

function onSeatClick(id) {
  const seat = state.seats.get(id);
  if (!seat) return;
  if (state.hold) {
    setMessage('You already have an active hold. Confirm or release it first.', 'warn');
    return;
  }
  const status = effectiveStatus(seat);
  if (status !== 'available') return;
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  setMessage('');
  render();
}

// ---- Countdown ----
function startCountdown() {
  stopCountdown();
  const tick = () => {
    if (!state.hold) return stopCountdown();
    const remaining = new Date(state.hold.expiresAt).getTime() - Date.now();
    if (remaining <= 0) {
      el.countdown.textContent = '00:00';
      setMessage('Your hold expired. Those seats were released.', 'warn');
      clearHold();
      refreshSeats();
      return;
    }
    const totalSec = Math.floor(remaining / 1000);
    const m = String(Math.floor(totalSec / 60)).padStart(2, '0');
    const s = String(totalSec % 60).padStart(2, '0');
    el.countdown.textContent = `${m}:${s}`;
  };
  tick();
  state.countdownTimer = setInterval(tick, 250);
}
function stopCountdown() {
  if (state.countdownTimer) clearInterval(state.countdownTimer);
  state.countdownTimer = null;
}
function clearHold() {
  state.hold = null;
  stopCountdown();
  renderControls();
}

// ---- API ----
async function refreshSeats() {
  try {
    const res = await fetch('/api/seats');
    const data = await res.json();
    state.seats.clear();
    for (const s of data.seats) state.seats.set(s.id, s);
    render();
  } catch (e) {
    setMessage('Failed to load seats.', 'error');
  }
}

async function requestHold() {
  const seatIds = [...state.selected];
  if (seatIds.length === 0) return;
  el.btnHold.disabled = true;
  setMessage('Requesting hold…');
  try {
    const res = await fetch('/api/holds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId }),
    });
    if (res.status === 409) {
      const data = await res.json();
      const conflicts = data.conflicts || [];
      setMessage(`Seats already taken: ${conflicts.join(', ')}. Map refreshed.`, 'error');
      // mark conflicts visually after refresh
      for (const id of conflicts) state.selected.delete(id);
      await refreshSeats();
      return;
    }
    if (!res.ok) {
      setMessage('Hold failed.', 'error');
      return;
    }
    const data = await res.json();
    state.hold = {
      id: data.hold.id,
      seatIds: data.hold.seatIds,
      expiresAt: data.hold.expiresAt,
    };
    // apply held seats locally
    for (const s of data.seats) state.seats.set(s.id, s);
    state.selected.clear();
    setMessage('Seats held! Confirm before the timer runs out.', 'ok');
    startCountdown();
    render();
  } catch (e) {
    setMessage('Network error during hold.', 'error');
  } finally {
    renderControls();
  }
}

async function confirmHold() {
  if (!state.hold) return;
  el.btnConfirm.disabled = true;
  setMessage('Confirming…');
  try {
    const res = await fetch(`/api/holds/${state.hold.id}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setMessage(`Confirmation failed: ${data.error || res.status}.`, 'error');
      clearHold();
      await refreshSeats();
      return;
    }
    const data = await res.json();
    for (const s of data.seats) state.seats.set(s.id, s);
    setMessage(`Booked: ${data.booking.seatIds.sort().join(', ')} 🎉`, 'ok');
    clearHold();
    render();
  } catch (e) {
    setMessage('Network error during confirm.', 'error');
  } finally {
    el.btnConfirm.disabled = false;
  }
}

async function releaseHold() {
  if (!state.hold) return;
  const holdId = state.hold.id;
  setMessage('Releasing…');
  try {
    await fetch(`/api/holds/${holdId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    setMessage('Hold released.', 'warn');
  } catch (e) {
    /* ignore */
  } finally {
    clearHold();
    await refreshSeats();
  }
}

// ---- SSE ----
function connectSSE() {
  const es = new EventSource('/api/stream');
  es.onopen = () => {
    el.conn.textContent = 'live';
    el.conn.className = 'conn online';
  };
  es.onerror = () => {
    el.conn.textContent = 'reconnecting…';
    el.conn.className = 'conn offline';
  };
  es.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'connected') return;
    if (Array.isArray(msg.seats)) {
      for (const s of msg.seats) {
        const existing = state.seats.get(s.id);
        if (existing) state.seats.set(s.id, { ...existing, ...s });
      }
      // If one of my held seats got released/booked by expiry, drop my hold view
      if (state.hold && msg.type !== 'held') {
        const stillMine = state.hold.seatIds.some((id) => {
          const seat = state.seats.get(id);
          return seat && seat.status === 'held' && seat.holdId === state.hold.id;
        });
        if (!stillMine && msg.type === 'released') {
          clearHold();
          setMessage('Your hold was released.', 'warn');
        }
      }
      render();
    }
  };
}

// ---- Wire up ----
el.btnHold.addEventListener('click', requestHold);
el.btnConfirm.addEventListener('click', confirmHold);
el.btnRelease.addEventListener('click', releaseHold);
window.addEventListener('beforeunload', () => {
  if (state.hold) {
    navigator.sendBeacon?.(
      `/api/holds/${state.hold.id}`,
      new Blob([JSON.stringify({ sessionId })], { type: 'application/json' })
    );
  }
});

refreshSeats();
// Defer SSE so the initial network burst settles (and screenshots/network-idle
// based tooling can capture the rendered map) before opening the long-lived
// stream connection.
setTimeout(connectSSE, 800);
