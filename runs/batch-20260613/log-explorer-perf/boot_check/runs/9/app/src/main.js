import './style.css';

const API = location.port === '5173' ? 'http://localhost:3000' : '';
const ROW_HEIGHT = 34;
const OVERSCAN = 12;
const LIMIT = 100;

let total = 0;
let cacheStart = -1;
let cacheRows = [];
let queryVersion = 0;
let aborter = null;
let state = { severity: '', q: '' };

const app = document.querySelector('#app');
app.innerHTML = `
  <header>
    <div>
      <h1>Log Explorer</h1>
      <p>100,000 deterministic rows, server-windowed and virtualized.</p>
    </div>
    <div id="stats" class="stats">Loading stats…</div>
  </header>
  <section class="toolbar">
    <label>Severity
      <select id="severity">
        <option value="">All</option>
        <option value="debug">Debug</option>
        <option value="info">Info</option>
        <option value="warn">Warn</option>
        <option value="error">Error</option>
      </select>
    </label>
    <label class="search">Search message
      <input id="search" type="search" placeholder="timeout, cache, user-42…" autocomplete="off" />
    </label>
    <strong id="count">0 of 0</strong>
  </section>
  <div class="tableHead">
    <span>Timestamp</span><span>Severity</span><span>Service</span><span>Message</span>
  </div>
  <main id="scroller" class="scroller">
    <div id="spacer" class="spacer"></div>
    <div id="rows" class="rows"></div>
  </main>
`;

const scroller = document.querySelector('#scroller');
const spacer = document.querySelector('#spacer');
const rowsEl = document.querySelector('#rows');
const countEl = document.querySelector('#count');
const severityEl = document.querySelector('#severity');
const searchEl = document.querySelector('#search');
const statsEl = document.querySelector('#stats');

function qs(params) {
  const u = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v !== '' && v != null) u.set(k, v); });
  return u.toString();
}

async function loadStats() {
  try {
    const res = await fetch(`${API}/api/stats`);
    const s = await res.json();
    statsEl.innerHTML = `Total <b>${s.total.toLocaleString()}</b> ` +
      ['debug','info','warn','error'].map(x => `<span class="pill ${x}">${x}: ${s.perSeverity[x].toLocaleString()}</span>`).join(' ');
  } catch { statsEl.textContent = 'Stats unavailable'; }
}

async function requestWindow(offset) {
  const version = ++queryVersion;
  if (aborter) aborter.abort();
  aborter = new AbortController();
  const centered = Math.max(0, offset - OVERSCAN);
  const url = `${API}/api/logs?${qs({ offset: centered, limit: LIMIT, severity: state.severity, q: state.q })}`;
  try {
    const res = await fetch(url, { signal: aborter.signal });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    if (version !== queryVersion) return;
    total = data.total;
    cacheStart = centered;
    cacheRows = data.rows;
    spacer.style.height = `${total * ROW_HEIGHT}px`;
    render();
  } catch (e) {
    if (e.name !== 'AbortError') console.error(e);
  }
}

function rowHtml(row) {
  return `<div class="row" data-id="${row.id}">
    <span class="ts">${new Date(row.ts).toLocaleString()}</span>
    <span><b class="sev ${row.severity}">${row.severity}</b></span>
    <span class="service">${row.service}</span>
    <span class="msg">${escapeHtml(row.message)}</span>
  </div>`;
}
function escapeHtml(s) {
  return s.replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}

let ticking = false;
function onScroll() {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => { ticking = false; render(); });
}

function render() {
  const firstVisible = Math.max(0, Math.floor(scroller.scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(scroller.clientHeight / ROW_HEIGHT) + OVERSCAN * 2;
  const needStart = firstVisible;
  const needEnd = Math.min(total, firstVisible + visibleCount);
  if (total === 0) {
    countEl.textContent = `0 of 0`;
    rowsEl.style.transform = 'translateY(0px)';
    rowsEl.innerHTML = '<div class="empty">No matching logs</div>';
    return;
  }
  const cacheEnd = cacheStart + cacheRows.length;
  if (cacheStart < 0 || needStart < cacheStart || needEnd > cacheEnd) {
    requestWindow(needStart);
  }
  const sliceStart = Math.max(needStart, cacheStart);
  const sliceEnd = Math.min(needEnd, cacheEnd);
  const rows = cacheRows.slice(sliceStart - cacheStart, sliceEnd - cacheStart);
  countEl.textContent = `${rows.length.toLocaleString()} of ${total.toLocaleString()}`;
  rowsEl.style.transform = `translateY(${sliceStart * ROW_HEIGHT}px)`;
  rowsEl.innerHTML = rows.map(rowHtml).join('');
}

function resetAndLoad() {
  cacheStart = -1;
  cacheRows = [];
  total = 0;
  spacer.style.height = '0px';
  rowsEl.innerHTML = '<div class="empty">Loading…</div>';
  scroller.scrollTop = 0;
  requestWindow(0);
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

severityEl.addEventListener('change', () => {
  state.severity = severityEl.value;
  resetAndLoad();
});
searchEl.addEventListener('input', debounce(() => {
  state.q = searchEl.value.trim();
  resetAndLoad();
}, 180));
scroller.addEventListener('scroll', onScroll, { passive: true });
window.addEventListener('resize', render);

loadStats();
resetAndLoad();
