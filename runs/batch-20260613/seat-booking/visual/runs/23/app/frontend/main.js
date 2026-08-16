// ---- State ----
const API_BASE = '/api';
let seats = [];           // all seats from server
let selectedSeatIds = new Set();
let currentHold = null;   // { holdId, seatIds, expiresAt }
let sessionId = getOrCreateSessionId();
let holdTtlSeconds = 30;
let timerInterval = null;

// ---- Session ----
function getOrCreateSessionId() {
  let id = localStorage.getItem('seatBookingSessionId');
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
    localStorage.setItem('seatBookingSessionId', id);
  }
  return id;
}

// ---- DOM refs ----
const seatMapEl = document.getElementById('seat-map');
const btnHold = document.getElementById('btn-hold');
const btnConfirm = document.getElementById('btn-confirm');
const btnRelease = document.getElementById('btn-release');
const selectionInfo = document.getElementById('selection-info');
const holdTimerEl = document.getElementById('hold-timer');
const timerValueEl = document.getElementById('timer-value');
const notificationsEl = document.getElementById('notifications');
const sseStatusEl = document.getElementById('sse-status');
const sseTextEl = document.getElementById('sse-text');
const inventoryEl = document.getElementById('inventory');

// ---- Notifications ----
function notify(message, type = 'info') {
  const el = document.createElement('div');
  el.className = `notification ${type}`;
  el.textContent = message;
  notificationsEl.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.3s';
    setTimeout(() => el.remove(), 300);
  }, 3500);
}

// ---- Inventory ----
function updateInventory() {
  let available = 0, held = 0, booked = 0;
  for (const seat of seats) {
    if (seat.status === 'available') available++;
    else if (seat.status === 'held') held++;
    else if (seat.status === 'booked') booked++;
  }
  const total = seats.length;
  inventoryEl.querySelector('.available-count strong').textContent = available;
  inventoryEl.querySelector('.held-count strong').textContent = held;
  inventoryEl.querySelector('.booked-count strong').textContent = booked;
  inventoryEl.querySelector('.total-count strong').textContent = total;
}

// ---- Render Seat Map ----
function renderSeatMap() {
  // Group by row
  const rows = {};
  for (const seat of seats) {
    if (!rows[seat.row_label]) rows[seat.row_label] = [];
    rows[seat.row_label].push(seat);
  }

  seatMapEl.innerHTML = '';

  const sortedRowLabels = Object.keys(rows).sort();

  for (const rowLabel of sortedRowLabels) {
    const rowSeats = rows[rowLabel].sort((a, b) => a.seat_number - b.seat_number);

    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';

    const labelEl = document.createElement('div');
    labelEl.className = 'row-label';
    labelEl.textContent = rowLabel;
    rowEl.appendChild(labelEl);

    for (const seat of rowSeats) {
      const seatEl = document.createElement('div');
      seatEl.dataset.seatId = seat.id;

      let className = 'seat';
      const isMyHold = seat.status === 'held' && seat.session_id === sessionId;
      const isSelected = selectedSeatIds.has(seat.id);

      if (seat.status === 'booked') {
        className += ' booked';
      } else if (isSelected) {
        className += ' selected';
      } else if (isMyHold) {
        className += ' held-mine';
      } else if (seat.status === 'held') {
        className += ' held';
      } else {
        className += ' available';
      }

      seatEl.className = className;
      seatEl.textContent = seat.seat_number;
      seatEl.title = `${seat.row_label}${seat.seat_number} - ${seat.status}${isMyHold ? ' (yours)' : ''}`;

      seatEl.addEventListener('click', () => handleSeatClick(seat));

      rowEl.appendChild(seatEl);
    }

    // Right label
    const labelElR = document.createElement('div');
    labelElR.className = 'row-label';
    labelElR.textContent = rowLabel;
    rowEl.appendChild(labelElR);

    seatMapEl.appendChild(rowEl);
  }

  updateInventory();
  updateActionButtons();
}

// ---- Seat Click ----
function handleSeatClick(seat) {
  // Can't select if we have an active hold
  if (currentHold) return;

  // Can only select available seats
  if (seat.status !== 'available') return;

  if (selectedSeatIds.has(seat.id)) {
    selectedSeatIds.delete(seat.id);
  } else {
    selectedSeatIds.add(seat.id);
  }

  renderSeatMap();
}

// ---- Action Buttons ----
function updateActionButtons() {
  const hasSelection = selectedSeatIds.size > 0;
  const hasHold = currentHold !== null;

  btnHold.disabled = !hasSelection || hasHold;
  btnConfirm.disabled = !hasHold;
  btnRelease.disabled = !hasHold;

  if (hasHold) {
    const seatLabels = currentHold.seatIds.map(id => {
      const s = seats.find(seat => seat.id === id);
      return s ? `${s.row_label}${s.seat_number}` : id;
    });
    selectionInfo.textContent = `Holding: ${seatLabels.join(', ')}`;
  } else if (hasSelection) {
    const seatLabels = [...selectedSeatIds].map(id => {
      const s = seats.find(seat => seat.id === id);
      return s ? `${s.row_label}${s.seat_number}` : id;
    });
    selectionInfo.textContent = `Selected: ${seatLabels.join(', ')}`;
  } else {
    selectionInfo.textContent = 'Select seats to hold them';
  }
}

// ---- Hold Timer ----
function startHoldTimer() {
  if (!currentHold) return;
  holdTimerEl.style.display = 'block';
  updateTimer();
  timerInterval = setInterval(updateTimer, 250);
}

function updateTimer() {
  if (!currentHold) {
    stopHoldTimer();
    return;
  }

  const remaining = Math.max(0, Math.ceil((new Date(currentHold.expiresAt).getTime() - Date.now()) / 1000));
  timerValueEl.textContent = remaining;

  if (remaining <= 5) {
    timerValueEl.style.color = '#e74c3c';
  } else {
    timerValueEl.style.color = '';
  }

  if (remaining <= 0) {
    // Hold expired on client side
    notify('Your hold has expired', 'error');
    currentHold = null;
    selectedSeatIds.clear();
    stopHoldTimer();
    fetchSeats(); // refresh
  }
}

function stopHoldTimer() {
  holdTimerEl.style.display = 'none';
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

// ---- API Calls ----
async function fetchSeats() {
  try {
    const resp = await fetch(`${API_BASE}/seats`);
    const data = await resp.json();
    seats = data.seats;
    holdTtlSeconds = data.holdTtlSeconds || 30;
    renderSeatMap();
  } catch (err) {
    console.error('Failed to fetch seats:', err);
    notify('Failed to load seats', 'error');
  }
}

async function requestHold() {
  const seatIds = [...selectedSeatIds];
  if (seatIds.length === 0) return;

  btnHold.disabled = true;

  try {
    const resp = await fetch(`${API_BASE}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId }),
    });

    if (resp.status === 409) {
      const data = await resp.json();
      notify(`Seats unavailable: ${data.conflicts.map(c => `${c.row_label}${c.seat_number}`).join(', ')}`, 'error');

      // Highlight conflicts
      for (const conflict of data.conflicts) {
        const el = seatMapEl.querySelector(`[data-seat-id="${conflict.id}"]`);
        if (el) {
          el.classList.add('conflict');
          setTimeout(() => el.classList.remove('conflict'), 500);
        }
      }

      selectedSeatIds.clear();
      await fetchSeats();
      return;
    }

    if (!resp.ok) {
      const data = await resp.json();
      notify(data.error || 'Failed to place hold', 'error');
      return;
    }

    const data = await resp.json();
    currentHold = {
      holdId: data.holdId,
      seatIds: data.seatIds,
      expiresAt: data.expiresAt,
    };
    selectedSeatIds.clear();

    // Update local seats
    for (const updatedSeat of data.seats) {
      const idx = seats.findIndex(s => s.id === updatedSeat.id);
      if (idx !== -1) seats[idx] = updatedSeat;
    }

    renderSeatMap();
    startHoldTimer();
    notify(`Held ${data.seatIds.length} seat(s)! Confirm within ${holdTtlSeconds}s`, 'success');
  } catch (err) {
    console.error('Hold error:', err);
    notify('Failed to place hold', 'error');
  }
}

async function confirmHold() {
  if (!currentHold) return;

  btnConfirm.disabled = true;

  try {
    const resp = await fetch(`${API_BASE}/holds/${currentHold.holdId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!resp.ok) {
      const data = await resp.json();
      notify(data.error || 'Failed to confirm', 'error');
      currentHold = null;
      stopHoldTimer();
      await fetchSeats();
      return;
    }

    const data = await resp.json();

    // Update local seats
    for (const updatedSeat of data.seats) {
      const idx = seats.findIndex(s => s.id === updatedSeat.id);
      if (idx !== -1) seats[idx] = updatedSeat;
    }

    currentHold = null;
    stopHoldTimer();
    renderSeatMap();
    notify('Booking confirmed! 🎉', 'success');
  } catch (err) {
    console.error('Confirm error:', err);
    notify('Failed to confirm booking', 'error');
  }
}

async function releaseHold() {
  if (!currentHold) return;

  btnRelease.disabled = true;

  try {
    const resp = await fetch(`${API_BASE}/holds/${currentHold.holdId}`, {
      method: 'DELETE',
    });

    if (!resp.ok) {
      const data = await resp.json();
      notify(data.error || 'Failed to release', 'error');
    } else {
      notify('Hold released', 'info');
    }

    currentHold = null;
    selectedSeatIds.clear();
    stopHoldTimer();
    await fetchSeats();
  } catch (err) {
    console.error('Release error:', err);
    notify('Failed to release hold', 'error');
  }
}

// ---- SSE ----
function connectSSE() {
  const evtSource = new EventSource(`${API_BASE}/stream`);

  evtSource.onopen = () => {
    sseStatusEl.className = 'sse-status connected';
    sseTextEl.textContent = 'Live';
  };

  evtSource.addEventListener('seat-update', (e) => {
    try {
      const updatedSeat = JSON.parse(e.data);
      const idx = seats.findIndex(s => s.id === updatedSeat.id);
      if (idx !== -1) {
        seats[idx] = { ...seats[idx], ...updatedSeat };
      }

      // If our held seat got released/booked by another mechanism, update hold state
      if (currentHold && currentHold.seatIds.includes(updatedSeat.id)) {
        if (updatedSeat.status === 'available' && updatedSeat.session_id !== sessionId) {
          // Our hold was expired/released server-side
          const allExpired = currentHold.seatIds.every(sid => {
            const s = seats.find(seat => seat.id === sid);
            return s && (s.status === 'available' || (s.status !== 'held' || s.session_id !== sessionId));
          });
          if (allExpired) {
            currentHold = null;
            selectedSeatIds.clear();
            stopHoldTimer();
            notify('Your hold has expired', 'error');
          }
        }
      }

      renderSeatMap();
    } catch (err) {
      console.error('SSE parse error:', err);
    }
  });

  evtSource.onerror = () => {
    sseStatusEl.className = 'sse-status disconnected';
    sseTextEl.textContent = 'Reconnecting...';
  };
}

// ---- Event Listeners ----
btnHold.addEventListener('click', requestHold);
btnConfirm.addEventListener('click', confirmHold);
btnRelease.addEventListener('click', releaseHold);

// ---- Init ----
async function init() {
  await fetchSeats();
  connectSSE();
}

init();
