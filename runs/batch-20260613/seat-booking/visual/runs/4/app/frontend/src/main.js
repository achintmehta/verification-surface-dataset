/**
 * Seat Booking Frontend
 * Vanilla JS SPA with SSE for real-time updates.
 */

// In production (served from backend), use relative URLs.
// In dev (Vite proxy), also use relative URLs (proxy handles it).
const API_BASE = '/api';

// ── Session ID ────────────────────────────────────────────────────────────────
function getSessionId() {
  let id = sessionStorage.getItem('seat_booking_session');
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem('seat_booking_session', id);
  }
  return id;
}

const SESSION_ID = getSessionId();

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  seats: {},           // id → seat object
  selectedIds: new Set(),
  currentHold: null,   // { id, seatIds, expiresAt, ttlSeconds }
  currentBooking: null, // { holdId, seatIds }
  countdownTimer: null,
  panel: 'select',     // 'select' | 'hold' | 'booked' | 'error'
};

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const els = {
  sessionDisplay: $('session-id-display'),
  connectionStatus: $('connection-status'),
  seatMap: $('seat-map'),
  invAvailable: $('inv-available'),
  invHeld: $('inv-held'),
  invBooked: $('inv-booked'),
  invTotal: $('inv-total'),
  panelSelect: $('panel-select'),
  panelHold: $('panel-hold'),
  panelBooked: $('panel-booked'),
  panelError: $('panel-error'),
  selectedCount: $('selected-count'),
  btnHold: $('btn-hold'),
  holdSeatList: $('hold-seat-list'),
  holdCountdown: $('hold-countdown'),
  btnConfirm: $('btn-confirm'),
  btnRelease: $('btn-release'),
  bookedSeatList: $('booked-seat-list'),
  btnNewBooking: $('btn-new-booking'),
  errorMessage: $('error-message'),
  btnErrorDismiss: $('btn-error-dismiss'),
};

// ── Toast notifications ───────────────────────────────────────────────────────
function createToastContainer() {
  const el = document.createElement('div');
  el.id = 'toast-container';
  document.body.appendChild(el);
  return el;
}

const toastContainer = createToastContainer();

function showToast(message, type = 'info', duration = 4000) {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ── Seat rendering ────────────────────────────────────────────────────────────
function getSeatClass(seat) {
  const isSelected = state.selectedIds.has(seat.id);
  const isMineHold = state.currentHold && state.currentHold.seatIds.includes(seat.id);
  const isMineBooked = state.currentBooking && state.currentBooking.seatIds.includes(seat.id);

  if (isSelected) return 'selected';
  if (seat.status === 'held') {
    return isMineHold ? 'held-mine' : 'held';
  }
  if (seat.status === 'booked') {
    return isMineBooked ? 'booked-mine' : 'booked';
  }
  return 'available';
}

function isSeatClickable(seat) {
  if (state.panel === 'hold' || state.panel === 'booked') return false;
  if (seat.status === 'booked') return false;
  if (seat.status === 'held') {
    // Only clickable if it's our own hold (to deselect) — but we don't allow
    // re-selecting held seats; they're locked.
    return false;
  }
  return true;
}

function renderSeatMap() {
  const seats = Object.values(state.seats);
  if (seats.length === 0) {
    els.seatMap.innerHTML = '<div class="loading">No seats found.</div>';
    return;
  }

  // Group by row
  const rows = {};
  for (const seat of seats) {
    if (!rows[seat.row_label]) rows[seat.row_label] = [];
    rows[seat.row_label].push(seat);
  }

  const rowLabels = Object.keys(rows).sort();
  const fragment = document.createDocumentFragment();

  for (const rowLabel of rowLabels) {
    const rowSeats = rows[rowLabel].sort((a, b) => a.seat_number - b.seat_number);
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';

    const labelEl = document.createElement('div');
    labelEl.className = 'row-label';
    labelEl.textContent = rowLabel;
    rowEl.appendChild(labelEl);

    const seatsEl = document.createElement('div');
    seatsEl.className = 'seats-container';

    for (const seat of rowSeats) {
      const seatEl = document.createElement('div');
      const cls = getSeatClass(seat);
      const clickable = isSeatClickable(seat);
      seatEl.className = `seat seat--${cls}${!clickable ? ' seat--disabled' : ''}`;
      seatEl.dataset.id = seat.id;
      seatEl.title = `${seat.id} — ${cls}`;
      seatEl.textContent = seat.seat_number;

      if (clickable) {
        seatEl.addEventListener('click', () => toggleSeatSelection(seat.id));
      }

      seatsEl.appendChild(seatEl);
    }

    rowEl.appendChild(seatsEl);
    fragment.appendChild(rowEl);
  }

  els.seatMap.innerHTML = '';
  els.seatMap.appendChild(fragment);
}

function updateSeatElement(seatId) {
  const seat = state.seats[seatId];
  if (!seat) return;

  const el = els.seatMap.querySelector(`[data-id="${seatId}"]`);
  if (!el) return;

  const cls = getSeatClass(seat);
  const clickable = isSeatClickable(seat);
  el.className = `seat seat--${cls}${!clickable ? ' seat--disabled' : ''}`;
  el.title = `${seat.id} — ${cls}`;

  // Re-bind click handler
  const newEl = el.cloneNode(true);
  if (clickable) {
    newEl.addEventListener('click', () => toggleSeatSelection(seatId));
  }
  el.replaceWith(newEl);
}

// ── Inventory ─────────────────────────────────────────────────────────────────
function updateInventory() {
  const seats = Object.values(state.seats);
  const available = seats.filter(s => s.status === 'available').length;
  const held = seats.filter(s => s.status === 'held').length;
  const booked = seats.filter(s => s.status === 'booked').length;
  const total = seats.length;

  els.invAvailable.textContent = available;
  els.invHeld.textContent = held;
  els.invBooked.textContent = booked;
  els.invTotal.textContent = total;
}

// ── Panel management ──────────────────────────────────────────────────────────
function showPanel(name) {
  state.panel = name;
  for (const [key, el] of Object.entries({
    select: els.panelSelect,
    hold: els.panelHold,
    booked: els.panelBooked,
    error: els.panelError,
  })) {
    el.classList.toggle('active', key === name);
  }
}

// ── Selection ─────────────────────────────────────────────────────────────────
function toggleSeatSelection(seatId) {
  if (state.panel !== 'select') return;
  const seat = state.seats[seatId];
  if (!seat || seat.status !== 'available') return;

  if (state.selectedIds.has(seatId)) {
    state.selectedIds.delete(seatId);
  } else {
    state.selectedIds.add(seatId);
  }

  updateSeatElement(seatId);
  updateSelectionUI();
}

function updateSelectionUI() {
  const count = state.selectedIds.size;
  els.selectedCount.textContent = count;
  els.btnHold.disabled = count === 0;
}

function clearSelection() {
  const prev = [...state.selectedIds];
  state.selectedIds.clear();
  for (const id of prev) updateSeatElement(id);
  updateSelectionUI();
}

// ── Hold countdown ────────────────────────────────────────────────────────────
function startCountdown() {
  if (state.countdownTimer) clearInterval(state.countdownTimer);

  function tick() {
    if (!state.currentHold) return;
    const remaining = Math.max(0, Math.floor((new Date(state.currentHold.expiresAt) - Date.now()) / 1000));
    const mins = Math.floor(remaining / 60).toString().padStart(2, '0');
    const secs = (remaining % 60).toString().padStart(2, '0');
    els.holdCountdown.textContent = `${mins}:${secs}`;
    els.holdCountdown.classList.toggle('urgent', remaining <= 10);

    if (remaining === 0) {
      clearInterval(state.countdownTimer);
      handleHoldExpired();
    }
  }

  tick();
  state.countdownTimer = setInterval(tick, 1000);
}

function stopCountdown() {
  if (state.countdownTimer) {
    clearInterval(state.countdownTimer);
    state.countdownTimer = null;
  }
}

function handleHoldExpired() {
  showToast('Your hold has expired. Seats are now available again.', 'error', 6000);
  state.currentHold = null;
  showPanel('select');
  renderSeatMap();
}

// ── API calls ─────────────────────────────────────────────────────────────────
async function requestHold() {
  const seatIds = [...state.selectedIds];
  if (seatIds.length === 0) return;

  els.btnHold.disabled = true;
  els.btnHold.textContent = 'Holding…';

  try {
    const resp = await fetch(`${API_BASE}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId: SESSION_ID }),
    });

    const data = await resp.json();

    if (resp.ok) {
      state.currentHold = {
        id: data.hold.id,
        seatIds: data.hold.seatIds,
        expiresAt: data.hold.expiresAt,
        ttlSeconds: data.hold.ttlSeconds,
      };

      // Update local seat state
      for (const id of seatIds) {
        if (state.seats[id]) {
          state.seats[id].status = 'held';
          state.seats[id].hold_id = data.hold.id;
          state.seats[id].hold_expires_at = data.hold.expiresAt;
        }
      }

      state.selectedIds.clear();
      els.holdSeatList.textContent = seatIds.join(', ');
      showPanel('hold');
      startCountdown();
      renderSeatMap();
      updateInventory();
      showToast(`Hold placed for ${seatIds.length} seat(s)!`, 'success');
    } else if (resp.status === 409) {
      const conflicting = data.conflictingSeats || [];
      showPanel('error');
      els.errorMessage.innerHTML = `
        <strong>Some seats are no longer available:</strong><br/>
        ${conflicting.join(', ')}<br/>
        <br/>Please select different seats.
      `;
      // Refresh seat map to show current state
      await loadSeats();
      clearSelection();
    } else {
      showToast(`Error: ${data.error}`, 'error');
    }
  } catch (err) {
    showToast('Network error. Please try again.', 'error');
    console.error('requestHold error:', err);
  } finally {
    els.btnHold.disabled = false;
    els.btnHold.textContent = 'Hold Selected Seats';
  }
}

async function confirmHold() {
  if (!state.currentHold) return;

  els.btnConfirm.disabled = true;
  els.btnConfirm.textContent = 'Confirming…';

  try {
    const resp = await fetch(`${API_BASE}/holds/${state.currentHold.id}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });

    const data = await resp.json();

    if (resp.ok) {
      const seatIds = data.booking.seatIds;
      state.currentBooking = { holdId: state.currentHold.id, seatIds };

      // Update local seat state
      for (const id of seatIds) {
        if (state.seats[id]) {
          state.seats[id].status = 'booked';
          state.seats[id].booked_by = SESSION_ID;
        }
      }

      stopCountdown();
      state.currentHold = null;
      els.bookedSeatList.textContent = seatIds.join(', ');
      showPanel('booked');
      renderSeatMap();
      updateInventory();
      showToast('Booking confirmed! 🎉', 'success', 6000);
    } else if (resp.status === 410) {
      showToast('Hold expired before confirmation. Please try again.', 'error', 6000);
      stopCountdown();
      state.currentHold = null;
      showPanel('select');
      await loadSeats();
    } else {
      showToast(`Confirmation failed: ${data.error}`, 'error');
    }
  } catch (err) {
    showToast('Network error. Please try again.', 'error');
    console.error('confirmHold error:', err);
  } finally {
    els.btnConfirm.disabled = false;
    els.btnConfirm.textContent = '✓ Confirm Booking';
  }
}

async function releaseHold() {
  if (!state.currentHold) return;

  els.btnRelease.disabled = true;
  els.btnRelease.textContent = 'Releasing…';

  try {
    const resp = await fetch(`${API_BASE}/holds/${state.currentHold.id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });

    if (resp.ok) {
      const data = await resp.json();
      const released = data.released || [];

      for (const id of released) {
        if (state.seats[id]) {
          state.seats[id].status = 'available';
          state.seats[id].hold_id = null;
          state.seats[id].hold_expires_at = null;
        }
      }

      stopCountdown();
      state.currentHold = null;
      showPanel('select');
      renderSeatMap();
      updateInventory();
      showToast('Hold released. Seats are available again.', 'info');
    } else {
      const data = await resp.json();
      showToast(`Release failed: ${data.error}`, 'error');
    }
  } catch (err) {
    showToast('Network error. Please try again.', 'error');
    console.error('releaseHold error:', err);
  } finally {
    els.btnRelease.disabled = false;
    els.btnRelease.textContent = '✗ Release Hold';
  }
}

// ── Load seats ────────────────────────────────────────────────────────────────
async function loadSeats() {
  try {
    const resp = await fetch(`${API_BASE}/seats`);
    const data = await resp.json();

    state.seats = {};
    for (const seat of data.seats) {
      state.seats[seat.id] = seat;
    }

    renderSeatMap();
    updateInventory();
  } catch (err) {
    els.seatMap.innerHTML = '<div class="loading">Failed to load seats. Retrying…</div>';
    console.error('loadSeats error:', err);
    setTimeout(loadSeats, 3000);
  }
}

// ── SSE ───────────────────────────────────────────────────────────────────────
function connectSSE() {
  els.connectionStatus.className = 'connection-status connecting';
  els.connectionStatus.title = 'Connecting…';

  const es = new EventSource(`${API_BASE}/stream`);

  es.addEventListener('open', () => {
    els.connectionStatus.className = 'connection-status connected';
    els.connectionStatus.title = 'Connected';
  });

  es.addEventListener('seat_update', (event) => {
    const { seats } = JSON.parse(event.data);
    let changed = false;

    for (const update of seats) {
      const existing = state.seats[update.id];
      if (!existing) continue;

      const oldStatus = existing.status;

      // Don't override our own hold/booking state from SSE
      // (we already updated it locally; SSE confirms it)
      existing.status = update.status;
      existing.hold_id = update.hold_id ?? null;
      existing.hold_expires_at = update.hold_expires_at ?? null;
      existing.booked_by = update.booked_by ?? null;

      // If a seat we're holding was released by expiry (from another tab/server sweep)
      if (state.currentHold && state.currentHold.seatIds.includes(update.id)) {
        if (update.status === 'available') {
          // Our hold was expired server-side
          stopCountdown();
          state.currentHold = null;
          showPanel('select');
          showToast('Your hold expired and seats were released.', 'error', 6000);
        }
      }

      changed = true;
    }

    if (changed) {
      // Re-render affected seats
      for (const update of seats) {
        updateSeatElement(update.id);
      }
      updateInventory();
    }
  });

  es.addEventListener('error', () => {
    els.connectionStatus.className = 'connection-status disconnected';
    els.connectionStatus.title = 'Disconnected — reconnecting…';
    es.close();
    setTimeout(connectSSE, 3000);
  });
}

// ── Event listeners ───────────────────────────────────────────────────────────
els.btnHold.addEventListener('click', requestHold);
els.btnConfirm.addEventListener('click', confirmHold);
els.btnRelease.addEventListener('click', releaseHold);

els.btnNewBooking.addEventListener('click', () => {
  state.currentBooking = null;
  showPanel('select');
  renderSeatMap();
});

els.btnErrorDismiss.addEventListener('click', () => {
  showPanel('select');
});

// ── Init ──────────────────────────────────────────────────────────────────────
function init() {
  // Display session ID (truncated)
  els.sessionDisplay.textContent = SESSION_ID.slice(0, 8) + '…';
  els.sessionDisplay.title = SESSION_ID;

  showPanel('select');
  loadSeats();
  connectSSE();
}

init();
