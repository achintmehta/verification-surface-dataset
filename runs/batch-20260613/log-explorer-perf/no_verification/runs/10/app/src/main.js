import './styles.css';

const ROW_HEIGHT = 36;
const OVERSCAN = 12;
const MAX_LIMIT = 100;
const API = '';

const state = {
  total: 0,
  rows: [],
  windowStart: 0,
  loading: false,
  severity: '',
  q: '',
  seq: 0,
  controller: null,
  debounceTimer: null,
};

const app = document.querySelector('#app');
app.innerHTML = `
  <header class="topbar">
    <div>
      <h1>Log Explorer</h1>
      <p>100,000 deterministic rows, server-side filters, virtualized viewport.</p>
    </div>
    <div id="stats" class="stats">Loading stats…</div>
  </header>

  <section class="filters" aria-label="Filters">
    <label>
      Severity
      <select id="severity">
        <option value="">All severities</option>
        <option value="debug">debug</option>
        <option value="info">info</option>
        <option value="warn">warn</option>
        <option value="error">error</option>
      </select>
    </label>
    <label class="search-label">
      Search message
      <input id="search" type="search" placeholder="Try timeout, cache, needle-777…" autocomplete="off" />
    </label>
    <button id="clear" type="button">Clear</button>
    <span id="count" class="count">0 of 0</span>
  </section>

  <main class="table-shell">
    <div class="table-head" role="row">
      <span>Time</span><span>Severity</span><span>Service</span><span>Message</span>
    </div>
    <div id="scroller" class="scroller" tabindex="0" aria-label="Virtualized logs">
      <div id="spacer" class="spacer"></div>
      <div id="rows" class="rows"></div>
      <div id="empty" class="empty hidden">No logs match the current filters.</div>
      <div id="loading" class="loading hidden">Loading…</div>
    </div>
  </main>
`;

const els = {
  stats: document.querySelector('#stats'),
  severity: document.querySelector('#severity'),
  search: document.querySelector('#search'),
  clear: document.querySelector('#clear'),
  count: document.querySelector('#count'),
  scroller: document.querySelector('#scroller'),
  spacer: document.querySelector('#spacer'),
  rows: document.querySelector('#rows'),
  empty: document.querySelector('#empty'),
  loading: document.querySelector('#loading'),
};

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function fmtTime(ts) {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toISOString().replace('T', ' ').replace('.000Z', 'Z');
}

async function loadStats() {
  try {
    const res = await fetch(`${API}/api/stats`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const s = data.severities || {};
    els.stats.innerHTML = `
      <span class="pill">total ${Number(data.total || 0).toLocaleString()}</span>
      <span class="pill sev-debug">debug ${(s.debug || 0).toLocaleString()}</span>
      <span class="pill sev-info">info ${(s.info || 0).toLocaleString()}</span>
      <span class="pill sev-warn">warn ${(s.warn || 0).toLocaleString()}</span>
      <span class="pill sev-error">error ${(s.error || 0).toLocaleString()}</span>
    `;
  } catch (err) {
    els.stats.textContent = `Stats unavailable: ${err.message}`;
  }
}

function currentOffset() {
  return Math.max(0, Math.floor(els.scroller.scrollTop / ROW_HEIGHT));
}

function visibleCapacity() {
  return Math.ceil(els.scroller.clientHeight / ROW_HEIGHT) || 20;
}

function queryString(params) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== '' && value !== undefined && value !== null) qs.set(key, value);
  }
  return qs.toString();
}

async function fetchWindow(anchorOffset = currentOffset()) {
  const visible = visibleCapacity();
  const start = Math.max(0, anchorOffset - OVERSCAN);
  const limit = Math.min(MAX_LIMIT, visible + OVERSCAN * 2);
  const seq = ++state.seq;

  if (state.controller) state.controller.abort();
  state.controller = new AbortController();
  state.loading = true;
  renderStatus();

  const qs = queryString({
    offset: start,
    limit,
    severity: state.severity,
    q: state.q,
  });

  try {
    const res = await fetch(`${API}/api/logs?${qs}`, { signal: state.controller.signal });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `HTTP ${res.status}`);
    }
    const data = await res.json();
    if (seq !== state.seq) return;
    state.total = Number(data.total || 0);
    state.windowStart = start;
    state.rows = Array.isArray(data.rows) ? data.rows : [];
    state.loading = false;
    render();
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (seq !== state.seq) return;
    state.loading = false;
    els.rows.innerHTML = `<div class="error">${escapeHtml(err.message)}</div>`;
    renderStatus();
  }
}

function renderStatus() {
  els.spacer.style.height = `${state.total * ROW_HEIGHT}px`;
  els.loading.classList.toggle('hidden', !state.loading);
  els.empty.classList.toggle('hidden', state.loading || state.total !== 0);
  const showing = state.rows.length;
  const first = state.total === 0 || showing === 0 ? 0 : state.windowStart + 1;
  const last = showing === 0 ? 0 : Math.min(state.windowStart + showing, state.total);
  els.count.textContent = `${first}-${last} of ${state.total.toLocaleString()}`;
}

function render() {
  renderStatus();
  els.rows.style.transform = `translateY(${state.windowStart * ROW_HEIGHT}px)`;
  els.rows.innerHTML = state.rows.map((row, idx) => `
    <div class="log-row" role="row" data-offset="${state.windowStart + idx}" style="height:${ROW_HEIGHT}px">
      <span class="time" title="${escapeHtml(row.ts)}">${escapeHtml(fmtTime(row.ts))}</span>
      <span><b class="severity sev-${escapeHtml(row.severity)}">${escapeHtml(row.severity)}</b></span>
      <span class="service">${escapeHtml(row.service)}</span>
      <span class="message">${escapeHtml(row.message)}</span>
    </div>
  `).join('');
}

let raf = 0;
function scheduleScrollFetch() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    const offset = currentOffset();
    const lowWater = state.windowStart + OVERSCAN / 2;
    const highWater = state.windowStart + Math.max(0, state.rows.length - visibleCapacity() - OVERSCAN / 2);
    if (!state.rows.length || offset < lowWater || offset > highWater) {
      fetchWindow(offset);
    }
  });
}

function resetAndFetch() {
  state.rows = [];
  state.windowStart = 0;
  state.total = 0;
  els.scroller.scrollTop = 0;
  render();
  fetchWindow(0);
}

els.scroller.addEventListener('scroll', scheduleScrollFetch, { passive: true });
els.severity.addEventListener('change', () => {
  state.severity = els.severity.value;
  resetAndFetch();
});
els.search.addEventListener('input', () => {
  clearTimeout(state.debounceTimer);
  const next = els.search.value;
  state.debounceTimer = setTimeout(() => {
    state.q = next.trim();
    resetAndFetch();
  }, 250);
});
els.clear.addEventListener('click', () => {
  els.severity.value = '';
  els.search.value = '';
  state.severity = '';
  state.q = '';
  clearTimeout(state.debounceTimer);
  resetAndFetch();
});
window.addEventListener('resize', () => fetchWindow(currentOffset()));

loadStats();
fetchWindow(0);
