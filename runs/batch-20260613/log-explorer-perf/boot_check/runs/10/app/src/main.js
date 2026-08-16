import './styles.css';

const ROW_HEIGHT = 34;
const OVERSCAN = 12;
const MAX_LIMIT = 200;
const API = '';

const app = document.querySelector('#app');
app.innerHTML = `
  <header class="toolbar">
    <div>
      <h1>Log Explorer</h1>
      <p>100k deterministic logs, server-side windows, virtualized rows</p>
    </div>
    <label>Severity
      <select id="severity">
        <option value="">All severities</option>
        <option value="debug">Debug</option>
        <option value="info">Info</option>
        <option value="warn">Warn</option>
        <option value="error">Error</option>
      </select>
    </label>
    <label class="searchLabel">Search message
      <input id="search" type="search" placeholder="try request, timeout, rare-critical" autocomplete="off" />
    </label>
    <div id="counts" class="counts">Loading…</div>
  </header>
  <main>
    <div class="tableHead" role="row">
      <span>Timestamp</span><span>Severity</span><span>Service</span><span>Message</span>
    </div>
    <div id="scroller" class="scroller" tabindex="0">
      <div id="spacer" class="spacer"></div>
      <div id="rows" class="rows"></div>
    </div>
    <div class="status"><span id="visibleCount">0 of 0</span><span id="loading"></span></div>
  </main>
`;

const scroller = document.querySelector('#scroller');
const spacer = document.querySelector('#spacer');
const rowsEl = document.querySelector('#rows');
const severityEl = document.querySelector('#severity');
const searchEl = document.querySelector('#search');
const countsEl = document.querySelector('#counts');
const visibleCountEl = document.querySelector('#visibleCount');
const loadingEl = document.querySelector('#loading');

const state = {
  total: 0,
  rows: [],
  windowStart: 0,
  requestSeq: 0,
  abort: null,
  q: '',
  severity: '',
  loading: false,
  stats: null
};

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function paramsFor(offset, limit) {
  const params = new URLSearchParams({ offset: String(offset), limit: String(limit) });
  if (state.severity) params.set('severity', state.severity);
  if (state.q) params.set('q', state.q);
  return params;
}

function viewportPlan() {
  const visible = Math.ceil(scroller.clientHeight / ROW_HEIGHT) || 20;
  const first = Math.max(0, Math.floor(scroller.scrollTop / ROW_HEIGHT) - OVERSCAN);
  const desired = Math.min(MAX_LIMIT, visible + OVERSCAN * 2);
  const limit = Math.max(1, Math.min(desired, Math.max(0, state.total - first) || desired));
  return { first, limit, visible };
}

async function fetchWindow(force = false) {
  const { first, limit } = viewportPlan();
  const currentEnd = state.windowStart + state.rows.length;
  if (!force && first >= state.windowStart && first + limit <= currentEnd) {
    render();
    return;
  }
  const seq = ++state.requestSeq;
  if (state.abort) state.abort.abort();
  state.abort = new AbortController();
  state.loading = true;
  loadingEl.textContent = 'Loading…';
  try {
    const res = await fetch(`${API}/api/logs?${paramsFor(first, limit)}`, { signal: state.abort.signal });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    if (seq !== state.requestSeq) return; // stale response
    state.total = data.total;
    state.windowStart = first;
    state.rows = data.rows;
    spacer.style.height = `${state.total * ROW_HEIGHT}px`;
    render();
  } catch (err) {
    if (err.name !== 'AbortError') {
      rowsEl.innerHTML = `<div class="error">${err.message}</div>`;
      console.error(err);
    }
  } finally {
    if (seq === state.requestSeq) {
      state.loading = false;
      loadingEl.textContent = '';
    }
  }
}

function rowHtml(row, absoluteIndex) {
  const date = new Date(row.ts).toLocaleString();
  return `<div class="logRow" role="row" data-index="${absoluteIndex}" style="transform: translateY(${absoluteIndex * ROW_HEIGHT}px)">
    <span class="ts">${date}</span>
    <span class="sev sev-${row.severity}">${row.severity}</span>
    <span class="svc">${row.service}</span>
    <span class="msg"></span>
  </div>`;
}

function render() {
  rowsEl.innerHTML = state.rows.map((r, i) => rowHtml(r, state.windowStart + i)).join('');
  [...rowsEl.querySelectorAll('.msg')].forEach((el, i) => { el.textContent = state.rows[i].message; });
  const { first, visible } = viewportPlan();
  const showing = Math.max(0, Math.min(visible, state.total - first));
  visibleCountEl.textContent = `${showing} visible (${state.rows.length} in DOM) of ${state.total.toLocaleString()}`;
  updateCounts();
}

function updateCounts() {
  if (!state.stats) return;
  const sev = state.stats.severities;
  countsEl.textContent = `Total ${state.stats.total.toLocaleString()} · debug ${sev.debug.toLocaleString()} · info ${sev.info.toLocaleString()} · warn ${sev.warn.toLocaleString()} · error ${sev.error.toLocaleString()}`;
}

async function loadStats() {
  const res = await fetch(`${API}/api/stats`);
  state.stats = await res.json();
  updateCounts();
}

function resetAndFetch() {
  state.severity = severityEl.value;
  state.q = searchEl.value.trim();
  state.rows = [];
  state.windowStart = 0;
  state.total = 0;
  scroller.scrollTop = 0;
  spacer.style.height = '0px';
  fetchWindow(true);
}

let raf = 0;
scroller.addEventListener('scroll', () => {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    fetchWindow(false);
  });
}, { passive: true });

severityEl.addEventListener('change', resetAndFetch);
searchEl.addEventListener('input', debounce(resetAndFetch, 250));
window.addEventListener('resize', () => fetchWindow(true));

loadStats().catch(console.error);
fetchWindow(true);
