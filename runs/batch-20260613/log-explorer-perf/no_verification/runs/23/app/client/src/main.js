/**
 * Log Explorer – Virtualized Log Viewer
 * 
 * Renders only the visible rows (plus overscan) in the DOM.
 * Fetches data window-by-window from the server.
 * Debounces search input and cancels stale requests via generation counter.
 */

const API_BASE = '/api';
const ROW_HEIGHT = 36; // Must match CSS --row-height
const OVERSCAN = 10;   // Extra rows above/below viewport
const FETCH_PAGE_SIZE = 100; // How many rows to fetch per API call
const DEBOUNCE_MS = 250;

// ===================== State =====================

const state = {
  total: 0,
  severity: '',
  query: '',
  cache: new Map(),         // pageOffset -> rows[]
  fetchGeneration: 0,       // incremented on filter change to invalidate stale responses
  pendingFetches: new Set(), // track in-flight page offsets
  stats: null,
};

// ===================== DOM References =====================

const scrollContainer = document.getElementById('virtual-scroll');
const scrollSpacer = document.getElementById('scroll-spacer');
const rowPool = document.getElementById('row-pool');
const severityFilter = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const rowCountEl = document.getElementById('row-count');
const severityBadgesEl = document.getElementById('severity-badges');

// ===================== API Layer =====================

/**
 * Fetch a page of logs from the server.
 * Returns null if the response arrives after a newer generation has started.
 */
async function fetchLogs(offset, limit, generation) {
  const params = new URLSearchParams();
  params.set('offset', String(offset));
  params.set('limit', String(limit));
  if (state.severity) params.set('severity', state.severity);
  if (state.query) params.set('q', state.query);

  const response = await fetch(`${API_BASE}/logs?${params}`);
  if (!response.ok) throw new Error(`API error: ${response.status}`);
  
  const data = await response.json();
  
  // Discard stale responses
  if (generation !== state.fetchGeneration) {
    return null;
  }
  
  return data;
}

async function fetchStats() {
  const response = await fetch(`${API_BASE}/stats`);
  if (!response.ok) throw new Error(`API error: ${response.status}`);
  return response.json();
}

// ===================== Data Layer =====================

/**
 * Ensure rows for the visible range [startRow, endRow) are cached.
 * Fetches any missing pages from the server, then re-renders.
 */
function ensureRows(startRow, endRow) {
  if (endRow <= startRow) return;

  const generation = state.fetchGeneration;
  const pagesToFetch = [];

  // Determine which FETCH_PAGE_SIZE-aligned pages we need
  const firstPage = Math.floor(startRow / FETCH_PAGE_SIZE) * FETCH_PAGE_SIZE;
  const lastPage = Math.floor((endRow - 1) / FETCH_PAGE_SIZE) * FETCH_PAGE_SIZE;

  for (let pageOffset = firstPage; pageOffset <= lastPage; pageOffset += FETCH_PAGE_SIZE) {
    if (!state.cache.has(pageOffset) && !state.pendingFetches.has(pageOffset)) {
      pagesToFetch.push(pageOffset);
    }
  }

  if (pagesToFetch.length === 0) return;

  // Fire all page fetches concurrently
  for (const offset of pagesToFetch) {
    state.pendingFetches.add(offset);
    fetchLogs(offset, FETCH_PAGE_SIZE, generation)
      .then((data) => {
        state.pendingFetches.delete(offset);
        if (data === null) return; // stale
        
        state.total = data.total;
        state.cache.set(offset, data.rows);
        
        updateSpacerHeight();
        updateRowCount();
        renderVisibleRows();
      })
      .catch((err) => {
        state.pendingFetches.delete(offset);
        console.error('Failed to fetch logs at offset', offset, err);
      });
  }
}

/**
 * Get a single row from the cache by its global index.
 */
function getRow(index) {
  const pageOffset = Math.floor(index / FETCH_PAGE_SIZE) * FETCH_PAGE_SIZE;
  const rows = state.cache.get(pageOffset);
  if (!rows) return null;
  const localIndex = index - pageOffset;
  return localIndex < rows.length ? rows[localIndex] : null;
}

// ===================== Virtual Scroll Rendering =====================

function updateSpacerHeight() {
  scrollSpacer.style.height = `${state.total * ROW_HEIGHT}px`;
}

function updateRowCount() {
  rowCountEl.textContent = `${state.total.toLocaleString()} entries`;
}

/**
 * Render (or update) DOM rows for the currently visible scroll region.
 * Only creates/destroys DOM elements when the visible count changes.
 */
function renderVisibleRows() {
  const scrollTop = scrollContainer.scrollTop;
  const viewportHeight = scrollContainer.clientHeight;

  if (viewportHeight === 0) return; // not yet laid out

  const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT);

  const startRow = Math.max(0, firstVisible - OVERSCAN);
  const endRow = Math.min(state.total, firstVisible + visibleCount + OVERSCAN);
  const neededCount = Math.max(0, endRow - startRow);

  // Position the row pool at the correct vertical offset
  rowPool.style.transform = `translateY(${startRow * ROW_HEIGHT}px)`;

  // Adjust DOM element count
  while (rowPool.children.length < neededCount) {
    rowPool.appendChild(createRowElement());
  }
  while (rowPool.children.length > neededCount) {
    rowPool.removeChild(rowPool.lastChild);
  }

  // Fill each DOM slot with data (or placeholder)
  for (let i = 0; i < neededCount; i++) {
    const rowIndex = startRow + i;
    const el = rowPool.children[i];
    const data = getRow(rowIndex);
    
    if (data) {
      fillRowElement(el, data, rowIndex);
    } else {
      fillRowPlaceholder(el, rowIndex);
    }
    el.style.visibility = 'visible';
  }

  // Trigger fetch for any missing pages
  ensureRows(startRow, endRow);
}

// ===================== Row DOM Helpers =====================

function createRowElement() {
  const row = document.createElement('div');
  row.className = 'log-row';
  row.innerHTML = `
    <div class="cell cell-ts"></div>
    <div class="cell cell-severity"></div>
    <div class="cell cell-service"></div>
    <div class="cell cell-message"></div>
  `;
  return row;
}

function formatTimestamp(ts) {
  const d = new Date(ts);
  const Y = d.getFullYear();
  const M = String(d.getMonth() + 1).padStart(2, '0');
  const D = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${Y}-${M}-${D} ${h}:${m}:${s}`;
}

function fillRowElement(el, data) {
  const cells = el.children;
  cells[0].textContent = formatTimestamp(data.ts);
  cells[1].innerHTML = `<span class="severity-pill ${data.severity}">${data.severity.toUpperCase()}</span>`;
  cells[2].textContent = data.service;
  cells[3].textContent = data.message;
}

function fillRowPlaceholder(el) {
  const cells = el.children;
  cells[0].textContent = '···';
  cells[1].innerHTML = '';
  cells[2].textContent = '';
  cells[3].textContent = 'Loading…';
}

// ===================== Scroll Handling =====================

let scrollRAF = null;

function onScroll() {
  if (scrollRAF !== null) return; // already scheduled
  scrollRAF = requestAnimationFrame(() => {
    scrollRAF = null;
    renderVisibleRows();
  });
}

scrollContainer.addEventListener('scroll', onScroll, { passive: true });

// ===================== Filter Handling =====================

/**
 * Reset all cached data and reload from the server with current filters.
 */
function resetAndReload() {
  // Bump generation → any in-flight fetch responses will be discarded
  state.fetchGeneration++;
  state.cache.clear();
  state.pendingFetches.clear();
  state.total = 0;
  
  // Reset scroll to top
  scrollContainer.scrollTop = 0;
  
  // Update visual state
  updateSpacerHeight();
  rowPool.innerHTML = '';
  
  // Fetch initial page
  loadInitial();
}

async function loadInitial() {
  const generation = state.fetchGeneration;
  try {
    const data = await fetchLogs(0, FETCH_PAGE_SIZE, generation);
    if (data === null) return; // stale, a newer filter change superseded us
    
    state.total = data.total;
    state.cache.set(0, data.rows);
    
    updateSpacerHeight();
    updateRowCount();
    renderVisibleRows();
  } catch (err) {
    console.error('Failed to load initial data:', err);
    rowCountEl.textContent = 'Error loading data';
  }
}

// Severity dropdown
severityFilter.addEventListener('change', () => {
  state.severity = severityFilter.value;
  resetAndReload();
});

// Search input with debounce – never blocks typing
let searchTimeout = null;

searchInput.addEventListener('input', () => {
  if (searchTimeout !== null) clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    searchTimeout = null;
    state.query = searchInput.value.trim();
    resetAndReload();
  }, DEBOUNCE_MS);
});

// ===================== Stats / Severity Badges =====================

async function loadStats() {
  try {
    const stats = await fetchStats();
    state.stats = stats;
    renderBadges(stats);
  } catch (err) {
    console.error('Failed to load stats:', err);
  }
}

function renderBadges(stats) {
  severityBadgesEl.innerHTML = ['debug', 'info', 'warn', 'error']
    .map(
      (sev) =>
        `<span class="severity-badge ${sev}">${sev}: ${stats.bySeverity[sev].toLocaleString()}</span>`
    )
    .join('');
}

// ===================== Window Resize =====================

let resizeRAF = null;

window.addEventListener('resize', () => {
  if (resizeRAF !== null) return;
  resizeRAF = requestAnimationFrame(() => {
    resizeRAF = null;
    renderVisibleRows();
  });
});

// ===================== Bootstrap =====================

async function init() {
  // Load initial page and stats concurrently
  await Promise.all([loadInitial(), loadStats()]);
}

init();
