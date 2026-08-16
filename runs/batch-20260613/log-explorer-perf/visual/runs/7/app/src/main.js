import './styles.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3000';
const ROW_HEIGHT = 34;
const HEADER_HEIGHT = 0;
const OVERSCAN = 12;
const PAGE_LIMIT = 200;
const FETCH_DEBOUNCE_MS = 60;
const SEARCH_DEBOUNCE_MS = 250;

const app = document.querySelector('#app');
app.innerHTML = `
  <header class="topbar">
    <div>
      <h1>Log Explorer</h1>
      <p>100,000 deterministic rows, server-windowed and virtualized</p>
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
    <label class="searchLabel">Message contains
      <input id="search" type="search" placeholder="e.g. timeout, payment, tenant-42" autocomplete="off" />
    </label>
    <button id="clear" type="button">Clear</button>
    <div class="visibleCount" id="visibleCount">0 of 0</div>
  </section>
  <main class="panel">
    <div class="tableHeader" aria-hidden="true">
      <div>Timestamp</div><div>Severity</div><div>Service</div><div>Message</div>
    </div>
    <div id="scroller" class="scroller" tabindex="0">
      <div id="spacer" class="spacer"></div>
      <div id="rows" class="rows"></div>
    </div>
  </main>
  <footer class="help">Only the viewport rows plus overscan are in the DOM. Scroll to the top, middle, or bottom without loading all rows.</footer>
`;

const els = {
  stats: document.querySelector('#stats'),
  severity: document.querySelector('#severity'),
  search: document.querySelector('#search'),
  clear: document.querySelector('#clear'),
  visibleCount: document.querySelector('#visibleCount'),
  scroller: document.querySelector('#scroller'),
  spacer: document.querySelector('#spacer'),
  rows: document.querySelector('#rows')
};

let state = {
  total: 0,
  rows: [],
  windowOffset: 0,
  windowLimit: PAGE_LIMIT,
  loading: false,
  severity: '',
  q: '',
  requestSeq: 0,
  abortController: null,
  renderTimer: 0,
  searchTimer: 0,
  lastRenderedRange: [-1, -1]
};

function fmt(n) {
  return Number(n || 0).toLocaleString();
}

function severityBadge(sev) {
  return `<span class="badge ${sev}">${sev}</span>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function rowHtml(row, absoluteIndex) {
  const ts = new Date(row.ts).toISOString().replace('T', ' ').replace('Z', '');
  return `<div class="logRow" data-index="${absoluteIndex}" style="transform: translateY(${absoluteIndex * ROW_HEIGHT}px)">
    <div class="ts">${escapeHtml(ts)}</div>
    <div>${severityBadge(row.severity)}</div>
    <div class="service">${escapeHtml(row.service)}</div>
    <div class="message">${escapeHtml(row.message)}</div>
  </div>`;
}

async function loadStats() {
  try {
    const res = await fetch(`${API_BASE}/api/stats`);
    const data = await res.json();
    els.stats.innerHTML = `
      <strong>${fmt(data.total)}</strong> total
      <span class="mini debug">debug ${fmt(data.severities.debug)}</span>
      <span class="mini info">info ${fmt(data.severities.info)}</span>
      <span class="mini warn">warn ${fmt(data.severities.warn)}</span>
      <span class="mini error">error ${fmt(data.severities.error)}</span>`;
  } catch (err) {
    els.stats.textContent = 'Stats unavailable';
  }
}

function currentFirstVisible() {
  return Math.max(0, Math.floor((els.scroller.scrollTop - HEADER_HEIGHT) / ROW_HEIGHT));
}

function visibleCapacity() {
  return Math.ceil(els.scroller.clientHeight / ROW_HEIGHT) + OVERSCAN * 2;
}

function targetWindowFor(firstVisible) {
  const capacity = Math.min(PAGE_LIMIT, Math.max(40, visibleCapacity()));
  const start = Math.max(0, firstVisible - OVERSCAN);
  // Align starts a little so pixel-level scrolling does not fetch for every row.
  const aligned = Math.max(0, Math.floor(start / 25) * 25);
  return { offset: aligned, limit: Math.min(PAGE_LIMIT, Math.max(capacity, 80)) };
}

function haveWindow(first, last) {
  return first >= state.windowOffset && last <= state.windowOffset + state.rows.length;
}

async function fetchWindow(offset, limit, reset = false) {
  const seq = ++state.requestSeq;
  if (state.abortController) state.abortController.abort();
  const controller = new AbortController();
  state.abortController = controller;
  state.loading = true;
  document.body.classList.add('loading');

  const params = new URLSearchParams({ offset: String(offset), limit: String(Math.min(limit, PAGE_LIMIT)) });
  if (state.severity) params.set('severity', state.severity);
  if (state.q) params.set('q', state.q);

  try {
    const started = performance.now();
    const res = await fetch(`${API_BASE}/api/logs?${params}`, { signal: controller.signal });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    if (seq !== state.requestSeq) return;
    state.total = data.total;
    state.rows = data.rows;
    state.windowOffset = offset;
    state.windowLimit = limit;
    els.spacer.style.height = `${state.total * ROW_HEIGHT}px`;
    els.visibleCount.textContent = `${fmt(Math.min(state.total, visibleCapacity()))} of ${fmt(state.total)}`;
    els.scroller.dataset.latency = `${Math.round(performance.now() - started)}ms`;
    if (reset) els.scroller.scrollTop = 0;
    renderRows(true);
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error(err);
      els.rows.innerHTML = `<div class="status" style="transform: translateY(${els.scroller.scrollTop}px)">Query failed. Is the API server running?</div>`;
    }
  } finally {
    if (seq === state.requestSeq) {
      state.loading = false;
      document.body.classList.remove('loading');
    }
  }
}

function renderRows(force = false) {
  const first = Math.max(0, currentFirstVisible() - OVERSCAN);
  const last = Math.min(state.total, first + visibleCapacity());
  els.visibleCount.textContent = `${fmt(Math.max(0, last - first))} of ${fmt(state.total)}`;

  if (!haveWindow(first, last)) {
    scheduleFetch();
  }

  if (!force && state.lastRenderedRange[0] === first && state.lastRenderedRange[1] === last) return;
  state.lastRenderedRange = [first, last];

  const html = [];
  for (let i = first; i < last; i++) {
    const row = state.rows[i - state.windowOffset];
    if (row) html.push(rowHtml(row, i));
  }
  if (html.length === 0 && state.loading) {
    html.push(`<div class="status" style="transform: translateY(${Math.max(0, first * ROW_HEIGHT)}px)">Loading…</div>`);
  } else if (state.total === 0 && !state.loading) {
    html.push('<div class="status">No logs match the active filters.</div>');
  }
  els.rows.innerHTML = html.join('');
}

function scheduleFetch() {
  clearTimeout(state.renderTimer);
  state.renderTimer = setTimeout(() => {
    const first = currentFirstVisible();
    const { offset, limit } = targetWindowFor(first);
    fetchWindow(offset, limit);
  }, FETCH_DEBOUNCE_MS);
}

function applyFilters() {
  state.severity = els.severity.value;
  state.q = els.search.value.trim();
  state.rows = [];
  state.windowOffset = 0;
  state.lastRenderedRange = [-1, -1];
  els.scroller.scrollTop = 0;
  fetchWindow(0, PAGE_LIMIT, true);
}

els.scroller.addEventListener('scroll', () => {
  requestAnimationFrame(() => renderRows(false));
}, { passive: true });

els.severity.addEventListener('change', applyFilters);
els.search.addEventListener('input', () => {
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(applyFilters, SEARCH_DEBOUNCE_MS);
});
els.clear.addEventListener('click', () => {
  els.severity.value = '';
  els.search.value = '';
  applyFilters();
});

loadStats();
fetchWindow(0, PAGE_LIMIT, true);
