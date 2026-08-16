import './styles.css';

const API_BASE = import.meta.env.VITE_API_BASE || '';
const ROW_HEIGHT = 42;
const OVERSCAN = 12;
const LIMIT = 120;
const MAX_DOM_ROWS = 100;
const severities = ['', 'debug', 'info', 'warn', 'error'];

const state = {
  total: 0,
  rows: [],
  start: 0,
  pendingStart: -1,
  severity: '',
  q: '',
  requestId: 0,
  abortController: null,
  stats: null,
  loading: false,
  error: ''
};

const app = document.querySelector('#app');
app.innerHTML = `
  <main class="shell">
    <header class="hero">
      <div>
        <h1>Log Explorer</h1>
        <p>100,000 deterministic server-side logs, fetched in small windows and rendered virtually.</p>
      </div>
      <div class="status" id="status">Booting…</div>
    </header>

    <section class="toolbar" aria-label="Log filters">
      <label>
        Severity
        <select id="severityFilter">
          <option value="">All severities</option>
          <option value="debug">Debug</option>
          <option value="info">Info</option>
          <option value="warn">Warn</option>
          <option value="error">Error</option>
        </select>
      </label>
      <label class="searchLabel">
        Message contains
        <input id="searchInput" type="search" placeholder="Try timeout, route, tenant-042, cache…" autocomplete="off" />
      </label>
      <button id="refreshBtn" type="button">Refresh</button>
      <div class="badges" id="badges"></div>
    </section>

    <section class="summary">
      <strong id="visibleCount">0 of 0</strong>
      <span id="rangeInfo">No rows loaded yet</span>
      <span id="domInfo">0 DOM rows</span>
    </section>

    <section class="table">
      <div class="thead" role="row">
        <div>Timestamp</div>
        <div>Severity</div>
        <div>Service</div>
        <div>Message</div>
      </div>
      <div id="scroller" class="scroller" tabindex="0" aria-label="Virtualized log rows">
        <div id="spacer" class="spacer"></div>
        <div id="rowLayer" class="rowLayer"></div>
        <div id="empty" class="empty hidden">No logs match the active filters.</div>
      </div>
    </section>
  </main>
`;

const els = {
  status: document.querySelector('#status'),
  severity: document.querySelector('#severityFilter'),
  search: document.querySelector('#searchInput'),
  refresh: document.querySelector('#refreshBtn'),
  badges: document.querySelector('#badges'),
  visibleCount: document.querySelector('#visibleCount'),
  rangeInfo: document.querySelector('#rangeInfo'),
  domInfo: document.querySelector('#domInfo'),
  scroller: document.querySelector('#scroller'),
  spacer: document.querySelector('#spacer'),
  rowLayer: document.querySelector('#rowLayer'),
  empty: document.querySelector('#empty')
};

function debounce(fn, delay) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function buildParams(start, limit = LIMIT) {
  const params = new URLSearchParams({ offset: String(Math.max(0, start)), limit: String(limit) });
  if (state.severity) params.set('severity', state.severity);
  if (state.q) params.set('q', state.q);
  return params;
}

async function fetchJson(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, options);
  if (!response.ok) {
    let message = response.statusText;
    try {
      const body = await response.json();
      message = body.error || message;
    } catch {
      // ignore non-json error bodies
    }
    throw new Error(message);
  }
  return response.json();
}

function desiredWindowStart() {
  const viewportRows = Math.ceil(els.scroller.clientHeight / ROW_HEIGHT);
  const firstVisible = Math.floor(els.scroller.scrollTop / ROW_HEIGHT);
  const rowsNeeded = Math.min(MAX_DOM_ROWS, Math.max(30, viewportRows + OVERSCAN * 2));
  const maxStart = Math.max(0, state.total - rowsNeeded);
  return Math.min(maxStart, Math.max(0, firstVisible - OVERSCAN));
}

function isWindowAdequate(start) {
  if (!state.rows.length) return false;
  const viewportRows = Math.ceil(els.scroller.clientHeight / ROW_HEIGHT);
  const firstVisible = Math.floor(els.scroller.scrollTop / ROW_HEIGHT);
  const lastNeeded = firstVisible + viewportRows + OVERSCAN;
  return start >= state.start && lastNeeded < state.start + state.rows.length && firstVisible >= state.start;
}

async function loadWindow(start = desiredWindowStart(), { reset = false } = {}) {
  start = Math.max(0, Math.floor(start));
  if (state.loading && state.pendingStart === start) return;

  const requestId = ++state.requestId;
  state.pendingStart = start;
  state.loading = true;
  state.error = '';
  if (state.abortController) state.abortController.abort();
  const abortController = new AbortController();
  state.abortController = abortController;
  updateStatus();

  try {
    const data = await fetchJson(`/api/logs?${buildParams(start)}`, { signal: abortController.signal });
    if (requestId !== state.requestId) return;
    state.total = data.total;
    state.start = start;
    state.rows = data.rows;
    state.loading = false;
    state.pendingStart = -1;

    const maxScrollTop = Math.max(0, state.total * ROW_HEIGHT - els.scroller.clientHeight);
    if (reset) els.scroller.scrollTop = 0;
    else if (els.scroller.scrollTop > maxScrollTop) els.scroller.scrollTop = maxScrollTop;

    render();
  } catch (error) {
    if (error.name === 'AbortError') return;
    if (requestId !== state.requestId) return;
    state.loading = false;
    state.error = error.message;
    render();
  }
}

function htmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatTimestamp(ts) {
  return new Date(ts).toISOString().replace('T', ' ').replace('.000Z', 'Z');
}

function renderRows() {
  const fragment = document.createDocumentFragment();
  const viewportTop = els.scroller.scrollTop;
  const viewportBottom = viewportTop + els.scroller.clientHeight;
  let visibleRendered = 0;

  for (const [index, row] of state.rows.entries()) {
    const absoluteIndex = state.start + index;
    const top = absoluteIndex * ROW_HEIGHT;
    if (top + ROW_HEIGHT < viewportTop - OVERSCAN * ROW_HEIGHT) continue;
    if (top > viewportBottom + OVERSCAN * ROW_HEIGHT) continue;
    if (visibleRendered >= MAX_DOM_ROWS) break;

    const div = document.createElement('div');
    div.className = `logRow sev-${row.severity}`;
    div.style.transform = `translateY(${top}px)`;
    div.dataset.index = String(absoluteIndex);
    div.setAttribute('role', 'row');
    div.innerHTML = `
      <div class="ts" title="${htmlEscape(row.ts)}">${htmlEscape(formatTimestamp(row.ts))}</div>
      <div><span class="pill">${htmlEscape(row.severity)}</span></div>
      <div class="service">${htmlEscape(row.service)}</div>
      <div class="message" title="${htmlEscape(row.message)}">${htmlEscape(row.message)}</div>
    `;
    fragment.appendChild(div);
    visibleRendered += 1;
  }

  els.rowLayer.replaceChildren(fragment);
  els.domInfo.textContent = `${visibleRendered} DOM row${visibleRendered === 1 ? '' : 's'}`;
}

function updateStatus() {
  if (state.error) {
    els.status.textContent = state.error;
    els.status.className = 'status error';
  } else if (state.loading) {
    els.status.textContent = 'Loading window…';
    els.status.className = 'status loading';
  } else {
    els.status.textContent = 'Ready';
    els.status.className = 'status';
  }
}

function renderBadges() {
  if (!state.stats) return;
  const all = `<button class="badge ${state.severity === '' ? 'active' : ''}" data-sev="">all ${state.stats.total.toLocaleString()}</button>`;
  const rest = severities.filter(Boolean).map((sev) => {
    const active = state.severity === sev ? 'active' : '';
    const count = state.stats.severities?.[sev] ?? 0;
    return `<button class="badge sev-${sev} ${active}" data-sev="${sev}">${sev} ${count.toLocaleString()}</button>`;
  }).join('');
  els.badges.innerHTML = all + rest;
}

function renderSummary() {
  const rendered = Math.min(state.rows.length, MAX_DOM_ROWS);
  els.visibleCount.textContent = `${rendered.toLocaleString()} of ${state.total.toLocaleString()}`;
  if (!state.total) {
    els.rangeInfo.textContent = 'No rows loaded';
    return;
  }
  const firstVisible = Math.floor(els.scroller.scrollTop / ROW_HEIGHT);
  const lastVisible = Math.min(state.total - 1, firstVisible + Math.ceil(els.scroller.clientHeight / ROW_HEIGHT));
  els.rangeInfo.textContent = `Viewport offsets ${firstVisible.toLocaleString()}–${lastVisible.toLocaleString()} · loaded window ${state.start.toLocaleString()}–${Math.max(state.start, state.start + state.rows.length - 1).toLocaleString()}`;
}

function render() {
  els.spacer.style.height = `${state.total * ROW_HEIGHT}px`;
  els.empty.classList.toggle('hidden', Boolean(state.total) || state.loading);
  renderRows();
  renderSummary();
  renderBadges();
  updateStatus();
}

let ticking = false;
function onScroll() {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => {
    ticking = false;
    renderRows();
    renderSummary();
    const start = desiredWindowStart();
    if (!isWindowAdequate(start)) loadWindow(start);
  });
}

async function loadStats() {
  try {
    state.stats = await fetchJson('/api/stats');
    renderBadges();
  } catch (error) {
    console.warn('Unable to load stats', error);
  }
}

function applyFilters() {
  state.severity = els.severity.value;
  state.q = els.search.value.trim();
  state.rows = [];
  state.start = 0;
  state.total = 0;
  els.scroller.scrollTop = 0;
  render();
  loadWindow(0, { reset: true });
}

const debouncedApplyFilters = debounce(applyFilters, 250);
els.scroller.addEventListener('scroll', onScroll, { passive: true });
els.severity.addEventListener('change', applyFilters);
els.search.addEventListener('input', debouncedApplyFilters);
els.refresh.addEventListener('click', () => loadWindow(desiredWindowStart()));
els.badges.addEventListener('click', (event) => {
  const target = event.target.closest('[data-sev]');
  if (!target) return;
  els.severity.value = target.dataset.sev;
  applyFilters();
});

window.addEventListener('resize', () => {
  render();
  loadWindow(desiredWindowStart());
});

loadStats();
loadWindow(0, { reset: true });
