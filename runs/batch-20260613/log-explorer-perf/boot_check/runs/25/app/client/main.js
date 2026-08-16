const API_BASE = '/api';
const ROW_HEIGHT = 32;
const OVERSCAN = 10;
const FETCH_WINDOW = 100; // fetch this many rows per request
const DEBOUNCE_MS = 250;

// State
let totalRows = 0;
let currentSeverity = '';
let currentQuery = '';
let requestId = 0; // monotonic counter for stale-response detection
let cache = new Map(); // offset -> { rows, requestId }

// DOM refs
const scroller = document.getElementById('virtual-scroller');
const spacer = document.getElementById('scroll-spacer');
const rowContainer = document.getElementById('row-container');
const severityFilter = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const rowCountEl = document.getElementById('row-count');
const badgesEl = document.getElementById('severity-badges');

// ---- API ----

async function fetchLogs(offset, limit, severity, q, rid) {
  const params = new URLSearchParams();
  params.set('offset', String(offset));
  params.set('limit', String(limit));
  if (severity) params.set('severity', severity);
  if (q) params.set('q', q);
  const resp = await fetch(`${API_BASE}/logs?${params}`);
  if (!resp.ok) throw new Error(`API error: ${resp.status}`);
  return resp.json();
}

async function fetchStats() {
  const resp = await fetch(`${API_BASE}/stats`);
  if (!resp.ok) throw new Error(`Stats error: ${resp.status}`);
  return resp.json();
}

// ---- Cache ----

function clearCache() {
  cache.clear();
  inFlight.clear();
}

function getCachedRow(offset) {
  // Find which fetch-window this offset belongs to
  const windowStart = Math.floor(offset / FETCH_WINDOW) * FETCH_WINDOW;
  const entry = cache.get(windowStart);
  if (!entry) return null;
  const idx = offset - windowStart;
  if (idx < 0 || idx >= entry.rows.length) return null;
  return entry.rows[idx];
}

// Track in-flight fetches to avoid duplicates
const inFlight = new Map(); // windowStart -> Promise

function ensureWindow(windowStart, rid) {
  // Already loaded
  const existing = cache.get(windowStart);
  if (existing && !existing.loading) return Promise.resolve();

  // Already fetching
  if (inFlight.has(windowStart)) return inFlight.get(windowStart);

  const limit = Math.min(FETCH_WINDOW, totalRows - windowStart);
  if (limit <= 0) return Promise.resolve();

  // Mark as loading
  cache.set(windowStart, { rows: [], requestId: rid, loading: true });

  const promise = fetchLogs(windowStart, limit, currentSeverity, currentQuery, rid)
    .then(data => {
      inFlight.delete(windowStart);
      // Stale check
      if (rid !== requestId) return;

      cache.set(windowStart, { rows: data.rows, requestId: rid, loading: false });

      // Update total if it changed
      if (data.total !== totalRows) {
        totalRows = data.total;
        updateScrollHeight();
        updateRowCount();
      }
    })
    .catch(e => {
      inFlight.delete(windowStart);
      // Remove failed entry so it can be retried
      if (cache.get(windowStart)?.requestId === rid) {
        cache.delete(windowStart);
      }
    });

  inFlight.set(windowStart, promise);
  return promise;
}

// ---- Rendering ----

function updateScrollHeight() {
  spacer.style.height = `${totalRows * ROW_HEIGHT}px`;
}

function updateRowCount() {
  const visibleStart = Math.floor(scroller.scrollTop / ROW_HEIGHT);
  const viewportRows = Math.ceil(scroller.clientHeight / ROW_HEIGHT);
  const visibleEnd = Math.min(visibleStart + viewportRows, totalRows);
  const shown = totalRows > 0 ? `${visibleEnd} of ${totalRows.toLocaleString()}` : '0';
  rowCountEl.textContent = `Showing ${shown} logs`;
}

function formatTimestamp(ts) {
  const d = new Date(ts);
  return d.toISOString().replace('T', ' ').replace('Z', '').slice(0, 23);
}

function createRowElement() {
  const row = document.createElement('div');
  row.className = 'log-row';
  row.innerHTML = `
    <div class="col col-ts"></div>
    <div class="col col-severity"><span class="severity-tag"></span></div>
    <div class="col col-service"></div>
    <div class="col col-message"></div>
  `;
  return row;
}

function updateRowElement(el, data, offset) {
  if (!data) {
    el.style.display = 'none';
    return;
  }
  el.style.display = 'flex';
  el.style.transform = `translateY(${offset * ROW_HEIGHT}px)`;
  el.style.position = 'absolute';
  el.style.width = '100%';
  el.style.height = `${ROW_HEIGHT}px`;

  const cols = el.children;
  cols[0].textContent = formatTimestamp(data.ts);

  const tag = cols[1].querySelector('.severity-tag');
  tag.textContent = data.severity;
  tag.className = `severity-tag severity-${data.severity}`;

  cols[2].textContent = data.service;
  cols[3].textContent = data.message;
}

// Row pool
const rowPool = [];
const MAX_POOL_ROWS = 80; // visible + overscan, never more than ~100

function getPooledRow() {
  if (rowPool.length > 0) {
    return rowPool.pop();
  }
  return createRowElement();
}

function releaseRow(el) {
  el.style.display = 'none';
  rowPool.push(el);
}

// Render state
let renderedRows = new Map(); // offset -> DOM element
let lastRenderStart = -1;
let lastRenderEnd = -1;

async function render() {
  const scrollTop = scroller.scrollTop;
  const viewportHeight = scroller.clientHeight;

  if (totalRows === 0) {
    // Clear all rendered rows
    for (const [off, el] of renderedRows) {
      rowContainer.removeChild(el);
      releaseRow(el);
    }
    renderedRows.clear();
    lastRenderStart = -1;
    lastRenderEnd = -1;
    updateRowCount();
    return;
  }

  const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT);

  const renderStart = Math.max(0, firstVisible - OVERSCAN);
  const renderEnd = Math.min(totalRows, firstVisible + visibleCount + OVERSCAN);

  const rid = requestId;

  // Determine which fetch windows we need
  const windowsNeeded = new Set();
  for (let i = renderStart; i < renderEnd; i++) {
    const ws = Math.floor(i / FETCH_WINDOW) * FETCH_WINDOW;
    windowsNeeded.add(ws);
  }

  // Fire off fetches for missing windows
  const fetchPromises = [];
  for (const ws of windowsNeeded) {
    const entry = cache.get(ws);
    if (!entry || entry.loading) {
      fetchPromises.push(ensureWindow(ws, rid));
    }
  }

  // Remove rows outside the new range
  for (const [off, el] of renderedRows) {
    if (off < renderStart || off >= renderEnd) {
      rowContainer.removeChild(el);
      releaseRow(el);
      renderedRows.delete(off);
    }
  }

  // Render rows we have data for
  for (let i = renderStart; i < renderEnd; i++) {
    const data = getCachedRow(i);
    if (data) {
      let el = renderedRows.get(i);
      if (!el) {
        el = getPooledRow();
        rowContainer.appendChild(el);
        renderedRows.set(i, el);
      }
      updateRowElement(el, data, i);
    }
  }

  lastRenderStart = renderStart;
  lastRenderEnd = renderEnd;

  updateRowCount();

  // After fetches complete, re-render if still current
  if (fetchPromises.length > 0) {
    await Promise.all(fetchPromises);
    if (rid === requestId) {
      // Re-render with newly fetched data
      for (let i = renderStart; i < renderEnd; i++) {
        const data = getCachedRow(i);
        if (data) {
          let el = renderedRows.get(i);
          if (!el) {
            el = getPooledRow();
            rowContainer.appendChild(el);
            renderedRows.set(i, el);
          }
          updateRowElement(el, data, i);
        }
      }
    }
  }
}

// ---- Scroll handling ----

let scrollRAF = null;

function onScroll() {
  if (scrollRAF) return;
  scrollRAF = requestAnimationFrame(() => {
    scrollRAF = null;
    render();
  });
}

scroller.addEventListener('scroll', onScroll, { passive: true });

// ---- Filter handling ----

async function applyFilters() {
  const rid = ++requestId;
  clearCache();

  // Clear rendered rows
  for (const [off, el] of renderedRows) {
    rowContainer.removeChild(el);
    releaseRow(el);
  }
  renderedRows.clear();
  lastRenderStart = -1;
  lastRenderEnd = -1;

  // Fetch first window to get total
  try {
    const data = await fetchLogs(0, FETCH_WINDOW, currentSeverity, currentQuery, rid);
    if (rid !== requestId) return; // stale

    totalRows = data.total;
    cache.set(0, { rows: data.rows, requestId: rid, loading: false });

    updateScrollHeight();
    scroller.scrollTop = 0;
    render();
  } catch (e) {
    console.error('Filter error:', e);
  }
}

severityFilter.addEventListener('change', () => {
  currentSeverity = severityFilter.value;
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

// ---- Badges ----

async function loadBadges() {
  try {
    const stats = await fetchStats();
    badgesEl.innerHTML = '';
    for (const sev of ['debug', 'info', 'warn', 'error']) {
      const count = stats.severityCounts[sev] || 0;
      const badge = document.createElement('span');
      badge.className = `badge badge-${sev}`;
      badge.textContent = `${sev}: ${count.toLocaleString()}`;
      badgesEl.appendChild(badge);
    }
  } catch (e) {
    console.error('Failed to load stats:', e);
  }
}

// ---- Init ----

async function init() {
  await loadBadges();
  await applyFilters();
}

init();

// Handle window resize
window.addEventListener('resize', () => {
  render();
});
