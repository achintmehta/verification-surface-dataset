/**
 * Seat Booking – Vanilla JS SPA
 *
 * State machine:
 *   IDLE        – no hold; user can select available seats
 *   HOLDING     – user has an active hold; countdown running
 *   CONFIRMED   – hold confirmed; seats booked
 */

const API = 'http://localhost:3001/api';

// ── Session identity ──────────────────────────────────────────────────────────
function getSessionId() {
  let id = sessionStorage.getItem('sessionId');
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem('sessionId', id);
  }
  return id;
}
const SESSION_ID = getSessionId();

// ── Application state ─────────────────────────────────────────────────────────
const state = {
  seats: {},          // id → seat object
  selected: new Set(),// ids of seats the user has clicked (pre-hold)
  hold: null,         // { holdId, seatIds, expiresAt }
  countdownTimer: null,
};

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $seatMap      = document.getElementById('seat-map');
const $statusBar    = document.getElementById('status-bar');
const $selInfo      = document.getElementById('selection-info');
const $selCount     = document.getElementById('selected-count');
const $holdPanel    = document.getElementById('hold-panel');
const $btnHold      = document.getElementById('btn-hold');
const $btnConfirm   = document.getElementById('btn-confirm');
const $btnRelease   = document.getElementById('btn-release');
const $countdown    = document.getElementById('countdown');
const $invAvailable = document.getElementById('inv-available');
const $invHeld      = document.getElementById('inv-held');
const $invBooked    = document.getElementById('inv-booked');
const $invTotal     = document.getElementById('inv-total');

// ── Status bar ────────────────────────────────────────────────────────────────
let statusTimeout;
function showStatus(msg, type = 'info', duration = 4000) {
  clearTimeout(statusTimeout);
  $statusBar.textContent = msg;
  $statusBar.className = `status-bar ${type}`;
  if (duration > 0) {
    statusTimeout = setTimeout(() => $statusBar.classList.add('hidden'), duration);
  }
}

// ── Seat map rendering ────────────────────────────────────────────────────────
function seatClass(seat) {
  if (state.hold && state.hold.seatIds.includes(seat.id)) {
    return 'held-own';
  }
  if (state.selected.has(seat.id)) return 'selected';
  if (seat.status === 'available') return 'available';
  if (seat.status === 'held') return 'held-other';
  if (seat.status === 'booked') return 'booked';
  return 'available';
}

function renderSeatMap() {
  // Group seats by row
  const rows = {};
  for (const seat of Object.values(state.seats)) {
    if (!rows[seat.row_label]) rows[seat.row_label] = [];
    rows[seat.row_label].push(seat);
  }

  $seatMap.innerHTML = '';

  for (const rowLabel of Object.keys(rows).sort()) {
    const rowSeats = rows[rowLabel].sort((a, b) => a.seat_number - b.seat_number);
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';
    rowEl.dataset.row = rowLabel;

    const labelEl = document.createElement('div');
    labelEl.className = 'row-label';
    labelEl.textContent = rowLabel;
    rowEl.appendChild(labelEl);

    for (const seat of rowSeats) {
      const seatEl = document.createElement('div');
      seatEl.className = `seat ${seatClass(seat)}`;
      seatEl.dataset.id = seat.id;
      seatEl.title = `${seat.row_label}${seat.seat_number} – ${seat.status}`;
      seatEl.textContent = seat.seat_number;
      seatEl.addEventListener('click', () => onSeatClick(seat.id));
      rowEl.appendChild(seatEl);
    }

    $seatMap.appendChild(rowEl);
  }

  updateInventory();
}

function updateSeatElement(seatId, newClass, pulse = false) {
  const el = $seatMap.querySelector(`[data-id="${seatId}"]`);
  if (!el) return;
  el.className = `seat ${newClass}${pulse ? ' just-held' : ''}`;
  const seat = state.seats[seatId];
  if (seat) el.title = `${seat.row_label}${seat.seat_number} – ${seat.status}`;
  if (pulse) {
    el.addEventListener('animationend', () => el.classList.remove('just-held'), { once: true });
  }
}

// ── Inventory counter ─────────────────────────────────────────────────────────
function updateInventory() {
  const seats = Object.values(state.seats);
  const total = seats.length;
  let available = 0, held = 0, booked = 0;
  for (const s of seats) {
    if (s.status === 'available') available++;
    else if (s.status === 'held') held++;
    else if (s.status === 'booked') booked++;
  }
  $invAvailable.textContent = available;
  $invHeld.textContent = held;
  $invBooked.textContent = booked;
  $invTotal.textContent = total;
}

// ── Action panel ──────────────────────────────────────────────────────────────
function updateActionPanel() {
  if (state.hold) {
    $holdPanel.classList.remove('hidden');
    $btnHold.classList.add('hidden');
    $selInfo.classList.add('hidden');
    return;
  }

  $holdPanel.classList.add('hidden');

  if (state.selected.size > 0) {
    $selInfo.classList.remove('hidden');
    $selCount.textContent = state.selected.size;
    $btnHold.classList.remove('hidden');
  } else {
    $selInfo.classList.add('hidden');
    $btnHold.classList.add('hidden');
  }
}

// ── Countdown timer ───────────────────────────────────────────────────────────
function startCountdown(expiresAt) {
  clearInterval(state.countdownTimer);

  function tick() {
    const remaining = Math.max(0, Math.floor((new Date(expiresAt) - Date.now()) / 1000));
    const mins = String(Math.floor(remaining / 60)).padStart(2, '0');
    const secs = String(remaining % 60).padStart(2, '0');
    $countdown.textContent = `${mins}:${secs}`;
    $countdown.classList.toggle('urgent', remaining <= 10);

    if (remaining === 0) {
      clearInterval(state.countdownTimer);
      // Hold expired client-side; the server will also expire it
      onHoldExpiredLocally();
    }
  }

  tick();
  state.countdownTimer = setInterval(tick, 1000);
}

function stopCountdown() {
  clearInterval(state.countdownTimer);
  state.countdownTimer = null;
  $countdown.textContent = '--';
  $countdown.classList.remove('urgent');
}

function onHoldExpiredLocally() {
  if (!state.hold) return;
  showStatus('Your hold has expired. Seats are now available again.', 'warning', 6000);
  clearHold();
}

// ── Seat click handler ────────────────────────────────────────────────────────
function onSeatClick(seatId) {
  // If we have an active hold, ignore clicks
  if (state.hold) return;

  const seat = state.seats[seatId];
  if (!seat) return;

  // Only available seats can be selected
  if (seat.status !== 'available') {
    showStatus(`Seat ${seatId} is ${seat.status}.`, 'warning', 2000);
    return;
  }

  if (state.selected.has(seatId)) {
    state.selected.delete(seatId);
    updateSeatElement(seatId, 'available');
  } else {
    state.selected.add(seatId);
    updateSeatElement(seatId, 'selected');
  }

  updateActionPanel();
}

// ── Hold flow ─────────────────────────────────────────────────────────────────
$btnHold.addEventListener('click', async () => {
  if (state.selected.size === 0) return;
  $btnHold.disabled = true;

  const seatIds = [...state.selected];

  try {
    const resp = await fetch(`${API}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId: SESSION_ID }),
    });

    const data = await resp.json();

    if (resp.ok) {
      // Success: set hold state
      state.hold = {
        holdId: data.holdId,
        seatIds: data.seatIds,
        expiresAt: data.expiresAt,
      };
      state.selected.clear();

      // Update seat states locally (SSE will also arrive, but be fast)
      for (const id of data.seatIds) {
        if (state.seats[id]) {
          state.seats[id].status = 'held';
          state.seats[id].hold_expires_at = data.expiresAt;
        }
        updateSeatElement(id, 'held-own', true);
      }

      startCountdown(data.expiresAt);
      updateActionPanel();
      updateInventory();
      showStatus(`Hold placed for ${data.seatIds.length} seat(s). Confirm within ${data.ttlSeconds}s.`, 'success');
    } else if (resp.status === 409) {
      // Conflict: some seats taken
      const taken = data.conflictingSeatIds || [];
      showStatus(
        `Seats unavailable: ${taken.join(', ')}. Please choose different seats.`,
        'error',
        6000
      );
      // Refresh seat map to show current state
      await loadSeats();
    } else {
      showStatus(data.error || 'Failed to place hold.', 'error');
    }
  } catch (err) {
    console.error('[hold]', err);
    showStatus('Network error placing hold.', 'error');
  } finally {
    $btnHold.disabled = false;
  }
});

// ── Confirm flow ──────────────────────────────────────────────────────────────
$btnConfirm.addEventListener('click', async () => {
  if (!state.hold) return;
  $btnConfirm.disabled = true;

  try {
    const resp = await fetch(`${API}/holds/${state.hold.holdId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });

    const data = await resp.json();

    if (resp.ok) {
      const bookedIds = data.seats.map((s) => s.id);

      // Update local state
      for (const id of bookedIds) {
        if (state.seats[id]) state.seats[id].status = 'booked';
        updateSeatElement(id, 'booked');
      }

      stopCountdown();
      clearHold(false); // don't reset seat visuals – already updated above
      updateInventory();
      showStatus(
        `🎉 Booking confirmed! Seats: ${bookedIds.join(', ')}`,
        'success',
        0 // persistent
      );
    } else {
      showStatus(data.error || 'Confirmation failed.', 'error');
      if (resp.status === 409 || resp.status === 404) {
        // Hold expired or invalid – clean up
        clearHold();
        await loadSeats();
      }
    }
  } catch (err) {
    console.error('[confirm]', err);
    showStatus('Network error confirming hold.', 'error');
  } finally {
    $btnConfirm.disabled = false;
  }
});

// ── Release flow ──────────────────────────────────────────────────────────────
$btnRelease.addEventListener('click', async () => {
  if (!state.hold) return;
  $btnRelease.disabled = true;

  try {
    const resp = await fetch(`${API}/holds/${state.hold.holdId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });

    const data = await resp.json();

    if (resp.ok) {
      const releasedIds = data.releasedSeatIds || [];
      for (const id of releasedIds) {
        if (state.seats[id]) state.seats[id].status = 'available';
        updateSeatElement(id, 'available');
      }
      clearHold(false);
      updateInventory();
      showStatus('Hold released. Seats are available again.', 'info');
    } else {
      showStatus(data.error || 'Failed to release hold.', 'error');
    }
  } catch (err) {
    console.error('[release]', err);
    showStatus('Network error releasing hold.', 'error');
  } finally {
    $btnRelease.disabled = false;
  }
});

// ── Clear hold state ──────────────────────────────────────────────────────────
function clearHold(resetSeatVisuals = true) {
  if (resetSeatVisuals && state.hold) {
    for (const id of state.hold.seatIds) {
      const seat = state.seats[id];
      if (seat && seat.status === 'held') {
        seat.status = 'available';
        updateSeatElement(id, 'available');
      }
    }
  }
  state.hold = null;
  stopCountdown();
  updateActionPanel();
}

// ── Load seats from API ───────────────────────────────────────────────────────
async function loadSeats() {
  try {
    const resp = await fetch(`${API}/seats`);
    const data = await resp.json();

    state.seats = {};
    for (const seat of data.seats) {
      state.seats[seat.id] = seat;
    }

    // If we had a hold, verify it's still valid
    if (state.hold) {
      const holdSeats = state.hold.seatIds.map((id) => state.seats[id]);
      const allHeld = holdSeats.every((s) => s && s.status === 'held');
      if (!allHeld) {
        stopCountdown();
        state.hold = null;
        updateActionPanel();
      }
    }

    renderSeatMap();
  } catch (err) {
    console.error('[loadSeats]', err);
    $seatMap.innerHTML = '<div class="loading">Failed to load seat map. Retrying…</div>';
    setTimeout(loadSeats, 3000);
  }
}

// ── SSE connection ────────────────────────────────────────────────────────────
function connectSSE() {
  const es = new EventSource(`${API}/stream`);

  es.addEventListener('connected', () => {
    console.log('[SSE] connected');
  });

  // seats:held – one or more seats just became held
  es.addEventListener('seats:held', (e) => {
    const { seats, holdId, expiresAt } = JSON.parse(e.data);
    for (const { id } of seats) {
      if (!state.seats[id]) continue;
      state.seats[id].status = 'held';
      state.seats[id].hold_expires_at = expiresAt;

      // Don't overwrite our own hold's visual
      if (state.hold && state.hold.seatIds.includes(id)) continue;
      updateSeatElement(id, 'held-other');
    }
    updateInventory();
  });

  // seats:booked – one or more seats just got booked
  es.addEventListener('seats:booked', (e) => {
    const { seats, holdId } = JSON.parse(e.data);
    for (const { id } of seats) {
      if (!state.seats[id]) continue;
      state.seats[id].status = 'booked';
      state.seats[id].hold_expires_at = null;
      updateSeatElement(id, 'booked');
    }

    // If our hold was confirmed from another tab
    if (state.hold && state.hold.holdId === holdId) {
      stopCountdown();
      state.hold = null;
      updateActionPanel();
    }

    updateInventory();
  });

  // seats:released – one or more seats became available again
  es.addEventListener('seats:released', (e) => {
    const { seats } = JSON.parse(e.data);
    for (const { id } of seats) {
      if (!state.seats[id]) continue;
      state.seats[id].status = 'available';
      state.seats[id].hold_expires_at = null;

      // If this was our own hold that expired server-side
      if (state.hold && state.hold.seatIds.includes(id)) {
        // Will be handled by the full clearHold below
        continue;
      }
      updateSeatElement(id, 'available');
    }

    // Check if our hold was among the released seats
    if (state.hold) {
      const releasedIds = new Set(seats.map((s) => s.id));
      const ourSeatReleased = state.hold.seatIds.some((id) => releasedIds.has(id));
      if (ourSeatReleased) {
        // Capture seatIds before clearing hold
        const ownSeatIds = [...state.hold.seatIds];
        showStatus('Your hold has expired or was released.', 'warning', 6000);
        clearHold(false); // visuals already updated above for non-own seats
        // Ensure our own held seats are shown as available
        for (const id of ownSeatIds) {
          updateSeatElement(id, 'available');
        }
      }
    }

    updateInventory();
  });

  es.onerror = () => {
    console.warn('[SSE] connection lost, reconnecting in 3s…');
    es.close();
    setTimeout(connectSSE, 3000);
  };
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function init() {
  await loadSeats();
  connectSSE();
}

init();
