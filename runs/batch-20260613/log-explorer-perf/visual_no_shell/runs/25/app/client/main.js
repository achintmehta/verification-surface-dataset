// ─── Configuration ───
const ROW_HEIGHT = 32;
const OVERSCAN = 10;          // extra rows above/below viewport
const FETCH_LIMIT = 200;      // max rows per API call
const DEBOUNCE_MS = 250;
const MAX_CACHE_BLOCKS = 20;  // max cached blocks before eviction

// ─── State ───
let totalRows = 0;
let currentSeverity = '';
let currentQuery = '';
let fetchGeneration = 0;      // monotonic counter to discard stale responses
let cache = new Map();        // blockOffset -> { rows, generation, lastAccess }
let pendingFetches = new Map(); // blockOffset -> AbortController
let stats = null;

// ─── DOM refs ───
const scroller = document.getElementById('virtual-scroller');
const spacer = document.getElementById('scroll-spacer');
const rowPool = document.getElementById('row-pool');
const severitySelect = document.getElementById('severity-select');
const searchInput = document.getElementById('search-input');
const rowCountEl = document.getElementById('row-count');
const badgesEl = document.getElementById('severity-badges');

// ─── Row DOM pool ───
// Pre-create a fixed pool of row elements and reuse them.
// 80 elements > any viewport at 32px row height (even 2560px tall = 80 rows).
const MAX_VISIBLE_ROWS = 80;
const rowElements = [];

function createRowElement() {
  const row = document.createElement('div');
  row.className = 'log-row';
  row.innerHTML = `
    <div class="col col-ts"></div>
    <div class="col col-severity"></div>
    <div class="col col-service"></div>
    <div class="col col-message"></div>
  `;
  row.style.display = 'none';
  rowPool.appendChild(row);
  return {
    el: row,
    cols: row.children,
    currentIndex: -1
  };
}

for (let i = 0; i < MAX_VISIBLE_ROWS; i++) {
  rowElements.push(createRowElement());
}

// ─── API ───
async function fetchLogs(offset, limit, generation, signal) {
  const params = new URLSearchParams();
  params.set('offset', String(offset));
  params.set('limit', String(Math.min(limit, FETCH_LIMIT)));
  if (currentSeverity) params.set('severity', currentSeverity);
  if (currentQuery) params.set('q', currentQuery);

  const resp = await fetch(`/api/logs?${params}`, { signal });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

async function fetchStats() {
  const resp = await fetch('/api/stats');
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

// ─── Cache management ───

function invalidateCache() {
  fetchGeneration++;
  cache.clear();
  // Abort all pending fetches
  for (const [, controller] of pendingFetches) {
    controller.abort();
  }
  pendingFetches.clear();
}

function evictOldCacheBlocks() {
  if (cache.size <= MAX_CACHE_BLOCKS) return;
  // Evict least-recently-accessed blocks
  const entries = [...cache.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess);
  const toEvict = entries.length - MAX_CACHE_BLOCKS;
  for (let i = 0; i < toEvict; i++) {
    cache.delete(entries[i][0]);
  }
}

// Returns a cached row by absolute index, or null
function getCachedRow(absoluteIndex) {
  const blockOffset = Math.floor(absoluteIndex / FETCH_LIMIT) * FETCH_LIMIT;
  const block = cache.get(blockOffset);
  if (!block || block.generation !== fetchGeneration) return null;
  const localIdx = absoluteIndex - blockOffset;
  if (localIdx >= 0 && localIdx < block.rows.length) {
    block.lastAccess = Date.now();
    return block.rows[localIdx];
  }
  return null;
}

async function ensureRowsLoaded(startIdx, endIdx) {
  const gen = fetchGeneration;

  // Determine which FETCH_LIMIT-aligned blocks we need
  const firstBlock = Math.floor(startIdx / FETCH_LIMIT) * FETCH_LIMIT;
  const lastBlock = Math.floor(endIdx / FETCH_LIMIT) * FETCH_LIMIT;

  const fetchPromises = [];

  for (let blockOffset = firstBlock; blockOffset <= lastBlock && blockOffset < totalRows; blockOffset += FETCH_LIMIT) {
    // Skip if already cached for current generation
    const cached = cache.get(blockOffset);
    if (cached && cached.generation === gen) continue;

    // Skip if already fetching this block
    if (pendingFetches.has(blockOffset)) continue;

    const controller = new AbortController();
    pendingFetches.set(blockOffset, controller);

    const promise = fetchLogs(blockOffset, FETCH_LIMIT, gen, controller.signal)
      .then(data => {
        pendingFetches.delete(blockOffset);
        if (gen !== fetchGeneration) return; // stale, discard

        cache.set(blockOffset, {
          rows: data.rows,
          generation: gen,
          lastAccess: Date.now()
        });
        evictOldCacheBlocks();

        // Update total if needed
        if (data.total !== totalRows) {
          totalRows = data.total;
          updateSpacerHeight();
          updateRowCount();
        }

        // Re-paint after data arrives
        renderVisibleRowsSync();
      })
      .catch(err => {
        pendingFetches.delete(blockOffset);
        if (err.name !== 'AbortError') {
          console.error('Fetch error:', err);
        }
      });

    fetchPromises.push(promise);
  }

  return fetchPromises.length > 0 ? Promise.all(fetchPromises) : Promise.resolve();
}

// ─── Rendering ───

function formatTimestamp(ts) {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const s = String(d.getUTCSeconds()).padStart(2, '0');
  const ms = String(d.getUTCMilliseconds()).padStart(3, '0');
  return `${y}-${mo}-${da} ${h}:${mi}:${s}.${ms}`;
}

function renderVisibleRowsSync() {
  if (totalRows === 0) {
    for (const re of rowElements) {
      re.el.style.display = 'none';
      re.currentIndex = -1;
    }
    return;
  }

  const scrollTop = scroller.scrollTop;
  const viewportHeight = scroller.clientHeight;

  const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
  const lastVisible = Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT);

  const startIdx = Math.max(0, firstVisible - OVERSCAN);
  const endIdx = Math.min(totalRows - 1, lastVisible + OVERSCAN);
  const neededCount = endIdx - startIdx + 1;

  for (let i = 0; i < rowElements.length; i++) {
    const re = rowElements[i];
    if (i >= neededCount) {
      re.el.style.display = 'none';
      re.currentIndex = -1;
      continue;
    }

    const absoluteIdx = startIdx + i;
    re.el.style.display = 'flex';
    re.el.style.top = `${absoluteIdx * ROW_HEIGHT}px`;

    const row = getCachedRow(absoluteIdx);
    if (row) {
      if (re.currentIndex !== absoluteIdx) {
        re.cols[0].textContent = formatTimestamp(row.ts);
        re.cols[1].innerHTML = `<span class="severity-tag severity-${row.severity}">${row.severity}</span>`;
        re.cols[2].textContent = row.service;
        re.cols[3].textContent = row.message;
        re.currentIndex = absoluteIdx;
      }
    } else {
      if (re.currentIndex !== absoluteIdx) {
        re.cols[0].textContent = '...';
        re.cols[1].innerHTML = '';
        re.cols[2].textContent = '';
        re.cols[3].textContent = 'Loading...';
        re.currentIndex = absoluteIdx;
      }
    }
  }
}

function renderVisibleRows() {
  const scrollTop = scroller.scrollTop;
  const viewportHeight = scroller.clientHeight;

  const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
  const lastVisible = Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT);

  const startIdx = Math.max(0, firstVisible - OVERSCAN);
  const endIdx = Math.min(totalRows - 1, lastVisible + OVERSCAN);

  // Paint immediately from cache
  renderVisibleRowsSync();

  // Trigger async fetch for any missing blocks
  ensureRowsLoaded(startIdx, endIdx);
}

function updateSpacerHeight() {
  spacer.style.height = `${totalRows * ROW_HEIGHT}px`;
}

function updateRowCount() {
  if (stats) {
    rowCountEl.textContent = `Showing ${totalRows.toLocaleString()} of ${stats.total.toLocaleString()} logs`;
  } else {
    rowCountEl.textContent = `${totalRows.toLocaleString()} logs`;
  }
}

function updateBadges() {
  if (!stats) return;
  const severities = ['debug', 'info', 'warn', 'error'];
  badgesEl.innerHTML = severities.map(s =>
    `<span class="badge badge-${s}">${s}: ${(stats.severityCounts[s] || 0).toLocaleString()}</span>`
  ).join('');
}

// ─── Scroll handling ───

let scrollRafId = null;

function onScroll() {
  if (scrollRafId) return;
  scrollRafId = requestAnimationFrame(() => {
    scrollRafId = null;
    renderVisibleRows();
  });
}

scroller.addEventListener('scroll', onScroll, { passive: true });

// ─── Filter handling ───

async function applyFilters() {
  invalidateCache();
  scroller.scrollTop = 0;

  const gen = fetchGeneration;
  try {
    const data = await fetchLogs(0, FETCH_LIMIT, gen);
    if (gen !== fetchGeneration) return; // stale

    totalRows = data.total;
    cache.set(0, { rows: data.rows, generation: gen, lastAccess: Date.now() });

    updateSpacerHeight();
    updateRowCount();
    renderVisibleRows();
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('Filter apply error:', err);
    }
  }
}

severitySelect.addEventListener('change', () => {
  currentSeverity = severitySelect.value;
  applyFilters();
});

let debounceTimer = null;
searchInput.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    currentQuery = searchInput.value.trim();
    applyFilters();
  }, DEBOUNCE_MS);
});

// ─── Init ───

async function init() {
  try {
    // Load stats
    stats = await fetchStats();
    updateBadges();

    // Initial load
    const data = await fetchLogs(0, FETCH_LIMIT, fetchGeneration);
    totalRows = data.total;
    cache.set(0, { rows: data.rows, generation: fetchGeneration, lastAccess: Date.now() });

    updateSpacerHeight();
    updateRowCount();
    renderVisibleRows();
  } catch (err) {
    console.error('Init error:', err);
    rowCountEl.textContent = 'Error loading logs. Is the server running?';
  }
}

init();
