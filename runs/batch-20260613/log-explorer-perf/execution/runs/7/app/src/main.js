import './styles.css';

const ROW_HEIGHT = 34;
const API_LIMIT = 200;
const OVERSCAN = 10;
const SEARCH_DEBOUNCE_MS = 180;

const state = {
  total: 0,
  rows: new Map(),
  severity: '',
  q: '',
  pendingQ: '',
  renderedStart: 0,
  renderedEnd: 0,
  requestSeq: 0,
  abortController: null,
  loading: false,
  error: '',
  stats: null,
  debounceTimer: null
};

const app = document.querySelector('#app');
app.innerHTML = `
  <main class="app-shell">
    <section class="header">
      <div>
        <h1>Log Explorer</h1>
        <div class="subtitle">100,000 deterministic rows · server-side windows · virtual DOM rows</div>
      </div>
    </section>

    <section class="controls">
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
      <label>
        Message contains
        <input id="search" type="search" autocomplete="off" spellcheck="false" placeholder="Try: heartbeat, needle, cache, timeout" />
      </label>
      <div id="badges" class="badges"></div>
    </section>

    <section class="status-line">
      <div id="count">Loading…</div>
      <div id="status" class="muted"></div>
    </section>

    <section class="table-wrap">
      <div class="table-head">
        <div>Offset</div><div>Timestamp</div><div>Severity</div><div>Service</div><div>Message</div>
      </div>
      <div id="scroller" class="scroller" aria-label="Virtualized log table">
        <div id="spacer" class="spacer">
          <div id="rowLayer" class="row-layer"></div>
        </div>
      </div>
    </section>
  </main>
`;

const els = {
  severity: document.querySelector('#severity'),
  search: document.querySelector('#search'),
  badges: document.querySelector('#badges'),
  scroller: document.querySelector('#scroller'),
  spacer: document.querySelector('#spacer'),
  rowLayer: document.querySelector('#rowLayer'),
  count: document.querySelector('#count'),
  status: document.querySelector('#status')
};

function formatNumber(n) {
  return new Intl.NumberFormat().format(n || 0);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[char]));
}

function formatTs(ts) {
  const d = new Date(ts);
  return Number.isFinite(d.getTime()) ? d.toISOString().replace('T', ' ').replace('Z', '') : ts;
}

async function loadStats() {
  try {
    const res = await fetch('/api/stats');
    if (!res.ok) throw new Error(`stats failed (${res.status})`);
    state.stats = await res.json();
    renderBadges();
  } catch (err) {
    state.error = err.message;
    renderStatus();
  }
}

function renderBadges() {
  const sev = state.stats?.severities || {};
  els.badges.innerHTML = `
    <span class="badge">all ${formatNumber(state.stats?.total || 0)}</span>
    <span class="badge">debug ${formatNumber(sev.debug)}</span>
    <span class="badge">info ${formatNumber(sev.info)}</span>
    <span class="badge">warn ${formatNumber(sev.warn)}</span>
    <span class="badge">error ${formatNumber(sev.error)}</span>
  `;
}

function renderStatus() {
  const visible = Math.max(0, state.renderedEnd - state.renderedStart);
  els.count.textContent = `${formatNumber(visible)} of ${formatNumber(state.total)} visible`;
  els.status.textContent = state.error ? state.error : state.loading ? 'Loading window…' : `Rows ${formatNumber(state.renderedStart)}–${formatNumber(Math.max(state.renderedStart, state.renderedEnd - 1))}`;
  els.status.className = state.error ? 'error-text' : 'muted';
}

function resetForFilters() {
  state.rows.clear();
  state.total = 0;
  state.error = '';
  els.scroller.scrollTop = 0;
  els.spacer.style.height = '1px';
  renderWindow();
  fetchWindow(0);
}

function currentWindow() {
  const viewportRows = Math.ceil(els.scroller.clientHeight / ROW_HEIGHT) || 20;
  const first = Math.max(0, Math.floor(els.scroller.scrollTop / ROW_HEIGHT) - OVERSCAN);
  const count = Math.min(100, viewportRows + OVERSCAN * 2);
  const end = state.total ? Math.min(state.total, first + count) : first + count;
  return { first, end, count };
}

function renderWindow() {
  const { first, end } = currentWindow();
  state.renderedStart = first;
  state.renderedEnd = end;
  const parts = [];
  for (let offset = first; offset < end; offset++) {
    const row = state.rows.get(offset);
    const top = offset * ROW_HEIGHT;
    if (!row) {
      parts.push(`<div class="log-row loading" style="transform: translateY(${top}px)"><div>${formatNumber(offset)}</div><div>loading…</div><div></div><div></div><div></div></div>`);
      continue;
    }
    parts.push(`
      <div class="log-row" data-offset="${offset}" style="transform: translateY(${top}px)">
        <div>${formatNumber(offset)}</div>
        <div title="${escapeHtml(row.ts)}">${escapeHtml(formatTs(row.ts))}</div>
        <div><span class="sev ${escapeHtml(row.severity)}">${escapeHtml(row.severity)}</span></div>
        <div title="${escapeHtml(row.service)}">${escapeHtml(row.service)}</div>
        <div title="${escapeHtml(row.message)}">${escapeHtml(row.message)}</div>
      </div>
    `);
  }
  els.rowLayer.innerHTML = parts.join('');
  els.spacer.style.height = `${Math.max(1, state.total * ROW_HEIGHT)}px`;
  renderStatus();
  ensureLoaded(first, end);
}

function missingRange(first, end) {
  let missingStart = -1;
  let missingEnd = -1;
  for (let i = first; i < end; i++) {
    if (!state.rows.has(i)) {
      if (missingStart === -1) missingStart = i;
      missingEnd = i + 1;
    } else if (missingStart !== -1) {
      break;
    }
  }
  return missingStart === -1 ? null : { start: missingStart, end: missingEnd };
}

function ensureLoaded(first, end) {
  if (state.loading) return;
  const miss = missingRange(first, end);
  if (!miss) return;
  const offset = Math.max(0, Math.floor(miss.start / API_LIMIT) * API_LIMIT);
  fetchWindow(offset);
}

async function fetchWindow(offset) {
  const seq = ++state.requestSeq;
  if (state.abortController) state.abortController.abort();
  state.abortController = new AbortController();
  state.loading = true;
  state.error = '';
  renderStatus();

  const params = new URLSearchParams({ offset: String(offset), limit: String(API_LIMIT) });
  if (state.severity) params.set('severity', state.severity);
  if (state.q) params.set('q', state.q);

  try {
    const res = await fetch(`/api/logs?${params}`, { signal: state.abortController.signal });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `request failed (${res.status})`);
    }
    const data = await res.json();
    if (seq !== state.requestSeq) return; // stale response; never overwrite newer filters/windows

    state.total = data.total;
    els.spacer.style.height = `${Math.max(1, state.total * ROW_HEIGHT)}px`;
    data.rows.forEach((row, i) => state.rows.set(offset + i, row));
    state.loading = false;
    renderWindow();
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (seq !== state.requestSeq) return;
    state.loading = false;
    state.error = err.message;
    renderWindow();
  }
}

let raf = 0;
els.scroller.addEventListener('scroll', () => {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    renderWindow();
  });
}, { passive: true });

window.addEventListener('resize', () => renderWindow());

els.severity.addEventListener('change', () => {
  state.severity = els.severity.value;
  resetForFilters();
});

els.search.addEventListener('input', () => {
  state.pendingQ = els.search.value.trim();
  clearTimeout(state.debounceTimer);
  state.debounceTimer = setTimeout(() => {
    state.q = state.pendingQ;
    resetForFilters();
  }, SEARCH_DEBOUNCE_MS);
});

loadStats();
resetForFilters();
