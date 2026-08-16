import { v4 as uuidv4 } from 'uuid';

const sessionId = uuidv4();
let seats = [];
let selectedSeatIds = new Set();
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
  renderSeatMap();
}

function renderSeatMap() {
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
      if (seat.status === 'available' && selectedSeatIds.has(seat.id)) {
        seatEl.classList.add('selected');
      }
      if (currentHold && currentHold.seats.some(s => s.id === seat.id)) {
        seatEl.classList.add('my-hold');
      }
      seatEl.textContent = seat.seat_number;
      
      seatEl.addEventListener('click', () => {
        if (currentHold) return; // Cannot select while holding
        if (seat.status !== 'available') return;
        
        if (selectedSeatIds.has(seat.id)) {
          selectedSeatIds.delete(seat.id);
        } else {
          selectedSeatIds.add(seat.id);
        }
        renderSeatMap();
        updateControls();
      });

      rowEl.appendChild(seatEl);
    });

    seatMapEl.appendChild(rowEl);
  }
}

function updateControls() {
  if (currentHold) {
    holdBtn.disabled = true;
    confirmBtn.disabled = false;
    releaseBtn.disabled = false;
  } else {
    holdBtn.disabled = selectedSeatIds.size === 0;
    confirmBtn.disabled = true;
    releaseBtn.disabled = true;
  }
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
      selectedSeatIds.clear();
      updateControls();
      renderSeatMap();
    }
  };
  updateTimer();
  timerInterval = setInterval(updateTimer, 1000);
}

holdBtn.addEventListener('click', async () => {
  if (selectedSeatIds.size === 0) return;
  
  const res = await fetch('/api/holds', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      seatIds: Array.from(selectedSeatIds),
      sessionId
    })
  });

  const data = await res.json();
  if (res.ok) {
    currentHold = data;
    selectedSeatIds.clear();
    startTimer(data.expiresAt);
    updateControls();
    renderSeatMap();
  } else {
    showMessage(data.error || 'Failed to hold seats');
    if (data.conflicts) {
      data.conflicts.forEach(id => selectedSeatIds.delete(id));
    }
    await fetchSeats();
  }
});

confirmBtn.addEventListener('click', async () => {
  if (!currentHold) return;

  const res = await fetch(`/api/holds/${currentHold.holdId}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId })
  });

  const data = await res.json();
  if (res.ok) {
    clearInterval(timerInterval);
    timerEl.textContent = 'Seats booked!';
    currentHold = null;
    updateControls();
    await fetchSeats();
  } else {
    showMessage(data.error || 'Failed to confirm hold');
    clearInterval(timerInterval);
    timerEl.textContent = '';
    currentHold = null;
    updateControls();
    await fetchSeats();
  }
});

releaseBtn.addEventListener('click', async () => {
  if (!currentHold) return;

  const res = await fetch(`/api/holds/${currentHold.holdId}`, {
    method: 'DELETE'
  });

  if (res.ok) {
    clearInterval(timerInterval);
    timerEl.textContent = '';
    currentHold = null;
    updateControls();
    await fetchSeats();
  } else {
    showMessage('Failed to release hold');
  }
});

function setupSSE() {
  const evtSource = new EventSource('/api/stream');
  evtSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'seats_updated') {
      let changed = false;
      data.seats.forEach(updatedSeat => {
        const seat = seats.find(s => s.id === updatedSeat.id);
        if (seat) {
          seat.status = updatedSeat.status;
          changed = true;
        }
      });
      if (changed) {
        renderSeatMap();
      }
    }
  };
}

fetchSeats().then(() => {
  setupSSE();
});
