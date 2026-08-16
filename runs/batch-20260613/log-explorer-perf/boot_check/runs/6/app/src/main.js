import './styles.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3000';
const ROW_HEIGHT = 36;
const HEADER_HEIGHT = 36;
const OVERSCAN = 12;
const PAGE_LIMIT = 160;
const MAX_DOM_ROWS = 100;

const app = document.querySelector('#app');
app.innerHTML = `
  <header class="topbar">
    <div>
      <h1>Log Explorer</h1>
      <p>100k deterministic logs, server-side filtering, virtualized rows.</p>
    </div>
    <div class="stats" id="stats">Loading stats…</div>
  </header>
  <section class="filters">
    <label>Severity
      <select id="severity">
        <option value="">All severities</option>
        <option value="debug">debug</option>
        <option value="info">info</option>
        <option value="warn">warn</option>
        <option value="error">error</option>
      </select>
    </label>
    <label class="searchLabel">Message contains
      <input id="search" type="search" placeholder="try timeout, cache, needle-critical-path…" autocomplete="off" />
    </label>
    <div id="visibleCount" class="visibleCount">0 of 0</div>
  </section>
  <main class="tableShell">
    <div class="head row">
      <div>Timestamp</div><div>Severity</div><div>Service</div><div>Message</div>
    </div>
    <div id="scroller" class="scroller">
      <div id="spacer" class="spacer"></div>
      <div id="rows" class="rows"></div>
    </div>
  </main>
  <footer class="hint">Only a small overscanned window is rendered. Query responses are capped at 200 rows.</footer>
`;

const severityEl = document.querySelector('#severity');
const searchEl = document.querySelector('#search');
const scroller = document.querySelector('#scroller');
const spacer = document.querySelector('#spacer');
const rowsEl = document.querySelector('#rows');
const visibleCountEl = document.querySelector('#visibleCount');
const statsEl = document.querySelector('#stats');

let state = {
  total: 0,
  severity: '',
  q: '',
  items: [],
  requestId: 0,
  controller: null,
  loading: false,
  lastStart: 0,
};

function fmtDate(ts) {
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

async function loadStats() {
  try {
    const r = await fetch(`${API_BASE}/api/stats`);
    const s = await r.json();
    statsEl.innerHTML = `Total <b>${s.total.toLocaleString()}</b> · debug ${s.severities.debug.toLocaleString()} · info ${s.severities.info.toLocaleString()} · warn ${s.severities.warn.toLocaleString()} · error ${s.severities.error.toLocaleString()}`;
  } catch {
    statsEl.textContent = 'Stats unavailable';
  }
}

function desiredWindow() {
  const viewportRows = Math.ceil(scroller.clientHeight / ROW_HEIGHT) || 20;
  const firstVisible = Math.max(0, Math.floor(scroller.scrollTop / ROW_HEIGHT));
  const count = Math.min(MAX_DOM_ROWS, viewportRows + OVERSCAN * 2);
  const start = Math.max(0, Math.min(Math.max(0, state.total - count), firstVisible - OVERSCAN));
  return { start, count };
}

async function fetchWindow(start, count) {
  const limit = Math.min(PAGE_LIMIT, Math.max(1, count));
  const reqId = ++state.requestId;
  if (state.controller) state.controller.abort();
  state.controller = new AbortController();
  state.loading = true;
  const params = new URLSearchParams({ offset: String(start), limit: String(limit) });
  if (state.severity) params.set('severity', state.severity);
  if (state.q) params.set('q', state.q);
  try {
    const r = await fetch(`${API_BASE}/api/logs?${params}`, { signal: state.controller.signal });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    if (reqId !== state.requestId) return; // stale response lost a race
    state.total = data.total;
    state.items = data.rows.map((row, i) => ({ ...row, __offset: start + i }));
    state.lastStart = start;
    state.loading = false;
    renderRows();
  } catch (e) {
    if (e.name !== 'AbortError') {
      rowsEl.innerHTML = `<div class="status">Failed to load logs</div>`;
      console.error(e);
    }
  }
}

function updateSpacer() {
  spacer.style.height = `${state.total * ROW_HEIGHT}px`;
}

function renderRows() {
  updateSpacer();
  rowsEl.innerHTML = '';
  rowsEl.style.transform = `translateY(${state.lastStart * ROW_HEIGHT}px)`;
  for (const row of state.items) {
    const el = document.createElement('div');
    el.className = 'row logRow';
    el.dataset.offset = row.__offset;
    el.innerHTML = `
      <div class="ts">${fmtDate(row.ts)}</div>
      <div><span class="sev ${row.severity}">${row.severity}</span></div>
      <div class="service">${row.service}</div>
      <div class="message" title="${escapeAttr(row.message)}">${escapeHtml(row.message)}</div>
    `;
    rowsEl.appendChild(el);
  }
  const first = state.items[0]?.__offset ?? 0;
  const last = state.items.length ? first + state.items.length : 0;
  visibleCountEl.textContent = `${state.items.length.toLocaleString()} of ${state.total.toLocaleString()}${state.total ? ` (showing ${first.toLocaleString()}–${(last - 1).toLocaleString()})` : ''}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s).replace(/'/g, '&#39;'); }

let scrollRaf = 0;
function scheduleWindowLoad() {
  cancelAnimationFrame(scrollRaf);
  scrollRaf = requestAnimationFrame(() => {
    const { start, count } = desiredWindow();
    const currentStart = state.items[0]?.__offset ?? -1;
    const currentEnd = currentStart + state.items.length;
    const firstVisible = Math.floor(scroller.scrollTop / ROW_HEIGHT);
    const lastVisible = firstVisible + Math.ceil(scroller.clientHeight / ROW_HEIGHT);
    const covered = firstVisible >= currentStart + 3 && lastVisible <= currentEnd - 3;
    if (!covered || state.items.length === 0) {
      fetchWindow(start, count);
    }
  });
}

function resetAndLoad() {
  state.severity = severityEl.value;
  state.q = searchEl.value.trim();
  state.items = [];
  state.total = 0;
  state.lastStart = 0;
  scroller.scrollTop = 0;
  updateSpacer();
  rowsEl.innerHTML = '<div class="status">Loading…</div>';
  fetchWindow(0, desiredWindow().count);
}

severityEl.addEventListener('change', resetAndLoad);
searchEl.addEventListener('input', debounce(resetAndLoad, 250));
scroller.addEventListener('scroll', scheduleWindowLoad, { passive: true });
window.addEventListener('resize', scheduleWindowLoad);

loadStats();
resetAndLoad();
