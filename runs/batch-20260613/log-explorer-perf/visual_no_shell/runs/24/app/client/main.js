const API_BASE = '';
const ROW_HEIGHT = 32;
const OVERSCAN = 10;
const FETCH_WINDOW = 100; // rows to fetch per request
const DEBOUNCE_MS = 250;

// State
let totalRows = 0;
let currentSeverity = '';
let currentSearch = '';
let cache = new Map(); // key: `${offset}:${limit}` -> rows
let fetchVersion = 0; // for stale response detection
let loading = false;
let lastRenderedRange = { start: -1, end: -1 };

// DOM refs
const scrollContainer = document.getElementById('scroll-container');
const scrollSpacer = document.getElementById('scroll-spacer');
const rowPool = document.getElementById('row-pool');
const severityFilter = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const rowCountEl = document.getElementById('row-count');
const loadIndicator = document.getElementById('load-indicator');
const severityBadgesEl = document.getElementById('severity-badges');

// Pre-create DOM row elements (pool)
const MAX_VISIBLE_ROWS = 80; // generous pool size
const rowElements = [];

function createRowElement() {
  const row = document.createElement('div');
  row.className = 'log-row';
  row.innerHTML = `
    <div class="col col-ts"></div>
    <div class="col col-severity"><span class="badge"></span></div>
    <div class="col col-service"></div>
    <div class="col col-message"></div>
  `;
  row.style.display = 'none';
  rowPool.appendChild(row);
  return row;
}

for (let i = 0; i < MAX_VISIBLE_ROWS; i++) {
  rowElements.push(createRowElement());
}

// API helpers
async function fetchLogs(offset, limit, version) {
  const params = new URLSearchParams();
  params.set('offset', String(offset));
  params.set('limit', String(Math.min(limit, 200)));
  if (currentSeverity) params.set('severity', currentSeverity);
  if (currentSearch) params.set('q', currentSearch);

  const res = await fetch(`${API_BASE}/api/logs?${params}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  const data = await res.json();

  // Stale check
  if (version !== fetchVersion) return null;

  return data;
}

async function fetchStats() {
  const res = await fetch(`${API_BASE}/api/stats`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

// Cache management
function getCacheKey(offset, limit) {
  return `${currentSeverity}|${currentSearch}|${offset}|${limit}`;
}

function clearCache() {
  cache.clear();
}

function getCachedRow(index) {
  // Find which fetch window this index belongs to
  const windowStart = Math.floor(index / FETCH_WINDOW) * FETCH_WINDOW;
  const key = getCacheKey(windowStart, FETCH_WINDOW);
  const cached = cache.get(key);
  if (cached) {
    const localIdx = index - windowStart;
    if (localIdx >= 0 && localIdx < cached.length) {
      return cached[localIdx];
    }
  }
  return null;
}

// Fetch a window if not cached
async function ensureWindow(windowStart, version) {
  const key = getCacheKey(windowStart, FETCH_WINDOW);
  if (cache.has(key)) return;

  const data = await fetchLogs(windowStart, FETCH_WINDOW, version);
  if (!data) return; // stale

  // Update total
  if (data.total !== totalRows) {
    totalRows = data.total;
    updateScrollHeight();
    updateRowCount();
  }

  cache.set(key, data.rows);
}

// Rendering
function updateScrollHeight() {
  scrollSpacer.style.height = `${totalRows * ROW_HEIGHT}px`;
}

function updateRowCount() {
  const visibleCount = Math.min(
    lastRenderedRange.end - lastRenderedRange.start,
    totalRows
  );
  rowCountEl.textContent = `Showing ${Math.max(0, visibleCount)} of ${totalRows.toLocaleString()} logs`;
}

function setLoading(isLoading) {
  loading = isLoading;
  if (isLoading) {
    loadIndicator.classList.remove('hidden');
  } else {
    loadIndicator.classList.add('hidden');
  }
}

function formatTimestamp(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toISOString().replace('T', ' ').replace('Z', '').slice(0, 19);
}

function renderRows(startIdx, endIdx) {
  // Clamp
  startIdx = Math.max(0, startIdx);
  endIdx = Math.min(endIdx, totalRows);

  const visibleCount = endIdx - startIdx;

  for (let i = 0; i < rowElements.length; i++) {
    const rowIdx = startIdx + i;
    const el = rowElements[i];

    if (i >= visibleCount || rowIdx >= totalRows) {
      el.style.display = 'none';
      continue;
    }

    const row = getCachedRow(rowIdx);
    if (!row) {
      // Show placeholder
      el.style.display = 'flex';
      el.style.top = `${rowIdx * ROW_HEIGHT}px`;
      el.className = rowIdx % 2 === 0 ? 'log-row even' : 'log-row';
      el.children[0].textContent = '...';
      el.children[1].firstElementChild.textContent = '';
      el.children[1].firstElementChild.className = 'badge';
      el.children[2].textContent = '';
      el.children[3].textContent = 'Loading...';
      continue;
    }

    el.style.display = 'flex';
    el.style.top = `${rowIdx * ROW_HEIGHT}px`;
    el.className = rowIdx % 2 === 0 ? 'log-row even' : 'log-row';

    el.children[0].textContent = formatTimestamp(row.ts);
    const badge = el.children[1].firstElementChild;
    badge.textContent = row.severity;
    badge.className = `badge ${row.severity}`;
    el.children[2].textContent = row.service;
    el.children[3].textContent = row.message;
  }

  lastRenderedRange = { start: startIdx, end: endIdx };
  updateRowCount();
}

// Main scroll handler
let pendingFetches = new Set();

async function onScroll() {
  const scrollTop = scrollContainer.scrollTop;
  const viewportHeight = scrollContainer.clientHeight;

  const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT);

  const startIdx = Math.max(0, firstVisible - OVERSCAN);
  const endIdx = Math.min(totalRows, firstVisible + visibleCount + OVERSCAN);

  // Render what we have immediately
  renderRows(startIdx, endIdx);

  // Determine which windows we need
  const firstWindow = Math.floor(startIdx / FETCH_WINDOW) * FETCH_WINDOW;
  const lastWindow = Math.floor(Math.max(0, endIdx - 1) / FETCH_WINDOW) * FETCH_WINDOW;

  const version = fetchVersion;
  const windowsToFetch = [];

  for (let w = firstWindow; w <= lastWindow; w += FETCH_WINDOW) {
    const key = getCacheKey(w, FETCH_WINDOW);
    if (!cache.has(key) && !pendingFetches.has(key)) {
      windowsToFetch.push(w);
      pendingFetches.add(key);
    }
  }

  if (windowsToFetch.length > 0) {
    setLoading(true);
    try {
      await Promise.all(
        windowsToFetch.map(async (w) => {
          try {
            await ensureWindow(w, version);
          } finally {
            pendingFetches.delete(getCacheKey(w, FETCH_WINDOW));
          }
        })
      );
    } finally {
      setLoading(false);
    }

    // Re-render with fetched data (if still current)
    if (version === fetchVersion) {
      const newScrollTop = scrollContainer.scrollTop;
      const newFirst = Math.floor(newScrollTop / ROW_HEIGHT);
      const newVisibleCount = Math.ceil(scrollContainer.clientHeight / ROW_HEIGHT);
      const newStart = Math.max(0, newFirst - OVERSCAN);
      const newEnd = Math.min(totalRows, newFirst + newVisibleCount + OVERSCAN);
      renderRows(newStart, newEnd);
    }
  }
}

// Throttled scroll handler
let scrollRafId = null;
scrollContainer.addEventListener('scroll', () => {
  if (scrollRafId) return;
  scrollRafId = requestAnimationFrame(() => {
    scrollRafId = null;
    onScroll();
  });
});

// Filter handlers
function onFilterChange() {
  // initialFetch will increment fetchVersion
  clearCache();
  pendingFetches.clear();
  totalRows = 0;
  lastRenderedRange = { start: -1, end: -1 };
  scrollContainer.scrollTop = 0;
  updateScrollHeight();

  // Hide all current rows
  for (const el of rowElements) {
    el.style.display = 'none';
  }

  // Immediately fetch the first window to get total
  initialFetch();
}

severityFilter.addEventListener('change', () => {
  currentSeverity = severityFilter.value;
  onFilterChange();
});

let searchDebounceTimer = null;
searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    currentSearch = searchInput.value.trim();
    onFilterChange();
  }, DEBOUNCE_MS);
});

// Initial load
async function initialFetch() {
  const version = ++fetchVersion;
  setLoading(true);

  try {
    const data = await fetchLogs(0, FETCH_WINDOW, version);
    if (!data) return; // stale

    totalRows = data.total;
    const key = getCacheKey(0, FETCH_WINDOW);
    cache.set(key, data.rows);
    updateScrollHeight();
    renderRows(0, Math.min(totalRows, MAX_VISIBLE_ROWS));
  } catch (err) {
    console.error('Failed to fetch logs:', err);
    rowCountEl.textContent = 'Error loading logs';
  } finally {
    setLoading(false);
  }
}

async function loadStats() {
  try {
    const stats = await fetchStats();
    const order = ['debug', 'info', 'warn', 'error'];
    severityBadgesEl.innerHTML = '';
    for (const sev of order) {
      const count = stats.bySeverity[sev] || 0;
      const badge = document.createElement('span');
      badge.className = `severity-badge ${sev}`;
      badge.textContent = `${sev}: ${count.toLocaleString()}`;
      severityBadgesEl.appendChild(badge);
    }
  } catch (err) {
    console.error('Failed to load stats:', err);
  }
}

// Boot
initialFetch();
loadStats();
