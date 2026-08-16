const API_BASE = 'http://localhost:3001';

// --- Configuration ---
const ROW_HEIGHT = 28;
const OVERSCAN = 10;        // extra rows above/below viewport
const FETCH_WINDOW = 100;   // rows to fetch per API call
const DEBOUNCE_MS = 250;    // search debounce

// --- State ---
let state = {
  total: 0,
  severity: '',
  q: '',
  cache: new Map(), // key: `${offset}-${limit}` -> rows array
  fetchVersion: 0,  // monotonically increasing, to discard stale responses
};

// --- DOM References ---
const scrollContainer = document.getElementById('scroll-container');
const scrollSpacer = document.getElementById('scroll-spacer');
const rowPool = document.getElementById('row-pool');
const severitySelect = document.getElementById('severity-select');
const searchInput = document.getElementById('search-input');
const rowCountEl = document.getElementById('row-count');
const severityBadgesEl = document.getElementById('severity-badges');

// --- Loading indicator ---
const loadingEl = document.createElement('div');
loadingEl.className = 'loading-indicator';
loadingEl.textContent = 'Loading...';
document.body.appendChild(loadingEl);

let activeRequests = 0;
function showLoading() {
  activeRequests++;
  loadingEl.classList.add('visible');
}
function hideLoading() {
  activeRequests = Math.max(0, activeRequests - 1);
  if (activeRequests === 0) loadingEl.classList.remove('visible');
}

// --- Row pool management ---
// We create a fixed pool of DOM row elements and reuse them
const MAX_VISIBLE_ROWS = 80; // enough for most viewports + overscan
const rowElements = [];

function createRowElement() {
  const row = document.createElement('div');
  row.className = 'log-row';
  row.innerHTML = `
    <div class="col col-ts"></div>
    <div class="col col-severity"><span class="severity-text"></span></div>
    <div class="col col-service"></div>
    <div class="col col-message"></div>
  `;
  row.style.display = 'none';
  rowPool.appendChild(row);
  return {
    el: row,
    tsEl: row.querySelector('.col-ts'),
    sevEl: row.querySelector('.severity-text'),
    svcEl: row.querySelector('.col-service'),
    msgEl: row.querySelector('.col-message'),
    currentIndex: -1,
  };
}

// Pre-create row pool
for (let i = 0; i < MAX_VISIBLE_ROWS; i++) {
  rowElements.push(createRowElement());
}

// --- Formatting ---
function formatTimestamp(ts) {
  const d = new Date(ts);
  return d.toISOString().replace('T', ' ').replace('Z', '').slice(0, 23);
}

// --- Data Fetching ---
// Cache is a simple Map keyed by `offset`. We cache aligned windows.
function cacheKey(offset) {
  return `${state.severity}|${state.q}|${offset}`;
}

function clearCache() {
  state.cache.clear();
}

async function fetchRows(offset, limit) {
  const key = cacheKey(offset);
  const cached = state.cache.get(key);
  if (cached && cached.limit >= limit) {
    return cached.rows.slice(0, limit);
  }

  const version = state.fetchVersion;
  const params = new URLSearchParams();
  params.set('offset', offset);
  params.set('limit', limit);
  if (state.severity) params.set('severity', state.severity);
  if (state.q) params.set('q', state.q);

  showLoading();
  try {
    const resp = await fetch(`${API_BASE}/api/logs?${params}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    // Discard if filters changed (stale response)
    if (version !== state.fetchVersion) return null;

    // Update total
    if (data.total !== state.total) {
      state.total = data.total;
      updateScrollHeight();
      updateRowCount();
    }

    // Cache
    state.cache.set(key, { rows: data.rows, limit });

    return data.rows;
  } catch (err) {
    console.error('Fetch error:', err);
    return null;
  } finally {
    hideLoading();
  }
}

async function fetchTotal() {
  const params = new URLSearchParams();
  params.set('offset', '0');
  params.set('limit', '1');
  if (state.severity) params.set('severity', state.severity);
  if (state.q) params.set('q', state.q);

  const version = state.fetchVersion;
  showLoading();
  try {
    const resp = await fetch(`${API_BASE}/api/logs?${params}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (version !== state.fetchVersion) return;
    state.total = data.total;
    updateScrollHeight();
    updateRowCount();
  } catch (err) {
    console.error('Fetch total error:', err);
  } finally {
    hideLoading();
  }
}

async function fetchStats() {
  try {
    const resp = await fetch(`${API_BASE}/api/stats`);
    if (!resp.ok) return;
    const data = await resp.json();
    severityBadgesEl.innerHTML = ['debug', 'info', 'warn', 'error']
      .map(s => `<span class="severity-badge ${s}">${s}: ${data[s].toLocaleString()}</span>`)
      .join('');
  } catch (err) {
    console.error('Stats error:', err);
  }
}

// --- Virtual Scroll ---
function updateScrollHeight() {
  const totalHeight = state.total * ROW_HEIGHT;
  scrollSpacer.style.height = `${totalHeight}px`;
}

function updateRowCount() {
  const visibleRows = Math.min(
    Math.ceil(scrollContainer.clientHeight / ROW_HEIGHT),
    state.total
  );
  rowCountEl.textContent = `${visibleRows} of ${state.total.toLocaleString()} logs`;
}

// Track which rows are currently rendered
let renderedRange = { start: -1, end: -1 };
let renderPending = false;
let pendingFetches = new Map(); // offset -> Promise

async function renderVisibleRows() {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(async () => {
    renderPending = false;
    await _doRender();
  });
}

async function _doRender() {
  const scrollTop = scrollContainer.scrollTop;
  const viewportHeight = scrollContainer.clientHeight;

  const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
  const lastVisible = Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT);

  const renderStart = Math.max(0, firstVisible - OVERSCAN);
  const renderEnd = Math.min(state.total, lastVisible + OVERSCAN);

  // Determine which windows we need
  const neededWindows = new Set();
  for (let i = renderStart; i < renderEnd; i += FETCH_WINDOW) {
    const windowStart = Math.floor(i / FETCH_WINDOW) * FETCH_WINDOW;
    neededWindows.add(windowStart);
  }
  // Also make sure we cover the end
  const lastWindowStart = Math.floor((renderEnd - 1) / FETCH_WINDOW) * FETCH_WINDOW;
  neededWindows.add(Math.max(0, lastWindowStart));

  // Fetch any windows not in cache
  const version = state.fetchVersion;
  const fetchPromises = [];
  for (const windowStart of neededWindows) {
    const key = cacheKey(windowStart);
    if (!state.cache.has(key)) {
      if (!pendingFetches.has(key)) {
        const p = fetchRows(windowStart, FETCH_WINDOW).then(() => {
          pendingFetches.delete(key);
        });
        pendingFetches.set(key, p);
        fetchPromises.push(p);
      } else {
        fetchPromises.push(pendingFetches.get(key));
      }
    }
  }

  if (fetchPromises.length > 0) {
    await Promise.all(fetchPromises);
  }

  // Check for stale render
  if (version !== state.fetchVersion) return;

  // Now render rows
  const rowCount = renderEnd - renderStart;
  let poolIdx = 0;

  for (let i = renderStart; i < renderEnd && poolIdx < rowElements.length; i++) {
    const windowStart = Math.floor(i / FETCH_WINDOW) * FETCH_WINDOW;
    const key = cacheKey(windowStart);
    const cached = state.cache.get(key);
    const rowData = cached ? cached.rows[i - windowStart] : null;

    const poolRow = rowElements[poolIdx++];

    if (rowData) {
      poolRow.tsEl.textContent = formatTimestamp(rowData.ts);
      poolRow.sevEl.textContent = rowData.severity;
      poolRow.svcEl.textContent = rowData.service;
      poolRow.msgEl.textContent = rowData.message;

      // Update severity class
      poolRow.el.className = `log-row severity-${rowData.severity}`;
      poolRow.el.style.top = `${i * ROW_HEIGHT}px`;
      poolRow.el.style.display = 'flex';
      poolRow.currentIndex = i;
    } else {
      // Placeholder for loading row
      poolRow.tsEl.textContent = '...';
      poolRow.sevEl.textContent = '';
      poolRow.svcEl.textContent = '';
      poolRow.msgEl.textContent = 'Loading...';
      poolRow.el.className = 'log-row';
      poolRow.el.style.top = `${i * ROW_HEIGHT}px`;
      poolRow.el.style.display = 'flex';
      poolRow.currentIndex = i;
    }
  }

  // Hide unused pool rows
  for (let i = poolIdx; i < rowElements.length; i++) {
    rowElements[i].el.style.display = 'none';
    rowElements[i].currentIndex = -1;
  }

  renderedRange = { start: renderStart, end: renderEnd };
  updateRowCount();
}

// --- Scroll handling ---
let scrollRAF = null;
scrollContainer.addEventListener('scroll', () => {
  if (scrollRAF) cancelAnimationFrame(scrollRAF);
  scrollRAF = requestAnimationFrame(() => {
    scrollRAF = null;
    _doRender();
  });
}, { passive: true });

// --- Filter handling ---
severitySelect.addEventListener('change', () => {
  state.severity = severitySelect.value;
  applyFilters();
});

let debounceTimer = null;
searchInput.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    state.q = searchInput.value.trim();
    applyFilters();
  }, DEBOUNCE_MS);
});

async function applyFilters() {
  // Bump version to invalidate in-flight requests
  state.fetchVersion++;
  clearCache();
  pendingFetches.clear();
  state.total = 0;

  // Reset scroll position
  scrollContainer.scrollTop = 0;

  // Hide all rows during transition
  for (const row of rowElements) {
    row.el.style.display = 'none';
    row.currentIndex = -1;
  }

  // Fetch new total and first window
  await fetchTotal();
  await _doRender();
}

// --- Window resize ---
window.addEventListener('resize', () => {
  renderVisibleRows();
});

// --- Init ---
async function init() {
  await fetchStats();
  await fetchTotal();
  await _doRender();
}

init();
