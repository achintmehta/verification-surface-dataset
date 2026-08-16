const API_URL = 'http://localhost:3000/api';

let seats = [];
let selectedSeatIds = new Set();
let currentHold = null; // { holdId, expiresAt, seatIds }
let timerInterval = null;
const sessionId = crypto.randomUUID();

const seatMapEl = document.getElementById('seat-map');
const holdBtn = document.getElementById('hold-btn');
const confirmBtn = document.getElementById('confirm-btn');
const releaseBtn = document.getElementById('release-btn');
const timerEl = document.getElementById('timer');

async function fetchSeats() {
  const res = await fetch(`${API_URL}/seats`);
  seats = await res.json();
  renderSeats();
}

function renderSeats() {
  seatMapEl.innerHTML = '';
  const rows = {};
  for (const seat of seats) {
    if (!rows[seat.row_label]) rows[seat.row_label] = [];
    rows[seat.row_label].push(seat);
  }

  for (const rowLabel of Object.keys(rows).sort()) {
    const rowEl = document.createElement('div');
    rowEl.className = 'row';
    
    const labelEl = document.createElement('div');
    labelEl.className = 'row-label';
    labelEl.textContent = rowLabel;
    rowEl.appendChild(labelEl);

    rows[rowLabel].sort((a, b) => a.seat_number - b.seat_number).forEach(seat => {
      const seatEl = document.createElement('div');
      seatEl.className = `seat ${seat.status}`;
      seatEl.textContent = seat.seat_number;
      
      if (currentHold && currentHold.seatIds.includes(seat.id) && seat.status === 'held') {
        seatEl.classList.add('my-held');
      } else if (selectedSeatIds.has(seat.id)) {
        seatEl.classList.add('selected');
      }

      seatEl.addEventListener('click', () => toggleSeatSelection(seat));
      rowEl.appendChild(seatEl);
    });

    seatMapEl.appendChild(rowEl);
  }
  updateButtons();
}

function toggleSeatSelection(seat) {
  if (currentHold) return; // Cannot select new seats while holding
  if (seat.status !== 'available') return;

  if (selectedSeatIds.has(seat.id)) {
    selectedSeatIds.delete(seat.id);
  } else {
    selectedSeatIds.add(seat.id);
  }
  renderSeats();
}

function updateButtons() {
  holdBtn.disabled = selectedSeatIds.size === 0 || currentHold !== null;
  confirmBtn.disabled = currentHold === null;
  releaseBtn.disabled = currentHold === null;
}

holdBtn.addEventListener('click', async () => {
  if (selectedSeatIds.size === 0) return;
  
  const seatIds = Array.from(selectedSeatIds);
  try {
    const res = await fetch(`${API_URL}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId })
    });

    if (res.ok) {
      currentHold = await res.json();
      selectedSeatIds.clear();
      for (const id of currentHold.seatIds) {
        const seat = seats.find(s => s.id === id);
        if (seat) seat.status = 'held';
      }
      startTimer();
      renderSeats();
    } else if (res.status === 409) {
      const data = await res.json();
      alert(`Seats unavailable: ${data.conflictingSeatIds.join(', ')}`);
      selectedSeatIds.clear();
      await fetchSeats();
    } else {
      alert('Failed to hold seats');
    }
  } catch (err) {
    console.error(err);
    alert('Error holding seats');
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

    if (res.ok) {
      alert('Booking confirmed!');
      for (const id of currentHold.seatIds) {
        const seat = seats.find(s => s.id === id);
        if (seat) seat.status = 'booked';
      }
      stopTimer();
      currentHold = null;
      renderSeats();
    } else {
      const data = await res.json();
      alert(`Failed to confirm: ${data.error}`);
      stopTimer();
      currentHold = null;
      await fetchSeats();
    }
  } catch (err) {
    console.error(err);
    alert('Error confirming booking');
  }
});

releaseBtn.addEventListener('click', async () => {
  if (!currentHold) return;

  try {
    const res = await fetch(`${API_URL}/holds/${currentHold.holdId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    });

    if (res.ok) {
      for (const id of currentHold.seatIds) {
        const seat = seats.find(s => s.id === id);
        if (seat) seat.status = 'available';
      }
      stopTimer();
      currentHold = null;
      renderSeats();
    } else {
      alert('Failed to release hold');
    }
  } catch (err) {
    console.error(err);
    alert('Error releasing hold');
  }
});

function startTimer() {
  stopTimer();
  updateTimerDisplay();
  timerInterval = setInterval(() => {
    if (!currentHold) {
      stopTimer();
      return;
    }
    const remaining = currentHold.expiresAt - Date.now();
    if (remaining <= 0) {
      stopTimer();
      currentHold = null;
      alert('Hold expired');
      fetchSeats();
    } else {
      updateTimerDisplay();
    }
  }, 1000);
}

function stopTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
  timerEl.textContent = '';
}

function updateTimerDisplay() {
  if (!currentHold) return;
  const remaining = Math.max(0, Math.floor((currentHold.expiresAt - Date.now()) / 1000));
  timerEl.textContent = `Hold expires in ${remaining}s`;
}

function setupSSE() {
  const evtSource = new EventSource(`${API_URL}/stream`);
  
  evtSource.onopen = () => {
    fetchSeats();
  };

  evtSource.addEventListener('seats_updated', (e) => {
    const updatedSeats = JSON.parse(e.data);
    let changed = false;
    for (const update of updatedSeats) {
      const seat = seats.find(s => s.id === update.id);
      if (seat && seat.status !== update.status) {
        seat.status = update.status;
        if (seat.status !== 'available' && selectedSeatIds.has(seat.id)) {
          selectedSeatIds.delete(seat.id);
        }
        changed = true;
      }
    }
    if (changed) renderSeats();
  });
}

setupSSE();