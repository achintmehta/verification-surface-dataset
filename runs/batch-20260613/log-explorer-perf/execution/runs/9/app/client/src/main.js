import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const ROW_HEIGHT = 34;
const OVERSCAN = 12;
const FETCH_LIMIT = 120;
const MAX_DOM_ROWS = 100;
const SEVERITIES = ['', 'debug', 'info', 'warn', 'error'];

const state = {
  total: 0,
  rows: [],
  windowStart: 0,
  loading: false,
  severity: '',
  q: '',
  requestSeq: 0,
  abort: null,
  stats: null,
};

const app = document.querySelector('#app');
app.innerHTML = `
  <header class="topbar">
    <div>
      <h1>Log Explorer</h1>
      <p>100k deterministic logs, server-side filtering, virtualized rendering.</p>
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
    <label class="searchLabel">Message contains
      <input id="search" type="search" placeholder="try: rare-unicorn, timeout, cache" autocomplete="off" />
    </label>
    <div class="badges" id="badges"></div>
  </section>
  <main class="panel">
    <div class="tableHead" aria-hidden="true">
      <div>Timestamp</div><div>Severity</div><div>Service</div><div>Message</div>
    </div>
    <div id="scroller" class="scroller" tabindex="0" aria-label="Virtualized log rows">
      <div id="spacer" class="spacer"></div>
      <div id="rows" class="rows"></div>
      <div id="empty" class="empty" hidden>No logs match the active filters.</div>
    </div>
  </main>
`;

const els = {
  status: document.querySelector('#status'),
  severity: document.querySelector('#severity'),
  search: document.querySelector('#search'),
  badges: document.querySelector('#badges'),
  scroller: document.querySelector('#scroller'),
  spacer: document.querySelector('#spacer'),
  rows: document.querySelector('#rows'),
  empty: document.querySelector('#empty'),
};

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function paramsFor(offset, limit) {
  const params = new URLSearchParams({ offset: String(offset), limit: String(limit) });
  if (state.severity) params.set('severity', state.severity);
  if (state.q) params.set('q', state.q);
  return params;
}

async function fetchStats() {
  const res = await fetch(`${API_BASE}/api/stats`);
  if (!res.ok) throw new Error('failed to load stats');
  state.stats = await res.json();
  renderBadges();
}

function renderBadges() {
  const stats = state.stats;
  if (!stats) {
    els.badges.textContent = '';
    return;
  }
  const parts = [`<span class="badge all">all ${stats.total.toLocaleString()}</span>`];
  for (const sev of SEVERITIES.slice(1)) {
    parts.push(`<span class="badge sev ${sev}">${sev} ${(stats.perSeverity?.[sev] ?? 0).toLocaleString()}</span>`);
  }
  els.badges.innerHTML = parts.join('');
}

function visibleRange() {
  const scrollTop = els.scroller.scrollTop;
  const viewportRows = Math.ceil(els.scroller.clientHeight / ROW_HEIGHT) || 1;
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const count = Math.min(MAX_DOM_ROWS, viewportRows + OVERSCAN * 2);
  const last = Math.min(state.total, first + count);
  return { first, last, count: Math.max(0, last - first) };
}

function hasWindow(first, last) {
  return first >= state.windowStart && last <= state.windowStart + state.rows.length;
}

function renderRows() {
  els.spacer.style.height = `${state.total * ROW_HEIGHT}px`;
  els.empty.hidden = state.loading || state.total !== 0;

  const { first, last } = visibleRange();
  if (!hasWindow(first, last) && !state.loading) {
    scheduleFetchFor(first);
  }

  const fragment = document.createDocumentFragment();
  const availableStart = Math.max(first, state.windowStart);
  const availableEnd = Math.min(last, state.windowStart + state.rows.length);

  for (let offset = availableStart; offset < availableEnd; offset++) {
    const row = state.rows[offset - state.windowStart];
    if (!row) continue;
    const div = document.createElement('div');
    div.className = 'logRow';
    div.dataset.offset = String(offset);
    div.style.transform = `translateY(${offset * ROW_HEIGHT}px)`;
    div.innerHTML = `
      <div class="ts">${escapeHtml(formatTs(row.ts))}</div>
      <div><span class="pill ${row.severity}">${row.severity}</span></div>
      <div class="service">${escapeHtml(row.service)}</div>
      <div class="message">${escapeHtml(row.message)}</div>
    `;
    fragment.appendChild(div);
  }
  els.rows.replaceChildren(fragment);
  els.status.textContent = statusText(availableEnd - availableStart, first);
}

function statusText(visible, first) {
  if (state.loading && state.total === 0) return 'Loading…';
  const from = state.total === 0 ? 0 : first + 1;
  const to = Math.min(state.total, first + visible);
  const filter = [state.severity || 'all', state.q ? `“${state.q}”` : ''].filter(Boolean).join(' ');
  return `${from.toLocaleString()}–${to.toLocaleString()} of ${state.total.toLocaleString()} ${filter}`;
}

function formatTs(ts) {
  const d = new Date(ts);
  return Number.isNaN(d.valueOf()) ? ts : d.toLocaleString();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

let raf = 0;
function onScroll() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    renderRows();
  });
}

function scheduleFetchFor(first) {
  const start = Math.max(0, Math.min(first - OVERSCAN, Math.max(0, state.total - FETCH_LIMIT)));
  void fetchWindow(start);
}

async function fetchWindow(offset = 0) {
  const seq = ++state.requestSeq;
  if (state.abort) state.abort.abort();
  const abort = new AbortController();
  state.abort = abort;
  state.loading = true;
  if (state.rows.length === 0) renderRows();

  const started = performance.now();
  try {
    const res = await fetch(`${API_BASE}/api/logs?${paramsFor(offset, FETCH_LIMIT)}`, { signal: abort.signal });
    if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
    const payload = await res.json();
    if (seq !== state.requestSeq) return;
    state.total = payload.total;
    state.windowStart = offset;
    state.rows = payload.rows;
    state.loading = false;
    renderRows();
    const elapsed = Math.round(performance.now() - started);
    els.status.title = `Last request ${elapsed}ms`;
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (seq !== state.requestSeq) return;
    console.error(err);
    state.loading = false;
    els.status.textContent = `Error: ${err.message}`;
  }
}

function resetAndFetch() {
  els.scroller.scrollTop = 0;
  state.rows = [];
  state.windowStart = 0;
  state.total = 0;
  renderRows();
  void fetchWindow(0);
}

els.scroller.addEventListener('scroll', onScroll, { passive: true });
els.severity.addEventListener('change', () => {
  state.severity = els.severity.value;
  resetAndFetch();
});
els.search.addEventListener('input', debounce(() => {
  state.q = els.search.value.trim();
  resetAndFetch();
}, 250));

fetchStats().catch(err => console.warn(err));
fetchWindow(0);
