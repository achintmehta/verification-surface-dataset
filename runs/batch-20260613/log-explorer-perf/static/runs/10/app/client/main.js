import './styles.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3000';
const ROW_HEIGHT = 42;
const OVERSCAN = 10;
const MAX_LIMIT = 200;
const FETCH_AHEAD = 25;
const state = {
  total: 0,
  rows: [],
  windowStart: 0,
  loading: false,
  severity: '',
  q: '',
  requestSeq: 0,
  abortController: null,
  stats: null,
};

const app = document.querySelector('#app');
app.innerHTML = `
  <header class="topbar">
    <div>
      <h1>Log Explorer</h1>
      <p>100,000 deterministic log entries · server-windowed · virtualized</p>
    </div>
    <div class="status" id="status">Booting…</div>
  </header>
  <section class="filters" aria-label="Log filters">
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
      <input id="search" type="search" placeholder="try heartbeat, needle-rare, timeout…" autocomplete="off" />
    </label>
    <div class="badges" id="badges"></div>
  </section>
  <section class="summary">
    <strong id="visibleCount">0 of 0</strong>
    <span id="rangeLabel">No rows loaded</span>
  </section>
  <main class="tableShell">
    <div class="tableHeader" role="row">
      <div>Timestamp</div><div>Severity</div><div>Service</div><div>Message</div>
    </div>
    <div id="scroller" class="scroller" tabindex="0" aria-label="Virtualized log table">
      <div id="spacer" class="spacer"></div>
      <div id="pool" class="pool"></div>
      <div id="empty" class="empty" hidden>No logs match the current filters.</div>
    </div>
  </main>
`;

const els = {
  status: document.querySelector('#status'),
  severity: document.querySelector('#severity'),
  search: document.querySelector('#search'),
  badges: document.querySelector('#badges'),
  visibleCount: document.querySelector('#visibleCount'),
  rangeLabel: document.querySelector('#rangeLabel'),
  scroller: document.querySelector('#scroller'),
  spacer: document.querySelector('#spacer'),
  pool: document.querySelector('#pool'),
  empty: document.querySelector('#empty'),
};

function debounce(fn, wait) {
  let id;
  return (...args) => {
    clearTimeout(id);
    id = setTimeout(() => fn(...args), wait);
  };
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function currentFirstVisible() {
  return Math.floor(els.scroller.scrollTop / ROW_HEIGHT);
}

function desiredWindow(firstVisible) {
  const viewportRows = Math.ceil(els.scroller.clientHeight / ROW_HEIGHT) || 20;
  const start = clamp(firstVisible - OVERSCAN, 0, Math.max(0, state.total - 1));
  const limit = clamp(viewportRows + OVERSCAN * 2 + FETCH_AHEAD, 1, MAX_LIMIT);
  return { start, limit, viewportRows };
}

function rowInCache(index) {
  return index >= state.windowStart && index < state.windowStart + state.rows.length;
}

function cacheCovers(start, limit) {
  const end = Math.min(state.total, start + limit);
  return start >= state.windowStart && end <= state.windowStart + state.rows.length;
}

function setStatus(text, busy = false) {
  els.status.textContent = text;
  els.status.classList.toggle('busy', busy);
}

function updateBadges() {
  const stats = state.stats;
  if (!stats) return;
  const items = [['all', stats.total], ...Object.entries(stats.severities)];
  els.badges.innerHTML = items.map(([name, count]) => `<span class="badge ${name}">${name}: ${count.toLocaleString()}</span>`).join('');
}

async function loadStats() {
  try {
    const res = await fetch(`${API_BASE}/api/stats`);
    if (!res.ok) throw new Error('stats failed');
    state.stats = await res.json();
    updateBadges();
  } catch {
    els.badges.textContent = 'Stats unavailable';
  }
}

async function fetchWindow(start, limit, reset = false) {
  const seq = ++state.requestSeq;
  if (state.abortController) state.abortController.abort();
  const controller = new AbortController();
  state.abortController = controller;
  state.loading = true;
  setStatus('Loading…', true);

  const params = new URLSearchParams({ offset: String(start), limit: String(limit) });
  if (state.severity) params.set('severity', state.severity);
  if (state.q) params.set('q', state.q);

  try {
    const res = await fetch(`${API_BASE}/api/logs?${params}`, { signal: controller.signal });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    if (seq !== state.requestSeq) return;
    state.total = data.total;
    state.windowStart = start;
    state.rows = data.rows;
    if (reset) els.scroller.scrollTop = 0;
    render();
    setStatus(`Loaded ${data.rows.length} row window`, false);
  } catch (err) {
    if (err.name !== 'AbortError') {
      setStatus(err.message || 'Request failed', false);
      console.error(err);
    }
  } finally {
    if (seq === state.requestSeq) state.loading = false;
  }
}

function ensureWindow() {
  if (state.total === 0 && state.rows.length === 0 && !state.loading) {
    fetchWindow(0, MAX_LIMIT);
    return;
  }
  const first = currentFirstVisible();
  const { start, limit, viewportRows } = desiredWindow(first);
  const neededStart = clamp(first - OVERSCAN, 0, Math.max(0, state.total - 1));
  const neededLimit = clamp(viewportRows + OVERSCAN * 2, 1, MAX_LIMIT);
  if (!cacheCovers(neededStart, neededLimit) && !state.loading) {
    fetchWindow(start, limit);
  }
}

function severityLabel(severity) {
  return `<span class="pill ${severity}">${severity}</span>`;
}

function render() {
  els.spacer.style.height = `${state.total * ROW_HEIGHT}px`;
  els.empty.hidden = state.total !== 0 || state.loading;

  const first = currentFirstVisible();
  const viewportRows = Math.ceil(els.scroller.clientHeight / ROW_HEIGHT) || 20;
  const renderStart = clamp(first - OVERSCAN, 0, Math.max(0, state.total));
  const renderEnd = clamp(first + viewportRows + OVERSCAN, 0, state.total);

  const fragments = [];
  let rendered = 0;
  for (let index = renderStart; index < renderEnd; index++) {
    if (!rowInCache(index)) continue;
    const row = state.rows[index - state.windowStart];
    rendered++;
    fragments.push(`
      <div class="logRow" role="row" data-index="${index}" style="transform: translateY(${index * ROW_HEIGHT}px)">
        <div class="ts">${new Date(row.ts).toISOString()}</div>
        <div>${severityLabel(row.severity)}</div>
        <div class="service">${row.service}</div>
        <div class="message" title="${escapeHtml(row.message)}">${escapeHtml(row.message)}</div>
      </div>`);
  }
  els.pool.innerHTML = fragments.join('');
  els.visibleCount.textContent = `${rendered.toLocaleString()} of ${state.total.toLocaleString()}`;
  if (state.total) {
    const end = Math.min(state.total, first + viewportRows);
    els.rangeLabel.textContent = `showing virtual rows ${Math.min(first + 1, state.total).toLocaleString()}–${end.toLocaleString()}`;
  } else {
    els.rangeLabel.textContent = 'No rows loaded';
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

let raf = 0;
els.scroller.addEventListener('scroll', () => {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    render();
    ensureWindow();
  });
});

els.severity.addEventListener('change', () => {
  state.severity = els.severity.value;
  state.rows = [];
  state.windowStart = 0;
  els.scroller.scrollTop = 0;
  fetchWindow(0, MAX_LIMIT, true);
});

els.search.addEventListener('input', debounce(() => {
  state.q = els.search.value.trim();
  state.rows = [];
  state.windowStart = 0;
  els.scroller.scrollTop = 0;
  fetchWindow(0, MAX_LIMIT, true);
}, 250));

window.addEventListener('resize', () => {
  render();
  ensureWindow();
});

loadStats();
fetchWindow(0, MAX_LIMIT, true);
