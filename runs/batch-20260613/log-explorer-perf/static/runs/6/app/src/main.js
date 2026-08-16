import './styles.css';

const ROW_HEIGHT = 36;
const HEADER_HEIGHT = 0;
const OVERSCAN = 8;
const PAGE_SIZE = 100;
const MAX_DOM_ROWS = 100;
const API_LIMIT = 100;

const state = {
  total: 0,
  rows: [],
  rowsStart: 0,
  loading: false,
  severity: '',
  q: '',
  stats: null,
  requestSeq: 0,
  abortController: null,
  loadingOffset: null,
  debounceTimer: null,
  lastRenderedStart: -1,
};

const app = document.querySelector('#app');
app.innerHTML = `
  <header class="topbar">
    <div>
      <h1>Log Explorer</h1>
      <p class="subtitle">100,000 deterministic rows • server-windowed • virtualized</p>
    </div>
    <div class="status" id="status">Starting…</div>
  </header>

  <section class="filters" aria-label="Log filters">
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
      <input id="searchBox" type="search" placeholder="try request, timeout, rare-sentinel, needle" autocomplete="off" />
    </label>
    <div class="badges" id="badges"></div>
  </section>

  <section class="meta">
    <span id="visibleCount">0 of 0</span>
    <span id="rangeLabel">Rows 0-0</span>
  </section>

  <main class="tableShell">
    <div class="tableHeader" role="row">
      <div>Timestamp</div>
      <div>Severity</div>
      <div>Service</div>
      <div>Message</div>
    </div>
    <div id="scroller" class="scroller" tabindex="0">
      <div id="spacer" class="spacer"></div>
      <div id="rowLayer" class="rowLayer"></div>
    </div>
  </main>
`;

const els = {
  status: document.querySelector('#status'),
  severity: document.querySelector('#severityFilter'),
  search: document.querySelector('#searchBox'),
  badges: document.querySelector('#badges'),
  visibleCount: document.querySelector('#visibleCount'),
  rangeLabel: document.querySelector('#rangeLabel'),
  scroller: document.querySelector('#scroller'),
  spacer: document.querySelector('#spacer'),
  rowLayer: document.querySelector('#rowLayer'),
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatTs(ts) {
  if (!ts) return '';
  return String(ts).replace('T', ' ').replace(/\.\d+Z?$/, '');
}

function renderBadges() {
  const stats = state.stats;
  if (!stats) {
    els.badges.textContent = '';
    return;
  }
  els.badges.innerHTML = `
    <span class="badge">All ${stats.total.toLocaleString()}</span>
    ${Object.entries(stats.severities)
      .map(([severity, count]) => `<span class="badge sev-${severity}">${severity} ${Number(count).toLocaleString()}</span>`)
      .join('')}
  `;
}

function setStatus(text, busy = false) {
  els.status.textContent = text;
  els.status.classList.toggle('busy', busy);
}

function updateSpacer() {
  els.spacer.style.height = `${state.total * ROW_HEIGHT}px`;
}

function getDesiredWindow() {
  const viewportRows = Math.ceil(els.scroller.clientHeight / ROW_HEIGHT) || 20;
  const firstVisible = Math.floor(els.scroller.scrollTop / ROW_HEIGHT);
  const renderCount = Math.min(MAX_DOM_ROWS, viewportRows + OVERSCAN * 2);
  const renderStart = clamp(firstVisible - OVERSCAN, 0, Math.max(0, state.total - renderCount));
  return { firstVisible, renderStart, renderCount };
}

function hasRowsFor(renderStart, renderCount) {
  return (
    renderStart >= state.rowsStart &&
    renderStart + renderCount <= state.rowsStart + state.rows.length
  );
}

function cacheContainsOffset(offset) {
  return offset >= state.rowsStart && offset < state.rowsStart + state.rows.length;
}

function renderRows() {
  const { firstVisible, renderStart, renderCount } = getDesiredWindow();
  state.lastRenderedStart = renderStart;
  updateSpacer();

  if (state.total === 0) {
    els.rowLayer.style.transform = 'translateY(0px)';
    els.rowLayer.innerHTML = '<div class="empty">No logs match the active filters.</div>';
    els.visibleCount.textContent = `0 of ${state.total.toLocaleString()}`;
    els.rangeLabel.textContent = 'Rows 0-0';
    return;
  }

  const availableRows = [];
  for (let i = 0; i < renderCount && renderStart + i < state.total; i += 1) {
    const absoluteIndex = renderStart + i;
    if (cacheContainsOffset(absoluteIndex)) {
      availableRows.push({ index: absoluteIndex, row: state.rows[absoluteIndex - state.rowsStart] });
    } else {
      availableRows.push({ index: absoluteIndex, row: null });
    }
  }

  els.rowLayer.style.transform = `translateY(${renderStart * ROW_HEIGHT}px)`;
  els.rowLayer.innerHTML = availableRows
    .map(({ index, row }) => {
      if (!row) {
        return `<div class="logRow skeleton" role="row" data-index="${index}"><div></div><div></div><div></div><div>Loading row ${index + 1}…</div></div>`;
      }
      return `
        <div class="logRow" role="row" data-index="${index}">
          <div class="ts">${escapeHtml(formatTs(row.ts))}</div>
          <div><span class="severity sev-${escapeHtml(row.severity)}">${escapeHtml(row.severity)}</span></div>
          <div class="service">${escapeHtml(row.service)}</div>
          <div class="message" title="${escapeHtml(row.message)}">${escapeHtml(row.message)}</div>
        </div>`;
    })
    .join('');

  const visibleEnd = Math.min(state.total, firstVisible + Math.ceil(els.scroller.clientHeight / ROW_HEIGHT));
  els.visibleCount.textContent = `${availableRows.filter((item) => item.row).length} rendered of ${state.total.toLocaleString()}`;
  els.rangeLabel.textContent = `Rows ${Math.min(firstVisible + 1, state.total).toLocaleString()}-${visibleEnd.toLocaleString()}`;
}

function scheduleFetchIfNeeded() {
  const { renderStart, renderCount } = getDesiredWindow();
  if (hasRowsFor(renderStart, renderCount)) return;

  // Fetch an aligned page around the viewport to reduce request count while the
  // DOM remains bounded to the visible virtual window.
  const fetchStart = clamp(
    Math.floor(renderStart / PAGE_SIZE) * PAGE_SIZE,
    0,
    Math.max(0, state.total - API_LIMIT),
  );
  if (state.loading && state.loadingOffset === fetchStart) return;
  void fetchRows(fetchStart);
}

async function fetchRows(offset = 0) {
  const seq = ++state.requestSeq;
  if (state.abortController) state.abortController.abort();
  const controller = new AbortController();
  state.abortController = controller;
  state.loading = true;
  state.loadingOffset = offset;
  setStatus('Loading…', true);

  const url = new URL('/api/logs', window.location.origin);
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('limit', String(API_LIMIT));
  if (state.severity) url.searchParams.set('severity', state.severity);
  if (state.q) url.searchParams.set('q', state.q);

  try {
    const started = performance.now();
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(await response.text());
    const payload = await response.json();
    if (seq !== state.requestSeq) return;

    state.total = Number(payload.total || 0);
    state.rows = Array.isArray(payload.rows) ? payload.rows.slice(0, API_LIMIT) : [];
    state.rowsStart = offset;
    state.loading = false;
    state.loadingOffset = null;
    updateSpacer();
    renderRows();
    setStatus(`Loaded in ${Math.round(performance.now() - started)} ms`);
    scheduleFetchIfNeeded();
  } catch (error) {
    if (error.name === 'AbortError') {
      if (seq === state.requestSeq) {
        state.loading = false;
        state.loadingOffset = null;
      }
      return;
    }
    if (seq !== state.requestSeq) return;
    state.loading = false;
    state.loadingOffset = null;
    setStatus('Request failed');
    console.error(error);
  }
}

function resetAndFetch() {
  state.rows = [];
  state.rowsStart = 0;
  state.total = 0;
  state.loadingOffset = null;
  state.lastRenderedStart = -1;
  els.scroller.scrollTop = 0;
  updateSpacer();
  renderRows();
  void fetchRows(0);
}

function onScroll() {
  renderRows();
  scheduleFetchIfNeeded();
}

els.scroller.addEventListener('scroll', onScroll, { passive: true });

els.severity.addEventListener('change', () => {
  state.severity = els.severity.value;
  resetAndFetch();
});

els.search.addEventListener('input', () => {
  const next = els.search.value.trim();
  window.clearTimeout(state.debounceTimer);
  state.debounceTimer = window.setTimeout(() => {
    state.q = next;
    resetAndFetch();
  }, 250);
});

window.addEventListener('resize', () => {
  renderRows();
  scheduleFetchIfNeeded();
});

async function loadStats() {
  try {
    const response = await fetch('/api/stats');
    if (!response.ok) throw new Error('stats failed');
    state.stats = await response.json();
    renderBadges();
  } catch (error) {
    console.warn('Unable to load stats', error);
  }
}

renderRows();
void loadStats();
void fetchRows(0);
