const API_BASE = 'http://localhost:3000/api';
let sessionId = localStorage.getItem('sessionId');
if (!sessionId) {
  sessionId = crypto.randomUUID();
  localStorage.setItem('sessionId', sessionId);
}

let seats = [];
let selectedSeatIds = new Set();
let currentHold = null; // { holdId, expiresAt, seatIds }
let timerInterval = null;

const seatMapEl = document.getElementById('seat-map');
const holdBtn = document.getElementById('hold-btn');
const confirmBtn = document.getElementById('confirm-btn');
const releaseBtn = document.getElementById('release-btn');
const timerEl = document.getElementById('timer');

async function fetchSeats() {
  const res = await fetch(`${API_BASE}/seats`);
  seats = await res.json();
  selectedSeatIds.forEach(id => {
    const seat = seats.find(s => s.id === id);
    if (!seat || seat.status !== 'available') {
      selectedSeatIds.delete(id);
    }
  });
  renderSeats();
}

function renderSeats() {
  seatMapEl.innerHTML = '';
  seats.forEach(seat => {
    const seatEl = document.createElement('div');
    seatEl.className = `seat ${seat.status}`;
    seatEl.textContent = seat.id;
    
    if (seat.status === 'available') {
      if (selectedSeatIds.has(seat.id)) {
        seatEl.classList.add('selected');
      }
      seatEl.addEventListener('click', () => toggleSelection(seat.id));
    } else if (seat.status === 'held' && currentHold && currentHold.seatIds.includes(seat.id)) {
      seatEl.classList.add('held-by-me');
    }

    seatMapEl.appendChild(seatEl);
  });
  updateControls();
}

function toggleSelection(seatId) {
  if (selectedSeatIds.has(seatId)) {
    selectedSeatIds.delete(seatId);
  } else {
    selectedSeatIds.add(seatId);
  }
  renderSeats();
}

function updateControls() {
  const anyUnavailable = Array.from(selectedSeatIds).some(id => {
    const seat = seats.find(s => s.id === id);
    return seat && seat.status !== 'available';
  });
  holdBtn.disabled = selectedSeatIds.size === 0 || currentHold !== null || anyUnavailable;
  confirmBtn.disabled = currentHold === null;
  releaseBtn.disabled = currentHold === null;
}

function startTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    if (!currentHold) {
      timerEl.textContent = '';
      clearInterval(timerInterval);
      return;
    }
    const remaining = Math.max(0, Math.floor((new Date(currentHold.expiresAt) - new Date()) / 1000));
    if (remaining === 0) {
      currentHold = null;
      selectedSeatIds.clear();
      timerEl.textContent = 'Hold expired';
      clearInterval(timerInterval);
      renderSeats();
    } else {
      timerEl.textContent = `Hold expires in ${remaining}s`;
    }
  }, 1000);
}

holdBtn.addEventListener('click', async () => {
  const seatIds = Array.from(selectedSeatIds);
  try {
    const res = await fetch(`${API_BASE}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId })
    });
    if (res.ok) {
      currentHold = await res.json();
      selectedSeatIds.clear();
      startTimer();
      // Optimistically update
      currentHold.seatIds.forEach(id => {
        const seat = seats.find(s => s.id === id);
        if (seat) seat.status = 'held';
      });
      renderSeats();
    } else if (res.status === 409) {
      const data = await res.json();
      alert(`Conflict: ${data.conflicts.join(', ')} are unavailable.`);
      selectedSeatIds.clear();
      fetchSeats();
    } else {
      alert('Failed to hold seats');
    }
  } catch (err) {
    console.error(err);
  }
});

confirmBtn.addEventListener('click', async () => {
  if (!currentHold) return;
  try {
    const res = await fetch(`${API_BASE}/holds/${currentHold.holdId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    });
    if (res.ok) {
      currentHold = null;
      timerEl.textContent = 'Booked successfully!';
      clearInterval(timerInterval);
      fetchSeats();
    } else {
      const data = await res.json();
      alert(`Failed to confirm: ${data.error}`);
      currentHold = null;
      fetchSeats();
    }
  } catch (err) {
    console.error(err);
  }
});

releaseBtn.addEventListener('click', async () => {
  if (!currentHold) return;
  try {
    await fetch(`${API_BASE}/holds/${currentHold.holdId}`, { method: 'DELETE' });
    currentHold = null;
    timerEl.textContent = '';
    clearInterval(timerInterval);
    fetchSeats();
  } catch (err) {
    console.error(err);
  }
});

function setupSSE() {
  const evtSource = new EventSource(`${API_BASE}/stream`);
  evtSource.addEventListener('seats_updated', (e) => {
    const updatedSeats = JSON.parse(e.data);
    let changed = false;
    updatedSeats.forEach(update => {
      const seat = seats.find(s => s.id === update.id);
      if (seat && seat.status !== update.status) {
        seat.status = update.status;
        if (seat.status !== 'available' && selectedSeatIds.has(seat.id)) {
          selectedSeatIds.delete(seat.id);
        }
        changed = true;
      }
      if (update.status === 'available' && currentHold && currentHold.seatIds.includes(update.id)) {
        currentHold = null;
        selectedSeatIds.clear();
        timerEl.textContent = 'Hold expired';
        if (timerInterval) clearInterval(timerInterval);
        changed = true;
      }
    });
    if (changed) renderSeats();
  });
}

fetchSeats().then(setupSSE);