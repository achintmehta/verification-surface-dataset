const ROW_HEIGHT = 38;
const OVERSCAN = 12;
const API_LIMIT = 120;
const DEBOUNCE_MS = 220;

const app = document.querySelector('#app');
app.innerHTML = `
  <header class="topbar">
    <div>
      <h1>Log Explorer</h1>
      <p>100,000 deterministic logs · server-windowed · virtualized</p>
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
    <label class="search-label">Message contains
      <input id="search" type="search" placeholder="timeout, payment-needle, customer…" autocomplete="off" />
    </label>
    <button id="refresh" type="button">Refresh</button>
    <div class="visible-count" id="visibleCount">0 of 0</div>
  </section>
  <main class="panel">
    <div class="table-head">
      <div>Timestamp</div><div>Severity</div><div>Service</div><div>Message</div>
    </div>
    <div id="scroller" class="scroller" tabindex="0" aria-label="Virtualized log table">
      <div id="spacer" class="spacer"></div>
      <div id="rows" class="rows"></div>
      <div id="empty" class="empty" hidden>No logs match the active filters.</div>
    </div>
  </main>
`;

const els = {
  stats: document.querySelector('#stats'),
  severity: document.querySelector('#severity'),
  search: document.querySelector('#search'),
  refresh: document.querySelector('#refresh'),
  visibleCount: document.querySelector('#visibleCount'),
  scroller: document.querySelector('#scroller'),
  spacer: document.querySelector('#spacer'),
  rows: document.querySelector('#rows'),
  empty: document.querySelector('#empty'),
};

const state = {
  total: 0,
  rows: new Map(),
  loadedStart: 0,
  loadedEnd: -1,
  severity: '',
  q: '',
  requestSeq: 0,
  aborter: null,
  loading: false,
};

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  }[ch]));
}

function formatTs(ts) {
  const d = new Date(ts);
  return Number.isNaN(d.valueOf()) ? ts : d.toISOString().replace('T', ' ').replace('.000Z', 'Z');
}

async function loadStats() {
  try {
    const res = await fetch('/api/stats');
    if (!res.ok) throw new Error(`stats ${res.status}`);
    const data = await res.json();
    els.stats.innerHTML = `
      <strong>${data.total.toLocaleString()}</strong> rows
      <span class="badge sev-debug">debug ${data.severities.debug.toLocaleString()}</span>
      <span class="badge sev-info">info ${data.severities.info.toLocaleString()}</span>
      <span class="badge sev-warn">warn ${data.severities.warn.toLocaleString()}</span>
      <span class="badge sev-error">error ${data.severities.error.toLocaleString()}</span>
    `;
  } catch (err) {
    els.stats.textContent = 'Stats unavailable';
    console.error(err);
  }
}

function currentFirstIndex() {
  return Math.max(0, Math.floor(els.scroller.scrollTop / ROW_HEIGHT));
}

function viewportRowCount() {
  return Math.ceil(els.scroller.clientHeight / ROW_HEIGHT);
}

function desiredRange() {
  const first = currentFirstIndex();
  const visible = viewportRowCount();
  const start = Math.max(0, first - OVERSCAN);
  const end = Math.min(Math.max(0, state.total - 1), first + visible + OVERSCAN);
  return { first, visible, start, end };
}

function hasRange(start, end) {
  if (state.total === 0) return true;
  for (let i = start; i <= end; i++) {
    if (!state.rows.has(i)) return false;
  }
  return true;
}

function pruneRows(keepStart, keepEnd) {
  const min = Math.max(0, keepStart - API_LIMIT);
  const max = keepEnd + API_LIMIT;
  for (const key of state.rows.keys()) {
    if (key < min || key > max) state.rows.delete(key);
  }
}

function render() {
  const { first, visible, start, end } = desiredRange();
  els.spacer.style.height = `${state.total * ROW_HEIGHT}px`;
  els.empty.hidden = state.total !== 0 || state.loading;
  els.visibleCount.textContent = `${Math.min(visible, Math.max(0, state.total - first)).toLocaleString()} of ${state.total.toLocaleString()}`;

  const html = [];
  if (state.total > 0) {
    for (let index = start; index <= end; index++) {
      const row = state.rows.get(index);
      if (!row) {
        html.push(`<div class="log-row skeleton" style="transform: translateY(${index * ROW_HEIGHT}px)"><div></div><div></div><div></div><div>Loading row ${index.toLocaleString()}…</div></div>`);
      } else {
        html.push(`
          <div class="log-row" data-index="${index}" style="transform: translateY(${index * ROW_HEIGHT}px)">
            <div class="ts">${escapeHtml(formatTs(row.ts))}</div>
            <div><span class="pill sev-${row.severity}">${escapeHtml(row.severity)}</span></div>
            <div class="service">${escapeHtml(row.service)}</div>
            <div class="message">${escapeHtml(row.message)}</div>
          </div>
        `);
      }
    }
  }
  els.rows.innerHTML = html.join('');
  scheduleFetchIfNeeded();
}

async function fetchWindow(offset) {
  if (state.aborter) state.aborter.abort();
  const seq = ++state.requestSeq;
  const controller = new AbortController();
  state.aborter = controller;
  state.loading = true;

  const params = new URLSearchParams({ offset: String(Math.max(0, offset)), limit: String(API_LIMIT) });
  if (state.severity) params.set('severity', state.severity);
  if (state.q) params.set('q', state.q);

  try {
    const res = await fetch(`/api/logs?${params}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`logs ${res.status}`);
    const data = await res.json();
    if (seq !== state.requestSeq) return;

    state.total = data.total;
    state.rows.clear();
    const actualOffset = Math.max(0, offset);
    data.rows.forEach((row, i) => state.rows.set(actualOffset + i, row));
    state.loadedStart = actualOffset;
    state.loadedEnd = actualOffset + data.rows.length - 1;
    pruneRows(...Object.values(desiredRange()).slice(2));
  } catch (err) {
    if (err.name !== 'AbortError') console.error(err);
  } finally {
    if (seq === state.requestSeq) {
      state.loading = false;
      render();
    }
  }
}

let fetchRaf = 0;
function scheduleFetchIfNeeded() {
  if (fetchRaf) return;
  fetchRaf = requestAnimationFrame(() => {
    fetchRaf = 0;
    const { start, end } = desiredRange();
    if (!hasRange(start, end) && !state.loading) {
      const centered = Math.max(0, Math.min(start, Math.max(0, state.total - API_LIMIT)));
      fetchWindow(centered);
    }
  });
}

let renderRaf = 0;
function scheduleRender() {
  if (renderRaf) return;
  renderRaf = requestAnimationFrame(() => {
    renderRaf = 0;
    render();
  });
}

function resetAndLoad() {
  state.severity = els.severity.value;
  state.q = els.search.value.trim();
  state.rows.clear();
  state.total = 0;
  state.loadedStart = 0;
  state.loadedEnd = -1;
  els.scroller.scrollTop = 0;
  render();
  fetchWindow(0);
}

let debounceTimer = 0;
els.search.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(resetAndLoad, DEBOUNCE_MS);
});
els.severity.addEventListener('change', resetAndLoad);
els.refresh.addEventListener('click', resetAndLoad);
els.scroller.addEventListener('scroll', scheduleRender, { passive: true });
window.addEventListener('resize', scheduleRender);

loadStats();
resetAndLoad();
