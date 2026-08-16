const API_BASE = 'http://localhost:3001/api';

// Generate or retrieve session ID
let sessionId = localStorage.getItem('sessionId');
if (!sessionId) {
  sessionId = crypto.randomUUID();
  localStorage.setItem('sessionId', sessionId);
}

let seats = {};
let selectedSeats = new Set();
let currentHold = null;
let countdownInterval = null;

const seatMapEl = document.getElementById('seat-map');
const messageEl = document.getElementById('message');
const actionsEl = document.getElementById('actions');
const countdownEl = document.getElementById('countdown');
const confirmBtn = document.getElementById('confirm-btn');
const releaseBtn = document.getElementById('release-btn');

async function fetchSeats() {
  const res = await fetch(`${API_BASE}/seats`);
  const data = await res.json();
  
  let myHoldId = null;
  let myExpiresAt = null;
  let mySeatIds = [];

  data.forEach(seat => {
    seats[seat.id] = seat;
    if (seat.status === 'held' && seat.booked_by === sessionId) {
      myHoldId = seat.hold_id;
      myExpiresAt = seat.hold_expires_at;
      mySeatIds.push(seat.id);
    }
  });

  if (myHoldId && !currentHold) {
    currentHold = {
      holdId: myHoldId,
      expiresAt: myExpiresAt,
      seatIds: mySeatIds
    };
    startCountdown();
    updateStatusBar();
  }

  renderSeats();
}

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

    if (seat.status === 'booked') {
      el.classList.add('booked');
    } else if (seat.status === 'held') {
      if (currentHold && currentHold.seatIds.includes(id)) {
        el.classList.add('held-by-me');
      } else {
        el.classList.add('held');
      }
    } else {
      if (selectedSeats.has(id)) {
        el.classList.add('selected');
      } else {
        el.classList.add('available');
      }
      el.addEventListener('click', () => toggleSelection(id));
    }

    seatMapEl.appendChild(el);
  });
}

function toggleSelection(id) {
  if (currentHold) return; // Cannot select more while holding
  if (selectedSeats.has(id)) {
    selectedSeats.delete(id);
  } else {
    selectedSeats.add(id);
  }
  renderSeats();
  updateStatusBar();
}

function updateStatusBar() {
  if (currentHold) {
    messageEl.textContent = `Holding ${currentHold.seatIds.length} seat(s)`;
    actionsEl.style.display = 'flex';
  } else if (selectedSeats.size > 0) {
    messageEl.textContent = `${selectedSeats.size} seat(s) selected. `;
    const holdBtn = document.createElement('button');
    holdBtn.textContent = 'Hold Seats';
    holdBtn.onclick = requestHold;
    messageEl.appendChild(holdBtn);
    actionsEl.style.display = 'none';
  } else {
    messageEl.textContent = 'Select seats to hold';
    actionsEl.style.display = 'none';
  }
}

async function requestHold() {
  const seatIds = Array.from(selectedSeats);
  try {
    const res = await fetch(`${API_BASE}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId })
    });

    if (res.status === 409) {
      const data = await res.json();
      alert(`Conflict! Seats already taken: ${data.conflicts.join(', ')}`);
      selectedSeats.clear();
      await fetchSeats();
    } else if (!res.ok) {
      throw new Error('Failed to hold seats');
    } else {
      const data = await res.json();
      currentHold = data;
      selectedSeats.clear();
      startCountdown();
      renderSeats();
      updateStatusBar();
    }
  } catch (err) {
    console.error(err);
    alert('Error requesting hold');
  }
}

async function confirmHold() {
  if (!currentHold) return;
  try {
    const res = await fetch(`${API_BASE}/holds/${currentHold.holdId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    });

    if (!res.ok) {
      const data = await res.json();
      alert(`Failed to confirm: ${data.error}`);
      clearHold();
      await fetchSeats();
    } else {
      alert('Booking confirmed!');
      clearHold();
      await fetchSeats();
    }
  } catch (err) {
    console.error(err);
    alert('Error confirming hold');
  }
}

async function releaseHold() {
  if (!currentHold) return;
  try {
    await fetch(`${API_BASE}/holds/${currentHold.holdId}?sessionId=${sessionId}`, {
      method: 'DELETE'
    });
    clearHold();
    await fetchSeats();
  } catch (err) {
    console.error(err);
  }
}

function clearHold() {
  currentHold = null;
  clearInterval(countdownInterval);
  updateStatusBar();
  renderSeats();
}

function startCountdown() {
  clearInterval(countdownInterval);
  countdownInterval = setInterval(() => {
    if (!currentHold) {
      clearInterval(countdownInterval);
      return;
    }
    const remaining = currentHold.expiresAt - Date.now();
    if (remaining <= 0) {
      clearHold();
      alert('Hold expired');
      fetchSeats();
    } else {
      countdownEl.textContent = `Expires in ${Math.ceil(remaining / 1000)}s`;
    }
  }, 1000);
}

confirmBtn.addEventListener('click', confirmHold);
releaseBtn.addEventListener('click', releaseHold);

// SSE Connection
const evtSource = new EventSource(`${API_BASE}/stream`);
evtSource.onopen = () => {
  fetchSeats();
};
evtSource.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.type === 'seats_updated') {
    let needsRender = false;
    data.seats.forEach(update => {
      if (seats[update.id] && seats[update.id].status !== update.status) {
        seats[update.id].status = update.status;
        needsRender = true;
        
        // If a seat we are holding gets released or booked
        if (currentHold && currentHold.seatIds.includes(update.id)) {
          if (update.status === 'available') {
            clearHold();
            alert('Your hold has expired.');
          } else if (update.status === 'booked') {
            clearHold();
          }
        }
      }
    });
    if (needsRender) {
      renderSeats();
    }
  }
};

fetchSeats();