/**
 * Seat Booking – Frontend SPA
 *
 * State machine:
 *   idle      → user selects seats → selecting
 *   selecting → user clicks "Hold" → holding (if success) | idle (if 409)
 *   holding   → user clicks "Confirm" → booked
 *   holding   → user clicks "Release" | TTL expires → idle
 *   booked    → user clicks "New Booking" → idle
 */

// Use relative URL so Vite's dev proxy works; falls back to absolute for direct access
const API = '/api';

// ── Session ID ────────────────────────────────────────────────────────────────
const SESSION_ID = (() => {
  let id = sessionStorage.getItem('seat_session_id');
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem('seat_session_id', id);
  }
  return id;
})();

document.getElementById('session-id-display').textContent =
  SESSION_ID.slice(0, 8) + '…';

// ── App state ─────────────────────────────────────────────────────────────────
let seats = {};          // id → seat object
let selectedIds = new Set();
let activeHold = null;   // { holdId, seatIds, expiresAt }
let bookedSeatIds = [];
let countdownTimer = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const seatMapEl       = document.getElementById('seat-map');
const panelSelect     = document.getElementById('panel-select');
const panelHold       = document.getElementById('panel-hold');
const panelBooked     = document.getElementById('panel-booked');
const panelMessage    = document.getElementById('panel-message');
const selectedCount   = document.getElementById('selected-count');
const selectedIdsEl   = document.getElementById('selected-ids');
const holdSeatIds     = document.getElementById('hold-seat-ids');
const holdCountdown   = document.getElementById('hold-countdown');
const bookedSeatIdsEl = document.getElementById('booked-seat-ids');
const messageContent  = document.getElementById('message-content');
const btnHold         = document.getElementById('btn-hold');
const btnClear        = document.getElementById('btn-clear');
const btnConfirm      = document.getElementById('btn-confirm');
const btnRelease      = document.getElementById('btn-release');
const btnNewBooking   = document.getElementById('btn-new-booking');
const btnDismiss      = document.getElementById('btn-dismiss');
const sseStatusEl     = document.getElementById('sse-status');
const invAvailable    = document.getElementById('inv-available');
const invHeld         = document.getElementById('inv-held');
const invBooked       = document.getElementById('inv-booked');
const invTotal        = document.getElementById('inv-total');

// ── Utility ───────────────────────────────────────────────────────────────────
function showPanel(name) {
  [panelSelect, panelHold, panelBooked, panelMessage].forEach((p) =>
    p.classList.add('hidden')
  );
  if (name === 'select')  panelSelect.classList.remove('hidden');
  if (name === 'hold')    panelHold.classList.remove('hidden');
  if (name === 'booked')  panelBooked.classList.remove('hidden');
  if (name === 'message') panelMessage.classList.remove('hidden');
}

function showMessage(text, type = 'info') {
  messageContent.className = `message ${type}`;
  messageContent.innerHTML = text;
  showPanel('message');
}

function updateInventory() {
  const all = Object.values(seats);
  const now = Date.now();
  let avail = 0, held = 0, booked = 0;
  for (const s of all) {
    if (s.status === 'booked') booked++;
    else if (s.status === 'held') {
      const exp = s.hold_expires_at ? new Date(s.hold_expires_at).getTime() : 0;
      if (exp > now) held++;
      else avail++;
    } else avail++;
  }
  invAvailable.textContent = avail;
  invHeld.textContent      = held;
  invBooked.textContent    = booked;
  invTotal.textContent     = all.length;
}

// ── Seat rendering ────────────────────────────────────────────────────────────
function seatClass(seat) {
  if (seat.status === 'booked') return 'booked';
  if (seat.status === 'held') {
    const exp = seat.hold_expires_at ? new Date(seat.hold_expires_at).getTime() : 0;
    if (exp <= Date.now()) return 'available'; // expired hold
    if (activeHold && activeHold.seatIds.includes(seat.id)) return 'held-mine';
    return 'held-other';
  }
  if (selectedIds.has(seat.id)) return 'selected';
  return 'available';
}

function renderSeatMap() {
  // Group by row
  const rows = {};
  for (const seat of Object.values(seats)) {
    if (!rows[seat.row_label]) rows[seat.row_label] = [];
    rows[seat.row_label].push(seat);
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
      const seatEl = document.createElement('div');
      seatEl.className = `seat ${seatClass(seat)}`;
      seatEl.dataset.id = seat.id;
      seatEl.title = `${seat.row_label}${seat.seat_number} – ${seat.status}`;
      seatEl.textContent = seat.seat_number;
      seatEl.addEventListener('click', () => onSeatClick(seat.id));
      rowEl.appendChild(seatEl);
    }

    seatMapEl.appendChild(rowEl);
  }
  updateInventory();
}

function updateSeatEl(seatId) {
  const seat = seats[seatId];
  if (!seat) return;
  const el = seatMapEl.querySelector(`[data-id="${seatId}"]`);
  if (!el) return;
  el.className = `seat ${seatClass(seat)}`;
  el.title = `${seat.row_label}${seat.seat_number} – ${seat.status}`;
}

// ── Seat click handler ────────────────────────────────────────────────────────
function onSeatClick(seatId) {
  // Ignore clicks when a hold is active or booking is done
  if (activeHold || bookedSeatIds.length > 0) return;

  const seat = seats[seatId];
  if (!seat) return;

  const cls = seatClass(seat);
  if (cls === 'booked' || cls === 'held-other' || cls === 'held-mine') return;

  if (selectedIds.has(seatId)) {
    selectedIds.delete(seatId);
  } else {
    selectedIds.add(seatId);
  }

  updateSeatEl(seatId);
  updateSelectionPanel();
}

function updateSelectionPanel() {
  if (selectedIds.size === 0) {
    showPanel(null);
    return;
  }
  selectedCount.textContent = selectedIds.size;
  selectedIdsEl.textContent = `(${[...selectedIds].join(', ')})`;
  showPanel('select');
}

// ── Hold countdown ────────────────────────────────────────────────────────────
function startCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);

  function tick() {
    if (!activeHold) { clearInterval(countdownTimer); return; }
    const remaining = Math.max(0, activeHold.expiresAt - Date.now());
    const secs = Math.ceil(remaining / 1000);
    const mm = String(Math.floor(secs / 60)).padStart(2, '0');
    const ss = String(secs % 60).padStart(2, '0');
    holdCountdown.textContent = `${mm}:${ss}`;
    holdCountdown.classList.toggle('urgent', secs <= 10);

    if (remaining === 0) {
      clearInterval(countdownTimer);
      onHoldExpired();
    }
  }

  tick();
  countdownTimer = setInterval(tick, 500);
}

function onHoldExpired() {
  if (!activeHold) return;
  const expiredHold = activeHold;
  activeHold = null;

  // Reset held-mine seats to available visually
  for (const id of expiredHold.seatIds) {
    if (seats[id] && seats[id].status === 'held') {
      seats[id].status = 'available';
      seats[id].hold_expires_at = null;
    }
    updateSeatEl(id);
  }

  showMessage(
    `⏰ Your hold on seats <strong>${expiredHold.seatIds.join(', ')}</strong> has expired. The seats are now available again.`,
    'warning'
  );
  updateInventory();
}

// ── API calls ─────────────────────────────────────────────────────────────────
async function requestHold() {
  const seatIds = [...selectedIds];
  btnHold.disabled = true;

  try {
    const resp = await fetch(`${API}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId: SESSION_ID }),
    });
    const data = await resp.json();

    if (resp.ok) {
      activeHold = {
        holdId: data.holdId,
        seatIds: data.seatIds,
        expiresAt: new Date(data.expiresAt).getTime(),
      };
      selectedIds.clear();

      // Update local seat state
      for (const id of data.seatIds) {
        if (seats[id]) {
          seats[id].status = 'held';
          seats[id].hold_id = data.holdId;
          seats[id].hold_expires_at = data.expiresAt;
        }
      }

      holdSeatIds.textContent = data.seatIds.join(', ');
      showPanel('hold');
      startCountdown();
      renderSeatMap();
    } else if (resp.status === 409) {
      const conflicting = data.conflictingSeatIds || [];
      // Refresh seat map to show current state
      await loadSeats();
      showMessage(
        `❌ Could not hold seats. The following seat(s) are already taken: <strong>${conflicting.join(', ')}</strong>. Please select different seats.`,
        'error'
      );
      selectedIds.clear();
    } else {
      showMessage(`❌ Error: ${data.error || 'Unknown error'}`, 'error');
    }
  } catch (err) {
    showMessage(`❌ Network error: ${err.message}`, 'error');
  } finally {
    btnHold.disabled = false;
  }
}

async function confirmHold() {
  if (!activeHold) return;
  btnConfirm.disabled = true;

  try {
    const resp = await fetch(`${API}/holds/${activeHold.holdId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });
    const data = await resp.json();

    if (resp.ok) {
      bookedSeatIds = activeHold.seatIds;
      const prevHold = activeHold;
      activeHold = null;
      if (countdownTimer) clearInterval(countdownTimer);

      // Update local state
      for (const id of prevHold.seatIds) {
        if (seats[id]) {
          seats[id].status = 'booked';
          seats[id].hold_expires_at = null;
          seats[id].booked_by = SESSION_ID;
        }
      }

      bookedSeatIdsEl.textContent = bookedSeatIds.join(', ');
      showPanel('booked');
      renderSeatMap();
    } else {
      const msg = data.error || 'Confirmation failed';
      if (resp.status === 410) {
        // Hold expired
        activeHold = null;
        if (countdownTimer) clearInterval(countdownTimer);
        await loadSeats();
        showMessage(`⏰ ${msg}. Please select new seats.`, 'warning');
      } else {
        showMessage(`❌ ${msg}`, 'error');
      }
    }
  } catch (err) {
    showMessage(`❌ Network error: ${err.message}`, 'error');
  } finally {
    btnConfirm.disabled = false;
  }
}

async function releaseHold() {
  if (!activeHold) return;
  btnRelease.disabled = true;

  try {
    const resp = await fetch(`${API}/holds/${activeHold.holdId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });

    if (resp.ok) {
      const prevHold = activeHold;
      activeHold = null;
      if (countdownTimer) clearInterval(countdownTimer);

      for (const id of prevHold.seatIds) {
        if (seats[id]) {
          seats[id].status = 'available';
          seats[id].hold_id = null;
          seats[id].hold_expires_at = null;
        }
      }

      showPanel(null);
      renderSeatMap();
    } else {
      const data = await resp.json();
      showMessage(`❌ ${data.error || 'Release failed'}`, 'error');
    }
  } catch (err) {
    showMessage(`❌ Network error: ${err.message}`, 'error');
  } finally {
    btnRelease.disabled = false;
  }
}

// ── Load seats ────────────────────────────────────────────────────────────────
async function loadSeats() {
  try {
    const resp = await fetch(`${API}/seats`);
    const data = await resp.json();

    seats = {};
    for (const seat of data.seats) {
      seats[seat.id] = seat;
    }

    renderSeatMap();
  } catch (err) {
    seatMapEl.innerHTML = `<div class="loading">Failed to load seats: ${err.message}</div>`;
  }
}

// ── SSE ───────────────────────────────────────────────────────────────────────
function connectSSE() {
  setSseStatus('connecting');
  const es = new EventSource(`${API}/stream`);

  es.addEventListener('connected', () => {
    setSseStatus('connected');
  });

  es.addEventListener('seats:held', (e) => {
    const { seats: updatedSeats, holdId, sessionId } = JSON.parse(e.data);
    for (const s of updatedSeats) {
      // Don't overwrite our own hold state (we already updated it)
      if (activeHold && activeHold.holdId === holdId) continue;
      seats[s.id] = { ...seats[s.id], ...s };
      updateSeatEl(s.id);
    }
    updateInventory();
  });

  es.addEventListener('seats:booked', (e) => {
    const { seats: updatedSeats } = JSON.parse(e.data);
    for (const s of updatedSeats) {
      seats[s.id] = { ...seats[s.id], ...s };
      updateSeatEl(s.id);
    }
    updateInventory();
  });

  es.addEventListener('seats:released', (e) => {
    const { seats: updatedSeats, holdId } = JSON.parse(e.data);
    for (const s of updatedSeats) {
      // If this is our own hold expiring via SSE, handle it
      if (activeHold && holdId === activeHold.holdId) {
        // The countdown will handle this; skip to avoid double-handling
        continue;
      }
      seats[s.id] = {
        ...seats[s.id],
        status: 'available',
        hold_id: null,
        hold_expires_at: null,
      };
      updateSeatEl(s.id);
    }
    updateInventory();
  });

  es.onerror = () => {
    setSseStatus('disconnected');
    es.close();
    // Reconnect after 3 seconds
    setTimeout(connectSSE, 3000);
  };

  es.onopen = () => setSseStatus('connected');
}

function setSseStatus(state) {
  sseStatusEl.className = `sse-status ${state}`;
  const labels = {
    connected:    '⬤ Live',
    disconnected: '⬤ Disconnected',
    connecting:   '⬤ Connecting…',
  };
  sseStatusEl.textContent = labels[state] || state;
}

// ── Button wiring ─────────────────────────────────────────────────────────────
btnHold.addEventListener('click', requestHold);
btnClear.addEventListener('click', () => {
  selectedIds.clear();
  renderSeatMap();
  showPanel(null);
});
btnConfirm.addEventListener('click', confirmHold);
btnRelease.addEventListener('click', releaseHold);
btnNewBooking.addEventListener('click', () => {
  bookedSeatIds = [];
  showPanel(null);
  renderSeatMap();
});
btnDismiss.addEventListener('click', () => {
  showPanel(null);
  // If we had a selection before the message, restore it
  if (selectedIds.size > 0) updateSelectionPanel();
});

// ── Boot ──────────────────────────────────────────────────────────────────────
(async () => {
  await loadSeats();
  connectSSE();
})();
