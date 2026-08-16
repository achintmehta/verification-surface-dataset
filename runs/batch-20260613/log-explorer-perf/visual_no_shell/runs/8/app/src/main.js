const ROW_HEIGHT = 36;
const LIMIT = 100;
const OVERSCAN = 18;
const API = '';

let state = {
  total: 0,
  rows: [],
  windowStart: 0,
  loading: false,
  severity: '',
  q: '',
  requestSeq: 0,
  stats: null,
};

const app = document.getElementById('app');
app.innerHTML = `
  <div class="topbar">
    <div class="title">Log Explorer</div>
    <label class="control">Severity
      <select id="severity">
        <option value="">All</option>
        <option value="debug">debug</option>
        <option value="info">info</option>
        <option value="warn">warn</option>
        <option value="error">error</option>
      </select>
    </label>
    <label class="control">Message contains
      <input id="search" autocomplete="off" spellcheck="false" placeholder="try timeout, payment, cache, retry" />
    </label>
    <div id="count" class="count">0 of 0</div>
    <div id="stats" class="stats"></div>
  </div>
  <div class="hint">Virtualized table: only the visible rows plus overscan are mounted, while the scrollbar covers the complete filtered corpus.</div>
  <div id="viewport" class="viewport" tabindex="0">
    <div id="spacer" class="spacer"><div id="rows" class="rows"></div></div>
    <div id="status" class="status">Loading…</div>
  </div>
`;

const viewport = document.getElementById('viewport');
const spacer = document.getElementById('spacer');
const rowsEl = document.getElementById('rows');
const statusEl = document.getElementById('status');
const countEl = document.getElementById('count');
const statsEl = document.getElementById('stats');
const severityEl = document.getElementById('severity');
const searchEl = document.getElementById('search');

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

function firstNeededOffset() {
  const visibleStart = Math.floor(viewport.scrollTop / ROW_HEIGHT);
  return clamp(visibleStart - OVERSCAN, 0, Math.max(0, state.total - 1));
}

function paramsFor(offset, limit) {
  const p = new URLSearchParams({ offset: String(offset), limit: String(limit) });
  if (state.severity) p.set('severity', state.severity);
  if (state.q.trim()) p.set('q', state.q.trim());
  return p;
}

async function fetchWindow(offset) {
  offset = clamp(offset, 0, Math.max(0, state.total - 1));
  const aligned = Math.floor(offset / LIMIT) * LIMIT;
  const mySeq = ++state.requestSeq;
  state.loading = true;
  updateStatus();
  const t0 = performance.now();
  try {
    const res = await fetch(`${API}/api/logs?${paramsFor(aligned, LIMIT)}`);
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    if (mySeq !== state.requestSeq) return;
    state.total = data.total;
    state.rows = data.rows;
    state.windowStart = aligned;
    state.loading = false;
    if (!currentViewportCovered()) {
      fetchWindow(firstNeededOffset());
      return;
    }
    render();
    updateStatus(`Loaded ${data.rows.length} rows in ${Math.round(performance.now() - t0)} ms`);
  } catch (err) {
    if (mySeq !== state.requestSeq) return;
    state.loading = false;
    updateStatus(`Error: ${err.message}`);
  }
}

function currentViewportCovered() {
  const start = firstNeededOffset();
  const end = Math.ceil((viewport.scrollTop + viewport.clientHeight) / ROW_HEIGHT) + OVERSCAN;
  return start >= state.windowStart && end <= state.windowStart + state.rows.length;
}

function ensureWindow() {
  if (state.loading) return;
  if (!currentViewportCovered()) {
    fetchWindow(firstNeededOffset());
  } else {
    render();
  }
}

function render() {
  spacer.style.height = `${state.total * ROW_HEIGHT}px`;
  if (state.total === 0) {
    rowsEl.innerHTML = '<div class="empty">No matching log entries</div>';
    countEl.textContent = '0 of 0';
    return;
  }
  const visibleStart = Math.floor(viewport.scrollTop / ROW_HEIGHT);
  const visibleEnd = Math.min(state.total, Math.ceil((viewport.scrollTop + viewport.clientHeight) / ROW_HEIGHT));
  const renderStart = clamp(visibleStart - OVERSCAN, state.windowStart, state.windowStart + state.rows.length);
  const renderEnd = clamp(visibleEnd + OVERSCAN, renderStart, state.windowStart + state.rows.length);
  const html = [];
  for (let globalIndex = renderStart; globalIndex < renderEnd; globalIndex++) {
    const row = state.rows[globalIndex - state.windowStart];
    if (!row) continue;
    const dt = new Date(row.ts).toISOString().replace('T', ' ').replace('.000Z', 'Z');
    html.push(`<div class="row" data-offset="${globalIndex}" style="transform:translateY(${globalIndex * ROW_HEIGHT}px)">
      <div class="ts">${escapeHtml(dt)}</div>
      <div class="sev ${row.severity}">${escapeHtml(row.severity)}</div>
      <div class="service">${escapeHtml(row.service)}</div>
      <div class="message" title="${escapeHtml(row.message)}">${escapeHtml(row.message)}</div>
    </div>`);
  }
  rowsEl.innerHTML = html.join('');
  countEl.textContent = `${visibleStart + 1}-${visibleEnd} of ${state.total.toLocaleString()}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function updateStatus(text) {
  if (text) statusEl.textContent = text;
  else statusEl.textContent = state.loading ? 'Loading…' : 'Ready';
}

async function loadStats() {
  const res = await fetch(`${API}/api/stats`);
  const data = await res.json();
  state.stats = data;
  statsEl.innerHTML = `<span class="stat">total ${data.total.toLocaleString()}</span>` +
    Object.entries(data.bySeverity).map(([k, v]) => `<span class="stat ${k}">${k} ${Number(v).toLocaleString()}</span>`).join('');
}

function resetAndFetch() {
  state.severity = severityEl.value;
  state.q = searchEl.value;
  state.rows = [];
  state.windowStart = 0;
  state.total = 0;
  rowsEl.innerHTML = '';
  viewport.scrollTop = 0;
  ++state.requestSeq; // invalidate stale in-flight responses immediately
  fetchWindow(0);
}

let scrollRaf = 0;
viewport.addEventListener('scroll', () => {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    ensureWindow();
  });
});
severityEl.addEventListener('change', resetAndFetch);
searchEl.addEventListener('input', debounce(resetAndFetch, 220));
window.addEventListener('resize', render);

loadStats().catch(() => {});
fetchWindow(0);
