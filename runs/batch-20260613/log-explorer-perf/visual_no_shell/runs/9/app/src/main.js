import './styles.css';

const API_BASE = import.meta.env.VITE_API_BASE || (location.port === '5173' ? 'http://localhost:3000' : '');
const ROW_HEIGHT = 36;
const OVERSCAN = 8;
const MAX_LIMIT = 200;

const state = {
  total: 0,
  rows: [],
  windowStart: 0,
  windowLimit: 120,
  severity: '',
  q: '',
  loading: false,
  requestId: 0,
  abort: null,
  stats: null
};

const app = document.querySelector('#app');
app.innerHTML = `
  <header class="topbar">
    <div>
      <h1>Log Explorer</h1>
      <p>Virtualized 100,000-row deterministic corpus</p>
    </div>
    <div class="stats" id="stats">Loading stats…</div>
  </header>
  <section class="filters">
    <label>Severity
      <select id="severity">
        <option value="">All severities</option>
        <option value="debug">Debug</option>
        <option value="info">Info</option>
        <option value="warn">Warn</option>
        <option value="error">Error</option>
      </select>
    </label>
    <label class="searchLabel">Message search
      <input id="search" type="search" placeholder="try timeout, success, rare-signal…" autocomplete="off" />
    </label>
    <div class="count" id="count">0 of 0</div>
  </section>
  <main class="tableShell">
    <div class="head row">
      <div>Timestamp</div><div>Severity</div><div>Service</div><div>Message</div>
    </div>
    <div class="scroller" id="scroller" tabindex="0" aria-label="Virtualized log rows">
      <div class="spacer" id="spacer"></div>
      <div class="pool" id="pool"></div>
      <div class="empty" id="empty">Loading logs…</div>
    </div>
  </main>
`;

const els = {
  stats: document.querySelector('#stats'),
  severity: document.querySelector('#severity'),
  search: document.querySelector('#search'),
  count: document.querySelector('#count'),
  scroller: document.querySelector('#scroller'),
  spacer: document.querySelector('#spacer'),
  pool: document.querySelector('#pool'),
  empty: document.querySelector('#empty')
};

function debounce(fn, ms) {
  let handle;
  return (...args) => {
    clearTimeout(handle);
    handle = setTimeout(() => fn(...args), ms);
  };
}

function filtersKey() {
  return `${state.severity}\n${state.q}`;
}

function buildUrl(offset, limit) {
  const url = new URL('/api/logs', API_BASE || location.origin);
  url.searchParams.set('offset', String(Math.max(0, offset)));
  url.searchParams.set('limit', String(Math.min(MAX_LIMIT, limit)));
  if (state.severity) url.searchParams.set('severity', state.severity);
  if (state.q) url.searchParams.set('q', state.q);
  return url;
}

async function fetchWindow(preferredStart = visibleStart()) {
  const viewportRows = Math.ceil(els.scroller.clientHeight / ROW_HEIGHT) || 20;
  const limit = Math.min(MAX_LIMIT, Math.max(60, viewportRows + OVERSCAN * 2 + 40));
  const maxStart = Math.max(0, state.total - limit);
  const offset = Math.max(0, Math.min(preferredStart - OVERSCAN, maxStart));
  const requestId = ++state.requestId;
  const key = filtersKey();
  if (state.abort) state.abort.abort();
  state.abort = new AbortController();
  state.loading = true;
  updateEmpty();
  try {
    const res = await fetch(buildUrl(offset, limit), { signal: state.abort.signal });
    if (!res.ok) throw new Error(`Request failed: ${res.status}`);
    const data = await res.json();
    if (requestId !== state.requestId || key !== filtersKey()) return;
    state.total = data.total;
    state.rows = data.rows;
    state.windowStart = offset;
    state.windowLimit = limit;
    state.loading = false;
    render();
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error(err);
    if (requestId === state.requestId) {
      state.loading = false;
      els.empty.textContent = 'Failed to load logs';
      els.empty.hidden = false;
    }
  }
}

function visibleStart() {
  return Math.max(0, Math.floor(els.scroller.scrollTop / ROW_HEIGHT));
}
function visibleRange() {
  const start = visibleStart();
  const count = Math.ceil(els.scroller.clientHeight / ROW_HEIGHT) || 20;
  return {
    start: Math.max(0, start - OVERSCAN),
    end: Math.min(state.total, start + count + OVERSCAN)
  };
}
function windowCovers(start, end) {
  return start >= state.windowStart && end <= state.windowStart + state.rows.length;
}
function ensureWindow() {
  const { start, end } = visibleRange();
  if (!windowCovers(start, end)) fetchWindow(start);
}

function formatTs(ts) {
  return new Date(ts).toLocaleString(undefined, { hour12: false });
}
function rowHtml(row, absoluteIndex) {
  return `<div class="row logRow" data-index="${absoluteIndex}" style="transform: translateY(${absoluteIndex * ROW_HEIGHT}px)">
    <div class="ts">${formatTs(row.ts)}</div>
    <div><span class="sev ${row.severity}">${row.severity}</span></div>
    <div class="svc">${row.service}</div>
    <div class="msg" title="${escapeHtml(row.message)}">${escapeHtml(row.message)}</div>
  </div>`;
}
function escapeHtml(v) {
  return String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function render() {
  els.spacer.style.height = `${state.total * ROW_HEIGHT}px`;
  const { start, end } = visibleRange();
  const html = [];
  for (let i = start; i < end; i++) {
    const local = i - state.windowStart;
    const row = state.rows[local];
    if (row) html.push(rowHtml(row, i));
  }
  els.pool.innerHTML = html.join('');
  els.count.textContent = `${Math.min(end, state.total).toLocaleString()} of ${state.total.toLocaleString()}`;
  updateEmpty();
  ensureWindow();
}

function updateEmpty() {
  const none = !state.loading && state.total === 0;
  const initial = state.loading && state.rows.length === 0;
  els.empty.hidden = !(none || initial);
  els.empty.textContent = none ? 'No logs match the active filters' : 'Loading logs…';
}

const onScroll = (() => {
  let raf = 0;
  return () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      render();
    });
  };
})();

function resetAndFetch() {
  state.rows = [];
  state.windowStart = 0;
  state.total = 0;
  els.scroller.scrollTop = 0;
  render();
  fetchWindow(0);
}

async function loadStats() {
  const res = await fetch(new URL('/api/stats', API_BASE || location.origin));
  const data = await res.json();
  state.stats = data;
  els.stats.innerHTML = `
    <b>${data.total.toLocaleString()}</b> rows
    <span class="badge debug">debug ${data.severity.debug.toLocaleString()}</span>
    <span class="badge info">info ${data.severity.info.toLocaleString()}</span>
    <span class="badge warn">warn ${data.severity.warn.toLocaleString()}</span>
    <span class="badge error">error ${data.severity.error.toLocaleString()}</span>`;
}

els.scroller.addEventListener('scroll', onScroll, { passive: true });
els.severity.addEventListener('change', () => {
  state.severity = els.severity.value;
  resetAndFetch();
});
els.search.addEventListener('input', debounce(() => {
  state.q = els.search.value.trim();
  resetAndFetch();
}, 180));
window.addEventListener('resize', render);

loadStats().catch(console.error);
fetchWindow(0);
