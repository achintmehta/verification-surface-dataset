import './styles.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const ROW_HEIGHT = 34;
const HEADER_HEIGHT = 34;
const OVERSCAN = 12;
const FETCH_LIMIT = 120;

const app = document.querySelector('#app');
app.innerHTML = `
  <header class="topbar">
    <div>
      <h1>Log Explorer</h1>
      <p>100k deterministic rows, server-windowed queries, virtualized DOM.</p>
    </div>
    <div class="status" id="status">starting…</div>
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
    <label class="searchLabel">
      Message contains
      <input id="search" type="search" placeholder="try: cache, timeout, marker-1234" autocomplete="off" />
    </label>
    <div class="badges" id="badges"></div>
    <div class="visibleCount" id="visibleCount">0 of 0</div>
  </section>

  <main class="tableShell">
    <div class="tableHeader gridRow">
      <div>Timestamp</div>
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
  scroller: document.querySelector('#scroller'),
  spacer: document.querySelector('#spacer'),
  rows: document.querySelector('#rows')
};

let total = 0;
let rows = [];
let loadedOffset = 0;
let querySeq = 0;
let activeController = null;
let renderScheduled = false;
let searchTimer = null;
let filters = { severity: '', q: '' };

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}

function setStatus(text, busy = false) {
  els.status.textContent = text;
  els.status.classList.toggle('busy', busy);
}

async function loadStats() {
  try {
    const res = await fetch(`${API_BASE}/api/stats`);
    const stats = await res.json();
    const sev = stats.severity || {};
    els.badges.innerHTML = ['debug', 'info', 'warn', 'error']
      .map(s => `<span class="badge sev-${s}">${s}: ${(sev[s] || 0).toLocaleString()}</span>`)
      .join('');
  } catch {
    els.badges.textContent = 'stats unavailable';
  }
}

function paramsFor(offset, limit) {
  const p = new URLSearchParams({ offset: String(Math.max(0, offset)), limit: String(limit) });
  if (filters.severity) p.set('severity', filters.severity);
  if (filters.q) p.set('q', filters.q);
  return p;
}

async function fetchWindow(offset, reason = 'scroll') {
  const seq = ++querySeq;
  if (activeController) activeController.abort();
  const controller = new AbortController();
  activeController = controller;
  const safeOffset = Math.max(0, Math.min(offset, Math.max(0, total - 1)));
  setStatus(`loading ${reason} @ ${safeOffset.toLocaleString()}…`, true);
  try {
    const res = await fetch(`${API_BASE}/api/logs?${paramsFor(safeOffset, FETCH_LIMIT)}`, { signal: controller.signal });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    if (seq !== querySeq) return; // stale response from an older filter/scroll request
    total = Number(data.total || 0);
    rows = data.rows || [];
    loadedOffset = safeOffset;
    els.spacer.style.height = `${total * ROW_HEIGHT}px`;
    setStatus(`ready (${rows.length} row window)`, false);
    renderNow();
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (seq !== querySeq) return;
    setStatus('load failed', false);
    els.rows.innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`;
  }
}

function visibleRange() {
  const viewportRows = Math.ceil(els.scroller.clientHeight / ROW_HEIGHT) || 20;
  const first = Math.floor(els.scroller.scrollTop / ROW_HEIGHT);
  const start = Math.max(0, first - OVERSCAN);
  const end = Math.min(total, first + viewportRows + OVERSCAN);
  return { first, start, end, viewportRows };
}

function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    renderNow();
  });
}

function renderNow() {
  const { first, start, end } = visibleRange();
  if (total === 0) {
    els.rows.style.transform = 'translateY(0px)';
    els.rows.innerHTML = '<div class="empty">No logs match these filters.</div>';
    els.visibleCount.textContent = `0 of 0`;
    return;
  }

  const rowEnd = loadedOffset + rows.length;
  const needsFetch = start < loadedOffset || end > rowEnd;
  if (needsFetch) {
    const centered = Math.max(0, first - Math.floor(OVERSCAN / 2));
    fetchWindow(centered, 'scroll');
  }

  const html = [];
  const renderStart = Math.max(start, loadedOffset);
  const renderEnd = Math.min(end, rowEnd, total);
  for (let index = renderStart; index < renderEnd; index++) {
    const row = rows[index - loadedOffset];
    if (!row) continue;
    const date = new Date(row.ts).toISOString().replace('T', ' ').replace('.000Z', 'Z');
    html.push(`
      <div class="logRow gridRow" data-index="${index}" data-id="${row.id}" style="height:${ROW_HEIGHT}px">
        <div class="ts">${date}</div>
        <div><span class="pill sev-${row.severity}">${row.severity}</span></div>
        <div class="service">${escapeHtml(row.service)}</div>
        <div class="message">${escapeHtml(row.message)}</div>
      </div>
    `);
  }
  els.rows.style.transform = `translateY(${renderStart * ROW_HEIGHT}px)`;
  els.rows.innerHTML = html.join('') || '<div class="empty">Loading…</div>';
  const visibleDom = els.rows.querySelectorAll('.logRow').length;
  els.visibleCount.textContent = `${visibleDom} of ${total.toLocaleString()}`;
}

function resetAndLoad() {
  rows = [];
  loadedOffset = 0;
  total = 0;
  els.scroller.scrollTop = 0;
  els.spacer.style.height = '0px';
  els.rows.innerHTML = '<div class="empty">Loading…</div>';
  fetchWindow(0, 'filter');
}

els.scroller.addEventListener('scroll', scheduleRender, { passive: true });
els.severity.addEventListener('change', () => {
  filters.severity = els.severity.value;
  resetAndLoad();
});
els.search.addEventListener('input', () => {
  window.clearTimeout(searchTimer);
  const value = els.search.value.trim();
  setStatus('typing…', false);
  searchTimer = window.setTimeout(() => {
    filters.q = value;
    resetAndLoad();
  }, 220);
});
window.addEventListener('resize', scheduleRender);

loadStats();
resetAndLoad();
