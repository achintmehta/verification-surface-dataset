// Virtualized log explorer client.
// - Only the visible window of rows exists in the DOM (recycled row pool).
// - Windows are fetched from the server; stale responses never overwrite new.
// - Search is debounced and never blocks input.

const ROW_H = 30;
const OVERSCAN = 12; // extra rows above/below viewport
const PAGE = 200; // server max limit; fetch in chunks of this
const DEBOUNCE_MS = 180;

const API = '/api';

const els = {
  viewport: document.getElementById('viewport'),
  spacer: document.getElementById('spacer'),
  pool: document.getElementById('pool'),
  severity: document.getElementById('severity'),
  search: document.getElementById('search'),
  count: document.getElementById('count'),
  status: document.getElementById('status'),
  badges: document.getElementById('badges'),
};

const state = {
  total: 0,
  severity: '',
  q: '',
  // Row cache: Map<index, row>. Bounded via eviction.
  cache: new Map(),
  cacheOrder: [], // page-start indexes in insertion order for eviction
  loadedPages: new Set(),
  inflight: new Map(), // pageStart -> AbortController
  // Monotonic token: bumps whenever filters change; guards stale responses.
  filterToken: 0,
  poolRows: [], // reusable DOM row elements
  renderScheduled: false,
};

const MAX_CACHED_PAGES = 30;

// --------------------------------------------------------------------------
// DOM row pool
// --------------------------------------------------------------------------
function ensurePool(size) {
  while (state.poolRows.length < size) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML =
      '<div class="col col-ts"></div>' +
      '<div class="col col-sev"><span class="sev"></span></div>' +
      '<div class="col col-svc"></div>' +
      '<div class="col col-msg"></div>';
    row._ts = row.children[0];
    row._sevWrap = row.children[1];
    row._sev = row.children[1].firstChild;
    row._svc = row.children[2];
    row._msg = row.children[3];
    els.pool.appendChild(row);
    state.poolRows.push(row);
  }
  // Hide extras
  for (let i = size; i < state.poolRows.length; i++) {
    state.poolRows[i].style.display = 'none';
  }
}

function fmtTs(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return ts;
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

// --------------------------------------------------------------------------
// Rendering the visible window
// --------------------------------------------------------------------------
function scheduleRender() {
  if (state.renderScheduled) return;
  state.renderScheduled = true;
  requestAnimationFrame(() => {
    state.renderScheduled = false;
    render();
  });
}

function render() {
  const scrollTop = els.viewport.scrollTop;
  const viewH = els.viewport.clientHeight;

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const visibleCount = Math.ceil(viewH / ROW_H) + OVERSCAN * 2;
  const last = Math.min(state.total, first + visibleCount);
  const count = Math.max(0, last - first);

  ensurePool(count);

  for (let i = 0; i < count; i++) {
    const idx = first + i;
    const rowEl = state.poolRows[i];
    rowEl.style.display = 'flex';
    rowEl.style.transform = `translateY(${idx * ROW_H}px)`;

    const data = state.cache.get(idx);
    if (data) {
      rowEl.classList.remove('loading');
      rowEl._ts.textContent = fmtTs(data.ts);
      rowEl._sev.textContent = data.severity;
      rowEl._sev.className = 'sev ' + data.severity;
      rowEl._svc.textContent = data.service;
      rowEl._msg.textContent = data.message;
      rowEl._msg.title = data.message;
    } else {
      rowEl.classList.add('loading');
      rowEl._ts.textContent = '…';
      rowEl._sev.textContent = '';
      rowEl._sev.className = 'sev';
      rowEl._svc.textContent = '';
      rowEl._msg.textContent = '';
      rowEl._msg.title = '';
    }
  }

  // Ensure needed pages are being fetched.
  requestPages(first, last);
}

// --------------------------------------------------------------------------
// Windowed fetching
// --------------------------------------------------------------------------
function pageStartFor(idx) {
  return Math.floor(idx / PAGE) * PAGE;
}

function requestPages(first, last) {
  if (state.total === 0) return;
  const startPage = pageStartFor(first);
  const endPage = pageStartFor(Math.max(first, last - 1));
  for (let ps = startPage; ps <= endPage; ps += PAGE) {
    if (state.loadedPages.has(ps) || state.inflight.has(ps)) continue;
    fetchPage(ps);
  }
}

async function fetchPage(pageStart) {
  const token = state.filterToken;
  const controller = new AbortController();
  state.inflight.set(pageStart, controller);
  setStatus('loading…');

  const params = new URLSearchParams({
    offset: String(pageStart),
    limit: String(PAGE),
  });
  if (state.severity) params.set('severity', state.severity);
  if (state.q) params.set('q', state.q);

  try {
    const res = await fetch(`${API}/logs?${params.toString()}`, {
      signal: controller.signal,
    });
    if (!res.ok) throw new Error('bad status ' + res.status);
    const data = await res.json();

    // Stale guard: if filters changed since this request started, drop it.
    if (token !== state.filterToken) return;

    state.total = data.total;
    updateSpacerHeight();
    updateCount();

    data.rows.forEach((row, i) => {
      state.cache.set(pageStart + i, row);
    });
    state.loadedPages.add(pageStart);
    state.cacheOrder.push(pageStart);
    evictIfNeeded();

    scheduleRender();
  } catch (err) {
    if (err.name === 'AbortError') return; // superseded by newer filter
    console.error('fetchPage error', err);
  } finally {
    state.inflight.delete(pageStart);
    if (state.inflight.size === 0) setStatus('');
  }
}

function evictIfNeeded() {
  while (state.cacheOrder.length > MAX_CACHED_PAGES) {
    const oldPage = state.cacheOrder.shift();
    if (!state.loadedPages.has(oldPage)) continue;
    // Don't evict the page currently under the viewport.
    const scrollTop = els.viewport.scrollTop;
    const firstVisible = Math.floor(scrollTop / ROW_H);
    const visPage = pageStartFor(firstVisible);
    if (oldPage === visPage) {
      state.cacheOrder.push(oldPage); // keep, retry later
      if (state.cacheOrder.length <= MAX_CACHED_PAGES + 1) break;
      continue;
    }
    for (let i = oldPage; i < oldPage + PAGE; i++) state.cache.delete(i);
    state.loadedPages.delete(oldPage);
  }
}

// --------------------------------------------------------------------------
// Filter changes
// --------------------------------------------------------------------------
function resetForFilterChange() {
  // Bump token so all in-flight responses are ignored, and abort them.
  state.filterToken++;
  for (const [, ctrl] of state.inflight) ctrl.abort();
  state.inflight.clear();
  state.cache.clear();
  state.cacheOrder = [];
  state.loadedPages.clear();
  els.viewport.scrollTop = 0;
  // total unknown until first fetch; fetch page 0 immediately.
  scheduleRender();
  fetchPage(0);
}

function updateSpacerHeight() {
  els.spacer.style.height = `${state.total * ROW_H}px`;
}

function updateCount() {
  const filtered = state.severity || state.q;
  if (filtered) {
    els.count.textContent = `${state.total.toLocaleString()} of ${globalTotal.toLocaleString()}`;
  } else {
    els.count.textContent = `${state.total.toLocaleString()} rows`;
  }
}

function setStatus(text) {
  els.status.textContent = text;
}

// --------------------------------------------------------------------------
// Stats / badges
// --------------------------------------------------------------------------
let globalTotal = 0;
async function loadStats() {
  try {
    const res = await fetch(`${API}/stats`);
    const data = await res.json();
    globalTotal = data.total;
    renderBadges(data);
  } catch (err) {
    console.error('stats error', err);
  }
}

function renderBadges(stats) {
  const order = ['debug', 'info', 'warn', 'error'];
  els.badges.innerHTML = '';
  for (const sev of order) {
    const b = document.createElement('span');
    b.className = 'badge';
    b.innerHTML = `<span class="dot ${sev}"></span>${sev}: ${(
      stats.bySeverity[sev] || 0
    ).toLocaleString()}`;
    els.badges.appendChild(b);
  }
}

// --------------------------------------------------------------------------
// Events
// --------------------------------------------------------------------------
let debounceTimer = null;

els.viewport.addEventListener('scroll', scheduleRender, { passive: true });
window.addEventListener('resize', scheduleRender);

els.severity.addEventListener('change', () => {
  state.severity = els.severity.value;
  resetForFilterChange();
});

els.search.addEventListener('input', () => {
  // Never block input: just schedule a debounced fetch.
  const val = els.search.value.trim();
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    if (val === state.q) return;
    state.q = val;
    resetForFilterChange();
  }, DEBOUNCE_MS);
});

// --------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------
async function boot() {
  await loadStats();
  // Initial load
  fetchPage(0);
  scheduleRender();
}

boot();
