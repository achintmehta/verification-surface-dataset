const API_BASE = '/api';
const ROW_HEIGHT = 32;
const OVERSCAN = 10;
const FETCH_LIMIT = 100;
const DEBOUNCE_MS = 250;

// ── State ──────────────────────────────────────────────────────────────────
const state = {
  total: 0,
  severity: '',
  searchQuery: '',
  // Row cache: Map<blockStart, { rows: [], pending?: boolean }>
  cache: new Map(),
  // Current request generation to discard stale responses
  generation: 0,
  stats: null,
};

// ── DOM refs ───────────────────────────────────────────────────────────────
const scrollEl = document.getElementById('virtual-scroll');
const spacerEl = document.getElementById('scroll-spacer');
const containerEl = document.getElementById('row-container');
const rowCountEl = document.getElementById('row-count');
const severityFilter = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const badgesEl = document.getElementById('severity-badges');

// ── Row pool (DOM recycling) ───────────────────────────────────────────────
const rowPool = [];
const activeRows = new Map(); // global-row-index -> element

function createRowEl() {
  const el = document.createElement('div');
  el.className = 'log-row';
  el.innerHTML =
    '<div class="col col-ts"></div>' +
    '<div class="col col-severity"></div>' +
    '<div class="col col-service"></div>' +
    '<div class="col col-message"></div>';
  return el;
}

function acquireRowEl() {
  return rowPool.length > 0 ? rowPool.pop() : createRowEl();
}

function releaseRowEl(el) {
  if (el.parentNode) el.parentNode.removeChild(el);
  rowPool.push(el);
}

function bindRowEl(el, row, index) {
  const ts = new Date(row.ts);
  const tsStr = ts.toISOString().replace('T', ' ').replace('Z', '').slice(0, 23);

  const cols = el.children;
  cols[0].textContent = tsStr;
  cols[1].textContent = row.severity.toUpperCase();
  cols[1].className = 'col col-severity severity-' + row.severity;
  cols[2].textContent = row.service;
  cols[3].textContent = row.message;

  el.style.transform = 'translateY(' + (index * ROW_HEIGHT) + 'px)';
  el.style.height = ROW_HEIGHT + 'px';
}

// ── API fetching with generation-based staleness guard ─────────────────────
async function fetchWindow(offset, limit, generation) {
  const params = new URLSearchParams();
  params.set('offset', String(offset));
  params.set('limit', String(limit));
  if (state.severity) params.set('severity', state.severity);
  if (state.searchQuery) params.set('q', state.searchQuery);

  const resp = await fetch(API_BASE + '/logs?' + params.toString());
  if (!resp.ok) throw new Error('API error: ' + resp.status);
  const data = await resp.json();

  // Discard if a newer generation has been started
  if (generation !== state.generation) return null;

  return data;
}

async function fetchStats() {
  const resp = await fetch(API_BASE + '/stats');
  if (!resp.ok) throw new Error('Stats API error: ' + resp.status);
  return resp.json();
}

// ── Cache management ───────────────────────────────────────────────────────
function blockStartFor(index) {
  return Math.floor(index / FETCH_LIMIT) * FETCH_LIMIT;
}

function getCachedRow(index) {
  const bs = blockStartFor(index);
  const entry = state.cache.get(bs);
  if (!entry || entry.pending) return null;
  const localIdx = index - bs;
  if (localIdx < 0 || localIdx >= entry.rows.length) return null;
  return entry.rows[localIdx];
}

// Track in-flight block fetches to prevent duplicates
const inflightBlocks = new Set();

async function ensureBlock(blockStart, generation) {
  if (state.cache.has(blockStart) && !state.cache.get(blockStart).pending) return;
  if (inflightBlocks.has(blockStart)) return;

  inflightBlocks.add(blockStart);
  // Mark pending
  state.cache.set(blockStart, { rows: [], pending: true });

  try {
    const data = await fetchWindow(blockStart, FETCH_LIMIT, generation);
    inflightBlocks.delete(blockStart);

    if (!data) {
      // Stale generation – clear pending marker
      state.cache.delete(blockStart);
      return;
    }

    state.total = data.total;
    state.cache.set(blockStart, { rows: data.rows });
    updateSpacerHeight();
    updateRowCount();
    scheduleRender();
  } catch (err) {
    inflightBlocks.delete(blockStart);
    state.cache.delete(blockStart);
    console.error('Failed to fetch block', blockStart, err);
  }
}

// ── Render visible rows ───────────────────────────────────────────────────
let rafId = null;

function scheduleRender() {
  if (rafId !== null) return;
  rafId = requestAnimationFrame(() => {
    rafId = null;
    render();
  });
}

function render() {
  const scrollTop = scrollEl.scrollTop;
  const viewportHeight = scrollEl.clientHeight;
  if (viewportHeight === 0) return; // not visible yet

  const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT);

  const rangeStart = Math.max(0, firstVisible - OVERSCAN);
  const rangeEnd = Math.min(state.total, firstVisible + visibleCount + OVERSCAN);

  // Determine which blocks we need
  const neededBlocks = new Set();
  for (let i = rangeStart; i < rangeEnd; i++) {
    neededBlocks.add(blockStartFor(i));
  }

  // Kick off fetches for missing blocks
  const gen = state.generation;
  for (const bs of neededBlocks) {
    const entry = state.cache.get(bs);
    if (!entry || entry.pending) {
      ensureBlock(bs, gen);
    }
  }

  // Recycle rows that are now out of range
  for (const [idx, el] of activeRows) {
    if (idx < rangeStart || idx >= rangeEnd) {
      activeRows.delete(idx);
      releaseRowEl(el);
    }
  }

  // Bind / create rows in the visible range
  for (let i = rangeStart; i < rangeEnd; i++) {
    if (activeRows.has(i)) continue; // already showing

    const row = getCachedRow(i);
    if (!row) continue; // data not loaded yet

    const el = acquireRowEl();
    bindRowEl(el, row, i);
    containerEl.appendChild(el);
    activeRows.set(i, el);
  }

  updateRowCount();
}

// ── UI helpers ─────────────────────────────────────────────────────────────
function updateSpacerHeight() {
  spacerEl.style.height = (state.total * ROW_HEIGHT) + 'px';
}

function updateRowCount() {
  const rendered = activeRows.size;
  rowCountEl.textContent = rendered + ' of ' + state.total.toLocaleString() + ' logs';
}

function updateBadges() {
  if (!state.stats) return;
  const s = state.stats.severities;
  badgesEl.innerHTML =
    '<span class="severity-badge debug">D: ' + s.debug.toLocaleString() + '</span>' +
    '<span class="severity-badge info">I: ' + s.info.toLocaleString() + '</span>' +
    '<span class="severity-badge warn">W: ' + s.warn.toLocaleString() + '</span>' +
    '<span class="severity-badge error">E: ' + s.error.toLocaleString() + '</span>';
}

// ── Filter changes ─────────────────────────────────────────────────────────
function resetAndReload() {
  // Bump generation to invalidate in-flight requests
  state.generation++;
  state.cache.clear();
  inflightBlocks.clear();

  // Recycle all active DOM rows
  for (const [, el] of activeRows) {
    releaseRowEl(el);
  }
  activeRows.clear();

  // Reset scroll position
  scrollEl.scrollTop = 0;
  state.total = 0;
  updateSpacerHeight();

  // Fetch initial window
  const gen = state.generation;
  fetchWindow(0, FETCH_LIMIT, gen).then((data) => {
    if (!data) return;
    state.total = data.total;
    state.cache.set(0, { rows: data.rows });
    updateSpacerHeight();
    updateRowCount();
    scheduleRender();
  }).catch((err) => {
    console.error('Failed to load initial window:', err);
  });
}

// Severity filter change
severityFilter.addEventListener('change', () => {
  state.severity = severityFilter.value;
  resetAndReload();
});

// Debounced search input
let searchTimeout = null;
searchInput.addEventListener('input', () => {
  if (searchTimeout) clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    state.searchQuery = searchInput.value.trim();
    resetAndReload();
  }, DEBOUNCE_MS);
});

// Scroll → re-render
scrollEl.addEventListener('scroll', () => {
  scheduleRender();
});

// ── Initial load ───────────────────────────────────────────────────────────
async function init() {
  try {
    // Load stats for severity badges
    state.stats = await fetchStats();
    updateBadges();

    // Load initial window
    const gen = state.generation;
    const data = await fetchWindow(0, FETCH_LIMIT, gen);
    if (!data) return;

    state.total = data.total;
    state.cache.set(0, { rows: data.rows });
    updateSpacerHeight();
    scheduleRender();
  } catch (err) {
    console.error('Failed to initialize:', err);
    rowCountEl.textContent = 'Error loading logs';
  }
}

init();
