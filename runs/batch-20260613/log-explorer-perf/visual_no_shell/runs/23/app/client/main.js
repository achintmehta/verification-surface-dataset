// ─── Configuration ───────────────────────────────────────────────────
const ROW_HEIGHT = 32;
const OVERSCAN = 10;        // extra rows above/below viewport
const FETCH_LIMIT = 200;    // max rows per API call
const DEBOUNCE_MS = 250;    // search debounce
const BUFFER_AHEAD = 100;   // prefetch buffer rows beyond visible window
const MAX_CACHED_CHUNKS = 10; // max number of chunks to keep in cache

// ─── State ───────────────────────────────────────────────────────────
let state = {
  total: 0,
  severity: '',
  query: '',
  cache: new Map(),        // offset -> { rows, fetchId }
  currentFetchId: 0,       // monotonic counter to discard stale responses
  pendingFetches: new Set(), // track in-flight chunk keys
  abortController: null,   // for cancelling stale fetch requests
};

// ─── DOM References ──────────────────────────────────────────────────
const scrollContainer = document.getElementById('scroll-container');
const scrollSpacer = document.getElementById('scroll-spacer');
const viewport = document.getElementById('viewport');
const severitySelect = document.getElementById('severity-select');
const searchInput = document.getElementById('search-input');
const rowCountEl = document.getElementById('row-count');
const badgesEl = document.getElementById('severity-badges');

// ─── Row Pool (DOM recycling) ────────────────────────────────────────
const rowPool = [];
const activeRows = new Map(); // rowIndex -> DOM element

function createRowElement() {
  const row = document.createElement('div');
  row.className = 'log-row';
  row.innerHTML = `
    <div class="col col-ts"></div>
    <div class="col col-severity"></div>
    <div class="col col-service service-name"></div>
    <div class="col col-message"></div>
  `;
  return row;
}

function acquireRow() {
  return rowPool.length > 0 ? rowPool.pop() : createRowElement();
}

function releaseRow(el) {
  el.style.transform = '';
  rowPool.push(el);
}

function populateRow(el, row, index) {
  const cols = el.children;

  // Timestamp
  const d = new Date(row.ts);
  cols[0].textContent = d.toISOString().replace('T', ' ').replace('Z', '').slice(0, 23);

  // Severity
  cols[1].innerHTML = `<span class="severity-tag severity-tag-${row.severity}">${row.severity}</span>`;

  // Service
  cols[2].textContent = row.service;

  // Message
  cols[3].textContent = row.message;

  // Position
  el.style.position = 'absolute';
  el.style.top = '0';
  el.style.left = '0';
  el.style.right = '0';
  el.style.height = ROW_HEIGHT + 'px';
  el.style.transform = `translateY(${index * ROW_HEIGHT}px)`;
}

// ─── API Fetch ───────────────────────────────────────────────────────
async function fetchLogs(offset, limit, signal) {
  const params = new URLSearchParams();
  params.set('offset', offset);
  params.set('limit', limit);
  if (state.severity) params.set('severity', state.severity);
  if (state.query) params.set('q', state.query);

  const response = await fetch(`/api/logs?${params}`, { signal });
  if (!response.ok) throw new Error(`API error: ${response.status}`);
  return response.json();
}

async function fetchStats() {
  const response = await fetch('/api/stats');
  if (!response.ok) return null;
  return response.json();
}

// ─── Cache Management ────────────────────────────────────────────────
function evictDistantChunks(currentOffset) {
  if (state.cache.size <= MAX_CACHED_CHUNKS) return;

  const currentChunk = Math.floor(currentOffset / FETCH_LIMIT) * FETCH_LIMIT;
  const entries = [...state.cache.entries()];

  // Sort by distance from current chunk
  entries.sort((a, b) => Math.abs(a[0] - currentChunk) - Math.abs(b[0] - currentChunk));

  // Keep only the closest MAX_CACHED_CHUNKS
  const toRemove = entries.slice(MAX_CACHED_CHUNKS);
  for (const [key] of toRemove) {
    state.cache.delete(key);
  }
}

// ─── Data fetching with caching ──────────────────────────────────────
async function ensureData(startRow, endRow) {
  const fetchId = state.currentFetchId;

  // Find which chunks we need (aligned to FETCH_LIMIT boundaries)
  const chunkStart = Math.floor(startRow / FETCH_LIMIT) * FETCH_LIMIT;
  const chunkEnd = Math.ceil(endRow / FETCH_LIMIT) * FETCH_LIMIT;

  for (let offset = chunkStart; offset < chunkEnd; offset += FETCH_LIMIT) {
    // Skip if already cached with current fetchId or currently being fetched
    const cached = state.cache.get(offset);
    if (cached && cached.fetchId === fetchId) continue;

    const key = `${fetchId}-${offset}`;
    if (state.pendingFetches.has(key)) continue;

    state.pendingFetches.add(key);

    // Use the current abort controller's signal
    const signal = state.abortController ? state.abortController.signal : undefined;

    fetchLogs(offset, FETCH_LIMIT, signal)
      .then(data => {
        state.pendingFetches.delete(key);
        // Discard if stale
        if (fetchId !== state.currentFetchId) return;

        state.total = data.total;
        state.cache.set(offset, { rows: data.rows, fetchId });

        // Evict distant chunks to bound memory
        const scrollTop = scrollContainer.scrollTop;
        const currentRow = Math.floor(scrollTop / ROW_HEIGHT);
        evictDistantChunks(currentRow);

        updateSpacerHeight();
        updateRowCount();
        renderVisibleRows();
      })
      .catch(err => {
        state.pendingFetches.delete(key);
        if (err.name === 'AbortError') return; // expected on filter change
        console.error('Fetch error:', err);
      });
  }
}

function getRow(index) {
  const chunkOffset = Math.floor(index / FETCH_LIMIT) * FETCH_LIMIT;
  const cached = state.cache.get(chunkOffset);
  if (!cached || cached.fetchId !== state.currentFetchId) return null;
  const localIndex = index - chunkOffset;
  if (localIndex >= cached.rows.length) return null;
  return cached.rows[localIndex];
}

// ─── Rendering ───────────────────────────────────────────────────────
function renderVisibleRows() {
  const scrollTop = scrollContainer.scrollTop;
  const containerHeight = scrollContainer.clientHeight;

  const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
  const lastVisible = Math.ceil((scrollTop + containerHeight) / ROW_HEIGHT);

  const startRow = Math.max(0, firstVisible - OVERSCAN);
  const endRow = Math.min(state.total, lastVisible + OVERSCAN);

  // Determine which row indices we need
  const neededIndices = new Set();
  for (let i = startRow; i < endRow; i++) {
    neededIndices.add(i);
  }

  // Remove rows that are no longer needed
  for (const [idx, el] of activeRows) {
    if (!neededIndices.has(idx)) {
      viewport.removeChild(el);
      releaseRow(el);
      activeRows.delete(idx);
    }
  }

  // Add/update rows that are needed
  for (let i = startRow; i < endRow; i++) {
    const rowData = getRow(i);
    if (!rowData) continue; // data not loaded yet

    let el = activeRows.get(i);
    if (!el) {
      el = acquireRow();
      viewport.appendChild(el);
      activeRows.set(i, el);
    }
    populateRow(el, rowData, i);
  }
}

function updateSpacerHeight() {
  scrollSpacer.style.height = (state.total * ROW_HEIGHT) + 'px';
}

function updateRowCount() {
  const visibleDomCount = activeRows.size;
  rowCountEl.textContent = `${visibleDomCount} of ${state.total.toLocaleString()} rows`;
}

// ─── Scroll Handler ──────────────────────────────────────────────────
let scrollRAF = null;

function onScroll() {
  if (scrollRAF) return;
  scrollRAF = requestAnimationFrame(() => {
    scrollRAF = null;
    handleScroll();
  });
}

function handleScroll() {
  const scrollTop = scrollContainer.scrollTop;
  const containerHeight = scrollContainer.clientHeight;

  const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
  const lastVisible = Math.ceil((scrollTop + containerHeight) / ROW_HEIGHT);

  // Prefetch a buffer around the visible range
  const prefetchStart = Math.max(0, firstVisible - BUFFER_AHEAD);
  const prefetchEnd = Math.min(state.total, lastVisible + BUFFER_AHEAD);

  // Render what we have immediately
  renderVisibleRows();
  updateRowCount();

  // Fetch any missing data
  ensureData(prefetchStart, prefetchEnd);
}

scrollContainer.addEventListener('scroll', onScroll, { passive: true });

// ─── Filter Handlers ────────────────────────────────────────────────
function resetAndReload() {
  // Abort any in-flight requests
  if (state.abortController) {
    state.abortController.abort();
  }
  state.abortController = new AbortController();

  // Increment fetchId to invalidate all pending/cached data
  state.currentFetchId++;
  state.cache.clear();
  state.total = 0;
  state.pendingFetches.clear();

  // Clear active rows
  for (const [idx, el] of activeRows) {
    viewport.removeChild(el);
    releaseRow(el);
  }
  activeRows.clear();

  // Reset scroll
  scrollContainer.scrollTop = 0;
  updateSpacerHeight();
  updateRowCount();

  // Fetch initial data
  loadInitial();
}

async function loadInitial() {
  const fetchId = state.currentFetchId;
  const signal = state.abortController ? state.abortController.signal : undefined;

  try {
    const data = await fetchLogs(0, FETCH_LIMIT, signal);

    // Discard if stale
    if (fetchId !== state.currentFetchId) return;

    state.total = data.total;
    state.cache.set(0, { rows: data.rows, fetchId });

    updateSpacerHeight();
    renderVisibleRows();
    updateRowCount();
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('Failed to load initial data:', err);
  }
}

// Severity filter
severitySelect.addEventListener('change', () => {
  state.severity = severitySelect.value;
  resetAndReload();
});

// Search with debounce
let searchTimeout = null;

searchInput.addEventListener('input', () => {
  if (searchTimeout) clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    state.query = searchInput.value.trim();
    resetAndReload();
  }, DEBOUNCE_MS);
});

// ─── Badges ──────────────────────────────────────────────────────────
async function loadBadges() {
  try {
    const stats = await fetchStats();
    if (!stats) return;

    badgesEl.innerHTML = `
      <span class="badge badge-debug">debug: ${stats.severities.debug.toLocaleString()}</span>
      <span class="badge badge-info">info: ${stats.severities.info.toLocaleString()}</span>
      <span class="badge badge-warn">warn: ${stats.severities.warn.toLocaleString()}</span>
      <span class="badge badge-error">error: ${stats.severities.error.toLocaleString()}</span>
    `;
  } catch (err) {
    console.error('Failed to load stats:', err);
  }
}

// ─── Window resize ──────────────────────────────────────────────────
window.addEventListener('resize', () => {
  renderVisibleRows();
  updateRowCount();
});

// ─── Initialize ─────────────────────────────────────────────────────
async function init() {
  // Create initial abort controller
  state.abortController = new AbortController();
  await Promise.all([loadInitial(), loadBadges()]);
}

init();
