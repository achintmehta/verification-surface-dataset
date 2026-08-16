const API = '';
const ROW_HEIGHT = 36;
const OVERSCAN = 12;
const LIMIT = 120;
const severities = ['', 'debug', 'info', 'warn', 'error'];

const app = document.querySelector('#app');
app.innerHTML = `
  <header class="topbar">
    <div>
      <h1>Log Explorer</h1>
      <p>100,000 deterministic log entries, server-windowed and virtualized.</p>
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
      <input id="search" type="search" placeholder="try: trace, failed, stripe, tenant-42" autocomplete="off" />
    </label>
    <span class="visible-count" id="visibleCount">0 of 0</span>
  </section>
  <main class="panel">
    <div class="table-head">
      <div>Time</div><div>Severity</div><div>Service</div><div>Message</div>
    </div>
    <div id="scroller" class="scroller" tabindex="0" aria-label="Virtualized log rows">
      <div id="spacer" class="spacer"></div>
      <div id="pool" class="pool"></div>
    </div>
  </main>
`;

const els = {
  stats: document.querySelector('#stats'),
  severity: document.querySelector('#severity'),
  search: document.querySelector('#search'),
  visibleCount: document.querySelector('#visibleCount'),
  scroller: document.querySelector('#scroller'),
  spacer: document.querySelector('#spacer'),
  pool: document.querySelector('#pool')
};

let state = {
  total: 0,
  rows: [],
  fetchOffset: 0,
  severity: '',
  q: '',
  requestSeq: 0,
  aborter: null,
  loading: false,
  lastRenderStart: 0
};

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function fmtTime(ts) { return new Date(ts).toISOString().replace('T', ' ').replace('.000Z', 'Z'); }
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
function rowOffsetForViewport() {
  return Math.floor(els.scroller.scrollTop / ROW_HEIGHT);
}
function currentVisibleCapacity() {
  return Math.ceil(els.scroller.clientHeight / ROW_HEIGHT) + OVERSCAN * 2;
}
function desiredFetchOffset(startRow) {
  const target = clamp(startRow - OVERSCAN, 0, Math.max(0, state.total - 1));
  // Align to small pages to improve cache hit while keeping deep scroll exact.
  return Math.floor(target / 40) * 40;
}
function updateSpacer() {
  els.spacer.style.height = `${state.total * ROW_HEIGHT}px`;
}
function updateVisibleCount(rendered = state.rows.length) {
  const start = state.total ? rowOffsetForViewport() + 1 : 0;
  const end = state.total ? Math.min(state.total, rowOffsetForViewport() + Math.ceil(els.scroller.clientHeight / ROW_HEIGHT)) : 0;
  els.visibleCount.textContent = `${start}-${end} of ${state.total.toLocaleString()} (${rendered} DOM rows)`;
}

async function fetchWindow(offset, reason = 'scroll') {
  if (state.aborter) state.aborter.abort();
  const seq = ++state.requestSeq;
  const controller = new AbortController();
  state.aborter = controller;
  state.loading = true;
  const params = new URLSearchParams({ offset: String(offset), limit: String(LIMIT) });
  if (state.severity) params.set('severity', state.severity);
  if (state.q) params.set('q', state.q);
  try {
    const res = await fetch(`${API}/api/logs?${params}`, { signal: controller.signal });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    if (seq !== state.requestSeq) return;
    state.total = data.total;
    state.rows = data.rows;
    state.fetchOffset = offset;
    state.loading = false;
    updateSpacer();
    renderRows();
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('Fetch failed', err);
      if (seq === state.requestSeq) {
        state.loading = false;
        els.pool.innerHTML = `<div class="error">Unable to load logs: ${err.message}</div>`;
      }
    }
  }
}

function needsWindow(startRow, count) {
  const needStart = Math.max(0, startRow - OVERSCAN);
  const needEnd = Math.min(state.total, startRow + count + OVERSCAN);
  return needStart < state.fetchOffset || needEnd > state.fetchOffset + state.rows.length;
}

function renderRows() {
  const scrollStart = rowOffsetForViewport();
  const visibleCount = currentVisibleCapacity();
  const renderStart = clamp(scrollStart - OVERSCAN, 0, Math.max(0, state.total));
  const renderEnd = Math.min(state.total, scrollStart + visibleCount - OVERSCAN);
  state.lastRenderStart = renderStart;

  if (state.total && needsWindow(scrollStart, Math.ceil(els.scroller.clientHeight / ROW_HEIGHT))) {
    const newOffset = desiredFetchOffset(scrollStart);
    if (!state.loading || newOffset !== state.fetchOffset) fetchWindow(newOffset);
  }

  const frag = document.createDocumentFragment();
  const maxRows = Math.min(renderEnd - renderStart, 90);
  for (let i = 0; i < maxRows; i++) {
    const globalIndex = renderStart + i;
    const localIndex = globalIndex - state.fetchOffset;
    const row = state.rows[localIndex];
    const div = document.createElement('div');
    div.className = 'log-row';
    div.style.transform = `translateY(${globalIndex * ROW_HEIGHT}px)`;
    div.dataset.offset = String(globalIndex);
    if (!row) {
      div.classList.add('placeholder');
      div.innerHTML = '<div></div><div></div><div></div><div>Loading…</div>';
    } else {
      div.innerHTML = `
        <div class="time">${fmtTime(row.ts)}</div>
        <div><span class="sev sev-${row.severity}">${row.severity}</span></div>
        <div class="service">${row.service}</div>
        <div class="message">${escapeHtml(row.message)}</div>
      `;
    }
    frag.appendChild(div);
  }
  els.pool.replaceChildren(frag);
  updateVisibleCount(maxRows);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>'"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}

async function loadStats() {
  const res = await fetch(`${API}/api/stats`);
  const stats = await res.json();
  els.stats.innerHTML = `
    <b>${stats.total.toLocaleString()}</b> total
    ${severities.filter(Boolean).map(s => `<span class="badge sev-${s}">${s}: ${stats.severities[s].toLocaleString()}</span>`).join('')}
  `;
}

function applyFilters() {
  state.severity = els.severity.value;
  state.q = els.search.value.trim();
  state.rows = [];
  state.fetchOffset = 0;
  state.total = 0;
  els.scroller.scrollTop = 0;
  els.pool.innerHTML = '<div class="loading">Loading…</div>';
  updateVisibleCount(0);
  fetchWindow(0, 'filter');
}

const debouncedFilter = debounce(applyFilters, 220);
els.search.addEventListener('input', debouncedFilter);
els.severity.addEventListener('change', applyFilters);
els.scroller.addEventListener('scroll', () => requestAnimationFrame(renderRows), { passive: true });
window.addEventListener('resize', () => requestAnimationFrame(renderRows));

loadStats().catch(err => { els.stats.textContent = `Stats unavailable: ${err.message}`; });
fetchWindow(0, 'initial');
