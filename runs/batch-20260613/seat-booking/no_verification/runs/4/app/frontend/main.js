/**
 * Seat Booking – Frontend SPA
 *
 * State machine:
 *   IDLE        – no hold; user can select seats
 *   HOLDING     – active hold; user can confirm or release
 *   BOOKED      – seats confirmed; show success screen
 */

// In dev, Vite proxies /api → http://localhost:3001/api
// In production (served from the same origin), /api works directly.
const API = '/api';

// ── Session identity ─────────────────────────────────────────────────────────
let sessionId = localStorage.getItem('seatBookingSession');
if (!sessionId) {
  sessionId = crypto.randomUUID();
  localStorage.setItem('seatBookingSession', sessionId);
}

// ── Application state ────────────────────────────────────────────────────────
let seats = {};          // seatId → seat object
let selectedSeatIds = new Set();
let currentHold = null;  // { holdId, seatIds, expiresAt, timerInterval }
let appState = 'IDLE';   // 'IDLE' | 'HOLDING' | 'BOOKED'
let holdButtonInjected = false;

// ── DOM refs ─────────────────────────────────────────────────────────────────
const seatMapEl      = document.getElementById('seat-map');
const statusBar      = document.getElementById('status-bar');
const holdPanel      = document.getElementById('hold-panel');
const holdSeatsLabel = document.getElementById('hold-seats-label');
const holdTimer      = document.getElementById('hold-timer');
const btnConfirm     = document.getElementById('btn-confirm');
const btnRelease     = document.getElementById('btn-release');
const bookingSuccess = document.getElementById('booking-success');
const bookingDetails = document.getElementById('booking-details');
const btnNewBooking  = document.getElementById('btn-new-booking');

// ── Utility ──────────────────────────────────────────────────────────────────
function showStatus(msg, type = 'info', autoDismiss = 4000) {
  // Clear previous content and button state
  statusBar.innerHTML = '';
  holdButtonInjected = false;

  const textNode = document.createTextNode(msg);
  statusBar.appendChild(textNode);
  statusBar.className = `status-bar ${type}`;
  statusBar.classList.remove('hidden');
  if (autoDismiss) {
    setTimeout(() => statusBar.classList.add('hidden'), autoDismiss);
  }
}

function hideStatus() {
  statusBar.classList.add('hidden');
  holdButtonInjected = false;
}

// ── Seat map rendering ───────────────────────────────────────────────────────
function buildSeatMap(seatList) {
  // Group by row
  const rows = {};
  for (const seat of seatList) {
    if (!rows[seat.row_label]) rows[seat.row_label] = [];
    rows[seat.row_label].push(seat);
    seats[seat.id] = seat;
  }

  seatMapEl.innerHTML = '';

  for (const rowLabel of Object.keys(rows).sort()) {
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';

    const labelEl = document.createElement('div');
    labelEl.className = 'row-label';
    labelEl.textContent = rowLabel;
    rowEl.appendChild(labelEl);

    for (const seat of rows[rowLabel].sort((a, b) => a.seat_number - b.seat_number)) {
      rowEl.appendChild(createSeatEl(seat));
    }

    seatMapEl.appendChild(rowEl);
  }
}

function createSeatEl(seat) {
  const el = document.createElement('div');
  el.className = 'seat';
  el.id = `seat-${seat.id}`;
  el.textContent = seat.seat_number;
  el.title = `${seat.row_label}${seat.seat_number}`;
  applySeatClass(el, seat);
  el.addEventListener('click', () => onSeatClick(seat.id));
  return el;
}

function applySeatClass(el, seat) {
  // Remove all state classes
  el.classList.remove('available', 'held-own', 'held-other', 'booked', 'selected');

  if (selectedSeatIds.has(seat.id) && appState === 'IDLE') {
    el.classList.add('selected');
    return;
  }

  switch (seat.status) {
    case 'available':
      el.classList.add('available');
      break;
    case 'held':
      if (currentHold && currentHold.seatIds.includes(seat.id)) {
        el.classList.add('held-own');
      } else {
        el.classList.add('held-other');
      }
      break;
    case 'booked':
      el.classList.add('booked');
      break;
  }
}

function refreshSeatEl(seatId) {
  const seat = seats[seatId];
  if (!seat) return;
  const el = document.getElementById(`seat-${seatId}`);
  if (!el) return;
  applySeatClass(el, seat);
}

function refreshAllSeats() {
  for (const seatId of Object.keys(seats)) {
    refreshSeatEl(seatId);
  }
}

// ── Seat click handler ───────────────────────────────────────────────────────
function onSeatClick(seatId) {
  if (appState !== 'IDLE') return;

  const seat = seats[seatId];
  if (!seat || seat.status !== 'available') return;

  if (selectedSeatIds.has(seatId)) {
    selectedSeatIds.delete(seatId);
  } else {
    selectedSeatIds.add(seatId);
  }

  refreshSeatEl(seatId);
  updateSelectionUI();
}

function updateSelectionUI() {
  if (selectedSeatIds.size === 0) {
    hideStatus();
  } else {
    const ids = [...selectedSeatIds].join(', ');
    showStatus(
      `${selectedSeatIds.size} seat(s) selected: ${ids}. Click "Hold" or select more.`,
      'info',
      0
    );
    // Show a hold button inline in the status bar if not already there
    ensureHoldButton();
  }
}

function ensureHoldButton() {
  if (holdButtonInjected) return;
  holdButtonInjected = true;

  const btn = document.createElement('button');
  btn.id = 'btn-hold';
  btn.className = 'btn btn-primary';
  btn.style.marginLeft = '1rem';
  btn.textContent = '🔒 Hold Selected';
  btn.addEventListener('click', requestHold);
  statusBar.appendChild(btn);
}

// ── Hold flow ────────────────────────────────────────────────────────────────
async function requestHold() {
  if (selectedSeatIds.size === 0) return;

  const seatIds = [...selectedSeatIds];
  hideStatus();

  try {
    const res = await fetch(`${API}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId }),
    });

    const data = await res.json();

    if (res.status === 201) {
      // Success
      selectedSeatIds.clear();
      holdButtonInjected = false;

      currentHold = {
        holdId: data.holdId,
        seatIds: data.seatIds,
        expiresAt: new Date(data.expiresAt),
      };

      // Update local seat state
      for (const seatId of data.seatIds) {
        if (seats[seatId]) {
          seats[seatId].status = 'held';
          seats[seatId].hold_id = data.holdId;
          seats[seatId].hold_expires_at = data.expiresAt;
        }
      }

      appState = 'HOLDING';
      refreshAllSeats();
      showHoldPanel();
    } else if (res.status === 409) {
      // Conflict
      const conflicting = data.conflictingSeatIds || [];
      showStatus(
        `⚠️ Seats already taken: ${conflicting.join(', ')}. Please choose different seats.`,
        'error',
        6000
      );
      // Highlight conflicting seats
      for (const seatId of conflicting) {
        const el = document.getElementById(`seat-${seatId}`);
        if (el) {
          el.classList.add('conflict');
          setTimeout(() => el.classList.remove('conflict'), 600);
        }
        // Remove from selection if selected
        selectedSeatIds.delete(seatId);
      }
      // Refresh the seat map to get latest state
      await loadSeats(false);
      refreshAllSeats();
      updateSelectionUI();
    } else {
      showStatus(`Error: ${data.error || 'Unknown error'}`, 'error');
    }
  } catch (err) {
    console.error('requestHold error:', err);
    showStatus('Network error. Please try again.', 'error');
  }
}

// ── Hold panel ───────────────────────────────────────────────────────────────
function showHoldPanel() {
  if (!currentHold) return;

  holdSeatsLabel.textContent = `Holding: ${currentHold.seatIds.join(', ')}`;
  holdPanel.classList.remove('hidden');
  bookingSuccess.classList.add('hidden');

  startHoldTimer();
}

function startHoldTimer() {
  if (currentHold.timerInterval) clearInterval(currentHold.timerInterval);

  function tick() {
    if (!currentHold) return;
    const remaining = Math.max(0, currentHold.expiresAt - Date.now());
    const secs = Math.ceil(remaining / 1000);
    holdTimer.textContent = `⏱ ${secs}s`;

    if (secs <= 10) {
      holdTimer.classList.add('urgent');
    } else {
      holdTimer.classList.remove('urgent');
    }

    if (remaining <= 0) {
      clearInterval(currentHold.timerInterval);
      onHoldExpiredLocally();
    }
  }

  tick();
  currentHold.timerInterval = setInterval(tick, 500);
}

function onHoldExpiredLocally() {
  showStatus('⏰ Your hold has expired. Please select seats again.', 'warning', 6000);
  clearHold();
}

function clearHold() {
  if (currentHold?.timerInterval) clearInterval(currentHold.timerInterval);
  currentHold = null;
  appState = 'IDLE';
  holdPanel.classList.add('hidden');
  holdButtonInjected = false;
  selectedSeatIds.clear();
  refreshAllSeats();
}

// ── Confirm ──────────────────────────────────────────────────────────────────
btnConfirm.addEventListener('click', async () => {
  if (!currentHold) return;
  btnConfirm.disabled = true;
  btnRelease.disabled = true;

  try {
    const res = await fetch(`${API}/holds/${currentHold.holdId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });

    const data = await res.json();

    if (res.ok) {
      const bookedIds = data.seatIds || currentHold.seatIds;

      // Update local state
      for (const seatId of bookedIds) {
        if (seats[seatId]) {
          seats[seatId].status = 'booked';
          seats[seatId].hold_id = null;
          seats[seatId].hold_expires_at = null;
          seats[seatId].booked_by = currentHold.holdId;
        }
      }

      const holdId = currentHold.holdId;
      clearHold();
      appState = 'BOOKED';
      refreshAllSeats();

      holdPanel.classList.add('hidden');
      bookingSuccess.classList.remove('hidden');
      bookingDetails.textContent = `Seats ${bookedIds.join(', ')} are now booked! (Booking ref: ${holdId.slice(0, 8)})`;
    } else if (res.status === 410 || res.status === 404) {
      showStatus(`Hold expired or not found. Please select seats again.`, 'error', 6000);
      clearHold();
      await loadSeats(false);
    } else {
      showStatus(`Confirmation failed: ${data.error}`, 'error');
      btnConfirm.disabled = false;
      btnRelease.disabled = false;
    }
  } catch (err) {
    console.error('confirm error:', err);
    showStatus('Network error during confirmation.', 'error');
    btnConfirm.disabled = false;
    btnRelease.disabled = false;
  }
});

// ── Release ──────────────────────────────────────────────────────────────────
btnRelease.addEventListener('click', async () => {
  if (!currentHold) return;
  btnRelease.disabled = true;
  btnConfirm.disabled = true;

  try {
    const res = await fetch(`${API}/holds/${currentHold.holdId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });

    if (res.ok) {
      showStatus('Hold released. Seats are available again.', 'info', 4000);
    } else {
      const data = await res.json();
      showStatus(`Release failed: ${data.error}`, 'error');
    }

    clearHold();
    await loadSeats(false);
  } catch (err) {
    console.error('release error:', err);
    showStatus('Network error during release.', 'error');
    btnRelease.disabled = false;
    btnConfirm.disabled = false;
  }
});

// ── New booking ───────────────────────────────────────────────────────────────
btnNewBooking.addEventListener('click', async () => {
  bookingSuccess.classList.add('hidden');
  appState = 'IDLE';
  await loadSeats(false);
});

// ── Load seats from API ───────────────────────────────────────────────────────
async function loadSeats(initial = true) {
  try {
    const res = await fetch(`${API}/seats`);
    const data = await res.json();

    if (initial) {
      buildSeatMap(data.seats);
    } else {
      // Merge updates into existing map
      for (const seat of data.seats) {
        seats[seat.id] = seat;
      }
      refreshAllSeats();
    }
  } catch (err) {
    console.error('loadSeats error:', err);
    seatMapEl.innerHTML = '<div class="loading">Failed to load seat map. Retrying…</div>';
    setTimeout(() => loadSeats(initial), 3000);
  }
}

// ── SSE ───────────────────────────────────────────────────────────────────────
function connectSSE() {
  const es = new EventSource(`${API}/stream`);

  es.addEventListener('seat:held', (e) => {
    const { seatId, holdId, holdExpiresAt } = JSON.parse(e.data);
    if (seats[seatId]) {
      seats[seatId].status = 'held';
      seats[seatId].hold_id = holdId;
      seats[seatId].hold_expires_at = holdExpiresAt;
      refreshSeatEl(seatId);
      flashSeat(seatId, 'flash-held');
    }
  });

  es.addEventListener('seat:booked', (e) => {
    const { seatId, bookedBy } = JSON.parse(e.data);
    if (seats[seatId]) {
      seats[seatId].status = 'booked';
      seats[seatId].hold_id = null;
      seats[seatId].hold_expires_at = null;
      seats[seatId].booked_by = bookedBy;
      refreshSeatEl(seatId);
      flashSeat(seatId, 'flash-booked');
    }
  });

  es.addEventListener('seat:released', (e) => {
    const { seatId } = JSON.parse(e.data);
    if (seats[seatId]) {
      // Only update if this seat isn't part of our own active hold
      const isOurHeld = currentHold && currentHold.seatIds.includes(seatId);
      if (!isOurHeld) {
        seats[seatId].status = 'available';
        seats[seatId].hold_id = null;
        seats[seatId].hold_expires_at = null;
        refreshSeatEl(seatId);
        flashSeat(seatId, 'flash-released');
      }
    }
  });

  es.onerror = () => {
    console.warn('SSE connection lost. Reconnecting in 3s…');
    es.close();
    setTimeout(connectSSE, 3000);
  };
}

function flashSeat(seatId, cls) {
  const el = document.getElementById(`seat-${seatId}`);
  if (!el) return;
  el.classList.remove('flash-held', 'flash-booked', 'flash-released');
  // Force reflow to restart animation
  void el.offsetWidth;
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), 700);
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
(async () => {
  await loadSeats(true);
  connectSSE();
})();
