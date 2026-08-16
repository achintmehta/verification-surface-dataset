import { v4 as uuidv4 } from 'uuid';

const API_URL = 'http://localhost:3001/api';
let sessionId = localStorage.getItem('sessionId');
if (!sessionId) {
  sessionId = uuidv4();
  localStorage.setItem('sessionId', sessionId);
}

let seats = [];
let selectedSeatIds = new Set();
let currentHold = null;
let countdownInterval = null;

const seatMapEl = document.getElementById('seat-map');
const holdBtn = document.getElementById('hold-btn');
const confirmBtn = document.getElementById('confirm-btn');
const releaseBtn = document.getElementById('release-btn');
const messageEl = document.getElementById('message');
const countdownEl = document.getElementById('countdown');

async function fetchSeats() {
  const res = await fetch(`${API_URL}/seats`);
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
      if (selectedSeatIds.has(seat.id)) {
        seatEl.classList.add('selected');
      }
      seatEl.textContent = seat.seat_number;
      
      seatEl.addEventListener('click', () => {
        if (seat.status !== 'available') return;
        if (currentHold) return; // Cannot select new seats while holding
        
        if (selectedSeatIds.has(seat.id)) {
          selectedSeatIds.delete(seat.id);
        } else {
          selectedSeatIds.add(seat.id);
        }
        renderSeats();
      });

      rowEl.appendChild(seatEl);
    });

    seatMapEl.appendChild(rowEl);
  }
}

holdBtn.addEventListener('click', async () => {
  if (selectedSeatIds.size === 0) {
    showMessage('Select seats first');
    return;
  }

  try {
    const res = await fetch(`${API_URL}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        seatIds: Array.from(selectedSeatIds),
        sessionId
      })
    });

    const data = await res.json();
    if (!res.ok) {
      if (res.status === 409) {
        const conflicts = data.conflictingSeatIds ? data.conflictingSeatIds.join(', ') : 'Some';
        showMessage(`Seats already taken: ${conflicts}`);
        selectedSeatIds.clear();
        await fetchSeats();
      } else {
        showMessage(data.error || 'Failed to hold seats');
      }
      return;
    }

    currentHold = data;
    selectedSeatIds.clear();
    updateControls();
    startCountdown();
    showMessage('Seats held successfully');
  } catch (err) {
    showMessage(err.message);
  }
});

confirmBtn.addEventListener('click', async () => {
  if (!currentHold) return;

  try {
    const res = await fetch(`${API_URL}/holds/${currentHold.holdId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    });

    const data = await res.json();
    if (!res.ok) {
      showMessage(data.error || 'Failed to confirm booking');
      currentHold = null;
      updateControls();
      stopCountdown();
      await fetchSeats();
      return;
    }

    showMessage('Booking confirmed!');
    currentHold = null;
    updateControls();
    stopCountdown();
  } catch (err) {
    showMessage(err.message);
  }
});

releaseBtn.addEventListener('click', async () => {
  if (!currentHold) return;

  try {
    await fetch(`${API_URL}/holds/${currentHold.holdId}`, {
      method: 'DELETE'
    });
    currentHold = null;
    updateControls();
    stopCountdown();
    showMessage('Hold released');
  } catch (err) {
    showMessage(err.message);
  }
});

function updateControls() {
  if (currentHold) {
    holdBtn.style.display = 'none';
    confirmBtn.style.display = 'inline-block';
    releaseBtn.style.display = 'inline-block';
  } else {
    holdBtn.style.display = 'inline-block';
    confirmBtn.style.display = 'none';
    releaseBtn.style.display = 'none';
  }
}

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
      updateControls();
      showMessage('Hold expired');
      countdownEl.textContent = '';
    } else {
      countdownEl.textContent = `Hold expires in ${Math.ceil(remaining / 1000)}s`;
    }
  }, 1000);
}

function stopCountdown() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
  countdownEl.textContent = '';
}

function showMessage(msg) {
  messageEl.textContent = msg;
  setTimeout(() => {
    if (messageEl.textContent === msg) messageEl.textContent = '';
  }, 5000);
}

function setupSSE() {
  const evtSource = new EventSource(`${API_URL}/stream`);
  evtSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'seats_updated') {
      let changed = false;
      data.seats.forEach(update => {
        const seat = seats.find(s => s.id === update.id);
        if (seat && seat.status !== update.status) {
          seat.status = update.status;
          changed = true;
        }
      });
      if (changed) renderSeats();
    }
  };
}

fetchSeats().then(() => {
  setupSSE();
});