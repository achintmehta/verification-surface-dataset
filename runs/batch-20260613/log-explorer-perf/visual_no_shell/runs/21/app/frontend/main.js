const API_BASE = '';
const ROW_HEIGHT = 32;
const OVERSCAN = 10;
const FETCH_BATCH = 100; // rows per fetch
const DEBOUNCE_MS = 250;
const MAX_CACHED_PAGES = 50; // Keep at most 50 pages (5000 rows) in cache

// ── State ──
let state = {
  total: 0,
  severity: '',
  query: '',
  // Cache: cacheKey -> rows[] (keyed by pageStart aligned to FETCH_BATCH)
  cache: new Map(),
  // LRU order tracking
  cacheOrder: [],
  // Track the current filter generation to discard stale responses
  generation: 0,
};

// ── DOM refs ──
const scrollContainer = document.getElementById('scroll-container');
const scrollSpacer = document.getElementById('scroll-spacer');
const viewport = document.getElementById('viewport');
const severityFilter = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const rowCountEl = document.getElementById('row-count');
const severityBadgesEl = document.getElementById('severity-badges');

// ── API calls ──
async function fetchLogs(offset, limit, generation) {
  const params = new URLSearchParams({
    offset: String(offset),
    limit: String(limit),
  });
  if (state.severity) params.set('severity', state.severity);
  if (state.query) params.set('q', state.query);

  try {
    const res = await fetch(`${API_BASE}/api/logs?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // Discard if generation has changed (stale response)
    if (generation !== state.generation) return null;

    return data;
  } catch (err) {
    if (err.name === 'AbortError') return null;
    console.error('Fetch error:', err);
    return null;
  }
}

async function fetchStats() {
  try {
    const res = await fetch(`${API_BASE}/api/stats`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ── Severity badges ──
async function updateBadges() {
  const stats = await fetchStats();
  if (!stats) return;

  severityBadgesEl.innerHTML = ['debug', 'info', 'warn', 'error']
    .map(
      (s) =>
        `<span class="severity-badge ${s}">${s}: ${stats[s].toLocaleString()}</span>`
    )
    .join('');
}

// ── Cache management ──
function addToCache(key, rows) {
  if (state.cache.has(key)) {
    // Move to end of LRU order
    const idx = state.cacheOrder.indexOf(key);
    if (idx !== -1) state.cacheOrder.splice(idx, 1);
  }
  state.cache.set(key, rows);
  state.cacheOrder.push(key);

  // Evict oldest pages if cache is too large
  while (state.cacheOrder.length > MAX_CACHED_PAGES) {
    const oldKey = state.cacheOrder.shift();
    state.cache.delete(oldKey);
  }
}

// ── Virtual scroller ──
function getTotalHeight() {
  return state.total * ROW_HEIGHT;
}

function updateSpacer() {
  scrollSpacer.style.height = `${getTotalHeight()}px`;
}

function updateRowCount() {
  const visibleCount = viewport.children.length;
  rowCountEl.textContent = `${visibleCount} of ${state.total.toLocaleString()} entries`;
}

function formatTimestamp(ts) {
  const d = new Date(ts);
  return d.toISOString().replace('T', ' ').replace('Z', '').slice(0, 23);
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function createRowElement(row) {
  const div = document.createElement('div');
  div.className = 'log-row';
  div.style.height = `${ROW_HEIGHT}px`;

  const tsDiv = document.createElement('div');
  tsDiv.className = 'col col-ts';
  tsDiv.textContent = formatTimestamp(row.ts);

  const sevDiv = document.createElement('div');
  sevDiv.className = `col col-severity severity-${row.severity}`;
  sevDiv.textContent = row.severity;

  const svcDiv = document.createElement('div');
  svcDiv.className = 'col col-service';
  svcDiv.textContent = row.service;

  const msgDiv = document.createElement('div');
  msgDiv.className = 'col col-message';
  msgDiv.textContent = row.message;
  msgDiv.title = row.message;

  div.appendChild(tsDiv);
  div.appendChild(sevDiv);
  div.appendChild(svcDiv);
  div.appendChild(msgDiv);

  return div;
}

function createPlaceholderRow() {
  const div = document.createElement('div');
  div.className = 'log-row loading';
  div.style.height = `${ROW_HEIGHT}px`;
  div.innerHTML = `
    <div class="col col-ts">Loading...</div>
    <div class="col col-severity">—</div>
    <div class="col col-service">—</div>
    <div class="col col-message">—</div>
  `;
  return div;
}

// Get the page-aligned start for a given row index
function pageStart(index) {
  return Math.floor(index / FETCH_BATCH) * FETCH_BATCH;
}

// Cache key for current filter state
function makeCacheKey(pageOffset) {
  return `${state.generation}:${pageOffset}`;
}

// Pending fetches to avoid duplicate requests
const pendingFetches = new Set();

async function ensurePage(pageOffset) {
  const key = makeCacheKey(pageOffset);
  if (state.cache.has(key)) return;
  if (pendingFetches.has(key)) return;

  pendingFetches.add(key);
  const gen = state.generation;
  const data = await fetchLogs(pageOffset, FETCH_BATCH, gen);
  pendingFetches.delete(key);

  if (!data) return;

  // Store in cache
  addToCache(key, data.rows);

  // Update total if it changed
  if (data.total !== state.total) {
    state.total = data.total;
    updateSpacer();
    updateRowCount();
  }

  // Re-render to fill in any placeholders
  if (gen === state.generation) {
    renderVisibleRows();
  }
}

function renderVisibleRows() {
  const scrollTop = scrollContainer.scrollTop;
  const containerHeight = scrollContainer.clientHeight;

  if (state.total === 0) {
    viewport.innerHTML = '';
    viewport.style.transform = 'translateY(0px)';
    updateRowCount();
    return;
  }

  // Calculate visible range
  const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
  const visibleCount = Math.ceil(containerHeight / ROW_HEIGHT);

  const startIndex = Math.max(0, firstVisible - OVERSCAN);
  const endIndex = Math.min(state.total - 1, firstVisible + visibleCount + OVERSCAN);

  // Position the viewport
  const offsetY = startIndex * ROW_HEIGHT;
  viewport.style.transform = `translateY(${offsetY}px)`;

  // Determine which pages we need
  const neededPages = new Set();
  for (let i = startIndex; i <= endIndex; i++) {
    neededPages.add(pageStart(i));
  }

  // Build DOM using document fragment for efficiency
  const fragment = document.createDocumentFragment();

  for (let i = startIndex; i <= endIndex; i++) {
    const ps = pageStart(i);
    const key = makeCacheKey(ps);
    const cachedRows = state.cache.get(key);

    if (cachedRows) {
      const localIndex = i - ps;
      if (localIndex < cachedRows.length) {
        fragment.appendChild(createRowElement(cachedRows[localIndex]));
      }
    } else {
      fragment.appendChild(createPlaceholderRow());
    }
  }

  // Replace viewport content
  viewport.innerHTML = '';
  viewport.appendChild(fragment);

  // Trigger fetches for missing pages
  for (const ps of neededPages) {
    const key = makeCacheKey(ps);
    if (!state.cache.has(key)) {
      ensurePage(ps);
    }
  }

  updateRowCount();
}

// ── Filter changes ──
function resetAndRefetch() {
  state.generation++;
  state.cache.clear();
  state.cacheOrder = [];
  state.total = 0;
  pendingFetches.clear();
  scrollContainer.scrollTop = 0;
  updateSpacer();
  viewport.innerHTML = '';

  const gen = state.generation;

  // Fetch the initial page to get the total
  fetchLogs(0, FETCH_BATCH, gen).then((data) => {
    if (!data || gen !== state.generation) return;
    state.total = data.total;
    updateSpacer();
    addToCache(makeCacheKey(0), data.rows);
    renderVisibleRows();
  });
}

// ── Event listeners ──
severityFilter.addEventListener('change', () => {
  state.severity = severityFilter.value;
  resetAndRefetch();
});

let searchTimeout = null;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    state.query = searchInput.value.trim();
    resetAndRefetch();
  }, DEBOUNCE_MS);
});

// Scroll handler with requestAnimationFrame throttling
let scrollRaf = null;
scrollContainer.addEventListener('scroll', () => {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = null;
    renderVisibleRows();
  });
});

// ── Initial load with retry ──
async function init() {
  // Retry until the backend is ready
  let retries = 0;
  const maxRetries = 30;

  async function tryLoad() {
    const data = await fetchLogs(0, FETCH_BATCH, state.generation);
    if (data) {
      state.total = data.total;
      updateSpacer();
      addToCache(makeCacheKey(0), data.rows);
      renderVisibleRows();
      updateBadges();
      return;
    }

    retries++;
    if (retries < maxRetries) {
      rowCountEl.textContent = 'Connecting to server...';
      setTimeout(tryLoad, 2000);
    } else {
      rowCountEl.textContent = 'Failed to connect to server';
    }
  }

  tryLoad();
}

init();
