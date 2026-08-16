import { v4 as uuidv4 } from 'uuid';

const sessionId = uuidv4();
let seats = [];
let selectedSeats = new Set();
let currentHold = null;
let timerInterval = null;

const seatMapEl = document.getElementById('seat-map');
const holdBtn = document.getElementById('hold-btn');
const confirmBtn = document.getElementById('confirm-btn');
const releaseBtn = document.getElementById('release-btn');
const timerEl = document.getElementById('timer');
const messagesEl = document.getElementById('messages');

function showMessage(msg) {
  messagesEl.textContent = msg;
  setTimeout(() => {
    if (messagesEl.textContent === msg) messagesEl.textContent = '';
  }, 5000);
}

async function fetchSeats() {
  const res = await fetch('/api/seats');
  seats = await res.json();
  renderSeats();
}

function renderSeats() {
  seatMapEl.innerHTML = '';
  const rows = {};
  seats.forEach(seat => {
    if (!rows[seat.row_label]) rows[seat.row_label] = [];
    rows[seat.row_label].push(seat);
  });

  for (const [rowLabel, rowSeats] of Object.entries(rows)) {
    const rowEl = document.createElement('div');
    rowEl.className = 'row';
    
    const labelEl = document.createElement('div');
    labelEl.className = 'row-label';
    labelEl.textContent = rowLabel;
    rowEl.appendChild(labelEl);

    rowSeats.forEach(seat => {
      const seatEl = document.createElement('div');
      seatEl.className = `seat ${seat.status}`;
      seatEl.textContent = seat.seat_number;
      
      if (seat.status === 'available' && selectedSeats.has(seat.id)) {
        seatEl.classList.add('selected');
      }
      
      if (currentHold && currentHold.seatIds.includes(seat.id)) {
        seatEl.classList.add('held-by-me');
      }

      seatEl.addEventListener('click', () => toggleSeat(seat));
      rowEl.appendChild(seatEl);
    });

    seatMapEl.appendChild(rowEl);
  }
  updateControls();
}

function toggleSeat(seat) {
  if (currentHold) return; // Cannot select new seats while holding
  if (seat.status !== 'available') return;

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

function startTimer(expiresAt) {
  clearInterval(timerInterval);
  const updateTimer = () => {
    const now = new Date();
    const exp = new Date(expiresAt);
    const diff = Math.max(0, Math.floor((exp - now) / 1000));
    if (diff > 0) {
      timerEl.textContent = `Hold expires in ${diff}s`;
    } else {
      timerEl.textContent = 'Hold expired';
      clearInterval(timerInterval);
      currentHold = null;
      selectedSeats.clear();
      updateControls();
      fetchSeats();
    }
  };
  updateTimer();
  timerInterval = setInterval(updateTimer, 1000);
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
      startTimer(data.expiresAt);
      // Local update before SSE
      seats.forEach(s => {
        if (seatIds.includes(s.id)) s.status = 'held';
      });
      renderSeats();
    } else if (res.status === 409) {
      const data = await res.json();
      showMessage(`Seats unavailable: ${data.conflictingSeats.join(', ')}`);
      selectedSeats.clear();
      fetchSeats();
    } else {
      showMessage('Failed to hold seats');
    }
  } catch (err) {
    showMessage('Network error');
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
      clearInterval(timerInterval);
      timerEl.textContent = 'Seats booked!';
      const seatIds = currentHold.seatIds;
      currentHold = null;
      seats.forEach(s => {
        if (seatIds.includes(s.id)) s.status = 'booked';
      });
      renderSeats();
    } else {
      const data = await res.json();
      showMessage(data.error || 'Failed to confirm hold');
      clearInterval(timerInterval);
      timerEl.textContent = '';
      currentHold = null;
      fetchSeats();
    }
  } catch (err) {
    showMessage('Network error');
  }
});

releaseBtn.addEventListener('click', async () => {
  if (!currentHold) return;
  try {
    const res = await fetch(`/api/holds/${currentHold.holdId}`, {
      method: 'DELETE'
    });
    
    if (res.ok) {
      clearInterval(timerInterval);
      timerEl.textContent = '';
      const seatIds = currentHold.seatIds;
      currentHold = null;
      seats.forEach(s => {
        if (seatIds.includes(s.id)) s.status = 'available';
      });
      renderSeats();
    }
  } catch (err) {
    showMessage('Network error');
  }
});

function setupSSE() {
  const evtSource = new EventSource('/api/stream');
  evtSource.addEventListener('seats_updated', (e) => {
    const data = JSON.parse(e.data);
    let changed = false;
    seats.forEach(s => {
      if (data.seats.includes(s.id)) {
        s.status = data.status;
        changed = true;
      }
    });
    if (changed) renderSeats();
  });
}

fetchSeats();
setupSSE();
