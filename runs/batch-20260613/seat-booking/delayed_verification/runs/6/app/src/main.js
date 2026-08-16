import './styles.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const sessionId = localStorage.getItem('seatBookingSessionId') || crypto.randomUUID();
localStorage.setItem('seatBookingSessionId', sessionId);

document.querySelector('#sessionId').textContent = sessionId.slice(0, 8);

const grid = document.querySelector('#seatGrid');
const inventoryEl = document.querySelector('#inventory');
const noticeEl = document.querySelector('#notice');
const selectionText = document.querySelector('#selectionText');
const holdBtn = document.querySelector('#holdBtn');
const holdPanel = document.querySelector('#holdPanel');
const holdText = document.querySelector('#holdText');
const countdownEl = document.querySelector('#countdown');
const confirmBtn = document.querySelector('#confirmBtn');
const releaseBtn = document.querySelector('#releaseBtn');

let seats = new Map();
let selected = new Set();
let currentHold = null;
let countdownTimer = null;

function showNotice(message, kind = 'info') {
  noticeEl.textContent = message;
  noticeEl.className = `notice ${kind}`;
  noticeEl.hidden = false;
  clearTimeout(showNotice.timer);
  showNotice.timer = setTimeout(() => {
    noticeEl.hidden = true;
  }, 6000);
}

async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(json.error || response.statusText);
    err.status = response.status;
    err.payload = json;
    throw err;
  }
  return json;
}

function setSeats(list) {
  for (const seat of list) seats.set(seat.id, seat);
  selected = new Set([...selected].filter((id) => seats.get(id)?.status === 'available'));
  render();
}

function statusLabel(seat) {
  if (seat.status === 'held' && currentHold?.seatIds?.includes(seat.id)) return 'held by you';
  return seat.status;
}

function render() {
  const ordered = [...seats.values()].sort((a, b) => a.rowLabel.localeCompare(b.rowLabel) || a.seatNumber - b.seatNumber);
  const rows = new Map();
  for (const seat of ordered) {
    if (!rows.has(seat.rowLabel)) rows.set(seat.rowLabel, []);
    rows.get(seat.rowLabel).push(seat);
  }

  grid.innerHTML = '';
  for (const [rowLabel, rowSeats] of rows) {
    const label = document.createElement('div');
    label.className = 'row-label';
    label.textContent = rowLabel;
    grid.append(label);

    for (const seat of rowSeats) {
      const btn = document.createElement('button');
      btn.className = `seat ${seat.status}${selected.has(seat.id) ? ' selected' : ''}`;
      btn.textContent = seat.seatNumber;
      btn.title = `${seat.id}: ${statusLabel(seat)}`;
      btn.disabled = seat.status !== 'available';
      btn.addEventListener('click', () => toggleSeat(seat.id));
      grid.append(btn);
    }
  }

  const selectedIds = [...selected];
  selectionText.textContent = selectedIds.length ? selectedIds.join(', ') : 'No seats selected.';
  holdBtn.disabled = selectedIds.length === 0 || Boolean(currentHold);

  const inv = [...seats.values()].reduce((acc, seat) => {
    acc.total++;
    acc[seat.status]++;
    return acc;
  }, { total: 0, available: 0, held: 0, booked: 0 });
  inventoryEl.textContent = `Available ${inv.available} · Held ${inv.held} · Booked ${inv.booked} · Total ${inv.total}`;
}

function toggleSeat(id) {
  const seat = seats.get(id);
  if (!seat || seat.status !== 'available' || currentHold) return;
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  render();
}

function startCountdown() {
  clearInterval(countdownTimer);
  const tick = () => {
    if (!currentHold) return;
    const ms = new Date(currentHold.expiresAt).getTime() - Date.now();
    if (ms <= 0) {
      countdownEl.textContent = 'expired';
      currentHold = null;
      holdPanel.hidden = true;
      showNotice('Your hold expired. Seats are available again if no one else took them.', 'warn');
      refreshSeats();
      clearInterval(countdownTimer);
      return;
    }
    countdownEl.textContent = `${Math.ceil(ms / 1000)}s`;
  };
  tick();
  countdownTimer = setInterval(tick, 250);
}

function showHold(hold) {
  currentHold = hold;
  selected.clear();
  holdPanel.hidden = false;
  holdText.textContent = `Held seats: ${hold.seatIds.join(', ')}`;
  startCountdown();
  render();
}

function clearHold() {
  currentHold = null;
  holdPanel.hidden = true;
  clearInterval(countdownTimer);
  render();
}

async function refreshSeats() {
  const data = await api('/api/seats');
  setSeats(data.seats);
}

holdBtn.addEventListener('click', async () => {
  const seatIds = [...selected];
  try {
    const data = await api('/api/holds', {
      method: 'POST',
      body: JSON.stringify({ seatIds, sessionId }),
    });
    setSeats(data.seats);
    showHold(data.hold);
    showNotice(`Held ${seatIds.length} seat(s). Confirm before the countdown ends.`, 'success');
  } catch (err) {
    if (err.status === 409) {
      showNotice(`Some seats were already taken: ${(err.payload.conflicts || []).join(', ')}`, 'error');
      await refreshSeats();
    } else {
      showNotice(`Could not create hold: ${err.message}`, 'error');
    }
  }
});

confirmBtn.addEventListener('click', async () => {
  if (!currentHold) return;
  try {
    const data = await api(`/api/holds/${currentHold.id}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    });
    setSeats(data.seats);
    clearHold();
    showNotice(`Booking confirmed: ${data.booking.seatIds.join(', ')}`, 'success');
  } catch (err) {
    clearHold();
    showNotice(`Could not confirm hold: ${err.message}`, 'error');
    await refreshSeats();
  }
});

releaseBtn.addEventListener('click', async () => {
  if (!currentHold) return;
  try {
    const holdId = currentHold.id;
    const data = await api(`/api/holds/${holdId}`, {
      method: 'DELETE',
      body: JSON.stringify({ sessionId }),
    });
    setSeats(data.seats);
    clearHold();
    showNotice('Hold released.', 'info');
  } catch (err) {
    showNotice(`Could not release hold: ${err.message}`, 'error');
  }
});

function connectStream() {
  const source = new EventSource(`${API_BASE}/api/stream`);
  source.addEventListener('snapshot', (event) => {
    const data = JSON.parse(event.data);
    setSeats(data.seats);
  });
  source.addEventListener('seats', (event) => {
    const data = JSON.parse(event.data);
    setSeats(data.seats);
    if (currentHold && data.seats.some((s) => currentHold.seatIds.includes(s.id) && s.status !== 'held')) {
      clearHold();
    }
  });
  source.onerror = () => {
    console.warn('SSE disconnected; browser will retry automatically');
  };
}

refreshSeats().catch((err) => showNotice(`Failed to load seats: ${err.message}`, 'error'));
connectStream();
