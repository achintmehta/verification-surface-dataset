import { v4 as uuidv4 } from 'uuid';

const API_URL = 'http://localhost:3001/api';
let sessionId = localStorage.getItem('sessionId');
if (!sessionId) {
  sessionId = uuidv4();
  localStorage.setItem('sessionId', sessionId);
}

let seats = {};
let selectedSeats = new Set();
let currentHold = null;
let timerInterval = null;

const seatMapEl = document.getElementById('seat-map');
const holdBtn = document.getElementById('hold-btn');
const confirmBtn = document.getElementById('confirm-btn');
const releaseBtn = document.getElementById('release-btn');
const statusMessageEl = document.getElementById('status-message');
const timerEl = document.getElementById('timer');

async function fetchSeats() {
  const res = await fetch(`${API_URL}/seats`);
  const data = await res.json();
  data.forEach(seat => {
    seats[seat.id] = seat;
  });
  renderSeatMap();
}

function renderSeatMap() {
  seatMapEl.innerHTML = '';
  const sortedIds = Object.keys(seats).sort((a, b) => {
    const rowA = a.charAt(0);
    const rowB = b.charAt(0);
    if (rowA !== rowB) return rowA.localeCompare(rowB);
    return parseInt(a.slice(1)) - parseInt(b.slice(1));
  });

  sortedIds.forEach(id => {
    const seat = seats[id];
    const el = document.createElement('div');
    el.className = `seat ${seat.status}`;
    if (selectedSeats.has(id)) {
      el.classList.add('selected');
    }
    el.textContent = id;
    el.addEventListener('click', () => toggleSeat(id));
    seatMapEl.appendChild(el);
  });
  updateControls();
}

function toggleSeat(id) {
  const seat = seats[id];
  if (seat.status !== 'available') return;
  if (currentHold) return; // Cannot select new seats while holding

  if (selectedSeats.has(id)) {
    selectedSeats.delete(id);
  } else {
    selectedSeats.add(id);
  }
  renderSeatMap();
}

function updateControls() {
  if (currentHold) {
    holdBtn.disabled = true;
    confirmBtn.disabled = false;
    releaseBtn.disabled = false;
  } else {
    holdBtn.disabled = selectedSeats.size === 0;
    confirmBtn.disabled = true;
    releaseBtn.disabled = true;
  }
}

holdBtn.addEventListener('click', async () => {
  if (selectedSeats.size === 0) return;
  const seatIds = Array.from(selectedSeats);
  
  try {
    const res = await fetch(`${API_URL}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId })
    });
    
    const data = await res.json();
    if (!res.ok) {
      if (res.status === 409) {
        alert(`Seats unavailable: ${data.conflictingSeats.join(', ')}`);
        selectedSeats.clear();
        await fetchSeats();
      } else {
        alert(data.error || 'Failed to hold seats');
      }
      return;
    }
    
    currentHold = {
      id: data.holdId,
      expiresAt: data.expiresAt,
      seats: data.seats
    };
    selectedSeats.clear();
    startTimer();
    updateControls();
  } catch (err) {
    console.error(err);
    alert('Error holding seats');
  }
});

confirmBtn.addEventListener('click', async () => {
  if (!currentHold) return;
  
  try {
    const res = await fetch(`${API_URL}/holds/${currentHold.id}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    });
    
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'Failed to confirm booking');
      clearHold();
      await fetchSeats();
      return;
    }
    
    alert('Booking confirmed!');
    clearHold();
    await fetchSeats();
  } catch (err) {
    console.error(err);
    alert('Error confirming booking');
  }
});

releaseBtn.addEventListener('click', async () => {
  if (!currentHold) return;
  
  const holdId = currentHold.id;
  clearHold();
  
  try {
    await fetch(`${API_URL}/holds/${holdId}`, {
      method: 'DELETE'
    });
    await fetchSeats();
  } catch (err) {
    console.error(err);
  }
});

function startTimer() {
  if (timerInterval) clearInterval(timerInterval);
  
  timerInterval = setInterval(() => {
    if (!currentHold) {
      clearInterval(timerInterval);
      timerEl.textContent = '';
      return;
    }
    
    const remaining = currentHold.expiresAt - Date.now();
    if (remaining <= 0) {
      clearHold();
      alert('Hold expired');
      fetchSeats();
    } else {
      timerEl.textContent = `Hold expires in ${Math.ceil(remaining / 1000)}s`;
    }
  }, 1000);
}

function clearHold() {
  currentHold = null;
  if (timerInterval) clearInterval(timerInterval);
  timerEl.textContent = '';
  updateControls();
}

function setupSSE() {
  const eventSource = new EventSource(`${API_URL}/stream`);
  
  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    
    if (data.type === 'held') {
      data.seats.forEach(id => {
        if (seats[id]) seats[id].status = 'held';
        if (selectedSeats.has(id)) selectedSeats.delete(id);
      });
    } else if (data.type === 'booked') {
      data.seats.forEach(id => {
        if (seats[id]) seats[id].status = 'booked';
        if (selectedSeats.has(id)) selectedSeats.delete(id);
      });
    } else if (data.type === 'released') {
      data.seats.forEach(id => {
        if (seats[id]) seats[id].status = 'available';
      });
      // If our hold was released by the server
      if (currentHold && data.seats.some(id => currentHold.seats.includes(id))) {
        clearHold();
        alert('Your hold was released');
      }
    }
    renderSeatMap();
  };
}

fetchSeats().then(() => {
  setupSSE();
});