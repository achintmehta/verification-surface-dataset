import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const ROW_HEIGHT = 42;
const OVERSCAN = 8;
const PAGE_SIZE = 100;
const MAX_DOM_ROWS = 100;

const state = {
  total: 0,
  rows: new Map(),
  loading: false,
  severity: '',
  q: '',
  requestSeq: 0,
  abortController: null,
  stats: null,
  lastRange: { start: 0, end: 0 },
};

const app = document.querySelector('#app');
app.innerHTML = `
  <header class="topbar">
    <div>
      <h1>Log Explorer</h1>
      <p>100,000 deterministic rows, server-side filters, virtualized rendering.</p>
    </div>
    <div class="status" id="status">Booting…</div>
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
    <label class="search">
      Message contains
      <input id="search" type="search" placeholder="try: rare-needle, heartbeat, checkout" autocomplete="off" />
    </label>
    <div class="badges" id="badges"></div>
  </section>
  <section class="summary">
    <span id="visibleCount">0 of 0</span>
    <span id="rangeLabel"></span>
  </section>
  <main class="tableShell">
    <div class="headerRow grid">
      <div>Time</div>
      <div>Severity</div>
      <div>Service</div>
      <div>Message</div>
    </div>
    <div id="scroller" class="scroller" tabindex="0" aria-label="Virtualized log table">
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
  visibleCount: document.querySelector('#visibleCount'),
  rangeLabel: document.querySelector('#rangeLabel'),
  scroller: document.querySelector('#scroller'),
  spacer: document.querySelector('#spacer'),
  rows: document.querySelector('#rows'),
};

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), ms);
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function currentParams(extra = {}) {
  const params = new URLSearchParams();
  params.set('offset', String(extra.offset ?? 0));
  params.set('limit', String(extra.limit ?? PAGE_SIZE));
  if (state.severity) params.set('severity', state.severity);
  if (state.q) params.set('q', state.q);
  return params;
}

async function loadStats() {
  const res = await fetch(`${API_BASE}/api/stats`);
  if (!res.ok) throw new Error('stats request failed');
  state.stats = await res.json();
  renderBadges();
}

function renderBadges() {
  const sev = state.stats?.severities || {};
  els.badges.innerHTML = ['debug', 'info', 'warn', 'error']
    .map((s) => `<span class="badge sev-${s}">${s}: ${(sev[s] || 0).toLocaleString()}</span>`)
    .join('');
}

async function fetchWindow(offset, limit, reason = 'scroll') {
  const safeOffset = Math.max(0, Math.min(offset, Math.max(0, state.total - 1)));
  const seq = ++state.requestSeq;
  if (state.abortController) state.abortController.abort();
  state.abortController = new AbortController();
  state.loading = true;
  els.status.textContent = reason === 'filter' ? 'Filtering…' : 'Loading…';
  const started = performance.now();
  try {
    const params = currentParams({ offset: safeOffset, limit });
    const res = await fetch(`${API_BASE}/api/logs?${params}`, { signal: state.abortController.signal });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `request failed (${res.status})`);
    }
    const data = await res.json();
    if (seq !== state.requestSeq) return; // stale response

    state.total = data.total;
    state.rows.clear();
    data.rows.forEach((row, i) => state.rows.set(safeOffset + i, row));
    els.spacer.style.height = `${state.total * ROW_HEIGHT}px`;
    els.status.textContent = `${Math.round(performance.now() - started)} ms`;
    state.loading = false;
    render();
  } catch (err) {
    if (err.name !== 'AbortError') {
      els.status.textContent = err.message;
      console.error(err);
    }
  } finally {
    if (seq === state.requestSeq && state.loading) {
      state.loading = false;
      render();
    }
  }
}

function desiredRange() {
  const scrollTop = els.scroller.scrollTop;
  const viewportRows = Math.ceil(els.scroller.clientHeight / ROW_HEIGHT);
  const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
  const start = Math.max(0, firstVisible - OVERSCAN);
  const count = Math.min(MAX_DOM_ROWS, viewportRows + OVERSCAN * 2);
  const end = Math.min(state.total, start + count);
  return { start, end, firstVisible, viewportRows };
}

function hasRange(start, end) {
  if (end <= start) return true;
  for (let i = start; i < end; i++) {
    if (!state.rows.has(i)) return false;
  }
  return true;
}

function scheduleNeededFetch(range) {
  if (state.loading || state.total === 0) return;
  if (hasRange(range.start, range.end)) return;
  const pageOffset = Math.max(0, Math.min(range.start, Math.max(0, state.total - PAGE_SIZE)));
  fetchWindow(pageOffset, PAGE_SIZE);
}

function render() {
  const range = desiredRange();
  state.lastRange = range;
  els.rows.style.transform = `translateY(${range.start * ROW_HEIGHT}px)`;

  const fragments = [];
  for (let index = range.start; index < range.end; index++) {
    const row = state.rows.get(index);
    if (!row) {
      fragments.push(`<div class="logRow grid skeleton" style="height:${ROW_HEIGHT}px" data-offset="${index}">
        <div>offset ${index.toLocaleString()}</div><div></div><div></div><div>Loading…</div>
      </div>`);
      continue;
    }
    const ts = new Date(row.ts).toISOString().replace('T', ' ').replace('.000Z', 'Z');
    fragments.push(`<div class="logRow grid" style="height:${ROW_HEIGHT}px" data-offset="${index}" data-id="${row.id}">
      <div class="mono" title="${escapeHtml(row.ts)}">${escapeHtml(ts)}</div>
      <div><span class="pill sev-${row.severity}">${escapeHtml(row.severity)}</span></div>
      <div>${escapeHtml(row.service)}</div>
      <div class="message" title="${escapeHtml(row.message)}">${escapeHtml(row.message)}</div>
    </div>`);
  }
  els.rows.innerHTML = fragments.join('');
  const visible = Math.max(0, Math.min(range.end, state.total) - range.start);
  els.visibleCount.textContent = `${visible.toLocaleString()} of ${state.total.toLocaleString()}`;
  const top = state.total ? range.firstVisible + 1 : 0;
  const bottom = Math.min(state.total, range.firstVisible + range.viewportRows);
  els.rangeLabel.textContent = state.total ? `rows ${top.toLocaleString()}–${bottom.toLocaleString()}` : 'no matches';
  scheduleNeededFetch(range);
}

let raf = 0;
els.scroller.addEventListener('scroll', () => {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    render();
  });
});

els.severity.addEventListener('change', () => {
  state.severity = els.severity.value;
  applyFilters();
});

els.search.addEventListener('input', debounce(() => {
  state.q = els.search.value.trim();
  applyFilters();
}, 220));

function applyFilters() {
  state.rows.clear();
  state.total = 0;
  els.scroller.scrollTop = 0;
  els.spacer.style.height = '0px';
  render();
  fetchWindow(0, PAGE_SIZE, 'filter');
}

async function boot() {
  try {
    els.status.textContent = 'Connecting…';
    await Promise.all([loadStats(), fetchWindow(0, PAGE_SIZE, 'filter')]);
  } catch (err) {
    els.status.textContent = err.message;
    console.error(err);
  }
}

boot();
