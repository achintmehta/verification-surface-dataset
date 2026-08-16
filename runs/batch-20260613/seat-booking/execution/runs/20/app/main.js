const sessionId = Math.random().toString(36).substr(2, 9);
let seats = {};
let selectedSeats = new Set();
let currentHold = null;
let timerInterval = null;

const seatMapEl = document.getElementById('seat-map');
const holdBtn = document.getElementById('hold-btn');
const confirmBtn = document.getElementById('confirm-btn');
const releaseBtn = document.getElementById('release-btn');
const timerEl = document.getElementById('timer');
const messagesEl = document.getElementById('messages');

function renderSeats() {
  seatMapEl.innerHTML = '';
  const sortedIds = Object.keys(seats).sort((a, b) => {
    const rowA = a.match(/[A-Z]+/)[0];
    const rowB = b.match(/[A-Z]+/)[0];
    if (rowA !== rowB) return rowA.localeCompare(rowB);
    const numA = parseInt(a.match(/\d+/)[0]);
    const numB = parseInt(b.match(/\d+/)[0]);
    return numA - numB;
  });

  sortedIds.forEach(id => {
    const seat = seats[id];
    const el = document.createElement('div');
    el.className = 'seat';
    el.textContent = id;

    if (seat.status === 'available') {
      if (selectedSeats.has(id)) {
        el.classList.add('selected');
      } else {
        el.classList.add('available');
      }
      el.addEventListener('click', () => toggleSelection(id));
    } else if (seat.status === 'held') {
      if (currentHold && currentHold.seats.includes(id)) {
        el.classList.add('held-by-me');
      } else {
        el.classList.add('held');
      }
    } else if (seat.status === 'booked') {
      el.classList.add('booked');
    }

    seatMapEl.appendChild(el);
  });

  updateControls();
}

function toggleSelection(id) {
  if (currentHold) return; // Cannot select new seats while holding
  if (selectedSeats.has(id)) {
    selectedSeats.delete(id);
  } else {
    selectedSeats.add(id);
  }
  renderSeats();
}

function updateControls() {
  holdBtn.disabled = selectedSeats.size === 0 || currentHold !== null;
  confirmBtn.disabled = currentHold === null;
  releaseBtn.disabled = currentHold === null;
}

function showMessage(msg) {
  messagesEl.textContent = msg;
  setTimeout(() => { messagesEl.textContent = ''; }, 5000);
}

async function fetchSeats() {
  const res = await fetch('/api/seats');
  const data = await res.json();
  data.forEach(seat => {
    seats[seat.id] = seat;
  });
  renderSeats();
}

function setupSSE() {
  const evtSource = new EventSource('/api/stream');
  evtSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'seats_updated') {
      data.seats.forEach(update => {
        if (seats[update.id]) {
          seats[update.id].status = update.status;
        }
      });
      
      // If our held seats were released (e.g. expired)
      if (currentHold) {
        const ourSeatsBecameAvailable = currentHold.seats.some(id => seats[id] && seats[id].status === 'available');
        if (ourSeatsBecameAvailable) {
          clearHoldState();
          showMessage('Your hold expired.');
        }
      }

      renderSeats();
    }
  };
}

function startTimer(expiresAt) {
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    const remaining = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
    timerEl.textContent = `Hold expires in ${remaining}s`;
    if (remaining === 0) {
      clearInterval(timerInterval);
      timerEl.textContent = '';
    }
  }, 1000);
}

function clearHoldState() {
  currentHold = null;
  selectedSeats.clear();
  clearInterval(timerInterval);
  timerEl.textContent = '';
  updateControls();
}

holdBtn.addEventListener('click', async () => {
  const seatIds = Array.from(selectedSeats);
  const res = await fetch('/api/holds', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seatIds, sessionId })
  });

  if (res.ok) {
    const data = await res.json();
    currentHold = data;
    selectedSeats.clear();
    startTimer(data.expiresAt);
    // Optimistically update
    data.seats.forEach(id => {
      if (seats[id]) seats[id].status = 'held';
    });
    renderSeats();
  } else if (res.status === 409) {
    const data = await res.json();
    showMessage(`Conflict: Seats ${data.conflicts.join(', ')} are no longer available.`);
    selectedSeats.clear();
    await fetchSeats();
  } else {
    showMessage('Error requesting hold.');
  }
});

confirmBtn.addEventListener('click', async () => {
  if (!currentHold) return;
  const res = await fetch(`/api/holds/${currentHold.holdId}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId })
  });

  if (res.ok) {
    const data = await res.json();
    data.seats.forEach(id => {
      if (seats[id]) seats[id].status = 'booked';
    });
    clearHoldState();
    renderSeats();
    showMessage('Booking confirmed!');
  } else {
    const data = await res.json();
    showMessage(data.error || 'Error confirming booking.');
    clearHoldState();
    await fetchSeats();
  }
});

releaseBtn.addEventListener('click', async () => {
  if (!currentHold) return;
  const res = await fetch(`/api/holds/${currentHold.holdId}`, {
    method: 'DELETE'
  });

  if (res.ok) {
    clearHoldState();
    await fetchSeats();
  } else {
    showMessage('Error releasing hold.');
  }
});

fetchSeats();
setupSSE();
