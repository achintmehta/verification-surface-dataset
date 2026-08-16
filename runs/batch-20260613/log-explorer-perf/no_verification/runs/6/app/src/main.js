import './styles.css';

const API = '';
const ROW_HEIGHT = 34;
const OVERSCAN = 12;
const MAX_LIMIT = 200;
const PAGE_SIZE = 100;
const severities = ['', 'debug', 'info', 'warn', 'error'];

const app = document.querySelector('#app');
app.innerHTML = `
  <header class="topbar">
    <div>
      <h1>Log Explorer</h1>
      <p>100k deterministic rows, server-windowed and virtualized.</p>
    </div>
    <div class="status" id="status">Starting…</div>
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
    <label class="search-label">Message contains
      <input id="search" type="search" placeholder="e.g. timeout, cache, region=iad" autocomplete="off" />
    </label>
    <div id="badges" class="badges"></div>
    <div id="visibleCount" class="visible-count">0 of 0</div>
  </section>
  <main class="table-shell">
    <div class="table-head grid-row">
      <div>Timestamp</div><div>Severity</div><div>Service</div><div>Message</div>
    </div>
    <div id="scroller" class="scroller" tabindex="0" aria-label="Virtualized log rows">
      <div id="spacer" class="spacer"></div>
      <div id="rows" class="rows"></div>
    </div>
  </main>
`;

const statusEl = document.querySelector('#status');
const severityEl = document.querySelector('#severity');
const searchEl = document.querySelector('#search');
const badgesEl = document.querySelector('#badges');
const visibleCountEl = document.querySelector('#visibleCount');
const scroller = document.querySelector('#scroller');
const spacer = document.querySelector('#spacer');
const rowsEl = document.querySelector('#rows');

let state = {
  total: 0,
  severity: '',
  q: '',
  windowStart: -1,
  rows: [],
  requestSeq: 0,
  abortController: null,
  debounceId: null,
  loading: false,
};

function qs(params) {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== '' && v !== undefined && v !== null) out.set(k, v);
  }
  return out.toString();
}

function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}

function formatTime(ts) {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toISOString().replace('T', ' ').replace('.000Z', 'Z');
}

async function loadStats() {
  try {
    const res = await fetch(`${API}/api/stats`);
    if (!res.ok) throw new Error(`stats ${res.status}`);
    const stats = await res.json();
    const counts = stats.bySeverity || {};
    badgesEl.innerHTML = severities.slice(1).map((sev) => `<span class="badge ${sev}">${sev}<b>${(counts[sev] || 0).toLocaleString()}</b></span>`).join('');
  } catch (err) {
    badgesEl.textContent = 'Stats unavailable';
  }
}

function computeRange() {
  const viewportRows = Math.ceil(scroller.clientHeight / ROW_HEIGHT) || 1;
  const firstVisible = Math.floor(scroller.scrollTop / ROW_HEIGHT);
  const start = Math.max(0, firstVisible - OVERSCAN);
  // Keep the rendered DOM bounded (normally ~40-60 rows, hard-capped at 100).
  const needed = Math.min(PAGE_SIZE, viewportRows + OVERSCAN * 2);
  const limit = Math.max(1, needed);
  return { start, limit, viewportRows };
}

function currentFilters() {
  return { severity: state.severity, q: state.q };
}

function sameFilters(a, b) {
  return a.severity === b.severity && a.q === b.q;
}

async function fetchWindow(start, limit) {
  const seq = ++state.requestSeq;
  const filters = currentFilters();
  if (state.abortController) state.abortController.abort();
  const controller = new AbortController();
  state.abortController = controller;
  state.loading = true;
  setStatus('Loading…');
  try {
    const query = qs({ offset: start, limit, ...filters });
    const res = await fetch(`${API}/api/logs?${query}`, { signal: controller.signal });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    if (seq !== state.requestSeq || !sameFilters(filters, currentFilters())) return;
    const clampedStart = data.total > 0 ? Math.min(start, Math.max(0, data.total - 1)) : 0;
    state.total = data.total;
    state.windowStart = clampedStart;
    state.rows = data.rows || [];
    state.loading = false;
    spacer.style.height = `${state.total * ROW_HEIGHT}px`;
    if (start !== clampedStart && scroller.scrollTop > state.total * ROW_HEIGHT) {
      scroller.scrollTop = clampedStart * ROW_HEIGHT;
    }
    renderRows();
    setStatus('Ready', 'ok');
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (seq !== state.requestSeq) return;
    state.loading = false;
    setStatus(err.message, 'error');
  }
}

function ensureWindow({ force = false } = {}) {
  const { start, limit } = computeRange();
  const end = start + limit;
  const loadedStart = state.windowStart;
  const loadedEnd = loadedStart + state.rows.length;
  const covers = loadedStart <= start && loadedEnd >= end;
  if (force || !covers) fetchWindow(start, limit);
  else renderRows();
}

function renderRows() {
  const top = state.windowStart < 0 ? 0 : state.windowStart * ROW_HEIGHT;
  rowsEl.style.transform = `translateY(${top}px)`;
  rowsEl.innerHTML = state.rows.map((row, i) => {
    const absolute = state.windowStart + i;
    return `<div class="log-row grid-row" style="height:${ROW_HEIGHT}px" data-index="${absolute}">
      <div class="mono" title="${escapeHtml(row.ts)}">${escapeHtml(formatTime(row.ts))}</div>
      <div><span class="sev ${escapeHtml(row.severity)}">${escapeHtml(row.severity)}</span></div>
      <div>${escapeHtml(row.service)}</div>
      <div class="message" title="${escapeHtml(row.message)}">${escapeHtml(row.message)}</div>
    </div>`;
  }).join('');
  const firstVisible = Math.floor(scroller.scrollTop / ROW_HEIGHT);
  const lastVisible = Math.min(state.total, firstVisible + (Math.ceil(scroller.clientHeight / ROW_HEIGHT) || 1));
  visibleCountEl.textContent = `${Math.max(0, lastVisible - firstVisible).toLocaleString()} of ${state.total.toLocaleString()}`;
}

function resetAndLoad() {
  state.severity = severityEl.value;
  state.q = searchEl.value.trim();
  state.total = 0;
  state.windowStart = -1;
  state.rows = [];
  scroller.scrollTop = 0;
  spacer.style.height = '0px';
  rowsEl.innerHTML = '';
  visibleCountEl.textContent = '0 of 0';
  ensureWindow({ force: true });
}

let ticking = false;
scroller.addEventListener('scroll', () => {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => {
    ticking = false;
    renderRows();
    ensureWindow();
  });
});

severityEl.addEventListener('change', resetAndLoad);
searchEl.addEventListener('input', () => {
  window.clearTimeout(state.debounceId);
  state.debounceId = window.setTimeout(resetAndLoad, 220);
});

window.addEventListener('resize', () => ensureWindow({ force: true }));

loadStats();
resetAndLoad();
