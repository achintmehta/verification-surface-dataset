import './style.css';

const API = '';
let seats = new Map();
let selected = new Set();
let currentHold = null;
let countdownTimer = null;
let conflictIds = new Set();

const sessionId = localStorage.getItem('seatBookingSessionId') || crypto.randomUUID();
localStorage.setItem('seatBookingSessionId', sessionId);

document.querySelector('#sessionId').textContent = sessionId.slice(0, 8);
const grid = document.querySelector('#grid');
const statusEl = document.querySelector('#status');
const invEl = document.querySelector('#inventory');
const holdBtn = document.querySelector('#holdBtn');
const confirmBtn = document.querySelector('#confirmBtn');
const releaseBtn = document.querySelector('#releaseBtn');
const holdPanel = document.querySelector('#holdPanel');

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle('error', isError);
}

function recomputeInventory() {
  const inv = { total: seats.size, available: 0, held: 0, booked: 0 };
  for (const seat of seats.values()) inv[seat.status]++;
  invEl.textContent = `Available ${inv.available} · Held ${inv.held} · Booked ${inv.booked} · Total ${inv.total}`;
}

function render() {
  const rows = new Map();
  for (const seat of [...seats.values()].sort((a, b) => a.rowLabel.localeCompare(b.rowLabel) || a.seatNumber - b.seatNumber)) {
    if (!rows.has(seat.rowLabel)) rows.set(seat.rowLabel, []);
    rows.get(seat.rowLabel).push(seat);
  }
  grid.innerHTML = '';
  for (const [row, rowSeats] of rows) {
    const label = document.createElement('div');
    label.className = 'row-label';
    label.textContent = row;
    grid.appendChild(label);
    for (const seat of rowSeats) {
      const btn = document.createElement('button');
      btn.className = `seat ${seat.status}`;
      if (selected.has(seat.id)) btn.classList.add('selected');
      if (conflictIds.has(seat.id)) btn.classList.add('conflict');
      btn.textContent = seat.seatNumber;
      btn.title = `${seat.id}: ${seat.status}`;
      btn.disabled = seat.status !== 'available' && !selected.has(seat.id);
      btn.onclick = () => toggleSeat(seat.id);
      grid.appendChild(btn);
    }
  }
  holdBtn.disabled = selected.size === 0 || !!currentHold;
  confirmBtn.disabled = !currentHold;
  releaseBtn.disabled = !currentHold;
  recomputeInventory();
}

function toggleSeat(id) {
  const seat = seats.get(id);
  if (!seat || seat.status !== 'available') return;
  conflictIds.clear();
  if (selected.has(id)) selected.delete(id); else selected.add(id);
  render();
}

async function loadSeats() {
  const res = await fetch(`${API}/api/seats`);
  if (!res.ok) throw new Error('Failed to load seats');
  const data = await res.json();
  seats = new Map(data.seats.map(s => [s.id, s]));
  if (data.inventory) invEl.textContent = `Available ${data.inventory.available} · Held ${data.inventory.held} · Booked ${data.inventory.booked} · Total ${data.inventory.total}`;
  render();
}

function updateHoldPanel() {
  if (!currentHold) {
    holdPanel.classList.add('hidden');
    holdPanel.textContent = '';
    return;
  }
  holdPanel.classList.remove('hidden');
  const ms = new Date(currentHold.expiresAt).getTime() - Date.now();
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  holdPanel.textContent = `Holding ${currentHold.seatIds.join(', ')} · expires in ${seconds}s`;
  if (seconds <= 0) {
    currentHold = null;
    selected.clear();
    setStatus('Your hold expired. Seats will return to available if not taken.');
    loadSeats().catch(console.error);
    updateHoldPanel();
  }
}

function startCountdown() {
  clearInterval(countdownTimer);
  updateHoldPanel();
  countdownTimer = setInterval(updateHoldPanel, 250);
}

holdBtn.onclick = async () => {
  try {
    const seatIds = [...selected];
    const res = await fetch(`${API}/api/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds, sessionId })
    });
    const data = await res.json();
    if (res.status === 409) {
      conflictIds = new Set(data.conflictingSeatIds || []);
      selected.clear();
      setStatus(`Hold failed. Conflicts: ${[...conflictIds].join(', ') || 'unknown'}`, true);
      await loadSeats();
      render();
      return;
    }
    if (!res.ok) throw new Error(data.error || 'Hold failed');
    currentHold = data.hold;
    selected.clear();
    data.seats.forEach(s => seats.set(s.id, s));
    setStatus('Hold acquired. Confirm before the countdown expires.');
    startCountdown();
    render();
  } catch (err) { setStatus(err.message, true); }
};

confirmBtn.onclick = async () => {
  if (!currentHold) return;
  try {
    const res = await fetch(`${API}/api/holds/${currentHold.id}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Confirm failed');
    data.seats.forEach(s => seats.set(s.id, s));
    setStatus(`Booked! Booking id: ${data.bookingId}`);
    currentHold = null;
    clearInterval(countdownTimer);
    updateHoldPanel();
    render();
  } catch (err) {
    setStatus(err.message, true);
    await loadSeats();
  }
};

releaseBtn.onclick = async () => {
  if (!currentHold) return;
  try {
    const res = await fetch(`${API}/api/holds/${currentHold.id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Release failed');
    currentHold = null;
    clearInterval(countdownTimer);
    updateHoldPanel();
    setStatus(`Released ${data.releasedSeatIds.length} seats.`);
    await loadSeats();
  } catch (err) { setStatus(err.message, true); }
};

function connectStream() {
  const es = new EventSource(`${API}/api/stream`);
  es.addEventListener('seats', e => {
    const data = JSON.parse(e.data);
    for (const seat of data.seats) {
      seats.set(seat.id, seat);
      if (seat.status !== 'available') selected.delete(seat.id);
    }
    setStatus(`Live update: ${data.reason} (${data.seats.map(s => s.id).join(', ')})`);
    render();
  });
  es.onerror = () => setStatus('Live connection interrupted; browser will retry…', true);
}

loadSeats().then(() => setStatus('Ready.')).catch(err => setStatus(err.message, true));
connectStream();
