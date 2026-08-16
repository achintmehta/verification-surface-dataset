import './style.css';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3000';
const SESSION_KEY = 'seat-booking-session-id';
const sessionId = localStorage.getItem(SESSION_KEY) || crypto.randomUUID();
localStorage.setItem(SESSION_KEY, sessionId);

document.querySelector('#app').innerHTML = `
  <main class="app">
    <section class="hero">
      <div><p class="eyebrow">Single Event</p><h1>Live Seat Booking</h1><p>Pick available seats, place a temporary hold, then confirm before the timer expires.</p></div>
      <div class="session-card"><span>Session</span><strong id="sessionId"></strong></div>
    </section>
    <section class="toolbar"><div class="legend"><span><i class="swatch available"></i>Available</span><span><i class="swatch selected"></i>Selected</span><span><i class="swatch held"></i>Held</span><span><i class="swatch booked"></i>Booked</span></div><div class="inventory" id="inventory">Loading inventory…</div></section>
    <section class="panel"><div class="controls"><button id="holdBtn">Hold selected seats</button><button id="confirmBtn" disabled>Confirm hold</button><button id="releaseBtn" disabled>Release hold</button><button id="refreshBtn" class="secondary">Refresh</button></div><div id="holdInfo" class="hold-info">No active hold.</div><div id="message" class="message"></div></section>
    <section class="seat-wrap"><div id="seatGrid" class="seat-grid" aria-live="polite"></div></section>
  </main>`;

document.getElementById('sessionId').textContent = sessionId;
const state = { seats: new Map(), selected: new Set(), currentHold: null, holdTimer: null, conflicts: new Set() };
const grid = document.getElementById('seatGrid');
const inventoryEl = document.getElementById('inventory');
const messageEl = document.getElementById('message');
const holdInfoEl = document.getElementById('holdInfo');
const holdBtn = document.getElementById('holdBtn');
const confirmBtn = document.getElementById('confirmBtn');
const releaseBtn = document.getElementById('releaseBtn');
const refreshBtn = document.getElementById('refreshBtn');
const showMessage = (t, k = '') => { messageEl.textContent = t; messageEl.className = `message ${k}`.trim(); };
function render() {
  const counts = { available: 0, held: 0, booked: 0 };
  const seats = [...state.seats.values()].sort((a,b)=>a.rowLabel.localeCompare(b.rowLabel)||a.seatNumber-b.seatNumber);
  seats.forEach(s => counts[s.status]++);
  inventoryEl.textContent = `Available ${counts.available} · Held ${counts.held} · Booked ${counts.booked} · Total ${state.seats.size}`;
  grid.innerHTML = '';
  const rows = [...new Set(seats.map(s => s.rowLabel))].sort();
  for (const row of rows) {
    const rowEl = document.createElement('div'); rowEl.className = 'row';
    rowEl.innerHTML = `<div class="row-label">${row}</div>`;
    for (const seat of seats.filter(s => s.rowLabel === row)) {
      const btn = document.createElement('button');
      const selected = state.selected.has(seat.id);
      btn.className = `seat ${selected ? 'selected' : seat.status}`; btn.textContent = seat.seatNumber; btn.title = `${seat.id}: ${seat.status}`;
      btn.disabled = seat.status !== 'available' && !selected;
      if (state.conflicts.has(seat.id)) btn.style.outline = '3px solid #ef4444';
      btn.onclick = () => { if (state.currentHold) return; selected ? state.selected.delete(seat.id) : state.selected.add(seat.id); state.conflicts.clear(); render(); };
      rowEl.appendChild(btn);
    }
    grid.appendChild(rowEl);
  }
  holdBtn.disabled = state.selected.size === 0 || !!state.currentHold; confirmBtn.disabled = !state.currentHold; releaseBtn.disabled = !state.currentHold;
}
async function loadSeats() { const r = await fetch(`${API}/api/seats`); const d = await r.json(); state.seats = new Map(d.seats.map(s => [s.id, s])); render(); }
function setHold(hold) { state.currentHold = hold; state.selected.clear(); if (state.holdTimer) clearInterval(state.holdTimer); if (!hold) { holdInfoEl.textContent = 'No active hold.'; render(); return; } const tick = () => { const ms = Math.max(0, new Date(hold.expiresAt) - Date.now()); holdInfoEl.textContent = `Hold ${hold.id.slice(0,8)} expires in ${Math.ceil(ms/1000)}s`; if (ms <= 0) { clearInterval(state.holdTimer); state.currentHold = null; loadSeats(); } render(); }; tick(); state.holdTimer = setInterval(tick, 500); }
holdBtn.onclick = async () => { const r = await fetch(`${API}/api/holds`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ seatIds:[...state.selected], sessionId }) }); const d = await r.json(); if (!r.ok) { state.conflicts = new Set((d.conflicts||[]).map(c=>c.id)); showMessage(d.error || 'Hold failed', 'error'); await loadSeats(); return; } d.seats.forEach(s=>state.seats.set(s.id,s)); setHold(d); showMessage('Seats held.', 'success'); };
confirmBtn.onclick = async () => { if (!state.currentHold) return; const r = await fetch(`${API}/api/holds/${state.currentHold.id}/confirm`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ sessionId }) }); const d = await r.json(); if (!r.ok) { showMessage(d.error || 'Confirm failed', 'error'); setHold(null); await loadSeats(); return; } d.seats.forEach(s=>state.seats.set(s.id,s)); setHold(null); showMessage('Booking confirmed.', 'success'); };
releaseBtn.onclick = async () => { if (!state.currentHold) return; await fetch(`${API}/api/holds/${state.currentHold.id}`, { method:'DELETE', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ sessionId }) }); setHold(null); await loadSeats(); showMessage('Hold released.', 'success'); };
refreshBtn.onclick = loadSeats;
function stream() { const es = new EventSource(`${API}/api/stream`); es.addEventListener('seats', e => { const m = JSON.parse(e.data); (m.seats||[]).forEach(s => { state.seats.set(s.id, { ...(state.seats.get(s.id)||{}), ...s }); if (s.status !== 'available') state.selected.delete(s.id); }); render(); }); es.onerror = () => showMessage('Live connection interrupted; retrying…', 'error'); }
loadSeats().then(stream).catch(e => showMessage(e.message, 'error'));
