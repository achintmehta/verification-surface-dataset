import './styles.css';

const ROW_HEIGHT = 36;
const OVERSCAN = 12;
const LIMIT = 120;
const API_BASE = '';

const app = document.querySelector('#app');
app.innerHTML = `
  <header class="topbar">
    <div>
      <h1>Log Explorer</h1>
      <p>100,000 deterministic PGLite-backed log rows, queried in windows.</p>
    </div>
    <div class="status" id="status">Booting…</div>
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
    <label class="searchLabel">Message contains
      <input id="search" type="search" placeholder="try: common, rare anomaly, checkout, stripe" autocomplete="off" />
    </label>
    <div id="badges" class="badges"></div>
    <div id="count" class="count">0 of 0</div>
  </section>
  <main class="tableShell">
    <div class="head row">
      <div>Timestamp</div><div>Severity</div><div>Service</div><div>Message</div>
    </div>
    <div id="scroller" class="scroller" role="table" aria-label="Virtualized logs">
      <div id="spacer" class="spacer"></div>
      <div id="rows" class="rows"></div>
    </div>
  </main>
`;

const els = {
  status: document.querySelector('#status'),
  severity: document.querySelector('#severity'),
  search: document.querySelector('#search'),
  badges: document.querySelector('#badges'),
  count: document.querySelector('#count'),
  scroller: document.querySelector('#scroller'),
  spacer: document.querySelector('#spacer'),
  rows: document.querySelector('#rows')
};

const state = {
  total: 0,
  rows: [],
  windowStart: 0,
  requestId: 0,
  controller: null,
  filters: { severity: '', q: '' },
  loading: false,
  debounce: null
};

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function escapeHtml(s) {
  return String(s).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}

async function fetchJson(url, signal) {
  const res = await fetch(url, { signal });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function paramsFor(offset) {
  const p = new URLSearchParams({ offset: String(Math.max(0, offset)), limit: String(LIMIT) });
  if (state.filters.severity) p.set('severity', state.filters.severity);
  if (state.filters.q) p.set('q', state.filters.q);
  return p;
}

async function loadWindow(offset, reason = 'scroll') {
  const maxOffset = Math.max(0, state.total - 1);
  const wanted = clamp(offset, 0, maxOffset);
  const requestId = ++state.requestId;
  if (state.controller) state.controller.abort();
  state.controller = new AbortController();
  state.loading = true;
  els.status.textContent = `Loading ${reason} window…`;
  try {
    const data = await fetchJson(`${API_BASE}/api/logs?${paramsFor(wanted)}`, state.controller.signal);
    if (requestId !== state.requestId) return;
    state.total = data.total;
    state.rows = data.rows;
    state.windowStart = wanted;
    state.loading = false;
    updateSpacer();
    render();
    els.status.textContent = `Ready · window ${wanted.toLocaleString()}-${(wanted + data.rows.length).toLocaleString()}`;
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (requestId !== state.requestId) return;
    state.loading = false;
    els.status.textContent = `Error: ${err.message}`;
  }
}

function visibleRange() {
  const top = els.scroller.scrollTop;
  const height = els.scroller.clientHeight || 500;
  const start = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(state.total, Math.ceil((top + height) / ROW_HEIGHT) + OVERSCAN);
  return { start, end };
}

let raf = 0;
function scheduleRender() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    const { start, end } = visibleRange();
    const bufferStart = state.windowStart;
    const bufferEnd = state.windowStart + state.rows.length;
    if (!state.loading && (start < bufferStart + 20 || end > bufferEnd - 20)) {
      loadWindow(Math.max(0, start - Math.floor((LIMIT - (end - start)) / 2)), 'scroll');
    }
    render();
  });
}

function updateSpacer() {
  els.spacer.style.height = `${state.total * ROW_HEIGHT}px`;
  els.count.textContent = `${state.rows.length.toLocaleString()} of ${state.total.toLocaleString()}`;
}

function rowHtml(row, index) {
  return `<div class="row logRow" role="row" data-index="${index}" style="top:${index * ROW_HEIGHT}px">
    <div class="mono">${escapeHtml(row.ts.replace('T', ' ').replace('.000Z', 'Z'))}</div>
    <div><span class="sev sev-${row.severity}">${row.severity}</span></div>
    <div>${escapeHtml(row.service)}</div>
    <div class="message">${escapeHtml(row.message)}</div>
  </div>`;
}

function render() {
  const { start, end } = visibleRange();
  const html = [];
  for (let i = start; i < end; i++) {
    const row = state.rows[i - state.windowStart];
    if (row) html.push(rowHtml(row, i));
  }
  els.rows.innerHTML = html.join('');
  els.count.textContent = `${html.length.toLocaleString()} visible / ${state.total.toLocaleString()} total`;
}

function applyFilters() {
  state.filters = { severity: els.severity.value, q: els.search.value.trim() };
  state.rows = [];
  state.windowStart = 0;
  state.total = 0;
  els.scroller.scrollTop = 0;
  updateSpacer();
  render();
  loadWindow(0, 'filter');
}

async function loadStats() {
  try {
    const data = await fetchJson(`${API_BASE}/api/stats`);
    els.badges.innerHTML = Object.entries(data.severities)
      .map(([sev, count]) => `<span class="badge sev-${sev}">${sev}: ${Number(count).toLocaleString()}</span>`)
      .join('');
  } catch (_) {
    els.badges.textContent = 'stats unavailable';
  }
}

els.scroller.addEventListener('scroll', scheduleRender, { passive: true });
els.severity.addEventListener('change', applyFilters);
els.search.addEventListener('input', () => {
  clearTimeout(state.debounce);
  state.debounce = setTimeout(applyFilters, 220);
});
window.addEventListener('resize', scheduleRender);

loadStats();
loadWindow(0, 'initial');
