const sessionId = Math.random().toString(36).substring(2, 15);
let seats = [];
let selectedSeats = new Set();
let currentHold = null; // { holdId, expiresAt, seats }
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
    const div = document.createElement('div');
    div.className = `seat ${seat.status}`;
    div.textContent = seat.id;
    
    if (currentHold && currentHold.seats.includes(seat.id)) {
      div.classList.add('my-hold');
    } else if (selectedSeats.has(seat.id)) {
      div.classList.add('selected');
    }

    div.addEventListener('click', () => toggleSeat(seat));
    seatMapEl.appendChild(div);
  });
  updateControls();
}

function toggleSeat(seat) {
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
  setTimeout(() => { messageEl.textContent = ''; }, 3000);
}

holdBtn.addEventListener('click', async () => {
  holdBtn.disabled = true;
  const seatIds = Array.from(selectedSeats);
  const res = await fetch('/api/holds', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seatIds, sessionId })
  });

  if (res.ok) {
    currentHold = await res.json();
    selectedSeats.clear();
    startCountdown();
    renderSeats();
    showMessage('Hold successful');
  } else if (res.status === 409) {
    const data = await res.json();
    showMessage(`Conflict: ${data.conflicts.join(', ')} already taken`);
    selectedSeats.clear();
    fetchSeats();
  } else {
    showMessage('Hold failed');
    holdBtn.disabled = false;
  }
});

confirmBtn.addEventListener('click', async () => {
  if (!currentHold) return;
  confirmBtn.disabled = true;
  const res = await fetch(`/api/holds/${currentHold.holdId}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId })
  });

  if (res.ok) {
    showMessage('Booking confirmed!');
    stopCountdown();
    currentHold = null;
    fetchSeats();
  } else {
    const data = await res.json();
    showMessage(`Confirm failed: ${data.error}`);
    stopCountdown();
    currentHold = null;
    fetchSeats();
  }
});

releaseBtn.addEventListener('click', async () => {
  if (!currentHold) return;
  releaseBtn.disabled = true;
  const res = await fetch(`/api/holds/${currentHold.holdId}`, {
    method: 'DELETE'
  });

  if (res.ok) {
    showMessage('Hold released');
    stopCountdown();
    currentHold = null;
    fetchSeats();
  } else {
    releaseBtn.disabled = false;
  }
});

function startCountdown() {
  stopCountdown();
  countdownInterval = setInterval(() => {
    if (!currentHold) {
      stopCountdown();
      return;
    }
    const remaining = Math.max(0, currentHold.expiresAt - Date.now());
    if (remaining === 0) {
      stopCountdown();
      currentHold = null;
      showMessage('Hold expired');
      fetchSeats();
    } else {
      countdownEl.textContent = `Hold expires in ${Math.ceil(remaining / 1000)}s`;
    }
  }, 1000);
}

function stopCountdown() {
  if (countdownInterval) clearInterval(countdownInterval);
  countdownInterval = null;
  countdownEl.textContent = '';
}

// SSE
const evtSource = new EventSource('/api/stream');
evtSource.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.type === 'seats_updated') {
    let changed = false;
    data.seats.forEach(update => {
      const seat = seats.find(s => s.id === update.id);
      if (seat && seat.status !== update.status) {
        seat.status = update.status;
        if (seat.status !== 'available' && selectedSeats.has(seat.id)) {
          selectedSeats.delete(seat.id);
        }
        changed = true;
      }
    });
    if (changed) renderSeats();
  }
};

fetchSeats();
