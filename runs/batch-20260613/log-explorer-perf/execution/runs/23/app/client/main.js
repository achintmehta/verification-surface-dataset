// When served via Vite dev server (port 3001), the proxy in vite.config.js
// forwards /api to localhost:3000. When served directly by Express, no prefix needed.
const API_BASE = '';

// --- Configuration ---
const ROW_HEIGHT = 28;
const OVERSCAN = 10;
const FETCH_LIMIT = 100; // rows per API request
const DEBOUNCE_MS = 250;

// --- State ---
let totalRows = 0;
let currentSeverity = '';
let currentQuery = '';
let fetchGeneration = 0;  // monotonic counter to detect stale responses
let cache = new Map();    // offset -> { generation, rows }
let pendingFetches = new Map(); // offset -> AbortController

// --- DOM Elements ---
const scroller = document.getElementById('virtual-scroller');
const spacer = document.getElementById('scroll-spacer');
const container = document.getElementById('row-container');
const severityFilter = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const rowCountEl = document.getElementById('row-count');
const statusBar = document.getElementById('status-bar');
const badgesEl = document.getElementById('severity-badges');

// --- Row Pool ---
// We create DOM elements and recycle them
const rowPool = [];
function getRowEl() {
  if (rowPool.length > 0) return rowPool.pop();
  const el = document.createElement('div');
  el.className = 'log-row';
  el.innerHTML = `
    <div class="col col-ts"></div>
    <div class="col col-severity"></div>
    <div class="col col-service"></div>
    <div class="col col-message"></div>
  `;
  return el;
}

function releaseRowEl(el) {
  el.remove();
  rowPool.push(el);
}

// Currently rendered rows tracked by offset
let renderedRows = new Map(); // offset -> DOM element

// --- API ---
async function fetchLogs(offset, limit, generation, signal) {
  const params = new URLSearchParams();
  params.set('offset', offset.toString());
  params.set('limit', limit.toString());
  if (currentSeverity) params.set('severity', currentSeverity);
  if (currentQuery) params.set('q', currentQuery);

  const resp = await fetch(`${API_BASE}/api/logs?${params}`, { signal });
  if (!resp.ok) throw new Error(`API error: ${resp.status}`);
  return resp.json();
}

async function fetchStats() {
  const resp = await fetch(`${API_BASE}/api/stats`);
  if (!resp.ok) throw new Error(`Stats error: ${resp.status}`);
  return resp.json();
}

// --- Rendering ---
function formatTimestamp(ts) {
  const d = new Date(ts);
  return d.toISOString().replace('T', ' ').replace('Z', '');
}

function renderRow(el, row, offset) {
  const cols = el.children;
  cols[0].textContent = formatTimestamp(row.ts);
  cols[1].textContent = row.severity.toUpperCase();
  cols[1].className = `col col-severity severity-${row.severity}`;
  cols[2].textContent = row.service;
  cols[3].textContent = row.message;
  el.style.transform = `translateY(${offset * ROW_HEIGHT}px)`;
  el.style.height = `${ROW_HEIGHT}px`;
  el.dataset.offset = offset;
}

function updateSpacerHeight() {
  spacer.style.height = `${totalRows * ROW_HEIGHT}px`;
}

function updateRowCount() {
  rowCountEl.textContent = `${totalRows.toLocaleString()} entries`;
}

// --- Virtual Scroll Logic ---
function getVisibleRange() {
  const scrollTop = scroller.scrollTop;
  const viewportHeight = scroller.clientHeight;

  const startRow = Math.floor(scrollTop / ROW_HEIGHT);
  const endRow = Math.min(
    Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT),
    totalRows
  );

  // Add overscan
  const overscanStart = Math.max(0, startRow - OVERSCAN);
  const overscanEnd = Math.min(totalRows, endRow + OVERSCAN);

  return { startRow: overscanStart, endRow: overscanEnd };
}

function render() {
  const { startRow, endRow } = getVisibleRange();
  const gen = fetchGeneration;

  // Determine which rows to show/hide
  const needed = new Set();
  for (let i = startRow; i < endRow; i++) {
    needed.add(i);
  }

  // Remove rows no longer in range
  for (const [offset, el] of renderedRows) {
    if (!needed.has(offset)) {
      releaseRowEl(el);
      renderedRows.delete(offset);
    }
  }

  // Figure out which fetch-aligned blocks we need
  const neededBlocks = new Set();
  for (let i = startRow; i < endRow; i++) {
    const blockStart = Math.floor(i / FETCH_LIMIT) * FETCH_LIMIT;
    neededBlocks.add(blockStart);
  }

  // Fetch missing blocks
  for (const blockStart of neededBlocks) {
    const cached = cache.get(blockStart);
    if (cached && cached.generation === gen) {
      // Render from cache
      renderBlock(blockStart, cached.rows, startRow, endRow);
    } else if (!pendingFetches.has(blockStart)) {
      // Fetch this block
      const controller = new AbortController();
      pendingFetches.set(blockStart, controller);

      fetchLogs(blockStart, FETCH_LIMIT, gen, controller.signal)
        .then((data) => {
          pendingFetches.delete(blockStart);
          if (gen !== fetchGeneration) return; // stale

          // Update total from server
          if (data.total !== totalRows) {
            totalRows = data.total;
            updateSpacerHeight();
            updateRowCount();
          }

          cache.set(blockStart, { generation: gen, rows: data.rows });
          // Re-render if still relevant
          const current = getVisibleRange();
          renderBlock(blockStart, data.rows, current.startRow, current.endRow);
        })
        .catch((err) => {
          pendingFetches.delete(blockStart);
          if (err.name !== 'AbortError') {
            console.error('Fetch error:', err);
          }
        });
    }
  }
}

function renderBlock(blockStart, rows, visibleStart, visibleEnd) {
  for (let i = 0; i < rows.length; i++) {
    const offset = blockStart + i;
    if (offset < visibleStart || offset >= visibleEnd) continue;
    if (renderedRows.has(offset)) continue;

    const el = getRowEl();
    renderRow(el, rows[i], offset);
    container.appendChild(el);
    renderedRows.set(offset, el);
  }
}

// --- Filter Changes ---
function invalidateAndRefresh() {
  // Bump generation to invalidate all pending fetches
  fetchGeneration++;

  // Cancel pending fetches
  for (const [, controller] of pendingFetches) {
    controller.abort();
  }
  pendingFetches.clear();

  // Clear cache
  cache.clear();

  // Clear rendered rows
  for (const [, el] of renderedRows) {
    releaseRowEl(el);
  }
  renderedRows.clear();

  // Reset scroll
  scroller.scrollTop = 0;

  // Fetch initial data to get the total
  const gen = fetchGeneration;
  fetchLogs(0, FETCH_LIMIT, gen)
    .then((data) => {
      if (gen !== fetchGeneration) return;
      totalRows = data.total;
      updateSpacerHeight();
      updateRowCount();
      cache.set(0, { generation: gen, rows: data.rows });
      render();
    })
    .catch((err) => {
      console.error('Initial fetch error:', err);
    });
}

// --- Event Handlers ---
let scrollRaf = null;
scroller.addEventListener('scroll', () => {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = null;
    render();
  });
});

severityFilter.addEventListener('change', () => {
  currentSeverity = severityFilter.value;
  invalidateAndRefresh();
});

let debounceTimer = null;
searchInput.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    currentQuery = searchInput.value.trim();
    invalidateAndRefresh();
  }, DEBOUNCE_MS);
});

// --- Stats / Badges ---
async function loadStats() {
  try {
    const stats = await fetchStats();
    const badges = ['debug', 'info', 'warn', 'error'];
    badgesEl.innerHTML = badges
      .map(
        (sev) =>
          `<span class="badge badge-${sev}">${sev}: ${(stats.severities[sev] || 0).toLocaleString()}</span>`
      )
      .join('');
  } catch (err) {
    console.error('Failed to load stats:', err);
  }
}

// --- Init ---
async function init() {
  statusBar.textContent = 'Connecting to server...';

  // Wait for server readiness
  let retries = 0;
  while (retries < 120) {
    try {
      const resp = await fetch(`${API_BASE}/api/health`);
      const data = await resp.json();
      if (data.ready) break;
    } catch (e) {
      // server not up yet
    }
    retries++;
    statusBar.textContent = `Waiting for server... (${retries}s)`;
    await new Promise((r) => setTimeout(r, 1000));
  }

  statusBar.textContent = 'Loading...';
  await loadStats();
  invalidateAndRefresh();
  statusBar.textContent = 'Ready';
}

init();
