const API_BASE = '/api';

// Generate or retrieve a session ID
function getSessionId() {
  let sessionId = localStorage.getItem('seat-booking-session');
  if (!sessionId) {
    sessionId = 'session-' + Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
    localStorage.setItem('seat-booking-session', sessionId);
  }
  return sessionId;
}

const sessionId = getSessionId();

// State
let seats = [];
let selectedSeatIds = new Set();
let currentHold = null; // { id, expiresAt, seatIds }
let countdownTimer = null;

// DOM elements
const seatMapEl = document.getElementById('seat-map');
const selectionPanel = document.getElementById('selection-panel');
const selectedSeatsList = document.getElementById('selected-seats-list');
const btnHold = document.getElementById('btn-hold');
const holdPanel = document.getElementById('hold-panel');
const holdInfo = document.getElementById('hold-info');
const holdCountdown = document.getElementById('hold-countdown');
const btnConfirm = document.getElementById('btn-confirm');
const btnRelease = document.getElementById('btn-release');
const bookingPanel = document.getElementById('booking-panel');
const bookingInfo = document.getElementById('booking-info');
const btnNew = document.getElementById('btn-new');
const errorPanel = document.getElementById('error-panel');
const errorMessage = document.getElementById('error-message');
const btnDismissError = document.getElementById('btn-dismiss-error');
const sseStatus = document.getElementById('sse-status');
const countAvailable = document.getElementById('count-available');
const countHeld = document.getElementById('count-held');
const countBooked = document.getElementById('count-booked');
const countTotal = document.getElementById('count-total');

// Fetch seats
async function fetchSeats() {
  try {
    const res = await fetch(`${API_BASE}/seats`);
    const data = await res.json();
    seats = data.seats;
    renderSeatMap();
    updateInventory();
  } catch (err) {
    console.error('Failed to fetch seats:', err);
  }
}

// Update inventory counts
function updateInventory() {
  let available = 0, held = 0, booked = 0;
  for (const seat of seats) {
    if (seat.status === 'available') available++;
    else if (seat.status === 'held') held++;
    else if (seat.status === 'booked') booked++;
  }
  countAvailable.textContent = available;
  countHeld.textContent = held;
  countBooked.textContent = booked;
  countTotal.textContent = seats.length;
}

// Render the seat map
function renderSeatMap() {
  // Group seats by row
  const rows = {};
  for (const seat of seats) {
    if (!rows[seat.row_label]) rows[seat.row_label] = [];
    rows[seat.row_label].push(seat);
  }

  seatMapEl.innerHTML = '';

  const sortedRows = Object.keys(rows).sort();
  for (const rowLabel of sortedRows) {
    const rowSeats = rows[rowLabel].sort((a, b) => a.seat_number - b.seat_number);
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';

    const labelEl = document.createElement('span');
    labelEl.className = 'row-label';
    labelEl.textContent = rowLabel;
    rowEl.appendChild(labelEl);

    for (const seat of rowSeats) {
      const seatEl = document.createElement('div');
      seatEl.className = 'seat';
      seatEl.dataset.seatId = seat.id;
      seatEl.textContent = seat.seat_number;

      // Determine visual state
      let visualStatus = seat.status;
      if (selectedSeatIds.has(seat.id) && seat.status === 'available') {
        visualStatus = 'selected';
      } else if (seat.status === 'held' && currentHold && seat.hold_id === currentHold.id) {
        visualStatus = 'my-hold';
      }

      seatEl.classList.add(visualStatus);
      seatEl.title = `${seat.row_label}${seat.seat_number} - ${visualStatus}`;

      seatEl.addEventListener('click', () => handleSeatClick(seat));
      rowEl.appendChild(seatEl);
    }

    // Right label
    const labelElRight = document.createElement('span');
    labelElRight.className = 'row-label';
    labelElRight.textContent = rowLabel;
    rowEl.appendChild(labelElRight);

    seatMapEl.appendChild(rowEl);
  }
}

// Handle clicking a seat
function handleSeatClick(seat) {
  // Can't select if we have an active hold or booking
  if (currentHold) return;
  if (bookingPanel.classList.contains('hidden') === false) return;

  if (seat.status !== 'available') return;

  if (selectedSeatIds.has(seat.id)) {
    selectedSeatIds.delete(seat.id);
  } else {
    selectedSeatIds.add(seat.id);
  }

  renderSeatMap();
  updateSelectionPanel();
}

// Update selection panel
function updateSelectionPanel() {
  if (selectedSeatIds.size === 0) {
    selectionPanel.classList.add('hidden');
    return;
  }

  selectionPanel.classList.remove('hidden');
  const selectedSeats = seats.filter(s => selectedSeatIds.has(s.id));
  selectedSeatsList.textContent = selectedSeats
    .map(s => `${s.row_label}${s.seat_number}`)
    .join(', ');
}

// Hold seats
async function handleHold() {
  if (selectedSeatIds.size === 0) return;

  btnHold.disabled = true;
  btnHold.textContent = 'Holding...';

  try {
    const res = await fetch(`${API_BASE}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        seatIds: Array.from(selectedSeatIds),
        sessionId
      })
    });

    const data = await res.json();

    if (!res.ok) {
      // Show error
      if (res.status === 409 && data.conflictingSeatIds) {
        showError(`Some seats are no longer available: ${data.conflictingSeatIds.join(', ')}. Please select different seats.`);
        // Highlight conflicting seats
        for (const id of data.conflictingSeatIds) {
          const seatEl = document.querySelector(`.seat[data-seat-id="${id}"]`);
          if (seatEl) seatEl.classList.add('conflict');
        }
        selectedSeatIds.clear();
        // Refresh seats
        await fetchSeats();
      } else {
        showError(data.error || 'Failed to hold seats');
      }
      return;
    }

    // Success
    currentHold = {
      id: data.hold.id,
      expiresAt: new Date(data.hold.expiresAt),
      seatIds: data.hold.seatIds
    };

    selectedSeatIds.clear();
    selectionPanel.classList.add('hidden');
    showHoldPanel();
    renderSeatMap();
    updateInventory();

  } catch (err) {
    showError('Network error: ' + err.message);
  } finally {
    btnHold.disabled = false;
    btnHold.textContent = 'Hold Selected Seats';
  }
}

// Show hold panel with countdown
function showHoldPanel() {
  holdPanel.classList.remove('hidden');
  bookingPanel.classList.add('hidden');

  const seatLabels = currentHold.seatIds
    .map(id => {
      const seat = seats.find(s => s.id === id);
      return seat ? `${seat.row_label}${seat.seat_number}` : `#${id}`;
    })
    .join(', ');

  holdInfo.textContent = `Seats: ${seatLabels} | Hold ID: ${currentHold.id.substring(0, 8)}...`;

  startCountdown();
}

function startCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);

  function updateCountdown() {
    const now = new Date();
    const remaining = Math.max(0, Math.ceil((currentHold.expiresAt - now) / 1000));

    if (remaining <= 0) {
      holdCountdown.textContent = '⏰ Hold expired!';
      holdCountdown.style.color = '#ef4444';
      clearInterval(countdownTimer);
      countdownTimer = null;

      // Auto-clear after a moment
      setTimeout(() => {
        currentHold = null;
        holdPanel.classList.add('hidden');
        fetchSeats();
      }, 2000);
      return;
    }

    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    holdCountdown.textContent = `⏱️ Expires in: ${mins}:${secs.toString().padStart(2, '0')}`;
    holdCountdown.style.color = remaining <= 10 ? '#ef4444' : '#fbbf24';
  }

  updateCountdown();
  countdownTimer = setInterval(updateCountdown, 1000);
}

// Confirm hold
async function handleConfirm() {
  if (!currentHold) return;

  btnConfirm.disabled = true;
  btnConfirm.textContent = 'Confirming...';

  try {
    const res = await fetch(`${API_BASE}/holds/${currentHold.id}/confirm`, {
      method: 'POST'
    });

    const data = await res.json();

    if (!res.ok) {
      showError(data.error || 'Failed to confirm hold');
      if (res.status === 410) {
        // Hold expired or gone
        currentHold = null;
        holdPanel.classList.add('hidden');
        if (countdownTimer) {
          clearInterval(countdownTimer);
          countdownTimer = null;
        }
        await fetchSeats();
      }
      return;
    }

    // Success
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }

    holdPanel.classList.add('hidden');
    showBookingConfirmation(data.seats);

    // Update local state
    for (const updatedSeat of data.seats) {
      const idx = seats.findIndex(s => s.id === updatedSeat.id);
      if (idx !== -1) seats[idx] = updatedSeat;
    }
    renderSeatMap();
    updateInventory();

  } catch (err) {
    showError('Network error: ' + err.message);
  } finally {
    btnConfirm.disabled = false;
    btnConfirm.textContent = 'Confirm Booking';
  }
}

// Release hold
async function handleRelease() {
  if (!currentHold) return;

  btnRelease.disabled = true;
  btnRelease.textContent = 'Releasing...';

  try {
    const res = await fetch(`${API_BASE}/holds/${currentHold.id}`, {
      method: 'DELETE'
    });

    if (!res.ok) {
      const data = await res.json();
      showError(data.error || 'Failed to release hold');
      return;
    }

    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }

    currentHold = null;
    holdPanel.classList.add('hidden');
    await fetchSeats();

  } catch (err) {
    showError('Network error: ' + err.message);
  } finally {
    btnRelease.disabled = false;
    btnRelease.textContent = 'Release Hold';
  }
}

// Show booking confirmation
function showBookingConfirmation(bookedSeats) {
  bookingPanel.classList.remove('hidden');
  const seatLabels = bookedSeats
    .map(s => `${s.row_label}${s.seat_number}`)
    .join(', ');
  bookingInfo.textContent = `Seats booked: ${seatLabels}`;
  currentHold = null;
}

// Start new booking
function handleNewBooking() {
  bookingPanel.classList.add('hidden');
  selectedSeatIds.clear();
  fetchSeats();
}

// Show error
function showError(msg) {
  errorPanel.classList.remove('hidden');
  errorMessage.textContent = msg;
}

function dismissError() {
  errorPanel.classList.add('hidden');
}

// SSE connection
function connectSSE() {
  const evtSource = new EventSource(`${API_BASE}/stream`);

  evtSource.addEventListener('connected', () => {
    sseStatus.textContent = '● Connected';
    sseStatus.className = 'sse-connected';
  });

  evtSource.addEventListener('seat-update', (event) => {
    try {
      const updatedSeat = JSON.parse(event.data);
      const idx = seats.findIndex(s => s.id === updatedSeat.id);
      if (idx !== -1) {
        seats[idx] = { ...seats[idx], ...updatedSeat };
      }

      // If our hold's seats were released (expired by server), clear hold state
      if (currentHold && updatedSeat.status === 'available' && currentHold.seatIds.includes(updatedSeat.id)) {
        // Check if all our held seats are now available
        const allReleased = currentHold.seatIds.every(id => {
          const seat = seats.find(s => s.id === id);
          return seat && seat.status !== 'held';
        });
        if (allReleased) {
          if (countdownTimer) {
            clearInterval(countdownTimer);
            countdownTimer = null;
          }
          currentHold = null;
          holdPanel.classList.add('hidden');
        }
      }

      renderSeatMap();
      updateInventory();
    } catch (err) {
      console.error('Error processing SSE event:', err);
    }
  });

  evtSource.onerror = () => {
    sseStatus.textContent = '● Disconnected';
    sseStatus.className = 'sse-disconnected';
  };

  evtSource.onopen = () => {
    sseStatus.textContent = '● Connected';
    sseStatus.className = 'sse-connected';
  };

  return evtSource;
}

// Event listeners
btnHold.addEventListener('click', handleHold);
btnConfirm.addEventListener('click', handleConfirm);
btnRelease.addEventListener('click', handleRelease);
btnNew.addEventListener('click', handleNewBooking);
btnDismissError.addEventListener('click', dismissError);

// Initialize
fetchSeats();
connectSSE();
