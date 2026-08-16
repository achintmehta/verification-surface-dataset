const sessionId = crypto.randomUUID();
let seats = [];
let selectedSeats = new Set();
let currentHold = null;
let countdownInterval = null;

const seatMapEl = document.getElementById('seat-map');
const holdBtn = document.getElementById('hold-btn');
const confirmBtn = document.getElementById('confirm-btn');
const releaseBtn = document.getElementById('release-btn');
const messageEl = document.getElementById('message');
const countdownEl = document.getElementById('countdown');

async function fetchSeats() {
  const res = await fetch('/api/seats');
  seats = await res.json();
  renderSeats();
}

function renderSeats() {
  seatMapEl.innerHTML = '';
  seats.forEach(seat => {
    const seatEl = document.createElement('div');
    seatEl.className = `seat ${seat.status}`;
    seatEl.textContent = seat.id;
    
    if (currentHold && currentHold.seatIds.includes(seat.id)) {
      seatEl.classList.add('my-hold');
    } else if (selectedSeats.has(seat.id)) {
      seatEl.classList.add('selected');
    }

    seatEl.addEventListener('click', () => toggleSeatSelection(seat));
    seatMapEl.appendChild(seatEl);
  });
  updateControls();
}

function toggleSeatSelection(seat) {
  if (seat.status !== 'available') return;
  if (currentHold) return; // Cannot select more if already holding

  if (selectedSeats.has(seat.id)) {
    selectedSeats.delete(seat.id);
  } else {
    selectedSeats.add(seat.id);
  }
  renderSeats();
}

function updateControls() {
  holdBtn.disabled = selectedSeats.size === 0 || currentHold !== null;
  confirmBtn.disabled = currentHold === null;
  releaseBtn.disabled = currentHold === null;
}

function showMessage(msg) {
  messageEl.textContent = msg;
  setTimeout(() => { messageEl.textContent = ''; }, 5000);
}

function startCountdown(expiresAt) {
  clearInterval(countdownInterval);
  countdownInterval = setInterval(() => {
    const remaining = Math.max(0, expiresAt - Date.now());
    if (remaining === 0) {
      clearInterval(countdownInterval);
      countdownEl.textContent = '';
      currentHold = null;
      selectedSeats.clear();
      showMessage('Hold expired');
      renderSeats();
    } else {
      countdownEl.textContent = `Hold expires in ${Math.ceil(remaining / 1000)}s`;
    }
  }, 1000);
}

function stopCountdown() {
  clearInterval(countdownInterval);
  countdownEl.textContent = '';
}

holdBtn.addEventListener('click', async () => {
  const seatIds = Array.from(selectedSeats);
  try {
    const res = await fetch('/api/holds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId })
    });

    if (res.ok) {
      const data = await res.json();
      currentHold = data;
      selectedSeats.clear();
      startCountdown(data.expiresAt);
      // Update local state optimistically
      seats.forEach(s => {
        if (seatIds.includes(s.id)) s.status = 'held';
      });
      renderSeats();
    } else if (res.status === 409) {
      const data = await res.json();
      showMessage(`Seats unavailable: ${data.conflicts.join(', ')}`);
      selectedSeats.clear();
      await fetchSeats();
    } else {
      showMessage('Failed to hold seats');
    }
  } catch (err) {
    showMessage('Error holding seats');
  }
});

confirmBtn.addEventListener('click', async () => {
  if (!currentHold) return;
  try {
    const res = await fetch(`/api/holds/${currentHold.holdId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    });

    if (res.ok) {
      showMessage('Booking confirmed!');
      stopCountdown();
      // Update local state optimistically
      seats.forEach(s => {
        if (currentHold.seatIds.includes(s.id)) s.status = 'booked';
      });
      currentHold = null;
      renderSeats();
    } else {
      const data = await res.json();
      showMessage(data.error || 'Failed to confirm booking');
      stopCountdown();
      currentHold = null;
      await fetchSeats();
    }
  } catch (err) {
    showMessage('Error confirming booking');
  }
});

releaseBtn.addEventListener('click', async () => {
  if (!currentHold) return;
  try {
    const res = await fetch(`/api/holds/${currentHold.holdId}`, {
      method: 'DELETE'
    });

    if (res.ok) {
      stopCountdown();
      // Update local state optimistically
      seats.forEach(s => {
        if (currentHold.seatIds.includes(s.id)) s.status = 'available';
      });
      currentHold = null;
      renderSeats();
    }
  } catch (err) {
    showMessage('Error releasing hold');
  }
});

// SSE Connection
const evtSource = new EventSource('/api/stream');
evtSource.addEventListener('seats_updated', (e) => {
  const data = JSON.parse(e.data);
  let changed = false;
  seats.forEach(seat => {
    if (data.seats.includes(seat.id)) {
      seat.status = data.status;
      changed = true;

      if (seat.status !== 'available' && selectedSeats.has(seat.id)) {
        selectedSeats.delete(seat.id);
      }

      // If our held seats were released or booked by someone else
      if (currentHold && currentHold.seatIds.includes(seat.id) && (data.status === 'available' || data.status === 'booked')) {
        stopCountdown();
        currentHold = null;
        selectedSeats.clear();
        showMessage(data.status === 'booked' ? 'Seat was booked by someone else' : 'Hold expired');
      }
    }
  });
  if (changed) renderSeats();
});

fetchSeats();
