const API_BASE = window.API_BASE || window.location.origin;
const ROW_HEIGHT = 34;
const OVERSCAN = 12;
const FETCH_LIMIT = 120;
const sevOrder = ['debug', 'info', 'warn', 'error'];

const app = document.querySelector('#app');
app.innerHTML = `
  <header class="topbar">
    <div>
      <h1>Log Explorer</h1>
      <p>100,000 deterministic rows · server-windowed queries · virtualized DOM</p>
    </div>
    <div class="status" id="status">Starting…</div>
  </header>
  <section class="filters">
    <label>
      Severity
      <select id="severity">
        <option value="">All severities</option>
        <option value="debug">Debug</option>
        <option value="info">Info</option>
        <option value="warn">Warn</option>
        <option value="error">Error</option>
      </select>
    </label>
    <label class="search-label">
      Message contains
      <input id="search" type="search" autocomplete="off" spellcheck="false" placeholder="try: rare-needle, heartbeat, exception" />
    </label>
    <div id="badges" class="badges"></div>
    <div id="visibleCount" class="visible-count">0 of 0</div>
  </section>
  <main class="panel">
    <div class="table-head grid-row">
      <div>Timestamp</div><div>Severity</div><div>Service</div><div>Message</div>
    </div>
    <div id="scroller" class="scroller" tabindex="0" aria-label="Virtualized log rows">
      <div id="spacer" class="spacer"></div>
      <div id="rows" class="rows"></div>
      <div id="empty" class="empty hidden">No log rows match the active filters.</div>
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
const rowsLayer = document.querySelector('#rows');
const emptyEl = document.querySelector('#empty');

const state = {
  total: 0,
  severity: '',
  q: '',
  cache: new Map(),
  inFlight: null,
  requestSeq: 0,
  lastRenderedStart: -1,
  lastRenderedEnd: -1,
  loadingWindow: null,
};

function fmtDate(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toISOString().replace('T', ' ').replace('.000Z', 'Z');
}

function apiUrl(path, params = {}) {
  const url = new URL(path, API_BASE);
  for (const [k, v] of Object.entries(params)) {
    if (v !== '' && v != null) url.searchParams.set(k, v);
  }
  return url;
}

function setStatus(text, tone = '') {
  statusEl.textContent = text;
  statusEl.className = `status ${tone}`;
}

function updateSpacer() {
  spacer.style.height = `${state.total * ROW_HEIGHT}px`;
  emptyEl.classList.toggle('hidden', state.total !== 0);
}

function cacheRows(offset, rows) {
  rows.forEach((row, index) => state.cache.set(offset + index, row));
  // Keep memory bounded while allowing scroll jitter without refetching every frame.
  if (state.cache.size > 1200) {
    const firstVisible = Math.floor(scroller.scrollTop / ROW_HEIGHT);
    for (const key of [...state.cache.keys()]) {
      if (Math.abs(key - firstVisible) > 700) state.cache.delete(key);
    }
  }
}

function currentWindow() {
  const viewportRows = Math.ceil(scroller.clientHeight / ROW_HEIGHT) || 20;
  const first = Math.max(0, Math.floor(scroller.scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(state.total, first + viewportRows + OVERSCAN * 2);
  return { first, last, viewportRows };
}

function missingRange(first, last) {
  for (let i = first; i < last; i++) {
    if (!state.cache.has(i)) {
      const start = Math.max(0, Math.min(i, state.total - FETCH_LIMIT));
      return { offset: start, limit: Math.min(FETCH_LIMIT, state.total - start) };
    }
  }
  return null;
}

function renderRows() {
  const { first, last } = currentWindow();
  state.lastRenderedStart = first;
  state.lastRenderedEnd = last;
  const frag = document.createDocumentFragment();
  let rendered = 0;

  for (let index = first; index < last; index++) {
    const row = state.cache.get(index);
    if (!row) continue;
    const el = document.createElement('div');
    el.className = 'log-row grid-row';
    el.style.transform = `translateY(${index * ROW_HEIGHT}px)`;
    el.dataset.offset = String(index);
    el.dataset.id = String(row.id);
    el.innerHTML = `
      <div class="ts">${fmtDate(row.ts)}</div>
      <div><span class="sev sev-${row.severity}">${row.severity}</span></div>
      <div class="service">${row.service}</div>
      <div class="message" title="${escapeAttr(row.message)}">${escapeHtml(row.message)}</div>
    `;
    frag.appendChild(el);
    rendered++;
  }
  rowsLayer.replaceChildren(frag);
  const topRow = Math.min(state.total, Math.floor(scroller.scrollTop / ROW_HEIGHT) + 1);
  visibleCountEl.textContent = state.total ? `${topRow.toLocaleString()}-${Math.min(state.total, topRow + rendered - 1).toLocaleString()} of ${state.total.toLocaleString()}` : '0 of 0';

  const missing = missingRange(first, last);
  if (missing) fetchWindow(missing.offset, missing.limit);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}
function escapeAttr(value) { return escapeHtml(value).replace(/'/g, '&#39;'); }

async function fetchWindow(offset, limit) {
  if (limit <= 0) return;
  const key = `${offset}:${limit}:${state.severity}:${state.q}`;
  if (state.loadingWindow === key) return;
  state.loadingWindow = key;
  const seq = state.requestSeq;
  try {
    const url = apiUrl('/api/logs', { offset, limit, severity: state.severity, q: state.q });
    const started = performance.now();
    const res = await fetch(url);
    if (!res.ok) throw new Error(`API ${res.status}`);
    const data = await res.json();
    if (seq !== state.requestSeq) return;
    state.total = data.total;
    updateSpacer();
    cacheRows(offset, data.rows);
    setStatus(`Loaded ${data.rows.length} rows in ${Math.round(performance.now() - started)} ms`, 'ok');
    renderRows();
  } catch (err) {
    if (seq === state.requestSeq) setStatus(err.message || 'Failed to load rows', 'err');
  } finally {
    if (state.loadingWindow === key) state.loadingWindow = null;
  }
}

async function resetAndLoad() {
  state.requestSeq++;
  if (state.inFlight) state.inFlight.abort();
  state.cache.clear();
  rowsLayer.replaceChildren();
  state.total = 0;
  updateSpacer();
  scroller.scrollTop = 0;
  setStatus('Loading…');

  const seq = state.requestSeq;
  const controller = new AbortController();
  state.inFlight = controller;
  try {
    const url = apiUrl('/api/logs', { offset: 0, limit: FETCH_LIMIT, severity: state.severity, q: state.q });
    const started = performance.now();
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`API ${res.status}`);
    const data = await res.json();
    if (seq !== state.requestSeq) return;
    state.total = data.total;
    cacheRows(0, data.rows);
    updateSpacer();
    setStatus(`Loaded ${data.rows.length} rows in ${Math.round(performance.now() - started)} ms`, 'ok');
    renderRows();
  } catch (err) {
    if (err.name !== 'AbortError' && seq === state.requestSeq) setStatus(err.message || 'Failed to load rows', 'err');
  }
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

const debouncedSearch = debounce(() => {
  state.q = searchEl.value.trim();
  resetAndLoad();
}, 220);

severityEl.addEventListener('change', () => {
  state.severity = severityEl.value;
  resetAndLoad();
});
searchEl.addEventListener('input', debouncedSearch);

let raf = 0;
scroller.addEventListener('scroll', () => {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    renderRows();
  });
});
window.addEventListener('resize', renderRows);

async function loadStats() {
  try {
    const res = await fetch(apiUrl('/api/stats'));
    const stats = await res.json();
    const badges = [`<span class="badge all">all ${Number(stats.total).toLocaleString()}</span>`]
      .concat(sevOrder.map((s) => `<span class="badge sev-bg-${s}">${s} ${Number(stats.severities?.[s] || 0).toLocaleString()}</span>`));
    badgesEl.innerHTML = badges.join('');
  } catch {
    badgesEl.textContent = 'stats unavailable';
  }
}

loadStats();
resetAndLoad();
