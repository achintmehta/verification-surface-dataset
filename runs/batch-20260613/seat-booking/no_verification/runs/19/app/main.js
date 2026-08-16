import { v4 as uuidv4 } from 'uuid';

const sessionId = uuidv4();
let currentHoldId = null;
let holdExpiresAt = null;
let timerInterval = null;

const seatMapEl = document.getElementById('seat-map');
const holdBtn = document.getElementById('hold-btn');
const confirmBtn = document.getElementById('confirm-btn');
const releaseBtn = document.getElementById('release-btn');
const timerEl = document.getElementById('timer');
const messagesEl = document.getElementById('messages');

let seats = {};
let selectedSeats = new Set();

async function fetchSeats() {
  const res = await fetch('/api/seats');
  const data = await res.json();
  data.forEach(seat => {
    seats[seat.id] = seat;
  });
  renderSeats();
}

function renderSeats() {
  seatMapEl.innerHTML = '';
  const sortedIds = Object.keys(seats).sort((a, b) => {
    const rowA = seats[a].row_label;
    const rowB = seats[b].row_label;
    if (rowA !== rowB) return rowA.localeCompare(rowB);
    return seats[a].seat_number - seats[b].seat_number;
  });

  sortedIds.forEach(id => {
    const seat = seats[id];
    const el = document.createElement('div');
    el.className = `seat ${seat.status}`;
    if (selectedSeats.has(id) && seat.status === 'available') {
      el.classList.add('selected');
    }
    el.textContent = id;
    el.addEventListener('click', () => toggleSeat(id));
    seatMapEl.appendChild(el);
  });
  updateButtons();
}

function toggleSeat(id) {
  const seat = seats[id];
  if (seat.status !== 'available') return;
  if (currentHoldId) return; // Cannot select new seats while holding

  if (selectedSeats.has(id)) {
    selectedSeats.delete(id);
  } else {
    selectedSeats.add(id);
  }
  renderSeats();
}

function updateButtons() {
  holdBtn.disabled = selectedSeats.size === 0 || currentHoldId !== null;
  confirmBtn.disabled = currentHoldId === null;
  releaseBtn.disabled = currentHoldId === null;
}

function showMessage(msg) {
  messagesEl.textContent = msg;
  setTimeout(() => {
    messagesEl.textContent = '';
  }, 5000);
}

holdBtn.addEventListener('click', async () => {
  if (selectedSeats.size === 0) return;
  const seatIds = Array.from(selectedSeats);
  
  try {
    const res = await fetch('/api/holds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId })
    });
    
    const data = await res.json();
    if (res.ok) {
      currentHoldId = data.holdId;
      holdExpiresAt = new Date(data.expiresAt);
      if (data.seatIds) {
        data.seatIds.forEach(id => {
          if (seats[id]) seats[id].status = 'held';
        });
        renderSeats();
      }
      startTimer();
      selectedSeats.clear();
      updateButtons();
    } else {
      showMessage(data.error || 'Failed to hold seats');
      if (data.conflictingSeatIds) {
        data.conflictingSeatIds.forEach(id => selectedSeats.delete(id));
      }
      fetchSeats();
    }
  } catch (err) {
    showMessage('Network error');
  }
});

confirmBtn.addEventListener('click', async () => {
  if (!currentHoldId) return;
  
  try {
    const res = await fetch(`/api/holds/${currentHoldId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    });
    
    const data = await res.json();
    if (res.ok) {
      if (data.seatIds) {
        data.seatIds.forEach(id => {
          if (seats[id]) seats[id].status = 'booked';
        });
        renderSeats();
      }
      clearHoldState();
      showMessage('Booking confirmed!');
    } else {
      showMessage(data.error || 'Failed to confirm booking');
      clearHoldState();
      fetchSeats();
    }
  } catch (err) {
    showMessage('Network error');
  }
});

releaseBtn.addEventListener('click', async () => {
  if (!currentHoldId) return;
  
  try {
    const res = await fetch(`/api/holds/${currentHoldId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    });
    
    const data = await res.json();
    if (res.ok) {
      if (data.seatIds) {
        data.seatIds.forEach(id => {
          if (seats[id]) seats[id].status = 'available';
        });
        renderSeats();
      }
      clearHoldState();
    } else {
      showMessage(data.error || 'Failed to release hold');
      clearHoldState();
      fetchSeats();
    }
  } catch (err) {
    showMessage('Network error');
  }
});

function startTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    if (!holdExpiresAt) return;
    const now = new Date();
    const diff = Math.max(0, Math.floor((holdExpiresAt - now) / 1000));
    timerEl.textContent = `Hold expires in ${diff}s`;
    if (diff === 0) {
      clearHoldState();
      showMessage('Hold expired');
      fetchSeats();
    }
  }, 1000);
}

function clearHoldState() {
  currentHoldId = null;
  holdExpiresAt = null;
  if (timerInterval) clearInterval(timerInterval);
  timerEl.textContent = '';
  updateButtons();
}

function setupSSE() {
  const evtSource = new EventSource('/api/stream');
  evtSource.onopen = () => {
    fetchSeats();
  };
  evtSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'seats_updated') {
      let changed = false;
      data.seats.forEach(update => {
        if (seats[update.id]) {
          seats[update.id].status = update.status;
          changed = true;
        }
      });
      if (changed) renderSeats();
    }
  };
}

setupSSE();
