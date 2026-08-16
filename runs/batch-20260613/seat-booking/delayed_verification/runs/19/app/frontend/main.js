const API_BASE = 'http://localhost:3001/api';
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
  renderSeats();
}

function renderSeats() {
  seatMapEl.innerHTML = '';
  seats.forEach(seat => {
    const el = document.createElement('div');
    el.className = `seat ${seat.status}`;
    if (seat.status === 'available' && selectedSeatIds.has(seat.id)) {
      el.classList.add('selected');
    }
    if (seat.status === 'held' && currentHold && currentHold.seatIds.includes(seat.id)) {
      el.classList.add('my-hold');
    }
    el.textContent = seat.id;
    el.addEventListener('click', () => toggleSeatSelection(seat));
    seatMapEl.appendChild(el);
  });
  updateButtons();
}

function toggleSeatSelection(seat) {
  if (seat.status !== 'available') return;
  if (currentHold) return; // Cannot select new seats while holding

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

function startTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    if (!currentHold) {
      timerEl.textContent = '';
      clearInterval(timerInterval);
      return;
    }
    const remaining = Math.max(0, currentHold.expiresAt - Date.now());
    timerEl.textContent = `Hold expires in ${Math.ceil(remaining / 1000)}s`;
    if (remaining === 0) {
      currentHold = null;
      selectedSeatIds.clear();
      renderSeats();
      clearInterval(timerInterval);
      timerEl.textContent = 'Hold expired';
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
    const data = await res.json();
    if (res.ok) {
      currentHold = data;
      selectedSeatIds.clear();
      startTimer();
      // Optimistically update
      data.seatIds.forEach(id => {
        const s = seats.find(seat => seat.id === id);
        if (s) s.status = 'held';
      });
      renderSeats();
    } else if (res.status === 409) {
      alert('Some seats are already taken: ' + data.conflicts.join(', '));
      selectedSeatIds.clear();
      await fetchSeats();
    } else {
      alert('Error: ' + data.error);
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
    const data = await res.json();
    if (res.ok) {
      currentHold = null;
      timerEl.textContent = 'Booked successfully!';
      clearInterval(timerInterval);
      await fetchSeats();
    } else {
      alert('Error: ' + data.error);
      currentHold = null;
      clearInterval(timerInterval);
      timerEl.textContent = '';
      await fetchSeats();
    }
  } catch (err) {
    console.error(err);
  }
});

releaseBtn.addEventListener('click', async () => {
  if (!currentHold) return;
  try {
    await fetch(`${API_BASE}/holds/${currentHold.holdId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    });
    currentHold = null;
    clearInterval(timerInterval);
    timerEl.textContent = '';
    await fetchSeats();
  } catch (err) {
    console.error(err);
  }
});

function setupSSE() {
  const evtSource = new EventSource(`${API_BASE}/stream`);
  evtSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'seats_updated') {
      let changed = false;
      data.seats.forEach(update => {
        const s = seats.find(seat => seat.id === update.id);
        if (s && s.status !== update.status) {
          s.status = update.status;
          changed = true;
          // If a seat we selected became unavailable, deselect it
          if (update.status !== 'available' && selectedSeatIds.has(update.id)) {
            selectedSeatIds.delete(update.id);
          }
        }
      });
      if (changed) renderSeats();
    }
  };
}

fetchSeats().then(setupSSE);
