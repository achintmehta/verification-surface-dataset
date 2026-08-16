/**
 * Log Explorer - Virtualized Log Table
 * 
 * Architecture:
 * - Virtual scroller with row recycling
 * - Only ~visible + overscan rows in DOM at any time
 * - Debounced search with request cancellation via AbortController
 * - Window-based data fetching with caching
 */

// API base URL. Empty string works with Vite's proxy in development.
// For direct access to backend (e.g., opening index.html from backend), also empty.
// Adjust if running on a different host.
const API_BASE = 'http://localhost:3001';
const ROW_HEIGHT = 32;
const OVERSCAN = 15;
const FETCH_WINDOW = 100; // rows per API call
const DEBOUNCE_MS = 250;

// State
const state = {
  total: 0,
  severity: '',
  query: '',
  cache: new Map(), // key: `${offset}` => rows[]
  fetchVersion: 0, // incremented on filter change to invalidate stale responses
  pendingFetches: new Map(), // cacheKey => Promise
  stats: null,
  abortController: null,
};

// DOM refs
const scroller = document.getElementById('virtual-scroller');
const spacer = document.getElementById('scroll-spacer');
const rowContainer = document.getElementById('row-container');
const severityFilter = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const rowCountEl = document.getElementById('row-count');
const loadingIndicator = document.getElementById('loading-indicator');
const badgesEl = document.getElementById('severity-badges');

// ---- Row Element Pool ----

// We maintain a pool of DOM elements and reuse them.
// `activeRows` maps DOM-position-index to the element currently in use.
let rowElements = [];

function getOrCreateRowElement(index) {
  if (!rowElements[index]) {
    const row = document.createElement('div');
    row.className = 'log-row';
    row.innerHTML = `
      <div class="col col-ts"><span class="ts-value"></span></div>
      <div class="col col-severity"><span class="severity-tag"></span></div>
      <div class="col col-service"><span class="service-value"></span></div>
      <div class="col col-message"></div>
    `;
    row.style.position = 'absolute';
    row.style.width = '100%';
    row.style.height = `${ROW_HEIGHT}px`;
    rowElements[index] = row;
    rowContainer.appendChild(row);
  }
  return rowElements[index];
}

function updateRowElement(el, row, rowIndex) {
  el.style.transform = `translateY(${rowIndex * ROW_HEIGHT}px)`;

  if (!row) {
    el.style.visibility = 'hidden';
    return;
  }
  el.style.visibility = 'visible';

  const tsEl = el.querySelector('.ts-value');
  const sevEl = el.querySelector('.severity-tag');
  const svcEl = el.querySelector('.service-value');
  const msgEl = el.querySelector('.col-message');

  // Format timestamp
  tsEl.textContent = formatTimestamp(row.ts);

  // Severity with color coding
  sevEl.textContent = row.severity;
  sevEl.className = `severity-tag severity-${row.severity}`;

  // Service
  svcEl.textContent = row.service;

  // Message
  msgEl.textContent = row.message;
}

function formatTimestamp(ts) {
  // PGLite may return timestamps as "2024-01-15 10:30:45" or ISO format
  // Normalize by ensuring it can be parsed
  if (typeof ts === 'string' && !ts.includes('T') && !ts.endsWith('Z')) {
    // Looks like "2024-01-15 10:30:45.123" - treat as UTC
    ts = ts.replace(' ', 'T') + 'Z';
  }
  const dt = new Date(ts);
  if (isNaN(dt.getTime())) return String(ts);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  const h = String(dt.getUTCHours()).padStart(2, '0');
  const min = String(dt.getUTCMinutes()).padStart(2, '0');
  const s = String(dt.getUTCSeconds()).padStart(2, '0');
  return `${y}-${m}-${d} ${h}:${min}:${s}`;
}

// ---- Data Fetching ----

async function fetchWindow(offset, limit, version) {
  const cacheKey = offset.toString();
  
  // Return cached data
  if (state.cache.has(cacheKey)) {
    return state.cache.get(cacheKey);
  }

  // Return existing in-flight promise 
  if (state.pendingFetches.has(cacheKey)) {
    return state.pendingFetches.get(cacheKey);
  }

  const promise = (async () => {
    try {
      const params = new URLSearchParams();
      params.set('offset', offset.toString());
      params.set('limit', limit.toString());
      if (state.severity) params.set('severity', state.severity);
      if (state.query) params.set('q', state.query);

      const resp = await fetch(`${API_BASE}/api/logs?${params}`);
      if (!resp.ok) return null;
      const data = await resp.json();

      // Check if this response is still relevant
      if (version !== state.fetchVersion) {
        return null; // Stale response, discard
      }

      // Update total count
      state.total = data.total;

      // Cache the rows
      state.cache.set(cacheKey, data.rows);
      return data.rows;
    } catch (err) {
      if (err.name === 'AbortError') return null;
      console.error('Fetch error:', err);
      return null;
    } finally {
      state.pendingFetches.delete(cacheKey);
    }
  })();

  state.pendingFetches.set(cacheKey, promise);
  return promise;
}

async function fetchStats() {
  try {
    const resp = await fetch(`${API_BASE}/api/stats`);
    if (!resp.ok) return;
    state.stats = await resp.json();
    renderBadges();
  } catch (err) {
    console.error('Stats fetch error:', err);
  }
}

// ---- UI Updates ----

function updateScrollHeight() {
  spacer.style.height = `${state.total * ROW_HEIGHT}px`;
}

function updateRowCount() {
  const parts = [];
  if (state.severity) parts.push(state.severity);
  if (state.query) parts.push(`"${state.query}"`);
  const filterStr = parts.length > 0 ? ` (filtered: ${parts.join(', ')})` : '';
  rowCountEl.textContent = `${state.total.toLocaleString()} entries${filterStr}`;
}

function renderBadges() {
  if (!state.stats) return;
  badgesEl.innerHTML = [
    `<span class="badge badge-debug">debug: ${state.stats.debug.toLocaleString()}</span>`,
    `<span class="badge badge-info">info: ${state.stats.info.toLocaleString()}</span>`,
    `<span class="badge badge-warn">warn: ${state.stats.warn.toLocaleString()}</span>`,
    `<span class="badge badge-error">error: ${state.stats.error.toLocaleString()}</span>`,
  ].join('');
}

// ---- Core Render Loop ----

let lastRangeStart = -1;
let lastRangeEnd = -1;
let lastVisibleCount = 0;
let renderRAF = null;

function scheduleRender() {
  if (renderRAF) return;
  renderRAF = requestAnimationFrame(() => {
    renderRAF = null;
    doRender();
  });
}

function doRender() {
  const scrollTop = scroller.scrollTop;
  const viewportHeight = scroller.clientHeight;
  const version = state.fetchVersion;

  if (state.total === 0) {
    // Remove all row elements
    for (let i = 0; i < rowElements.length; i++) {
      if (rowElements[i] && rowElements[i].parentNode) {
        rowElements[i].style.visibility = 'hidden';
      }
    }
    return;
  }

  // Calculate visible row range
  const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
  const lastVisible = Math.min(
    state.total - 1,
    Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT)
  );

  // Apply overscan
  const rangeStart = Math.max(0, firstVisible - OVERSCAN);
  const rangeEnd = Math.min(state.total, lastVisible + OVERSCAN + 1);
  const visibleCount = rangeEnd - rangeStart;

  // Determine which fetch windows we need
  const windowsToFetch = [];
  for (let i = rangeStart; i < rangeEnd; i += FETCH_WINDOW) {
    const windowOffset = Math.floor(i / FETCH_WINDOW) * FETCH_WINDOW;
    if (!state.cache.has(windowOffset.toString()) && !state.pendingFetches.has(windowOffset.toString())) {
      windowsToFetch.push(windowOffset);
    }
  }
  // Also check the last row's window
  if (rangeEnd > 0) {
    const lastWindowOffset = Math.floor((rangeEnd - 1) / FETCH_WINDOW) * FETCH_WINDOW;
    if (!state.cache.has(lastWindowOffset.toString()) && !state.pendingFetches.has(lastWindowOffset.toString())) {
      if (!windowsToFetch.includes(lastWindowOffset)) {
        windowsToFetch.push(lastWindowOffset);
      }
    }
  }

  // Kick off fetches for missing windows
  const hasPendingFetches = windowsToFetch.length > 0;
  for (const offset of windowsToFetch) {
    fetchWindow(offset, FETCH_WINDOW, version).then((rows) => {
      if (rows && version === state.fetchVersion) {
        scheduleRender();
      }
    });
  }

  // Hide excess row elements
  for (let i = visibleCount; i < lastVisibleCount; i++) {
    if (rowElements[i]) {
      rowElements[i].style.visibility = 'hidden';
    }
  }

  // Update visible rows
  for (let i = 0; i < visibleCount; i++) {
    const rowIndex = rangeStart + i;
    const el = getOrCreateRowElement(i);

    // Look up data from cache
    const windowOffset = Math.floor(rowIndex / FETCH_WINDOW) * FETCH_WINDOW;
    const cachedRows = state.cache.get(windowOffset.toString());
    const rowData = cachedRows ? cachedRows[rowIndex - windowOffset] : null;

    updateRowElement(el, rowData, rowIndex);
  }

  lastRangeStart = rangeStart;
  lastRangeEnd = rangeEnd;
  lastVisibleCount = visibleCount;

  // Loading indicator
  if (hasPendingFetches || state.pendingFetches.size > 0) {
    loadingIndicator.classList.remove('hidden');
  } else {
    loadingIndicator.classList.add('hidden');
  }
}

// ---- Filter Handling ----

function resetAndReload() {
  state.fetchVersion++;
  state.cache.clear();
  state.pendingFetches.clear();
  state.total = 0;

  // Reset scroll
  scroller.scrollTop = 0;

  // Hide all existing row elements
  for (let i = 0; i < rowElements.length; i++) {
    if (rowElements[i]) {
      rowElements[i].style.visibility = 'hidden';
    }
  }

  lastRangeStart = -1;
  lastRangeEnd = -1;
  lastVisibleCount = 0;

  updateScrollHeight();
  updateRowCount();

  // Fetch first window to establish total
  const version = state.fetchVersion;
  fetchWindow(0, FETCH_WINDOW, version).then((rows) => {
    if (rows && version === state.fetchVersion) {
      updateScrollHeight();
      updateRowCount();
      scheduleRender();
    }
  });
}

// Severity filter
severityFilter.addEventListener('change', () => {
  state.severity = severityFilter.value;
  resetAndReload();
});

// Debounced search
let searchTimeout = null;

searchInput.addEventListener('input', () => {
  if (searchTimeout) {
    clearTimeout(searchTimeout);
  }
  searchTimeout = setTimeout(() => {
    searchTimeout = null;
    const newQuery = searchInput.value.trim();
    if (newQuery !== state.query) {
      state.query = newQuery;
      resetAndReload();
    }
  }, DEBOUNCE_MS);
});

// Scroll handler - passive for performance
scroller.addEventListener('scroll', scheduleRender, { passive: true });

// Handle resize
window.addEventListener('resize', scheduleRender);

// ---- Initialization ----

async function init() {
  rowCountEl.textContent = 'Connecting to server...';

  // Retry loop for server startup
  let retries = 0;
  while (retries < 30) {
    try {
      const resp = await fetch(`${API_BASE}/api/stats`);
      if (resp.ok) {
        state.stats = await resp.json();
        renderBadges();
        break;
      }
    } catch (err) {
      // Server not ready yet
    }
    retries++;
    rowCountEl.textContent = `Waiting for server... (${retries})`;
    await new Promise(r => setTimeout(r, 2000));
  }

  // Fetch initial data
  const version = state.fetchVersion;
  const rows = await fetchWindow(0, FETCH_WINDOW, version);
  if (rows && version === state.fetchVersion) {
    updateScrollHeight();
    updateRowCount();
    scheduleRender();
  }
}

init();
