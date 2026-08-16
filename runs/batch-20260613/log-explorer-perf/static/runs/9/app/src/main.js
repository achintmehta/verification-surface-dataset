import './styles.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3000';
const ROW_HEIGHT = 34;
const LIMIT = 120;
const OVERSCAN = 12;
const DEBOUNCE_MS = 220;

const state = {
  total: 0,
  rowsByIndex: new Map(),
  pendingWindows: new Set(),
  severity: '',
  q: '',
  stats: null,
  generation: 0,
  abortController: null,
  hasLoaded: false,
  lastVisibleStart: 0,
  lastVisibleEnd: 0
};

const app = document.querySelector('#app');
app.innerHTML = `
  <header class="app-header">
    <div>
      <h1>Log Explorer</h1>
      <p>100,000 deterministic rows, server-windowed and virtualized.</p>
    </div>
    <div class="status" id="status">Connecting…</div>
  </header>

  <section class="toolbar">
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
    <label class="search-label">
      Message contains
      <input id="searchInput" type="search" autocomplete="off" placeholder="timeout, queue, tenant-042…" />
    </label>
    <div class="badges" id="badges"></div>
    <div class="visible-count" id="visibleCount">0 of 0</div>
  </section>

  <main class="table-card">
    <div class="table-head">
      <div>Time</div><div>Severity</div><div>Service</div><div>Message</div>
    </div>
    <div id="scroller" class="scroller" tabindex="0" aria-label="Virtualized log table">
      <div id="spacer" class="spacer"></div>
      <div id="rows" class="rows"></div>
    </div>
  </main>
`;

const els = {
  status: document.querySelector('#status'),
  severity: document.querySelector('#severityFilter'),
  search: document.querySelector('#searchInput'),
  badges: document.querySelector('#badges'),
  visibleCount: document.querySelector('#visibleCount'),
  scroller: document.querySelector('#scroller'),
  spacer: document.querySelector('#spacer'),
  rows: document.querySelector('#rows')
};

function params(extra = {}) {
  const p = new URLSearchParams();
  if (state.severity) p.set('severity', state.severity);
  if (state.q) p.set('q', state.q);
  for (const [key, value] of Object.entries(extra)) p.set(key, value);
  return p;
}

async function fetchJson(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function loadStats() {
  try {
    state.stats = await fetchJson('/api/stats');
    renderBadges();
  } catch (error) {
    console.warn('Unable to load stats yet:', error);
  }
}

function renderBadges() {
  const s = state.stats?.severities || {};
  els.badges.innerHTML = ['debug', 'info', 'warn', 'error']
    .map(sev => `<span class="badge sev-${sev}">${sev}<b>${(s[sev] || 0).toLocaleString()}</b></span>`)
    .join('');
}

function resetForFilters() {
  state.generation++;
  state.rowsByIndex.clear();
  state.pendingWindows.clear();
  state.total = 0;
  state.hasLoaded = false;
  if (state.abortController) state.abortController.abort();
  els.scroller.scrollTop = 0;
  els.rows.innerHTML = '';
  els.spacer.style.height = '0px';
  requestWindow(0, true);
}

function debounce(fn, delay) {
  let timer = null;
  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), delay);
  };
}

const debouncedSearch = debounce(() => {
  state.q = els.search.value.trim();
  resetForFilters();
}, DEBOUNCE_MS);

els.severity.addEventListener('change', () => {
  state.severity = els.severity.value;
  resetForFilters();
});

els.search.addEventListener('input', () => {
  els.status.textContent = 'Typing…';
  debouncedSearch();
});

els.scroller.addEventListener('scroll', () => {
  renderVisibleRows();
});

function windowStartFor(index) {
  return Math.max(0, Math.floor(index / LIMIT) * LIMIT);
}

async function requestWindow(offset, highPriority = false) {
  offset = Math.max(0, Math.min(offset, Math.max(0, state.total - 1)));
  offset = windowStartFor(offset);
  const key = `${state.generation}:${offset}`;
  if (state.pendingWindows.has(key)) return;
  state.pendingWindows.add(key);

  const generation = state.generation;
  const controller = new AbortController();
  if (highPriority) {
    if (state.abortController) state.abortController.abort();
    state.abortController = controller;
  }

  els.status.textContent = 'Loading…';
  try {
    const data = await fetchJson(`/api/logs?${params({ offset, limit: LIMIT })}`, { signal: controller.signal });
    if (generation !== state.generation) return;
    state.total = data.total;
    state.hasLoaded = true;
    els.spacer.style.height = `${state.total * ROW_HEIGHT}px`;
    data.rows.forEach((row, i) => state.rowsByIndex.set(offset + i, row));
    state.pendingWindows.delete(key);
    els.status.textContent = `${state.total.toLocaleString()} matching logs`;
    renderVisibleRows();
  } catch (error) {
    state.pendingWindows.delete(key);
    if (error.name === 'AbortError') return;
    els.status.textContent = `Error: ${error.message}`;
    console.error(error);
  }
}

function ensureData(start, end) {
  if (!state.hasLoaded) {
    requestWindow(0, true);
    return;
  }
  if (state.total === 0) return;

  const first = Math.max(0, start);
  const last = Math.min(Math.max(0, state.total - 1), end);
  for (let idx = first; idx <= last; idx += LIMIT) {
    requestWindow(idx);
  }

  // If the viewport straddles a window and starts near the end, fetch both boundaries.
  requestWindow(first);
  requestWindow(last);
}

function renderVisibleRows() {
  const viewport = els.scroller.clientHeight || 500;
  const rawStart = Math.floor(els.scroller.scrollTop / ROW_HEIGHT);
  const visibleRows = Math.ceil(viewport / ROW_HEIGHT);
  const start = Math.max(0, rawStart - OVERSCAN);
  const end = Math.min(Math.max(0, state.total - 1), rawStart + visibleRows + OVERSCAN);
  state.lastVisibleStart = start;
  state.lastVisibleEnd = end;

  ensureData(start, end);

  const frag = document.createDocumentFragment();
  let rendered = 0;
  for (let index = start; index <= end; index++) {
    const row = state.rowsByIndex.get(index);
    const el = document.createElement('div');
    el.className = `log-row ${row ? `sev-border-${row.severity}` : 'placeholder'}`;
    el.style.transform = `translateY(${index * ROW_HEIGHT}px)`;
    el.style.height = `${ROW_HEIGHT}px`;
    el.dataset.index = String(index);
    if (row) {
      el.innerHTML = `
        <div class="mono">${escapeHtml(formatTime(row.ts))}</div>
        <div><span class="pill sev-${row.severity}">${row.severity}</span></div>
        <div class="service">${escapeHtml(row.service)}</div>
        <div class="message">${escapeHtml(row.message)}</div>
      `;
      rendered++;
    } else {
      el.innerHTML = '<div class="skeleton"></div><div class="skeleton short"></div><div class="skeleton"></div><div class="skeleton wide"></div>';
    }
    frag.appendChild(el);
  }
  els.rows.replaceChildren(frag);
  els.visibleCount.textContent = `${rendered} of ${state.total.toLocaleString()}`;
}

function formatTime(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toISOString().replace('T', ' ').replace('.000Z', 'Z');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[ch]));
}

loadStats();
requestWindow(0, true);
window.addEventListener('resize', renderVisibleRows);
